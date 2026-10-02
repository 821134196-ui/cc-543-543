'use strict';
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- 当事人：住户 / 物业 / 勘查人 / 协商员
CREATE TABLE IF NOT EXISTS parties (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,            -- resident_reporter | resident_up | manager | inspector | negotiator
  name TEXT NOT NULL,
  unit TEXT,                     -- 门牌，如 3栋601
  building TEXT
);

-- 渗漏案件（再开案通过 root_case_id 串成链）
CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  building TEXT NOT NULL,
  title TEXT NOT NULL,
  unit_reporter TEXT NOT NULL,   -- 报修户（楼下）
  unit_up TEXT NOT NULL,         -- 楼上户
  floor_reporter INTEGER NOT NULL,
  floor_up INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  root_case_id TEXT REFERENCES cases(id),
  reopen_seq INTEGER NOT NULL DEFAULT 0,
  reopen_reason TEXT,
  parent_case_id TEXT REFERENCES cases(id),
  current_evidence_version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS case_members (
  case_id TEXT NOT NULL REFERENCES cases(id),
  party_id TEXT NOT NULL REFERENCES parties(id),
  PRIMARY KEY (case_id, party_id)
);

-- 住户陈述与物业登记：只可追加、不可修改删除
CREATE TABLE IF NOT EXISTS statements (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  party_id TEXT NOT NULL REFERENCES parties(id),
  seq INTEGER NOT NULL,
  location TEXT,
  damaged_parts TEXT,            -- JSON 数组
  description TEXT NOT NULL,
  source TEXT NOT NULL,          -- 本人陈述 | 物业代录
  created_at TEXT NOT NULL,
  UNIQUE(case_id, seq)
);

-- 证据版本（冻结后不可变；责任意见引用其 id）
CREATE TABLE IF NOT EXISTS evidence_versions (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  version INTEGER NOT NULL,
  label TEXT,
  note TEXT,
  published_by TEXT REFERENCES parties(id),
  created_at TEXT NOT NULL,
  UNIQUE(case_id, version)
);

CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'image/png',
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  room TEXT,
  caption TEXT,
  taken_at TEXT NOT NULL,        -- 拍摄时间（随照片声明/读取）
  uploaded_at TEXT NOT NULL,
  uploaded_by TEXT REFERENCES parties(id),
  annotations TEXT NOT NULL DEFAULT '[]'  -- 归一化标注 [{x,y,text,by}]
);

-- 证据条目：version_id 为空 = 当前草稿；冻结后归入版本、永不修改
CREATE TABLE IF NOT EXISTS evidence_items (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  seq INTEGER NOT NULL,
  version_id TEXT REFERENCES evidence_versions(id), -- NULL = 草稿
  type TEXT NOT NULL,            -- photo | note | stale_flag
  photo_id TEXT REFERENCES photos(id),
  caption TEXT,
  flag_reason TEXT,
  created_by TEXT REFERENCES parties(id),
  created_at TEXT NOT NULL,
  UNIQUE(case_id, seq)
);

-- 仅追加事件链
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor TEXT REFERENCES parties(id),
  payload TEXT NOT NULL DEFAULT '{}',
  evidence_version_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(case_id, seq)
);

-- 维修分阶段：关阀 / 排查 / 试水
CREATE TABLE IF NOT EXISTS work_stages (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  stage TEXT NOT NULL CHECK(stage IN ('valve','inspection','water_test')),
  status TEXT NOT NULL DEFAULT 'planned', -- planned | in_progress | done | blocked
  actor TEXT REFERENCES parties(id),
  note TEXT,
  started_at TEXT,
  finished_at TEXT
);

-- 入户预约
CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  target_party TEXT NOT NULL REFERENCES parties(id),
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL,          -- requested | accepted | refused | rescheduled | completed | no_show
  reason TEXT,
  response_note TEXT,
  created_by TEXT REFERENCES parties(id),
  created_at TEXT NOT NULL,
  responded_at TEXT
);

-- 试水记录
CREATE TABLE IF NOT EXISTS water_tests (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  method TEXT NOT NULL,
  zone TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  result TEXT NOT NULL,          -- positive | negative | inconclusive
  observed_at TEXT,
  leak_point TEXT,
  operator TEXT REFERENCES parties(id),
  note TEXT
);

-- 不同结论并存（水源未定位 / 多房间同漏 / 拒绝入户 / 旧照片 / 复漏 / 费用争议 / 责任意见）
CREATE TABLE IF NOT EXISTS conclusions (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  evidence_version_id TEXT REFERENCES evidence_versions(id),
  author TEXT REFERENCES parties(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- 协商方案（按版本；签署后不可改，须出新版本重新协商）
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL,          -- draft | pending | signed | rejected | approved
  evidence_version_id TEXT NOT NULL REFERENCES evidence_versions(id),
  responsibility_summary TEXT,
  repair_plan TEXT NOT NULL DEFAULT '[]', -- JSON 步骤
  warranty_until TEXT,
  created_by TEXT REFERENCES parties(id),
  created_at TEXT NOT NULL,
  finalized_at TEXT,
  approved_at TEXT,
  approved_by TEXT REFERENCES parties(id),
  UNIQUE(case_id, version)
);

-- 费用按责任项列明金额与依据（金额：分）
CREATE TABLE IF NOT EXISTS proposal_items (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  party_id TEXT NOT NULL REFERENCES parties(id),
  title TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  basis TEXT NOT NULL,
  seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS proposal_signatures (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  party_id TEXT NOT NULL REFERENCES parties(id),
  action TEXT NOT NULL,          -- signed | rejected
  doc_version INTEGER NOT NULL,  -- 签署时的文档版本
  note TEXT,
  signed_at TEXT NOT NULL,
  UNIQUE(proposal_id, party_id)
);

CREATE TABLE IF NOT EXISTS repairs (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  proposal_id TEXT REFERENCES proposals(id),
  status TEXT NOT NULL,          -- scheduled | in_progress | done
  contractor TEXT,
  scope TEXT,
  started_at TEXT,
  finished_at TEXT
);

-- 修复复验
CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  repair_id TEXT REFERENCES repairs(id),
  result TEXT NOT NULL,          -- pass | fail
  dry_days INTEGER,
  observed TEXT,
  photo_id TEXT REFERENCES photos(id),
  inspector TEXT REFERENCES parties(id),
  checked_at TEXT NOT NULL
);

-- 模拟适配器落库（文件日志由适配器另写）
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  case_id TEXT,
  channel TEXT NOT NULL,         -- sms | onsite
  to_party TEXT REFERENCES parties(id),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'simulated',
  sent_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  case_id TEXT,
  doc_type TEXT NOT NULL,        -- proposal_sign | proposal_approve | reopen
  doc_id TEXT NOT NULL,
  party_id TEXT REFERENCES parties(id),
  payload TEXT NOT NULL DEFAULT '{}',
  signed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_case ON events(case_id, seq);
CREATE INDEX IF NOT EXISTS idx_items_case ON evidence_items(case_id);
CREATE INDEX IF NOT EXISTS idx_photos_case ON photos(case_id);

-- 仅追加保护：事件链、陈述、冻结版本、签署/签收一律不可改删
CREATE TRIGGER IF NOT EXISTS trg_events_no_upd BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events 仅追加，禁止修改'); END;
CREATE TRIGGER IF NOT EXISTS trg_events_no_del BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events 仅追加，禁止删除'); END;
CREATE TRIGGER IF NOT EXISTS trg_statements_no_upd BEFORE UPDATE ON statements
  BEGIN SELECT RAISE(ABORT, 'statements 仅追加，对方陈述不可修改'); END;
CREATE TRIGGER IF NOT EXISTS trg_statements_no_del BEFORE DELETE ON statements
  BEGIN SELECT RAISE(ABORT, 'statements 仅追加，禁止删除'); END;
CREATE TRIGGER IF NOT EXISTS trg_versions_no_upd BEFORE UPDATE ON evidence_versions
  BEGIN SELECT RAISE(ABORT, '证据版本冻结后不可修改'); END;
CREATE TRIGGER IF NOT EXISTS trg_versions_no_del BEFORE DELETE ON evidence_versions
  BEGIN SELECT RAISE(ABORT, '证据版本禁止删除'); END;
CREATE TRIGGER IF NOT EXISTS trg_items_frozen_no_upd BEFORE UPDATE ON evidence_items
  WHEN OLD.version_id IS NOT NULL
  BEGIN SELECT RAISE(ABORT, '已入册证据不可修改'); END;
CREATE TRIGGER IF NOT EXISTS trg_items_frozen_no_del BEFORE DELETE ON evidence_items
  WHEN OLD.version_id IS NOT NULL
  BEGIN SELECT RAISE(ABORT, '已入册证据禁止删除'); END;
CREATE TRIGGER IF NOT EXISTS trg_sigs_no_upd BEFORE UPDATE ON proposal_signatures
  BEGIN SELECT RAISE(ABORT, '签署记录不可修改'); END;
CREATE TRIGGER IF NOT EXISTS trg_sigs_no_del BEFORE DELETE ON proposal_signatures
  BEGIN SELECT RAISE(ABORT, '签署记录禁止删除'); END;
`;

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb };
