"""领域服务：事件链写入、证据版本、权限规则、协商签署、复验再开案。

关键规则（对应需求原文）：
1. 报修方不能修改对方陈述 —— statements 只可追加，更正只能由原作者发起。
2. 勘查人不能独自批准赔偿 —— compensation 类方案项仅协商员可建，且必须有签署。
3. 每份责任意见引用当时的证据版本（snapshot_seq + citations）；
   快照之后出现的新证据不会改写旧意见，只能触发新一轮重新协商。
4. 方案签署冲突：同版本两户分别签署/拒绝；一旦版本被拒绝即 disputed；
   已 superseded 的版本不可签署。
5. 复验失败 → 案件 reopen，round_no+1，旧结论全部保留。
"""
from __future__ import annotations

import hashlib
import json
import os
import time
import uuid
from datetime import datetime, timedelta, timezone

from . import db

TZ = timezone(timedelta(hours=8))  # 本地时间统一 CST


def now_ts(offset_min: int = 0) -> str:
    return (datetime.now(TZ) + timedelta(minutes=offset_min)).strftime("%Y-%m-%d %H:%M:%S")


def parse_ts(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d %H:%M:%S").replace(tzinfo=TZ)


def new_id() -> str:
    return uuid.uuid4().hex[:12]


class DomainError(Exception):
    """422 业务规则错误。"""


class Store:
    def __init__(self, conn, photo_dir: str):
        self.c = conn
        self.photo_dir = photo_dir
        if photo_dir:
            os.makedirs(photo_dir, exist_ok=True)

    # ---------- 基础 ----------
    def actor(self, actor_id: str):
        return self.c.execute("SELECT * FROM actors WHERE id=?", (actor_id,)).fetchone()

    def require_role(self, actor_id: str, roles, action: str):
        a = self.actor(actor_id)
        if not a:
            raise DomainError(f"未知操作人：{actor_id}")
        if a["role"] not in roles:
            names = {"property": "物业", "repair": "维修勘查人",
                     "negotiator": "协商员", "resident": "住户"}
            allow = "、".join(names[r] for r in roles)
            raise DomainError(f"{names[a['role']]}无权执行「{action}」，仅 {allow} 可操作")
        return a

    def case_row(self, case_id: int):
        row = self.c.execute("SELECT * FROM cases WHERE id=?", (case_id,)).fetchone()
        if not row:
            raise DomainError(f"案件 {case_id} 不存在")
        return row

    # ---------- 事件哈希链 ----------
    def emit(self, case_id: int, etype: str, payload: dict,
             actor_id: str | None = None, ts: str | None = None):
        ts = ts or now_ts()
        seq = self.c.execute("SELECT COALESCE(MAX(seq),0)+1 FROM events WHERE case_id=?",
                             (case_id,)).fetchone()[0]
        prev = self.c.execute("SELECT hash FROM events WHERE case_id=? ORDER BY seq DESC LIMIT 1",
                              (case_id,)).fetchone()
        prev_hash = prev["hash"] if prev else "GENESIS"
        actor = self.actor(actor_id) if actor_id else None
        body = json.dumps({"case_id": case_id, "seq": seq, "ts": ts, "type": etype,
                           "payload": payload, "prev_hash": prev_hash,
                           "actor_id": actor_id,
                           "actor_role": actor["role"] if actor else None},
                          ensure_ascii=False, sort_keys=True)
        h = hashlib.sha256(body.encode()).hexdigest()
        cur = self.c.execute(
            "INSERT INTO events(case_id,seq,ts,actor_id,actor_role,type,payload,prev_hash,hash)"
            " VALUES(?,?,?,?,?,?,?,?,?)",
            (case_id, seq, ts, actor_id, actor["role"] if actor else None,
             etype, json.dumps(payload, ensure_ascii=False, sort_keys=True), prev_hash, h))
        return cur.lastrowid

    def verify_chain(self, case_id: int) -> bool:
        prev_hash = "GENESIS"
        for e in self.c.execute("SELECT * FROM events WHERE case_id=? ORDER BY seq", (case_id,)):
            body = json.dumps({"case_id": e["case_id"], "seq": e["seq"], "ts": e["ts"],
                               "type": e["type"], "payload": json.loads(e["payload"]),
                               "prev_hash": prev_hash, "actor_id": e["actor_id"],
                               "actor_role": e["actor_role"]},
                              ensure_ascii=False, sort_keys=True)
            if hashlib.sha256(body.encode()).hexdigest() != e["hash"]:
                return False
            prev_hash = e["hash"]
        return True

    # ---------- 通知 / 签收（模拟适配器） ----------
    def notify(self, case_id: int, to_actor: str, content: str, ts: str | None = None):
        cur = self.c.execute(
            "INSERT INTO notifications(case_id,to_actor,channel,content,created_at)"
            " VALUES(?,?,?,?,?)",
            (case_id, to_actor, "mock-sms", content, ts or now_ts()))
        nid = cur.lastrowid
        self.emit(case_id, "notification_sent",
                  {"notification_id": nid, "to": to_actor, "content": content}, ts=ts)
        return nid

    def acknowledge(self, notification_id: int, recipient: str, ts: str | None = None):
        n = self.c.execute("SELECT * FROM notifications WHERE id=?", (notification_id,)).fetchone()
        if not n:
            raise DomainError("通知不存在")
        if n["to_actor"] != recipient:
            raise DomainError("仅收件本人可签收")
        if self.c.execute("SELECT 1 FROM receipts WHERE notification_id=?",
                          (notification_id,)).fetchone():
            raise DomainError("该通知已签收，不能重复签收")
        self.c.execute("INSERT INTO receipts(notification_id,recipient,acknowledged_at)"
                       " VALUES(?,?,?)", (notification_id, recipient, ts or now_ts()))
        self.emit(n["case_id"], "receipt_signed",
                  {"notification_id": notification_id, "recipient": recipient}, ts=ts)

    # ---------- 立案 ----------
    def register_case(self, actor_id: str, code: str, title: str, address: str,
                      location: str, happened_at: str, damaged_parts: list,
                      descriptions: dict, ts: str | None = None) -> int:
        """物业登记：位置、时间、受损部位及各方描述。"""
        self.require_role(actor_id, ("property",), "立案登记")
        cur = self.c.execute(
            "INSERT INTO cases(code,title,address,status,created_at)"
            " VALUES(?,?,?, 'open',?)",
            (code, title, address, ts or now_ts()))
        case_id = cur.lastrowid
        self.emit(case_id, "case_registered",
                  {"code": code, "title": title, "address": address,
                   "location": location, "happened_at": happened_at,
                   "damaged_parts": damaged_parts,
                   "descriptions": descriptions}, actor_id, ts=ts)
        return case_id

    def add_unit(self, case_id: int, floor_no: int, room_no: str, side: str,
                 role: str, resident: str | None, phone: str | None,
                 scope_note: str | None = None) -> int:
        cur = self.c.execute(
            "INSERT INTO units(case_id,floor_no,room_no,side,resident,phone,role,scope_note)"
            " VALUES(?,?,?,?,?,?,?,?)",
            (case_id, floor_no, room_no, side, resident, phone, role, scope_note))
        return cur.lastrowid

    def link_actor_unit(self, actor_id: str, unit_id: int):
        self.c.execute("UPDATE actors SET unit_id=? WHERE id=?", (unit_id, actor_id))

    # ---------- 陈述 ----------
    def add_statement(self, case_id: int, actor_id: str, content: str,
                      unit_id: int | None = None, ts: str | None = None):
        actor = self.require_role(actor_id, ("property", "resident"), "登记陈述")
        if actor["role"] == "resident":
            # 住户只能替自己户陈述
            if unit_id is None or actor["unit_id"] != unit_id:
                raise DomainError("住户只能登记本户陈述，不能代写对方陈述")
        cur = self.c.execute(
            "INSERT INTO statements(case_id,unit_id,author_id,content,created_at)"
            " VALUES(?,?,?,?,?)",
            (case_id, unit_id, actor_id, content, ts or now_ts()))
        sid = cur.lastrowid
        self.emit(case_id, "statement_added",
                  {"statement_id": sid, "unit_id": unit_id, "author": actor_id,
                   "content": content}, actor_id, ts=ts)
        return sid

    def correct_statement(self, case_id: int, actor_id: str, statement_id: int,
                          new_content: str, ts: str | None = None):
        """只能由原作者更正自己的陈述；原记录保留。"""
        old = self.c.execute("SELECT * FROM statements WHERE id=? AND case_id=?",
                             (statement_id, case_id)).fetchone()
        if not old:
            raise DomainError("陈述不存在")
        if old["author_id"] != actor_id:
            raise DomainError("报修方不能修改对方陈述：更正只能由陈述本人追加")
        cur = self.c.execute(
            "INSERT INTO statements(case_id,unit_id,author_id,content,corrects_id,created_at)"
            " VALUES(?,?,?,?,?,?)",
            (case_id, old["unit_id"], actor_id, new_content, statement_id, ts or now_ts()))
        new_id_ = cur.lastrowid
        self.emit(case_id, "statement_corrected",
                  {"new_statement_id": new_id_, "corrects_id": statement_id,
                   "content": new_content}, actor_id, ts=ts)
        return new_id_

    # ---------- 证据版本 ----------
    def _next_evidence_seq(self, case_id: int) -> int:
        seq = self.c.execute("SELECT evidence_seq FROM cases WHERE id=?", (case_id,)).fetchone()[0] + 1
        self.c.execute("UPDATE cases SET evidence_seq=? WHERE id=?", (seq, case_id))
        return seq

    def create_evidence(self, case_id: int, actor_id: str, title: str,
                        visibility: str = "all", owner_unit: int | None = None,
                        ts: str | None = None) -> int:
        actor = self.require_role(actor_id, ("property", "repair", "negotiator"), "上传证据")
        if visibility.startswith("unit:"):
            owner_unit = int(visibility.split(":")[1])
        cur = self.c.execute(
            "INSERT INTO evidence(case_id,kind,title,visibility,owner_unit,created_at,created_by)"
            " VALUES(?, 'photo',?,?,?,?,?)",
            (case_id, title, visibility, owner_unit, ts or now_ts(), actor_id))
        return cur.lastrowid

    def add_evidence_version(self, case_id: int, evidence_id: int, actor_id: str,
                             photo_file: str, width: int, height: int,
                             taken_at: str, stage: str, caption: str,
                             status: str = "valid", review_note: str | None = None,
                             ts: str | None = None,
                             mark_previous: str = "superseded") -> int:
        """追加证据版本。旧版本默认标 superseded；误用旧照场景显式传 misused。"""
        self.require_role(actor_id, ("property", "repair", "negotiator"), "上传证据版本")
        ev = self.c.execute("SELECT * FROM evidence WHERE id=? AND case_id=?",
                            (evidence_id, case_id)).fetchone()
        if not ev:
            raise DomainError("证据不存在")
        version_no = ev["current_version"] + 1
        seq = self._next_evidence_seq(case_id)
        cur = self.c.execute(
            "INSERT INTO evidence_versions(evidence_id,case_id,version_seq,version_no,"
            "photo_file,width,height,taken_at,uploaded_at,uploaded_by,stage,caption,status,review_note)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (evidence_id, case_id, seq, version_no, photo_file, width, height,
             taken_at, ts or now_ts(), actor_id, stage, caption, status, review_note))
        vid = cur.lastrowid
        if status == "valid":
            self.c.execute("UPDATE evidence SET current_version=? WHERE id=?",
                           (version_no, evidence_id))
        # 处理上一版状态
        if mark_previous in ("superseded", "misused") and version_no > 1:            self.c.execute(
                "UPDATE evidence_versions SET status=? WHERE evidence_id=? AND version_no=? "
                "AND status='valid'", (mark_previous, evidence_id, version_no - 1))
        self.emit(case_id, "evidence_version_added",
                  {"evidence_id": evidence_id, "version_id": vid,
                   "version_no": version_no, "evidence_seq": seq,
                   "stage": stage, "caption": caption, "status": status,
                   "taken_at": taken_at}, actor_id, ts=ts)
        return vid

    def mark_misused(self, case_id: int, version_id: int, actor_id: str,
                     note: str, ts: str | None = None):
        """把旧照片标记为误用（不删除），并产生新证据序号触发重新协商。"""
        self.require_role(actor_id, ("property", "repair", "negotiator"), "复核证据")
        v = self.c.execute("SELECT * FROM evidence_versions WHERE id=? AND case_id=?",
                           (version_id, case_id)).fetchone()
        if not v:
            raise DomainError("证据版本不存在")
        self.c.execute("UPDATE evidence_versions SET status='misused', review_note=? WHERE id=?",
                       (note, version_id))
        self.emit(case_id, "evidence_marked_misused",
                  {"version_id": version_id, "evidence_id": v["evidence_id"],
                   "version_no": v["version_no"], "note": note}, actor_id, ts=ts)

    def add_annotation(self, evidence_id: int, actor_id: str, nx: float, ny: float,
                       label: str, ts: str | None = None):
        self.require_role(actor_id, ("property", "repair", "negotiator"), "标注漏点")
        cur = self.c.execute(
            "INSERT INTO annotations(evidence_id,nx,ny,label,author_id,created_at)"
            " VALUES(?,?,?,?,?,?)",
            (evidence_id, nx, ny, label, actor_id, ts or now_ts()))
        ev = self.c.execute("SELECT case_id FROM evidence WHERE id=?", (evidence_id,)).fetchone()
        self.emit(ev["case_id"], "annotation_added",
                  {"evidence_id": evidence_id, "annotation_id": cur.lastrowid,
                   "nx": nx, "ny": ny, "label": label}, actor_id, ts=ts)
        return cur.lastrowid

    def visible_evidence(self, case_id: int, actor_id: str):
        """跨户隐私：按操作人过滤证据。物业/维修/协商看全部；住户只看 all 与本户。"""
        actor = self.actor(actor_id)
        rows = self.c.execute(
            "SELECT * FROM evidence_versions WHERE case_id=? ORDER BY version_seq", (case_id,)
        ).fetchall()
        if actor["role"] in ("property", "repair", "negotiator"):
            return rows
        out = []
        for r in rows:
            ev = self.c.execute("SELECT * FROM evidence WHERE id=?", (r["evidence_id"],)).fetchone()
            if ev["visibility"] == "all" or (
                ev["visibility"].startswith("unit:") and ev["owner_unit"] == actor["unit_id"]):
                out.append(r)
        return out

    # ---------- 入户预约 ----------
    def create_appointment(self, case_id: int, actor_id: str, unit_id: int,
                           scheduled_at: str, ts: str | None = None):
        self.require_role(actor_id, ("property", "repair"), "发起入户预约")
        cur = self.c.execute(
            "INSERT INTO appointments(case_id,unit_id,scheduled_at,created_by,created_at)"
            " VALUES(?,?,?,?,?)",
            (case_id, unit_id, scheduled_at, actor_id, ts or now_ts()))
        aid = cur.lastrowid
        unit = self.c.execute("SELECT * FROM units WHERE id=?", (unit_id,)).fetchone()
        self.emit(case_id, "appointment_created",
                  {"appointment_id": aid, "unit_id": unit_id, "scheduled_at": scheduled_at},
                  actor_id, ts=ts)
        if unit and unit["resident"]:
            resident = self.c.execute(
                "SELECT id FROM actors WHERE unit_id=? AND role='resident' ORDER BY id LIMIT 1",
                (unit_id,)).fetchone()
            if resident:
                self.notify(case_id, resident["id"],
                            f"入户预约：{scheduled_at} 前往 {unit['room_no']} 勘查，请确认。",
                            ts=ts)
        return aid

    def respond_appointment(self, appt_id: int, actor_id: str, accept: bool,
                            reason: str | None = None, ts: str | None = None):
        appt = self.c.execute("SELECT * FROM appointments WHERE id=?", (appt_id,)).fetchone()
        if not appt:
            raise DomainError("预约不存在")
        actor = self.actor(actor_id)
        if actor["role"] != "resident" or actor["unit_id"] != appt["unit_id"]:
            raise DomainError("仅该户住户可回应入户预约")
        status = "accepted" if accept else "refused"
        self.c.execute(
            "UPDATE appointments SET status=?, refusal_reason=?, response_at=? WHERE id=?",
            (status, None if accept else reason, ts or now_ts(), appt_id))
        self.emit(appt["case_id"], "appointment_responded",
                  {"appointment_id": appt_id, "status": status, "reason": reason},
                  actor_id, ts=ts)

    # ---------- 维修阶段 / 试水 ----------
    def add_stage(self, case_id: int, actor_id: str, kind: str, started_at: str,
                  ended_at: str | None = None, result: str | None = None,
                  note: str | None = None, ts: str | None = None):
        self.require_role(actor_id, ("repair", "property"), "登记维修阶段")
        seq = self.c.execute("SELECT COALESCE(MAX(seq),0)+1 FROM work_stages WHERE case_id=?",
                             (case_id,)).fetchone()[0]
        cur = self.c.execute(
            "INSERT INTO work_stages(case_id,seq,kind,operator_id,started_at,ended_at,result,note)"
            " VALUES(?,?,?,?,?,?,?,?)",
            (case_id, seq, kind, actor_id, started_at, ended_at, result, note))
        sid = cur.lastrowid
        self.emit(case_id, "stage_added",
                  {"stage_id": sid, "seq": seq, "kind": kind, "result": result,
                   "note": note, "started_at": started_at, "ended_at": ended_at},
                  actor_id, ts=ts)
        if kind == "valve_off":
            self.emit(case_id, "valve_closed", {"stage_id": sid, "note": note}, actor_id, ts=ts)
        return sid

    def add_water_test(self, case_id: int, stage_id: int, actor_id: str, method: str,
                       duration_min: int, conclusion: str, observed_at: str,
                       points: list, ts: str | None = None):
        self.require_role(actor_id, ("repair",), "记录试水")
        if conclusion not in ("leak", "no_leak", "inconclusive"):
            raise DomainError("试水结论只能是 leak/no_leak/inconclusive")
        cur = self.c.execute(
            "INSERT INTO water_tests(case_id,stage_id,method,duration_min,conclusion,observed_at,points)"
            " VALUES(?,?,?,?,?,?,?)",
            (case_id, stage_id, method, duration_min, conclusion, observed_at,
             json.dumps(points, ensure_ascii=False)))
        wid = cur.lastrowid
        self.emit(case_id, "water_test_recorded",
                  {"water_test_id": wid, "stage_id": stage_id, "method": method,
                   "conclusion": conclusion, "points": points}, actor_id, ts=ts)
        return wid

    # ---------- 责任意见（证据快照） ----------
    def current_snapshot_seq(self, case_id: int) -> int:
        return self.c.execute("SELECT evidence_seq FROM cases WHERE id=?", (case_id,)).fetchone()[0]

    def add_opinion(self, case_id: int, actor_id: str, conclusion_tags: list,
                    responsibility: dict, rationale: str,
                    citations: list | None = None, ts: str | None = None) -> int:
        self.require_role(actor_id, ("negotiator",), "出具责任意见")
        case = self.case_row(case_id)
        snapshot = self.current_snapshot_seq(case_id)
        # citations: 显式给出或自动收录截至快照的全部 valid 版本
        if citations is None:
            citations = []
            rows = self.c.execute(
                "SELECT ev.id AS eid, v.id AS vid, v.version_no FROM evidence_versions v"
                " JOIN evidence ev ON ev.id=v.evidence_id"
                " WHERE v.case_id=? AND v.version_seq<=? AND v.status='valid'",
                (case_id, snapshot)).fetchall()
            citations = [{"evidence_id": r["eid"], "version_id": r["vid"],
                          "version_no": r["version_no"]} for r in rows]
        else:
            for c_ in citations:
                v = self.c.execute(
                    "SELECT * FROM evidence_versions WHERE id=? AND case_id=?",
                    (c_["version_id"], case_id)).fetchone()
                if not v:
                    raise DomainError("引用的证据版本不存在")
                if v["version_seq"] > snapshot:
                    raise DomainError("责任意见只能引用截至当前快照的证据版本")
        seq = self.c.execute("SELECT COALESCE(MAX(seq),0)+1 FROM opinions WHERE case_id=?",
                             (case_id,)).fetchone()[0]
        cur = self.c.execute(
            "INSERT INTO opinions(case_id,round_no,seq,author_id,snapshot_seq,citations,"
            "conclusion_tags,responsibility,rationale,created_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?)",
            (case_id, case["round_no"], seq, actor_id, snapshot,
             json.dumps(citations, ensure_ascii=False),
             json.dumps(conclusion_tags, ensure_ascii=False),
             json.dumps(responsibility, ensure_ascii=False), rationale, ts or now_ts()))
        oid = cur.lastrowid
        self.emit(case_id, "opinion_submitted",
                  {"opinion_id": oid, "seq": seq, "round_no": case["round_no"],
                   "snapshot_seq": snapshot, "citations": citations,
                   "conclusion_tags": conclusion_tags,
                   "responsibility": responsibility}, actor_id, ts=ts)
        return oid

    def new_evidence_after_opinion(self, opinion_id: int) -> list:
        """快照之后出现的新证据（只能触发重新协商，不能改旧意见）。"""
        o = self.c.execute("SELECT * FROM opinions WHERE id=?", (opinion_id,)).fetchone()
        return self.c.execute(
            "SELECT v.* FROM evidence_versions v WHERE v.case_id=? AND v.version_seq>?"
            " ORDER BY v.version_seq", (o["case_id"], o["snapshot_seq"])).fetchall()

    # ---------- 费用方案 + 签署冲突 ----------
    def create_plan(self, case_id: int, actor_id: str, opinion_id: int,
                    summary: str, items: list, ts: str | None = None) -> int:
        """items: [{unit_id, category, item, amount_fen, basis}]
        赔偿项（compensation）仅协商员可创建——勘查人无权独自批准赔偿。"""
        actor = self.require_role(actor_id, ("negotiator", "repair"), "拟定方案")
        for it in items:
            if it["category"] == "compensation" and actor["role"] != "negotiator":
                raise DomainError("勘查人不能独自批准赔偿：赔偿项须由协商员列入方案")
        opinion = self.c.execute("SELECT * FROM opinions WHERE id=? AND case_id=?",
                                 (opinion_id, case_id)).fetchone()
        if not opinion:
            raise DomainError("责任意见不存在")
        # 旧版方案全部置 superseded（重新协商产生新方案）
        self.c.execute("UPDATE plans SET status='superseded' WHERE case_id=? AND status IN"
                       " ('proposed','disputed','rejected')", (case_id,))
        version_no = self.c.execute(
            "SELECT COALESCE(MAX(version_no),0)+1 FROM plans WHERE case_id=?",
            (case_id,)).fetchone()[0]
        cur = self.c.execute(
            "INSERT INTO plans(case_id,round_no,opinion_id,version_no,status,summary,created_by,created_at)"
            " VALUES(?,?,?,?, 'proposed',?,?,?)",
            (case_id, opinion["round_no"], opinion_id, version_no, summary,
             actor_id, ts or now_ts()))
        pid = cur.lastrowid
        for it in items:
            self.c.execute(
                "INSERT INTO plan_items(plan_id,unit_id,category,item,amount,basis)"
                " VALUES(?,?,?,?,?,?)",
                (pid, it.get("unit_id"), it["category"], it["item"],
                 int(it["amount_fen"]), it["basis"]))
        self.emit(case_id, "plan_created",
                  {"plan_id": pid, "version_no": version_no, "opinion_id": opinion_id,
                   "items": items, "summary": summary}, actor_id, ts=ts)
        return pid

    def sign_plan(self, plan_id: int, actor_id: str, decision: str,
                  comment: str | None = None, ts: str | None = None):
        actor = self.require_role(actor_id, ("resident",), "签署方案")
        plan = self.c.execute("SELECT * FROM plans WHERE id=?", (plan_id,)).fetchone()
        if not plan:
            raise DomainError("方案不存在")
        if plan["status"] == "superseded":
            raise DomainError("方案版本已被新方案取代，不能签署旧版本")
        if plan["status"] == "signed":
            raise DomainError("该版本已完成签署")
        # 同户重复签：同一户只能签一次，改主意须走拒绝或新一轮方案
        dup = self.c.execute("SELECT 1 FROM signatures WHERE plan_id=? AND unit_id=?",
                             (plan_id, actor["unit_id"])).fetchone()
        if dup:
            raise DomainError("本户已对该版本作出决定，不能重复签署；如有异议请提出后重新协商")
        self.c.execute(
            "INSERT INTO signatures(plan_id,unit_id,decision,comment,signed_at)"
            " VALUES(?,?,?,?,?)",
            (plan_id, actor["unit_id"], decision, comment, ts or now_ts()))

        rejections = self.c.execute(
            "SELECT COUNT(*) n FROM signatures WHERE plan_id=? AND decision='reject'",
            (plan_id,)).fetchone()["n"]
        new_status = "disputed" if rejections else "proposed"
        # 两户都接受才算 signed（相关住户数来自案件中 upstairs/downstairs）
        party_units = {r["id"] for r in self.c.execute(
            "SELECT id FROM units WHERE case_id=? AND role IN ('upstairs','downstairs')",
            (plan["case_id"],))}
        signed_units = {r["unit_id"] for r in self.c.execute(
            "SELECT unit_id FROM signatures WHERE plan_id=? AND decision='sign'", (plan_id,))}
        if rejections == 0 and party_units and party_units <= signed_units:
            new_status = "signed"
        self.c.execute("UPDATE plans SET status=? WHERE id=?", (new_status, plan_id))
        self.emit(plan["case_id"], "plan_signed",
                  {"plan_id": plan_id, "unit_id": actor["unit_id"], "decision": decision,
                   "comment": comment, "result_status": new_status}, actor_id, ts=ts)
        return new_status

    # ---------- 修复 / 复验 / 再开案 ----------
    def start_repair(self, case_id: int, actor_id: str, plan_id: int, scope: str,
                     contractor: str, started_at: str, ts: str | None = None):
        self.require_role(actor_id, ("property", "repair"), "登记修复")
        plan = self.c.execute("SELECT * FROM plans WHERE id=? AND case_id=?",
                              (plan_id, case_id)).fetchone()
        if not plan or plan["status"] != "signed":
            raise DomainError("只有双方签署通过的方案才能进入修复")
        cur = self.c.execute(
            "INSERT INTO repairs(case_id,plan_id,round_no,scope,contractor,started_at,status)"
            " VALUES(?,?,?,?,?,?,'repairing')",
            (case_id, plan_id, self.case_row(case_id)["round_no"], scope, contractor, started_at))
        rid = cur.lastrowid
        self.emit(case_id, "repair_started",
                  {"repair_id": rid, "plan_id": plan_id, "scope": scope,
                   "contractor": contractor, "started_at": started_at}, actor_id, ts=ts)
        return rid

    def finish_repair(self, repair_id: int, actor_id: str, finished_at: str,
                      ts: str | None = None):
        self.require_role(actor_id, ("property", "repair"), "完工登记")
        r = self.c.execute("SELECT * FROM repairs WHERE id=?", (repair_id,)).fetchone()
        self.c.execute("UPDATE repairs SET status='done', finished_at=? WHERE id=?",
                       (finished_at, repair_id))
        self.emit(r["case_id"], "repair_finished",
                  {"repair_id": repair_id, "finished_at": finished_at}, actor_id, ts=ts)

    def reinspect(self, case_id: int, repair_id: int, actor_id: str, result: str,
                  leak_found: bool, note: str, inspected_at: str, ts: str | None = None):
        """复验通过 → resolved；复漏 → reopened，轮次+1，旧方案/意见全部保留。"""
        self.require_role(actor_id, ("repair", "property"), "复验")
        repair = self.c.execute("SELECT * FROM repairs WHERE id=? AND case_id=?",
                                (repair_id, case_id)).fetchone()
        if not repair or repair["status"] != "done":
            raise DomainError("修复未完工，不能复验")
        reopened_round = None
        if result == "pass":
            self.c.execute("UPDATE cases SET status='resolved', closed_at=? WHERE id=?",
                           (inspected_at, case_id))
        else:
            row = self.c.execute("SELECT round_no FROM cases WHERE id=?", (case_id,)).fetchone()
            reopened_round = row["round_no"] + 1
            self.c.execute("UPDATE cases SET status='reopened', round_no=?, closed_at=NULL"
                           " WHERE id=?", (reopened_round, case_id))
        cur = self.c.execute(
            "INSERT INTO reinspections(case_id,repair_id,inspector_id,inspected_at,result,"
            "leak_found,note,reopened_round) VALUES(?,?,?,?,?,?,?,?)",
            (case_id, repair_id, actor_id, inspected_at, result,
             1 if leak_found else 0, note, reopened_round))
        rid = cur.lastrowid
        self.emit(case_id, "reinspection_done",
                  {"reinspection_id": rid, "repair_id": repair_id, "result": result,
                   "leak_found": leak_found, "note": note,
                   "reopened_round": reopened_round}, actor_id, ts=ts)
        if result == "fail":
            self.emit(case_id, "case_reopened",
                      {"repair_id": repair_id, "new_round": reopened_round, "note": note},
                      actor_id, ts=ts)
        return rid
