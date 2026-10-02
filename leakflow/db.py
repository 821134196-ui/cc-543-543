"""SQLite 持久层：事件链、证据版本、协商签署与复验再开案。

所有业务表只增不改（append-only 倾向）：
- events 为按案件串联的哈希链，任何状态变更都落一条事件；
- statements 仅可追加“更正陈述”，原陈述不可修改；
- evidence_versions 不可变，旧照片误用会被标记为 misused 而不是删除；
- opinions / plans 全部版本留存，复验失败触发新一轮协商而非覆盖旧结论。
"""
from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- 角色：property 物业 / repair 维修（勘查人）/ negotiator 协商员 / resident 住户
CREATE TABLE IF NOT EXISTS actors (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('property','repair','negotiator','resident')),
    unit_id     INTEGER,           -- resident 绑定住户
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cases (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    code          TEXT NOT NULL UNIQUE,
    title         TEXT NOT NULL,
    address       TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','investigating','negotiating','resolved','reopened','closed')),
    round_no      INTEGER NOT NULL DEFAULT 1,          -- 复验复漏后轮次 +1
    evidence_seq  INTEGER NOT NULL DEFAULT 0,          -- 证据版本逻辑时钟
    created_at    TEXT NOT NULL,
    closed_at     TEXT
);

CREATE TABLE IF NOT EXISTS units (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id     INTEGER NOT NULL REFERENCES cases(id),
    floor_no    INTEGER NOT NULL,                     -- 楼层号，用于上下楼叠放
    room_no     TEXT NOT NULL,                        -- 门牌号 501/502
    side        TEXT NOT NULL,                         -- 户型方位 东/西
    resident    TEXT,
    phone       TEXT,
    role        TEXT NOT NULL CHECK (role IN ('upstairs','downstairs','self')),
    scope_note  TEXT
);

-- 事件哈希链（每案件独立一条链）
CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id     INTEGER NOT NULL REFERENCES cases(id),
    seq         INTEGER NOT NULL,
    ts          TEXT NOT NULL,
    actor_id    TEXT,
    actor_role  TEXT,
    type        TEXT NOT NULL,
    payload     TEXT NOT NULL DEFAULT '{}',
    prev_hash   TEXT NOT NULL,
    hash        TEXT NOT NULL,
    UNIQUE (case_id, seq)
);

-- 各方陈述：不可修改；更正通过 corrects_id 追加
CREATE TABLE IF NOT EXISTS statements (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id      INTEGER NOT NULL REFERENCES cases(id),
    unit_id      INTEGER REFERENCES units(id),        -- 物业陈述可为 NULL
    author_id    TEXT NOT NULL,
    content      TEXT NOT NULL,
    corrects_id  INTEGER REFERENCES statements(id),
    created_at   TEXT NOT NULL
);

-- 证据条目（一份证据可有多个版本）
CREATE TABLE IF NOT EXISTS evidence (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id     INTEGER NOT NULL REFERENCES cases(id),
    kind        TEXT NOT NULL DEFAULT 'photo',
    title       TEXT NOT NULL,
    -- 可见范围：all 各方可见 / unit:<id> 仅该户室内隐私
    visibility  TEXT NOT NULL DEFAULT 'all',
    owner_unit  INTEGER REFERENCES units(id),
    current_version INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    created_by  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_versions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    evidence_id  INTEGER NOT NULL REFERENCES evidence(id),
    case_id      INTEGER NOT NULL REFERENCES cases(id),
    version_seq  INTEGER NOT NULL,                    -- 案件级证据逻辑时钟序号
    version_no   INTEGER NOT NULL,                    -- 该证据的第几个版本
    photo_file   TEXT,
    width        INTEGER,
    height       INTEGER,
    taken_at     TEXT NOT NULL,                       -- 声称的拍摄时间
    uploaded_at  TEXT NOT NULL,
    uploaded_by  TEXT NOT NULL,
    stage        TEXT NOT NULL,                       -- report/valve/inspection/water_test/repair/reinspection
    caption      TEXT NOT NULL,
    -- valid 有效 / superseded 被新版本取代 / misused 旧照片误用
    status       TEXT NOT NULL DEFAULT 'valid'
                 CHECK (status IN ('valid','superseded','misused')),
    review_note  TEXT,
    UNIQUE (evidence_id, version_no)
);

-- 漏点标注：归一化坐标，前端按原图等比缩放叠放
CREATE TABLE IF NOT EXISTS annotations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    evidence_id INTEGER NOT NULL REFERENCES evidence(id),
    nx          REAL NOT NULL CHECK (nx BETWEEN 0 AND 1),
    ny          REAL NOT NULL CHECK (ny BETWEEN 0 AND 1),
    label       TEXT NOT NULL,
    author_id   TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

-- 入户预约
CREATE TABLE IF NOT EXISTS appointments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id       INTEGER NOT NULL REFERENCES cases(id),
    unit_id       INTEGER NOT NULL REFERENCES units(id),
    scheduled_at  TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','accepted','refused','done','cancelled')),
    refusal_reason TEXT,
    response_at   TEXT,
    created_by    TEXT NOT NULL,
    created_at    TEXT NOT NULL
);

-- 维修分阶段动作：关阀 / 排查 / 试水 / 修复 / 复验
CREATE TABLE IF NOT EXISTS work_stages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id     INTEGER NOT NULL REFERENCES cases(id),
    seq         INTEGER NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('valve_off','inspection','water_test','repair','reinspection')),
    operator_id TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    ended_at    TEXT,
    result      TEXT,                                -- blocked / leak_located / no_leak / pass / fail ...
    note        TEXT,
    UNIQUE (case_id, seq)
);

CREATE TABLE IF NOT EXISTS water_tests (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id      INTEGER NOT NULL REFERENCES cases(id),
    stage_id     INTEGER NOT NULL REFERENCES work_stages(id),
    method       TEXT NOT NULL,                      -- 打压 / 闭水 / 通水观察
    duration_min INTEGER NOT NULL,
    conclusion   TEXT NOT NULL,                      -- leak / no_leak / inconclusive
    observed_at  TEXT NOT NULL,
    points       TEXT NOT NULL DEFAULT '[]'          -- [{room, result, note}]
);

-- 责任意见（协商员整理；绑定当时证据快照）
CREATE TABLE IF NOT EXISTS opinions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id        INTEGER NOT NULL REFERENCES cases(id),
    round_no       INTEGER NOT NULL,
    seq            INTEGER NOT NULL,                 -- 案件内意见序号
    author_id      TEXT NOT NULL,
    snapshot_seq   INTEGER NOT NULL,                 -- 引用的证据版本逻辑时钟
    citations      TEXT NOT NULL DEFAULT '[]',       -- [{evidence_id, version_id, version_no}]
    conclusion_tags TEXT NOT NULL DEFAULT '[]',      -- 多结论并存，见 seed/文档
    responsibility TEXT NOT NULL DEFAULT '{}',       -- {unit_id: 比例0-100, 'unknown': x}
    rationale      TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'submitted'
                   CHECK (status IN ('draft','submitted','superseded')),
    created_at     TEXT NOT NULL,
    UNIQUE (case_id, seq)
);

-- 费用修复方案（版本化，签署冲突靠 version + status 防护）
CREATE TABLE IF NOT EXISTS plans (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id      INTEGER NOT NULL REFERENCES cases(id),
    round_no     INTEGER NOT NULL,
    opinion_id   INTEGER NOT NULL REFERENCES opinions(id),
    version_no   INTEGER NOT NULL,
    status       TEXT NOT NULL DEFAULT 'proposed'
                 CHECK (status IN ('proposed','signed','rejected','disputed','superseded')),
    summary      TEXT NOT NULL,
    created_by   TEXT NOT NULL,
    created_at   TEXT,
    UNIQUE (case_id, version_no)
);

CREATE TABLE IF NOT EXISTS plan_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id    INTEGER NOT NULL REFERENCES plans(id),
    unit_id    INTEGER REFERENCES units(id),         -- 责任承担户；NULL=待定/公共
    category   TEXT NOT NULL,                        -- repair 修复 / compensation 赔偿 / inspection 勘查
    item       TEXT NOT NULL,                        -- 责任项
    amount     INTEGER NOT NULL,                     -- 金额（分）
    basis      TEXT NOT NULL                         -- 依据（引用意见条目/证据版本）
);

CREATE TABLE IF NOT EXISTS signatures (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id     INTEGER NOT NULL REFERENCES plans(id),
    unit_id     INTEGER NOT NULL REFERENCES units(id),
    decision    TEXT NOT NULL CHECK (decision IN ('sign','reject')),
    comment     TEXT,
    signed_at   TEXT NOT NULL,
    UNIQUE (plan_id, unit_id)
);

CREATE TABLE IF NOT EXISTS repairs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id     INTEGER NOT NULL REFERENCES cases(id),
    plan_id     INTEGER NOT NULL REFERENCES plans(id),
    round_no    INTEGER NOT NULL,
    scope       TEXT NOT NULL,
    contractor  TEXT NOT NULL,
    started_at  TEXT,
    finished_at TEXT,
    status      TEXT NOT NULL DEFAULT 'repairing'
                CHECK (status IN ('repairing','done'))
);

CREATE TABLE IF NOT EXISTS reinspections (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id     INTEGER NOT NULL REFERENCES cases(id),
    repair_id   INTEGER NOT NULL REFERENCES repairs(id),
    inspector_id TEXT NOT NULL,
    inspected_at TEXT NOT NULL,
    result      TEXT NOT NULL CHECK (result IN ('pass','fail')),
    leak_found  INTEGER NOT NULL,                    -- 复漏位置描述在 note
    note        TEXT,
    reopened_round INTEGER
);

-- 模拟通知适配器落库
CREATE TABLE IF NOT EXISTS notifications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id     INTEGER NOT NULL REFERENCES cases(id),
    to_actor    TEXT NOT NULL,
    channel     TEXT NOT NULL DEFAULT 'mock-sms',
    content     TEXT NOT NULL,
    delivered   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL
);

-- 模拟签收
CREATE TABLE IF NOT EXISTS receipts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    notification_id INTEGER NOT NULL REFERENCES notifications(id),
    recipient       TEXT NOT NULL,
    acknowledged_at TEXT,
    UNIQUE (notification_id, recipient)
);

CREATE INDEX IF NOT EXISTS idx_ev_ver ON evidence_versions(case_id, version_seq);
CREATE INDEX IF NOT EXISTS idx_events_case ON events(case_id, seq);
"""


def connect(db_path: str) -> sqlite3.Connection:
    os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    conn.commit()


@contextmanager
def tx(conn: sqlite3.Connection):
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def jdump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True)


def jload(text: str, default):
    if not text:
        return default
    return json.loads(text)
