"""种子案例 LK-2026-0920-07：502 报修多房间渗漏，经拒入户、旧照误用、
费用分歧、修复闭环后复漏再开案，第二轮定位为卫生间防水层并复验通过。

时间戳全部固定，保证可重复演示与测试。
"""
from __future__ import annotations

import os
import shutil

from . import db as dbmod
from . import png as pngmod
from .services import Store, now_ts

CASE_CODE = "LK-2026-0920-07"


def _photo(photo_dir, name, w, h, spots, seed, base=(214, 222, 224), stain=(64, 86, 96)):
    path = os.path.join(photo_dir, name)
    pngmod.make_synthetic_photo(path, w, h, base=base, stain=stain, spots=spots, seed=seed)
    return name


def build(db_path: str, photo_dir: str, reset: bool = True) -> int:
    if reset:
        for p in (db_path, db_path + "-wal", db_path + "-shm"):
            if os.path.exists(p):
                os.remove(p)
        if os.path.isdir(photo_dir):
            shutil.rmtree(photo_dir)
        os.makedirs(photo_dir, exist_ok=True)

    conn = dbmod.connect(db_path)
    dbmod.init_db(conn)
    st = Store(conn, photo_dir)

    with dbmod.tx(conn):
        # ---- 人员 ----
        actors = [
            ("a_wuye", "林敏（物业管家）", "property", None),
            ("a_zhao", "赵德海（维修勘查）", "repair", None),
            ("a_he", "何平（协商员）", "negotiator", None),
            ("a_chen", "陈兰（502 报修方）", "resident", None),
            ("a_zhou", "周建国（602 住户）", "resident", None),
        ]
        for aid, name, role, unit in actors:
            conn.execute("INSERT INTO actors(id,name,role,unit_id,created_at)"
                         " VALUES(?,?,?,?,?)", (aid, name, role, unit, "2026-09-20 08:30:00"))

        # ---- 立案 ----
        case_id = st.register_case(
            "a_wuye", CASE_CODE, "502 室多房间顶板渗漏",
            "锦园小区 3 栋 2 单元",
            location="502 主卧顶板、次卧东墙、卫生间吊顶（三处同时渗漏）",
            happened_at="2026-09-19 22:30:00",
            damaged_parts=["主卧顶板涂层起泡", "次卧东墙墙皮脱落约 0.8㎡",
                           "卫生间吊顶积水", "主卧木地板起拱"],
            descriptions={
                "502": "19 日晚 10 点半发现主卧顶灯周围滴水，次卧墙角和卫生间吊顶同时有水痕。",
                "602": "最近一周很少在家做饭，没发现自家地面有水，怀疑是楼体外墙雨水。",
                "物业": "接报后先行登记，三处受损部位同时拍照，等待入户勘查。",
            },
            ts="2026-09-20 08:40:00")

        u_down = st.add_unit(case_id, floor_no=5, room_no="502", side="东",
                             role="downstairs", resident="陈兰", phone="138****0052",
                             scope_note="报修户：主卧、次卧、卫生间三处受损")
        u_up = st.add_unit(case_id, floor_no=6, room_no="602", side="东",
                           role="upstairs", resident="周建国", phone="139****0062",
                           scope_note="被排查户：厨房、卫生间、主卧位于受损部位上方")
        st.link_actor_unit("a_chen", u_down)
        st.link_actor_unit("a_zhou", u_up)
        conn.execute("UPDATE actors SET unit_id=? WHERE id='a_chen'", (u_down,))
        conn.execute("UPDATE actors SET unit_id=? WHERE id='a_zhou'", (u_up,))

        # ---- 各方陈述（不可改） ----
        st.add_statement(case_id, "a_wuye",
                         "现场登记三处受损部位：主卧顶板滴水、次卫东墙渗水、卫生间吊顶积水。",
                         ts="2026-09-20 08:45:00")
        st.add_statement(case_id, "a_chen",
                         "水是 19 号夜里 10 点半发现的，三个房间几乎同时出现，主卧最严重，灯都不敢开。",
                         unit_id=u_down, ts="2026-09-20 08:50:00")
        st.add_statement(case_id, "a_zhou",
                         "我家地上没水，最近也没怎么用水，凭什么说是我家漏的？不同意随便进门。",
                         unit_id=u_up, ts="2026-09-20 09:00:00")

        # ---- 第一次入户预约：602 拒绝 ----
        appt1 = st.create_appointment(case_id, "a_wuye", u_up,
                                      "2026-09-20 14:00:00", ts="2026-09-20 09:05:00")
        st.respond_appointment(appt1, "a_zhou", False,
                               "工作日家中无人，且认为与己无关，拒绝入户",
                               ts="2026-09-20 11:20:00")

        # ---- 关阀 + 502 室内排查 + 试水（无法定位） ----
        sg1 = st.add_stage(case_id, "a_zhao", "valve_off",
                           "2026-09-20 09:10:00", ended_at="2026-09-20 09:25:00",
                           result="still_seeping",
                           note="关闭 502 进水总阀后观察 15 分钟，顶板仍缓慢渗水，水源不在 502 户内管。",
                           ts="2026-09-20 09:26:00")
        sg2 = st.add_stage(case_id, "a_zhao", "inspection",
                           "2026-09-20 09:40:00", ended_at="2026-09-20 10:20:00",
                           result="multi_room_suspect_upstairs",
                           note="三间房受损面均位于楼板上方对应位置，因无法进入 602，暂不能定位具体水源。",
                           ts="2026-09-20 10:22:00")
        wt_stage = st.add_stage(case_id, "a_zhao", "water_test",
                                "2026-09-20 10:25:00", ended_at="2026-09-20 10:55:00",
                                result="inconclusive",
                                note="502 户内管线打压正常；上层无法配合，结论待定。",
                                ts="2026-09-20 10:56:00")
        st.add_water_test(case_id, wt_stage, "a_zhao", "户内打压+闭水观察", 30,
                          "inconclusive", "2026-09-20 10:55:00",
                          [{"room": "502 主卧", "result": "no_leak", "note": "打压 30 分钟不掉压"},
                           {"room": "502 卫生间", "result": "no_leak", "note": "闭水无下降"},
                           {"room": "602（未入户）", "result": "unknown", "note": "住户拒绝入户，无法试水"}],
                          ts="2026-09-20 10:58:00")

        # ---- 第一批证据（横/竖不同比例，测试前端保持原比例） ----
        e1 = st.create_evidence(case_id, "a_zhao", "502 主卧顶板水渍", "all")
        f1 = _photo(photo_dir, "e1_v1_master_ceiling.png", 640, 420,
                    [(0.45, 0.4, 0.26), (0.62, 0.55, 0.12)], seed=11)
        st.add_evidence_version(case_id, e1, "a_zhao", f1, 640, 420,
                                "2026-09-20 09:45:00", "inspection",
                                "主卧顶灯周围顶板水渍，边缘仍潮。",
                                ts="2026-09-20 09:48:00")
        st.add_annotation(e1, "a_zhao", 0.45, 0.40, "滴水点（灯座旁）", ts="2026-09-20 09:49:00")

        e2 = st.create_evidence(case_id, "a_zhao", "502 次卧东墙渗水（竖拍）", "all")
        f2 = _photo(photo_dir, "e2_v1_bedroom_wall.png", 480, 600,
                    [(0.5, 0.34, 0.22), (0.42, 0.62, 0.14)], seed=23)
        st.add_evidence_version(case_id, e2, "a_zhao", f2, 480, 600,
                                "2026-09-20 09:52:00", "inspection",
                                "次卧东墙由上向下水痕，墙皮脱落。",
                                ts="2026-09-20 09:55:00")
        st.add_annotation(e2, "a_zhao", 0.5, 0.33, "高位进水痕", ts="2026-09-20 09:56:00")

        e3 = st.create_evidence(case_id, "a_zhao", "502 卫生间吊顶积水", "all")
        f3 = _photo(photo_dir, "e3_v1_bath_ceiling.png", 600, 450,
                    [(0.35, 0.45, 0.2), (0.6, 0.4, 0.15)], seed=31)
        st.add_evidence_version(case_id, e3, "a_zhao", f3, 600, 450,
                                "2026-09-20 09:58:00", "inspection",
                                "卫生间铝扣板吊顶内有积水，拆开一角可见水珠。",
                                ts="2026-09-20 10:00:00")

        # 分户隐私证据：502 私域受损照，仅本户与工作人员可见
        e_priv_dn = st.create_evidence(case_id, "a_zhao", "502 主卧家具地板受损（私域）",
                                       visibility=f"unit:{u_down}", owner_unit=u_down)
        f_pd = _photo(photo_dir, "epriv_down_furniture.png", 600, 400,
                      [(0.4, 0.55, 0.2), (0.65, 0.45, 0.12)], seed=77,
                      base=(208, 200, 192), stain=(90, 78, 66))
        st.add_evidence_version(case_id, e_priv_dn, "a_zhao", f_pd, 600, 400,
                                "2026-09-20 10:05:00", "inspection",
                                "502 主卧起拱地板与床脚受潮情况，限本户及工作人员查看。",
                                ts="2026-09-20 10:08:00")

        # E4：后被证实误用的“旧照片”（8 月拍摄，色调偏旧）
        e4 = st.create_evidence(case_id, "a_wuye", "602 厨房管根照片", "all")
        f4old = _photo(photo_dir, "e4_v1_kitchen_old.png", 520, 390,
                       [(0.5, 0.55, 0.16)], seed=47,
                       base=(196, 192, 182), stain=(96, 92, 84))
        st.add_evidence_version(case_id, e4, "a_wuye", f4old, 520, 390,
                                "2026-08-28 10:12:00", "inspection",
                                "602 厨房给水管管根（注：此照片拍摄于 8 月 28 日）。",
                                ts="2026-09-20 16:10:00")

        # ---- 第一轮责任意见：水源未定 + 多房间 + 拒入户，多结论并存 ----
        op1 = st.add_opinion(
            case_id, "a_he",
            conclusion_tags=["source_unlocated", "multi_room_leak", "upstairs_refused_entry"],
            responsibility={"unknown": 100},
            rationale=("三处受损部位位于不同房间且同时出现，502 户内打压、闭水均不掉压；"
                       "602 拒绝入户导致上层管线无法排查，现阶段不能确定责任主体，"
                       "依据《民法典》相邻关系条款，建议在物业见证下再次预约入户勘查。"
                       "附 8 月 28 日 602 厨房管根旧照仅作位置参考，不得作为现状渗漏依据。"),
            ts="2026-09-21 09:00:00")

        # ---- 方案 v1：含赔偿项（协商员拟），602 不认可费用 ----
        plan1 = st.create_plan(
            case_id, "a_he", op1,
            "先行入户勘查 + 由 602 垫付维修与赔偿（待责任最终认定后多退少补）",
            [{"unit_id": u_up, "category": "inspection", "item": "三方入户勘查费",
              "amount_fen": 30000,
              "basis": "意见#1：上层为唯一未排查区域，需入户勘查"},
             {"unit_id": u_up, "category": "repair", "item": "预估管根维修（暂定）",
              "amount_fen": 80000,
              "basis": "意见#1：漏水方向指向上层，具体点位待查"},
             {"unit_id": u_up, "category": "compensation", "item": "502 顶板墙面修复补偿（暂定）",
              "amount_fen": 200000,
              "basis": "意见#1：三处受损部位照片 E1/E2/E3"}],
            ts="2026-09-21 10:00:00")
        st.sign_plan(plan1, "a_chen", "sign", "同意先修，金额按最终责任多退少补。",
                     ts="2026-09-21 10:30:00")
        st.sign_plan(plan1, "a_zhou", "reject",
                     "水源没定就让我全出？而且那张厨房照片明明是旧照片，不认可费用。",
                     ts="2026-09-21 15:10:00")
        n1 = st.notify(case_id, "a_he",
                       "602 拒绝方案 v1 并对照片真实性提出异议，请安排重新勘查与证据复核。",
                       ts="2026-09-21 15:12:00")
        st.acknowledge(n1, "a_he", ts="2026-09-21 15:20:00")

        # ---- 第二次预约：602 同意；旧照片被标记误用，重新拍摄 ----
        appt2 = st.create_appointment(case_id, "a_wuye", u_up,
                                      "2026-09-22 14:00:00", ts="2026-09-21 16:00:00")
        st.respond_appointment(appt2, "a_zhou", True, ts="2026-09-22 09:30:00")

        # 旧照误用：保留记录但标记 misused，不删除
        v_old = conn.execute("SELECT id FROM evidence_versions WHERE evidence_id=? "
                             "ORDER BY version_no LIMIT 1", (e4,)).fetchone()["id"]
        st.mark_misused(case_id, v_old, "a_he",
                        "该照片拍摄于 2026-08-28，早于本次渗漏（09-19），不能作为现状证据。",
                        ts="2026-09-22 14:05:00")

        sg3 = st.add_stage(case_id, "a_zhao", "inspection",
                           "2026-09-22 14:10:00", ended_at="2026-09-22 15:00:00",
                           result="leak_located_kitchen_valve",
                           note="入户后发现厨房水槽下角阀接口缓慢渗水，地面积水沿楼板线管缝隙下流。",
                           ts="2026-09-22 15:02:00")
        conn.execute("UPDATE appointments SET status='done' WHERE id=?", (appt2,))
        f4new = _photo(photo_dir, "e4_v2_kitchen_valve.png", 520, 390,
                       [(0.52, 0.5, 0.18)], seed=52,
                       base=(208, 214, 216), stain=(54, 80, 92))
        st.add_evidence_version(case_id, e4, "a_zhao", f4new, 520, 390,
                                "2026-09-22 14:20:00", "inspection",
                                "602 厨房角阀接口现状：可见缓慢滴水与水垢。",
                                ts="2026-09-22 14:25:00",
                                mark_previous="keep")
        st.add_annotation(e4, "a_zhao", 0.52, 0.5, "角阀渗漏点", ts="2026-09-22 14:26:00")

        # 分户隐私证据：602 橱柜内部（含私人物品），仅本户与工作人员可见
        e_priv_up = st.create_evidence(case_id, "a_zhao", "602 厨房橱柜内部（含私人物品）",
                                       visibility=f"unit:{u_up}", owner_unit=u_up)
        f_pu = _photo(photo_dir, "epriv_up_cabinet.png", 560, 420,
                      [(0.48, 0.5, 0.18)], seed=71,
                      base=(202, 208, 210), stain=(58, 82, 92))
        st.add_evidence_version(case_id, e_priv_up, "a_zhao", f_pu, 560, 420,
                                "2026-09-22 14:30:00", "inspection",
                                "602 橱柜内部漏水痕迹，画面含住户私人物品，限本户及工作人员查看。",
                                ts="2026-09-22 14:32:00")

        e5 = st.create_evidence(case_id, "a_zhao", "602 厨房打压试水记录", "all")
        f5 = _photo(photo_dir, "e5_v1_pressure_gauge.png", 600, 400,
                    [(0.5, 0.5, 0.1)], seed=66,
                    base=(222, 226, 228), stain=(70, 96, 110))
        st.add_evidence_version(case_id, e5, "a_zhao", f5, 600, 400,
                                "2026-09-22 14:50:00", "water_test",
                                "厨房给水管打压 30 分钟掉压 0.08MPa，角阀位置复现渗水。",
                                ts="2026-09-22 15:05:00")
        sg4 = st.add_stage(case_id, "a_zhao", "water_test",
                           "2026-09-22 14:35:00", ended_at="2026-09-22 15:05:00",
                           result="leak",
                           note="分段打压定位：厨房角阀段掉压，其余管段正常。",
                           ts="2026-09-22 15:06:00")
        st.add_water_test(case_id, sg4, "a_zhao", "分段打压", 30, "leak",
                          "2026-09-22 15:00:00",
                          [{"room": "602 厨房角阀段", "result": "leak",
                            "note": "30 分钟掉压 0.08MPa，目视复现滴水"},
                           {"room": "602 卫生间管段", "result": "no_leak",
                            "note": "当时打压未掉压（注：防水层未做闭水）"}],
                          ts="2026-09-22 15:08:00")

        # ---- 新证据触发第二轮协商（旧意见 #1 不被改写） ----
        op2 = st.add_opinion(
            case_id, "a_he",
            conclusion_tags=["upstairs_kitchen_valve", "multi_room_leak",
                             "old_photo_misused", "fee_disputed"],
            responsibility={str(u_up): 100},
            rationale=("602 入户勘查及分段打压确认厨房角阀接口渗漏，水源明确，对应 502 主卧及卫生间受损；"
                       "8 月 28 日旧照已被认定为误用并剔除（见证据 E4-v1 misused 记录），"
                       "本意见仅引用 E4-v2、E5-v1 及 502 室内 E1-E3。次卧水痕来源建议维修后观察。"),
            ts="2026-09-23 09:30:00")

        # 方案 v2：502 接受，602 仍不认可赔偿金额 → disputed
        plan2 = st.create_plan(
            case_id, "a_he", op2,
            "602 更换厨房角阀并承担 502 顶面墙面修复，赔偿金额协商中",
            [{"unit_id": u_up, "category": "repair", "item": "更换 602 厨房角阀及接口",
              "amount_fen": 120000, "basis": "意见#2：打压定位角阀渗漏（E5-v1）"},
             {"unit_id": u_up, "category": "repair", "item": "502 主卧/卫生间顶面修复",
              "amount_fen": 90000, "basis": "意见#2：受损照片 E1、E3"},
             {"unit_id": u_up, "category": "compensation", "item": "502 墙面与地板补偿",
              "amount_fen": 150000, "basis": "意见#2：E2 墙皮脱落、木地板起拱"}],
            ts="2026-09-23 10:00:00")
        st.sign_plan(plan2, "a_chen", "sign", "认可责任认定，补偿可以再谈。",
                     ts="2026-09-23 10:30:00")
        st.sign_plan(plan2, "a_zhou", "reject",
                     "角阀我认，但 1500 元补偿太高，次卧那面墙说不定是老印子。",
                     ts="2026-09-23 11:00:00")

        # 方案 v3：协商员调整金额，双方签署
        plan3 = st.create_plan(
            case_id, "a_he", op2,
            "维修照价、补偿按实际受损面积折减，次卧列入修复后观察复验",
            [{"unit_id": u_up, "category": "repair", "item": "更换 602 厨房角阀及接口",
              "amount_fen": 120000, "basis": "意见#2：E5-v1 打压掉压"},
             {"unit_id": u_up, "category": "repair", "item": "502 主卧/卫生间顶面修复",
              "amount_fen": 90000, "basis": "意见#2：E1、E3"},
             {"unit_id": u_up, "category": "compensation", "item": "次卧墙面补偿（按 0.8㎡ 折减）",
              "amount_fen": 80000, "basis": "意见#2：E2 标注面积，双方现场确认"},
             {"unit_id": None, "category": "inspection", "item": "修复后闭水复验（观察期 3 天）",
              "amount_fen": 0, "basis": "意见#2：次卧水源待观察，复验免费"}],
            ts="2026-09-24 09:00:00")
        st.sign_plan(plan3, "a_chen", "sign", "同意折减金额，要求 3 天后复验次卧。",
                     ts="2026-09-24 09:30:00")
        st.sign_plan(plan3, "a_zhou", "sign", "角阀和补偿都接受，配合维修与复验。",
                     ts="2026-09-24 10:00:00")

        # ---- 第一轮修复 + 复验失败（复漏）→ 再开案 ----
        r1 = st.start_repair(case_id, "a_wuye", plan3,
                             "更换厨房角阀及波纹管；502 主卧、卫生间顶面修补；次卧墙面铲除重批。",
                             "安居修缮队", "2026-09-25 09:00:00", ts="2026-09-25 09:05:00")
        st.finish_repair(r1, "a_wuye", "2026-09-26 17:30:00", ts="2026-09-26 17:35:00")
        st.reinspect(case_id, r1, "a_zhao", "fail", True,
                     "复验时 502 次卧东墙原位置上方仍有新水珠，沿楼板裂缝下渗；"
                     "关闭厨房角阀后滴水不停，判定复漏且为不同水源，"
                     "初步指向上层 602 卫生间防水层（首轮仅打压未做闭水）。",
                     "2026-09-29 10:00:00", ts="2026-09-29 10:20:00")

        # ---- 第二轮（round_no=2）：新证据、新意见、新方案，旧结论全部保留 ----
        e6 = st.create_evidence(case_id, "a_zhao", "602 卫生间闭水试验（复漏排查）", "all")
        f6 = _photo(photo_dir, "e6_v1_bath_water_test.png", 640, 480,
                    [(0.45, 0.5, 0.24), (0.66, 0.42, 0.1)], seed=83,
                    base=(206, 216, 220), stain=(44, 84, 102))
        st.add_evidence_version(case_id, e6, "a_zhao", f6, 640, 480,
                                "2026-09-30 09:40:00", "water_test",
                                "602 卫生间蓄水 5cm，2 小时后 502 次卧顶板对应位置出现新水珠。",
                                ts="2026-09-30 10:00:00")
        st.add_annotation(e6, "a_zhao", 0.45, 0.5, "闭水区下渗点", ts="2026-09-30 10:01:00")

        sg5 = st.add_stage(case_id, "a_zhao", "water_test",
                           "2026-09-30 09:00:00", ended_at="2026-09-30 11:30:00",
                           result="leak",
                           note="闭水试验确认复漏来自 602 卫生间防水层，与已修复的厨房角阀无关。",
                           ts="2026-09-30 11:35:00")
        st.add_water_test(case_id, sg5, "a_zhao", "卫生间闭水试验", 150, "leak",
                          "2026-09-30 11:30:00",
                          [{"room": "602 卫生间", "result": "leak",
                            "note": "蓄水 2 小时楼下对应位置现新水珠"},
                           {"room": "602 厨房（已修）", "result": "no_leak",
                            "note": "角阀更换后干燥，排除"}],
                          ts="2026-09-30 11:40:00")

        e7 = st.create_evidence(case_id, "a_zhao", "502 次卧复漏点（竖拍）", "all")
        f7 = _photo(photo_dir, "e7_v1_releak_point.png", 460, 600,
                    [(0.5, 0.3, 0.2), (0.47, 0.52, 0.13)], seed=91,
                    base=(205, 212, 214), stain=(52, 72, 84))
        st.add_evidence_version(case_id, e7, "a_zhao", f7, 460, 600,
                                "2026-09-30 11:50:00", "reinspection",
                                "复验后复漏：次卧东墙老位置上方新水珠，与 09-20 照片位置重合但水源不同。",
                                ts="2026-09-30 12:00:00")
        st.add_annotation(e7, "a_zhao", 0.5, 0.3, "复漏滴水点", ts="2026-09-30 12:01:00")

        op3 = st.add_opinion(
            case_id, "a_he",
            conclusion_tags=["releak_after_repair", "bathroom_waterproofing",
                             "distinct_from_first_source"],
            responsibility={str(u_up): 100},
            rationale=("复验发现复漏，闭水试验确认水源为 602 卫生间防水层失效，"
                       "与第一轮厨房角阀渗漏（已修复，E5/E4-v2）非同一水源；"
                       "首轮意见与方案保留有效，不溯及修改。本轮引用 E6-v1、E7-v1。"),
            ts="2026-10-01 09:00:00")

        plan4 = st.create_plan(
            case_id, "a_he", op3,
            "602 卫生间整体防水重做 + 502 次卧顶棚修复 + 复漏期间补偿",
            [{"unit_id": u_up, "category": "repair", "item": "602 卫生间防水铲除重做（含闭水）",
              "amount_fen": 350000, "basis": "意见#3：E6-v1 闭水复现渗漏"},
             {"unit_id": u_up, "category": "repair", "item": "502 次卧顶板墙面二次修复",
              "amount_fen": 60000, "basis": "意见#3：E7-v1 复漏点"},
             {"unit_id": u_up, "category": "compensation", "item": "复漏期间住宿补偿（3 晚）",
              "amount_fen": 50000, "basis": "意见#3：复验失败导致工期延长"}],
            ts="2026-10-01 10:00:00")
        st.sign_plan(plan4, "a_chen", "sign", "认可二次责任认定，要求完工后再做一次闭水复验。",
                     ts="2026-10-01 10:30:00")
        st.sign_plan(plan4, "a_zhou", "sign", "防水我家做，这次一定修好，同意补偿。",
                     ts="2026-10-01 11:00:00")

        r2 = st.start_repair(case_id, "a_wuye", plan4,
                             "602 卫生间瓷砖铲除、防水层重做并 48 小时闭水；502 次卧二次修补。",
                             "安居修缮队", "2026-10-01 13:00:00", ts="2026-10-01 13:10:00")
        st.finish_repair(r2, "a_wuye", "2026-10-02 11:00:00", ts="2026-10-02 11:10:00")
        st.reinspect(case_id, r2, "a_zhao", "pass", False,
                     "48 小时闭水无渗漏，502 三个房间顶板干燥，复漏点未再出现，复验通过。",
                     "2026-10-02 15:00:00", ts="2026-10-02 15:20:00")

        # 结案通知与签收
        n2 = st.notify(case_id, "a_chen",
                       "案件复验通过已结案：两轮修复均已完成，如有新渗漏可凭案号再开案。",
                       ts="2026-10-02 15:25:00")
        st.acknowledge(n2, "a_chen", ts="2026-10-02 15:40:00")
        n3 = st.notify(case_id, "a_zhou", "案件复验通过已结案，感谢配合。",
                       ts="2026-10-02 15:26:00")
        st.acknowledge(n3, "a_zhou", ts="2026-10-02 15:45:00")

    conn.close()
    return case_id


if __name__ == "__main__":
    import sys
    base = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "data")
    cid = build(os.path.join(base, "leakflow.db"), os.path.join(base, "photos"))
    print(f"seeded case id={cid} code={CASE_CODE}")
