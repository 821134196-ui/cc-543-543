"""零依赖 HTTP 服务：案件只读视图模型 + 少量动作接口 + 本地照片/静态资源。

启动：python -m leakflow.server --db ... --photos ... --port 8000
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import posixpath
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from . import db as dbmod
from .services import Store, DomainError

WEB_DIR = os.path.join(os.path.dirname(__file__), "web")


def _row(r):
    return dict(r) if r is not None else None


class CaseView:
    """组装详情页视图模型；按 actor 做跨户隐私过滤。"""

    def __init__(self, conn, case_id: int, actor_id: str | None):
        self.c = conn
        self.case_id = case_id
        self.actor_id = actor_id
        self.st = Store(conn, "")

    def build(self) -> dict:
        c = self.c
        cid = self.case_id
        case = _row(c.execute("SELECT * FROM cases WHERE id=?", (cid,)).fetchone())

        units = [dict(r) for r in c.execute(
            "SELECT * FROM units WHERE case_id=? ORDER BY floor_no DESC, id", (cid,))]
        actors = [dict(r) for r in c.execute(
            "SELECT id,name,role,unit_id FROM actors ORDER BY "
            "CASE role WHEN 'property' THEN 0 WHEN 'repair' THEN 1 "
            "WHEN 'negotiator' THEN 2 ELSE 3 END, id")]

        statements = [dict(r) for r in c.execute(
            "SELECT s.*, a.name AS author_name, a.role AS author_role, u.room_no AS room_no"
            " FROM statements s JOIN actors a ON a.id=s.author_id"
            " LEFT JOIN units u ON u.id=s.unit_id"
            " WHERE s.case_id=? ORDER BY s.id", (cid,))]

        appointments = [dict(r) for r in c.execute(
            "SELECT ap.*, u.room_no, u.resident FROM appointments ap"
            " JOIN units u ON u.id=ap.unit_id WHERE ap.case_id=? ORDER BY ap.id", (cid,))]

        stages = [dict(r) for r in c.execute(
            "SELECT w.*, a.name AS operator_name FROM work_stages w"
            " JOIN actors a ON a.id=w.operator_id WHERE w.case_id=? ORDER BY w.seq", (cid,))]
        tests = [dict(r, points=json.loads(r["points"])) for r in c.execute(
            "SELECT t.* FROM water_tests t WHERE t.case_id=? ORDER BY t.id", (cid,))]

        # 证据（按操作人隐私过滤）
        if self.actor_id:
            visible_rows = self.st.visible_evidence(cid, self.actor_id)
            visible_ids = {r["id"] for r in visible_rows}
            visible_ev_ids = {r["evidence_id"] for r in visible_rows}
        else:
            visible_ids = None
            visible_ev_ids = None
        evidence_all = [dict(r) for r in c.execute(
            "SELECT * FROM evidence WHERE case_id=? ORDER BY id", (cid,))]
        versions_all = [dict(r) for r in c.execute(
            "SELECT * FROM evidence_versions WHERE case_id=? ORDER BY version_seq, id", (cid,))]
        anns = [dict(r) for r in c.execute(
            "SELECT an.* FROM annotations an JOIN evidence e ON e.id=an.evidence_id"
            " WHERE e.case_id=? ORDER BY an.id", (cid,))]
        ann_map = {}
        for a in anns:
            ann_map.setdefault(a["evidence_id"], []).append(a)

        total_versions = len(versions_all)
        evidence = []
        for e in evidence_all:
            if visible_ev_ids is not None and e["id"] not in visible_ev_ids:
                continue
            ev = dict(e)
            ev["versions"] = []
            for v in versions_all:
                if v["evidence_id"] != e["id"]:
                    continue
                if visible_ids is not None and v["id"] not in visible_ids:
                    continue
                vv = dict(v)
                vv["annotations"] = ann_map.get(e["id"], [])
                ev["versions"].append(vv)
            evidence.append(ev)
        hidden_versions = (total_versions -
                           sum(len(ev["versions"]) for ev in evidence)) if visible_ids else 0

        opinions = [dict(r, citations=json.loads(r["citations"]),
                         conclusion_tags=json.loads(r["conclusion_tags"]),
                         responsibility=json.loads(r["responsibility"]))
                    for r in c.execute("SELECT * FROM opinions WHERE case_id=? ORDER BY seq", (cid,))]
        for o in opinions:
            newer = [dict(r) for r in c.execute(
                "SELECT v.id,v.evidence_id,v.version_no,v.version_seq,v.stage,v.caption,v.status,"
                "v.taken_at,v.uploaded_at FROM evidence_versions v"
                " WHERE v.case_id=? AND v.version_seq>? ORDER BY v.version_seq",
                (cid, o["snapshot_seq"])).fetchall()]
            o["new_evidence_after_snapshot"] = newer

        plans = [dict(r) for r in c.execute(
            "SELECT * FROM plans WHERE case_id=? ORDER BY version_no", (cid,))]
        for p in plans:
            p["items"] = [dict(r) for r in c.execute(
                "SELECT pi.*, u.room_no AS unit_no FROM plan_items pi"
                " LEFT JOIN units u ON u.id=pi.unit_id WHERE pi.plan_id=? ORDER BY pi.id",
                (p["id"],))]
            p["signatures"] = [dict(r) for r in c.execute(
                "SELECT sg.*, u.room_no FROM signatures sg JOIN units u ON u.id=sg.unit_id"
                " WHERE sg.plan_id=? ORDER BY sg.id", (p["id"],))]

        repairs = [dict(r) for r in c.execute(
            "SELECT rp.*, p.version_no AS plan_version FROM repairs rp"
            " JOIN plans p ON p.id=rp.plan_id WHERE rp.case_id=? ORDER BY rp.id", (cid,))]
        reinspections = [dict(r) for r in c.execute(
            "SELECT * FROM reinspections WHERE case_id=? ORDER BY id", (cid,))]

        events = [dict(r, payload=json.loads(r["payload"])) for r in c.execute(
            "SELECT * FROM events WHERE case_id=? ORDER BY seq", (cid,))]

        notifications = [dict(r, ack=bool(r["acknowledged_at"])) for r in c.execute(
            "SELECT n.*, rc.acknowledged_at FROM notifications n"
            " LEFT JOIN receipts rc ON rc.notification_id=n.id"
            " WHERE n.case_id=? ORDER BY n.id", (cid,))]

        return {
            "case": case,
            "actors": actors,
            "units": units,
            "statements": statements,
            "appointments": appointments,
            "stages": stages,
            "water_tests": tests,
            "evidence": evidence,
            "hidden_versions": hidden_versions,
            "opinions": opinions,
            "plans": plans,
            "repairs": repairs,
            "reinspections": reinspections,
            "events": events,
            "notifications": notifications,
            "chain_ok": self.st.verify_chain(cid),
        }


def make_handler(db_path: str, photo_dir: str):
    class Handler(BaseHTTPRequestHandler):
        server_version = "LeakFlow/1.0"

        def log_message(self, fmt, *args):
            pass

        # ---------- 工具 ----------
        def _json(self, obj, status=200):
            body = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _read_json(self):
            n = int(self.headers.get("Content-Length", 0))
            if not n:
                return {}
            return json.loads(self.rfile.read(n).decode())

        def _store(self):
            conn = dbmod.connect(db_path)
            return conn, Store(conn, photo_dir)

        def _case_id(self, qs):
            v = qs.get("case", [None])[0]
            return int(v) if v else 1

        # ---------- GET ----------
        def do_GET(self):
            parsed = urlparse(self.path)
            path = parsed.path
            qs = parse_qs(parsed.query)
            try:
                if path == "/api/case":
                    conn = dbmod.connect(db_path)
                    cid = self._case_id(qs)
                    actor = qs.get("actor", [None])[0]
                    data = CaseView(conn, cid, actor).build()
                    conn.close()
                    return self._json(data)
                if path.startswith("/api/photos/"):
                    return self._serve_photo(path[len("/api/photos/"):])
                if path in ("/", "/index.html"):
                    return self._serve_static("index.html")
                if path.startswith("/static/"):
                    return self._serve_static(path[len("/static/"):])
                self.send_error(HTTPStatus.NOT_FOUND)
            except Exception as e:  # noqa
                return self._json({"error": str(e)}, 500)

        def _serve_photo(self, name):
            name = posixpath.normpath(name).lstrip("/")
            full = os.path.join(photo_dir, name)
            if not os.path.abspath(full).startswith(os.path.abspath(photo_dir) + os.sep) \
                    or not os.path.isfile(full):
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            ctype = mimetypes.guess_type(full)[0] or "image/png"
            with open(full, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _serve_static(self, rel):
            rel = posixpath.normpath(rel).lstrip("/")
            full = os.path.join(WEB_DIR, rel)
            if not os.path.abspath(full).startswith(os.path.abspath(WEB_DIR) + os.sep) \
                    or not os.path.isfile(full):
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            if full.endswith(".js"):
                ctype = "application/javascript; charset=utf-8"
            if full.endswith(".css"):
                ctype = "text/css; charset=utf-8"
            with open(full, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        # ---------- POST ----------
        def do_POST(self):
            parsed = urlparse(self.path)
            path = parsed.path
            try:
                payload = self._read_json()
                conn, st = self._store()
                with dbmod.tx(conn):
                    cid = int(payload.get("case_id", 1))
                    actor = payload.get("actor")
                    if path.startswith("/api/appointments/") and path.endswith("/respond"):
                        appt_id = int(path.split("/")[3])
                        st.respond_appointment(appt_id, actor, bool(payload["accept"]),
                                               payload.get("reason"))
                    elif path.startswith("/api/plans/") and path.endswith("/sign"):
                        plan_id = int(path.split("/")[3])
                        st.sign_plan(plan_id, actor, payload.get("decision", "sign"),
                                     payload.get("comment"))
                    elif path.startswith("/api/notifications/") and path.endswith("/ack"):
                        nid = int(path.split("/")[3])
                        st.acknowledge(nid, actor)
                    elif path == "/api/statements":
                        st.add_statement(cid, actor, payload["content"],
                                         payload.get("unit_id"))
                    elif path == "/api/annotations":
                        st.add_annotation(int(payload["evidence_id"]), actor,
                                          float(payload["nx"]), float(payload["ny"]),
                                          payload["label"])
                    else:
                        conn.close()
                        return self._json({"error": "unknown endpoint"}, 404)
                conn.close()
                return self._json({"ok": True})
            except DomainError as e:
                return self._json({"error": str(e)}, 422)
            except Exception as e:  # noqa
                return self._json({"error": str(e)}, 400)

    return Handler


def serve(db_path: str, photo_dir: str, port: int = 8000, host: str = "127.0.0.1"):
    httpd = ThreadingHTTPServer((host, port), make_handler(db_path, photo_dir))
    print(f"LeakFlow on http://{host}:{port}  (db={db_path})")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


def main():
    ap = argparse.ArgumentParser()
    base = os.path.join(os.path.dirname(__file__), "data")
    ap.add_argument("--db", default=os.path.join(base, "leakflow.db"))
    ap.add_argument("--photos", default=os.path.join(base, "photos"))
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--reseed", action="store_true", help="启动前重建种子案例")
    args = ap.parse_args()
    if args.reseed or not os.path.exists(args.db):
        from .seed import build
        build(args.db, args.photos)
        print("seed ready.")
    serve(args.db, args.photos, args.port, args.host)


if __name__ == "__main__":
    main()
