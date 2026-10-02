"""LeakFlow 领域规则测试（unittest，零三方依赖）。

覆盖四类需求场景：
  1. 证据版本：意见冻结快照、新证据只触发重新协商、旧照误用保留不删
  2. 跨户隐私：住户只见公共证据与本户私域证据
  3. 方案签署冲突：拒签争议、重复签署、旧版禁签、勘查人不能批赔偿、不能改对方陈述
  4. 复验后再开案：复漏 → round+1、旧结论保留、新一轮可再协商并复验通过
另含：事件哈希链完整性与篡改检测、种子复漏案例不变量。
"""
import os
import shutil
import tempfile
import unittest

from leakflow import db as dbmod
from leakflow.services import Store, DomainError


class FlowTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="leakflow-test-")
        self.dbp = os.path.join(self.tmp, "t.db")
        self.photos = os.path.join(self.tmp, "photos")
        self.conn = dbmod.connect(self.dbp)
        dbmod.init_db(self.conn)
        self.st = Store(self.conn, self.photos)
        self._actors()
        self.cid = self._open_case()

    def tearDown(self):
        self.conn.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ---------- 夹具 ----------
    def _actors(self):
        c = self.conn
        for aid, name, role in [
            ("w", "物业", "property"),
            ("r", "维修", "repair"),
            ("n", "协商员", "negotiator"),
            ("d", "楼下陈", "resident"),
            ("u", "楼上周", "resident"),
        ]:
            c.execute("INSERT INTO actors(id,name,role,unit_id,created_at)"
                      " VALUES(?,?,?,?, '2026-09-20 08:30:00')", (aid, name, role, None))

    def _open_case(self):
        with dbmod.tx(self.conn):
            cid = self.st.register_case(
                "w", "T-1", "测试渗漏", "测试地址",
                location="楼下顶板", happened_at="2026-09-19 22:00:00",
                damaged_parts=["顶板"],
                descriptions={"down": "滴水", "up": "不知情", "property": "登记"},
                ts="2026-09-20 08:40:00")
            self.u_down = self.st.add_unit(cid, 5, "501", "东", "downstairs", "楼下陈", "1")
            self.u_up = self.st.add_unit(cid, 6, "601", "东", "upstairs", "楼上周", "2")
            self.conn.execute("UPDATE actors SET unit_id=? WHERE id='d'", (self.u_down,))
            self.conn.execute("UPDATE actors SET unit_id=? WHERE id='u'", (self.u_up,))
            # 一张公共照片
            self.e1 = self.st.create_evidence(cid, "r", "公共漏点照", "all")
            self.st.add_evidence_version(
                cid, self.e1, "r", "p.png", 100, 100,
                "2026-09-20 09:00:00", "inspection", "公共", ts="2026-09-20 09:05:00")
        return cid

    def _opinion(self, tags=None, actor="n", ts="2026-09-21 09:00:00"):
        with dbmod.tx(self.conn):
            return self.st.add_opinion(
                self.cid, actor, tags or ["source_unlocated"],
                {"unknown": 100}, "阶段性意见", ts=ts)

    # ---------- 1. 证据版本 ----------
    def test_opinion_freezes_snapshot_new_evidence_triggers_renegotiation(self):
        oid = self._opinion()
        # 旧意见快照在 seq=1
        o = self.conn.execute("SELECT * FROM opinions WHERE id=?", (oid,)).fetchone()
        self.assertEqual(o["snapshot_seq"], 1)
        self.assertEqual(len(__import__("json").loads(o["citations"])), 1)

        # 出具新证据（seq=2），旧意见内容不变，且能检测到快照后的新证据
        with dbmod.tx(self.conn):
            e2 = self.st.create_evidence(self.cid, "r", "新排查照", "all")
            self.st.add_evidence_version(
                self.cid, e2, "r", "p2.png", 100, 100,
                "2026-09-22 14:00:00", "inspection", "新发现", ts="2026-09-22 14:10:00")

        o_after = self.conn.execute("SELECT * FROM opinions WHERE id=?", (oid,)).fetchone()
        self.assertEqual(o_after["snapshot_seq"], 1, "旧意见不得被新证据改写")
        newer = self.st.new_evidence_after_opinion(oid)
        self.assertEqual([v["version_seq"] for v in newer], [2])

        # 不能引用不存在的证据版本
        with self.assertRaises(DomainError):
            self.st.add_opinion(
                self.cid, "n", ["x"], {"unknown": 100}, "引用不存在版本",
                citations=[{"evidence_id": 999, "version_id": 999, "version_no": 1}],
                ts="2026-09-20 10:00:00")

        # 重新协商：新意见引用截至新快照的全部有效版本
        with dbmod.tx(self.conn):
            oid2 = self.st.add_opinion(
                self.cid, "n", ["upstairs_kitchen_valve"], {str(self.u_up): 100},
                "重新协商意见", ts="2026-09-23 09:00:00")
        o2 = self.conn.execute("SELECT * FROM opinions WHERE id=?", (oid2,)).fetchone()
        self.assertEqual(o2["snapshot_seq"], 2)
        self.assertEqual(len(__import__("json").loads(o2["citations"])), 2)
        # 旧意见仍然存在且仍为 submitted
        self.assertEqual(o_after["status"], "submitted")

    def test_misused_old_photo_is_marked_not_deleted(self):
        with dbmod.tx(self.conn):
            ev = self.st.create_evidence(self.cid, "w", "管根照", "all")
            vid = self.st.add_evidence_version(
                self.cid, ev, "w", "old.png", 80, 80,
                "2026-08-28 10:00:00", "inspection", "8 月旧照",
                ts="2026-09-20 16:00:00")
            self.st.mark_misused(self.cid, vid, "n",
                                 "拍摄早于本次渗漏，属误用", ts="2026-09-22 14:05:00")
        row = self.conn.execute("SELECT * FROM evidence_versions WHERE id=?", (vid,)).fetchone()
        self.assertEqual(row["status"], "misused")
        self.assertIn("误用", row["review_note"])
        # 物理记录仍在
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) n FROM evidence_versions WHERE id=?", (vid,)).fetchone()["n"], 1)
        # 误用版本不会被自动收录进新意见引用
        with dbmod.tx(self.conn):
            oid = self.st.add_opinion(self.cid, "n", ["old_photo_misused"],
                                      {"unknown": 100}, "剔除旧照", ts="2026-09-23 09:00:00")
        cites = __import__("json").loads(
            self.conn.execute("SELECT citations FROM opinions WHERE id=?", (oid,)).fetchone()["citations"])
        self.assertNotIn(vid, [c["version_id"] for c in cites])

    # ---------- 2. 跨户隐私 ----------
    def test_cross_household_privacy(self):
        with dbmod.tx(self.conn):
            # 楼上下户各自的私域照片 + 一张公共照
            up = self.st.create_evidence(self.cid, "r", "楼上橱柜内部",
                                         visibility=f"unit:{self.u_up}", owner_unit=self.u_up)
            self.st.add_evidence_version(
                self.cid, up, "r", "up.png", 50, 50,
                "2026-09-22 14:00:00", "inspection", "楼上私域", ts="2026-09-22 14:05:00")
            dn = self.st.create_evidence(self.cid, "r", "楼下家具受损",
                                         visibility=f"unit:{self.u_down}", owner_unit=self.u_down)
            self.st.add_evidence_version(
                self.cid, dn, "r", "dn.png", 50, 50,
                "2026-09-20 10:00:00", "inspection", "楼下私域", ts="2026-09-20 10:05:00")

        def ids(actor):
            return {v["evidence_id"] for v in self.st.visible_evidence(self.cid, actor)}

        self.assertEqual(ids("u"), {self.e1, up})       # 楼上：公共 + 本户
        self.assertEqual(ids("d"), {self.e1, dn})       # 楼下：公共 + 本户
        self.assertEqual(ids("r"), {self.e1, up, dn})   # 维修可见全部
        self.assertEqual(ids("w"), {self.e1, up, dn})   # 物业可见全部
        self.assertEqual(ids("n"), {self.e1, up, dn})   # 协商员可见全部

    # ---------- 3. 方案签署冲突 ----------
    def _signed_plan_setup(self):
        """意见 + 双方可签的方案，返回 plan_id。"""
        oid = self._opinion()
        return self.st.create_plan(
            self.cid, "n", oid, "测试方案",
            [{"unit_id": self.u_up, "category": "repair", "item": "维修",
              "amount_fen": 10000, "basis": "意见引用"}],
            ts="2026-09-21 10:00:00")

    def test_sign_conflict_and_duplicate_and_superseded(self):
        with dbmod.tx(self.conn):
            pid = self._signed_plan_setup()
            # 楼下同意
            self.assertEqual(self.st.sign_plan(pid, "d", "sign", "同意",
                                               ts="2026-09-21 10:30:00"), "proposed")
            # 楼上拒绝 → disputed
            self.assertEqual(self.st.sign_plan(pid, "u", "reject", "费用不认可",
                                               ts="2026-09-21 11:00:00"), "disputed")
            # 同一户不能就同一版本重复签署
            with self.assertRaises(DomainError):
                self.st.sign_plan(pid, "u", "sign", "改主意", ts="2026-09-21 12:00:00")
            # 非住户不能签
            with self.assertRaises(DomainError):
                self.st.sign_plan(pid, "r", "sign", None, ts="2026-09-21 12:05:00")

            # 协商员出新版 → 旧版 superseded，旧版永不可签
            oid = self.conn.execute("SELECT id FROM opinions ORDER BY seq LIMIT 1").fetchone()["id"]
            pid2 = self.st.create_plan(
                self.cid, "n", oid, "调整后方案",
                [{"unit_id": self.u_up, "category": "repair", "item": "维修折减",
                  "amount_fen": 8000, "basis": "重新协商"}],
                ts="2026-09-22 09:00:00")
            self.assertEqual(self.conn.execute(
                "SELECT status FROM plans WHERE id=?", (pid,)).fetchone()["status"], "superseded")
            with self.assertRaises(DomainError):
                self.st.sign_plan(pid, "d", "sign", None, ts="2026-09-22 09:30:00")

            # 新版双方签署 → signed
            self.st.sign_plan(pid2, "d", "sign", None, ts="2026-09-22 10:00:00")
            final = self.st.sign_plan(pid2, "u", "sign", None, ts="2026-09-22 10:30:00")
            self.assertEqual(final, "signed")
            # 已完成版本也不能再签
            with self.assertRaises(DomainError):
                self.st.sign_plan(pid2, "d", "sign", None, ts="2026-09-22 11:00:00")

    def test_repair_cannot_approve_compensation(self):
        with dbmod.tx(self.conn):
            oid = self._opinion()
            # 勘查人拟含赔偿项的方案 → 拒绝
            with self.assertRaises(DomainError):
                self.st.create_plan(
                    self.cid, "r", oid, "勘查人自己批赔偿",
                    [{"unit_id": self.u_up, "category": "compensation", "item": "赔偿",
                      "amount_fen": 50000, "basis": "无"}], ts="2026-09-21 10:00:00")
            # 勘查人可以拟纯维修项
            pid = self.st.create_plan(
                self.cid, "r", oid, "仅维修",
                [{"unit_id": self.u_up, "category": "repair", "item": "换阀",
                  "amount_fen": 10000, "basis": "排查"}], ts="2026-09-21 10:05:00")
            self.assertTrue(pid > 0)

    def test_cannot_modify_counterpart_statement(self):
        with dbmod.tx(self.conn):
            sid_d = self.st.add_statement(
                self.cid, "d", "楼下：三个房间都在漏", unit_id=self.u_down,
                ts="2026-09-20 09:00:00")
            # 楼上试图改楼下陈述
            with self.assertRaises(DomainError):
                self.st.correct_statement(self.cid, "u", sid_d, "楼上代写：其实没漏",
                                          ts="2026-09-20 09:10:00")
            # 物业也不能改住户陈述
            with self.assertRaises(DomainError):
                self.st.correct_statement(self.cid, "w", sid_d, "物业代写",
                                          ts="2026-09-20 09:12:00")
            # 本人可以追加更正，原记录保留
            sid_new = self.st.correct_statement(
                self.cid, "d", sid_d, "楼下更正：主卧最严重",
                ts="2026-09-20 09:20:00")
            self.assertNotEqual(sid_new, sid_d)
            self.assertEqual(self.conn.execute(
                "SELECT content FROM statements WHERE id=?", (sid_d,)).fetchone()["content"],
                "楼下：三个房间都在漏")
            self.assertEqual(self.conn.execute(
                "SELECT corrects_id FROM statements WHERE id=?", (sid_new,)).fetchone()["corrects_id"],
                sid_d)
            # 住户不能替对方户新增陈述
            with self.assertRaises(DomainError):
                self.st.add_statement(self.cid, "u", "楼上替楼下说没事",
                                      unit_id=self.u_down, ts="2026-09-20 09:30:00")

    def test_repair_requires_signed_plan(self):
        with dbmod.tx(self.conn):
            oid = self._opinion()
            pid = self.st.create_plan(
                self.cid, "n", oid, "未签署方案",
                [{"unit_id": self.u_up, "category": "repair", "item": "维修",
                  "amount_fen": 10000, "basis": "x"}], ts="2026-09-21 10:00:00")
            with self.assertRaises(DomainError):
                self.st.start_repair(self.cid, "w", pid, "维修", "队",
                                     "2026-09-22 09:00:00", ts="2026-09-22 09:05:00")

    def test_notification_receipt_is_idempotent_per_recipient(self):
        with dbmod.tx(self.conn):
            nid = self.st.notify(self.cid, "d", "请查看预约", ts="2026-09-20 12:00:00")
            self.st.acknowledge(nid, "d", ts="2026-09-20 12:05:00")
            # 重复签收被拒
            with self.assertRaises(DomainError):
                self.st.acknowledge(nid, "d", ts="2026-09-20 12:06:00")
            # 非收件人不能代签
            with self.assertRaises(DomainError):
                self.st.acknowledge(nid, "u", ts="2026-09-20 12:07:00")

    # ---------- 4. 复验后再开案 ----------
    def test_reinspection_fail_reopens_and_history_preserved(self):
        with dbmod.tx(self.conn):
            oid = self._opinion(tags=["upstairs_kitchen_valve"], ts="2026-09-21 09:00:00")
            pid = self.st.create_plan(
                self.cid, "n", oid, "首轮方案",
                [{"unit_id": self.u_up, "category": "repair", "item": "换角阀",
                  "amount_fen": 10000, "basis": "意见"}],
                ts="2026-09-21 10:00:00")
            self.st.sign_plan(pid, "d", "sign", None, ts="2026-09-21 10:30:00")
            self.st.sign_plan(pid, "u", "sign", None, ts="2026-09-21 11:00:00")
            rid = self.st.start_repair(self.cid, "w", pid, "换角阀", "队",
                                       "2026-09-22 09:00:00", ts="2026-09-22 09:05:00")
            self.st.finish_repair(rid, "w", "2026-09-23 17:00:00", ts="2026-09-23 17:10:00")

            # 复验失败：复漏 → reopened，轮次 +1
            self.st.reinspect(self.cid, rid, "r", "fail", True,
                              "原位上方仍有新水珠，判定复漏且为不同水源",
                              "2026-09-26 10:00:00", ts="2026-09-26 10:20:00")
        case = self.conn.execute("SELECT * FROM cases WHERE id=?", (self.cid,)).fetchone()
        self.assertEqual(case["status"], "reopened")
        self.assertEqual(case["round_no"], 2)
        # 旧意见、旧方案、旧签署均保留
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) n FROM opinions WHERE case_id=? AND round_no=1",
            (self.cid,)).fetchone()["n"], 1)
        self.assertEqual(self.conn.execute(
            "SELECT status FROM plans WHERE id=?", (pid,)).fetchone()["status"], "signed")
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) n FROM signatures WHERE plan_id=?", (pid,)).fetchone()["n"], 2)

        with dbmod.tx(self.conn):
            # 第二轮：新证据 → 新意见 → 新方案 → 修复 → 复验通过
            e2 = self.st.create_evidence(self.cid, "r", "卫生间闭水照", "all")
            self.st.add_evidence_version(
                self.cid, e2, "r", "wt.png", 120, 90,
                "2026-09-27 09:00:00", "water_test", "闭水复现渗漏",
                ts="2026-09-27 09:30:00")
            oid2 = self.st.add_opinion(
                self.cid, "n", ["releak_after_repair", "bathroom_waterproofing"],
                {str(self.u_up): 100}, "第二轮意见：防水层",
                ts="2026-09-28 09:00:00")
            pid2 = self.st.create_plan(
                self.cid, "n", oid2, "防水重做",
                [{"unit_id": self.u_up, "category": "repair", "item": "防水重做",
                  "amount_fen": 30000, "basis": "闭水照"}],
                ts="2026-09-28 10:00:00")
            self.st.sign_plan(pid2, "d", "sign", None, ts="2026-09-28 10:30:00")
            self.st.sign_plan(pid2, "u", "sign", None, ts="2026-09-28 11:00:00")
            rid2 = self.st.start_repair(self.cid, "w", pid2, "防水重做", "队",
                                        "2026-09-29 09:00:00", ts="2026-09-29 09:10:00")
            self.st.finish_repair(rid2, "w", "2026-09-30 17:00:00", ts="2026-09-30 17:10:00")
            self.st.reinspect(self.cid, rid2, "r", "pass", False,
                              "48 小时闭水无渗漏",
                              "2026-10-02 10:00:00", ts="2026-10-02 10:20:00")
        case2 = self.conn.execute("SELECT * FROM cases WHERE id=?", (self.cid,)).fetchone()
        self.assertEqual(case2["status"], "resolved")
        self.assertEqual(case2["round_no"], 2)
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) n FROM reinspections WHERE case_id=?",
            (self.cid,)).fetchone()["n"], 2)
        # 两轮意见都在
        self.assertEqual([r["round_no"] for r in self.conn.execute(
            "SELECT DISTINCT round_no FROM opinions WHERE case_id=? ORDER BY round_no",
            (self.cid,))], [1, 2])

    # ---------- 事件链 ----------
    def test_event_hash_chain(self):
        self._opinion()
        self.assertTrue(self.st.verify_chain(self.cid))
        # 篡改任意一条事件 payload → 校验失败
        self.conn.execute("UPDATE events SET payload='{\"tampered\":true}' WHERE seq=1")
        self.conn.commit()
        self.assertFalse(self.st.verify_chain(self.cid))


class SeedCaseTest(unittest.TestCase):
    """种子复漏案例的端到端不变量。"""

    def test_seed_invariants(self):
        from leakflow.seed import build, CASE_CODE
        tmp = tempfile.mkdtemp(prefix="leakflow-seed-")
        try:
            dbp = os.path.join(tmp, "s.db")
            photos = os.path.join(tmp, "photos")
            cid = build(dbp, photos)
            conn = dbmod.connect(dbp)
            st = Store(conn, photos)
            try:
                # 哈希链
                self.assertTrue(st.verify_chain(cid))
                case = conn.execute("SELECT * FROM cases WHERE id=?", (cid,)).fetchone()
                self.assertEqual(case["code"], CASE_CODE)
                self.assertEqual(case["status"], "resolved")
                self.assertEqual(case["round_no"], 2)  # 经历复漏再开案

                # 六类“不同结论”标签全部保留在历史意见中
                tags = set()
                for r in conn.execute("SELECT conclusion_tags FROM opinions"):
                    tags.update(__import__("json").loads(r["conclusion_tags"]))
                for t in ["source_unlocated", "multi_room_leak", "upstairs_refused_entry",
                          "old_photo_misused", "releak_after_repair", "fee_disputed"]:
                    self.assertIn(t, tags, f"缺少结论标签 {t}")

                # 旧照片误用保留 + 新照片有效
                self.assertIsNotNone(conn.execute(
                    "SELECT 1 FROM evidence_versions WHERE status='misused'").fetchone())
                self.assertIsNotNone(conn.execute(
                    "SELECT 1 FROM evidence_versions WHERE status='valid'").fetchone())

                # 拒绝入户被记录
                self.assertIsNotNone(conn.execute(
                    "SELECT 1 FROM appointments WHERE status='refused'").fetchone())

                # 复验一次失败一次通过
                self.assertEqual([r["result"] for r in conn.execute(
                    "SELECT result FROM reinspections ORDER BY id")], ["fail", "pass"])

                # 方案 v1/v2 被新版本取代，v3/v4 签署
                self.assertEqual([r["status"] for r in conn.execute(
                    "SELECT status FROM plans ORDER BY version_no")],
                    ["superseded", "superseded", "signed", "signed"])

                # 照片文件全部真实落盘且为 PNG
                n = 0
                for r in conn.execute("SELECT DISTINCT photo_file FROM evidence_versions"):
                    p = os.path.join(photos, r["photo_file"])
                    self.assertTrue(os.path.isfile(p))
                    with open(p, "rb") as f:
                        self.assertEqual(f.read(8), b"\x89PNG\r\n\x1a\n")
                    n += 1
                self.assertGreaterEqual(n, 8)

                # 跨户隐私
                up = conn.execute("SELECT id FROM actors WHERE id='a_zhou'").fetchone()["id"]
                dn = conn.execute("SELECT id FROM actors WHERE id='a_chen'").fetchone()["id"]
                self.assertLess(len(st.visible_evidence(cid, up)),
                                len(st.visible_evidence(cid, "a_he")))
                self.assertLess(len(st.visible_evidence(cid, dn)),
                                len(st.visible_evidence(cid, "a_he")))
            finally:
                conn.close()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
