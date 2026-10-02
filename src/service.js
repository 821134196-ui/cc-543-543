'use strict';
// 业务服务层：事件链、证据版本、权限与协商/复验规则全部在此强制执行
const fs = require('node:fs');
const path = require('node:path');
const { id } = require('./util');
const { pngSize } = require('./png');

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status; this.code = code;
  }
}

class Service {
  constructor(db, adapters, opts = {}) {
    this.db = db;
    this.ntf = adapters;
    this.photoDir = opts.photoDir;
    this.clock = opts.clock || (() => new Date().toISOString());
    if (this.photoDir) fs.mkdirSync(this.photoDir, { recursive: true });
  }

  get t() { return this.clock(); }

  // ---------- 基础 ----------
  party(pid) {
    const p = this.db.prepare('SELECT * FROM parties WHERE id=?').get(pid);
    if (!p) throw new HttpError(401, 'unknown_party', '身份不存在');
    return p;
  }

  caseFor(caseId) {
    const c = this.db.prepare('SELECT * FROM cases WHERE id=?').get(caseId);
    if (!c) throw new HttpError(404, 'case_not_found', '案件不存在');
    return c;
  }

  // 跨户隐私：非本案成员一律拒绝
  assertMember(caseId, pid) {
    this.party(pid);
    const m = this.db.prepare('SELECT 1 FROM case_members WHERE case_id=? AND party_id=?')
      .get(caseId, pid);
    if (!m) throw new HttpError(403, 'cross_household_denied', '与本案无关，禁止查看他户信息');
  }

  assertRole(pid, roles) {
    const p = this.party(pid);
    if (!roles.includes(p.role))
      throw new HttpError(403, 'role_forbidden', `该操作需要角色：${roles.join('/')}`);
    return p;
  }

  event(caseId, type, actor, payload = {}, evidenceVersionId = null) {
    const seq = (this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM events WHERE case_id=?').get(caseId).n);
    const eid = id('evt');
    this.db.prepare(`INSERT INTO events (id, case_id, seq, type, actor, payload, evidence_version_id, created_at)
                     VALUES (?,?,?,?,?,?,?,?)`)
      .run(eid, caseId, seq, type, actor, JSON.stringify(payload), evidenceVersionId, this.t);
    return eid;
  }

  // ---------- 案件 ----------
  createCase({ code, building, title, unitReporter, unitUp, floorReporter, floorUp, members, actor }) {
    this.party(actor);
    const cid = id('case');
    this.db.prepare(`INSERT INTO cases
      (id, code, building, title, unit_reporter, unit_up, floor_reporter, floor_up, status, created_at)
      VALUES (?,?,?,?,?,?,?,?, 'open', ?)`)
      .run(cid, code, building, title, unitReporter, unitUp, floorReporter, floorUp, this.t);
    const ins = this.db.prepare('INSERT OR IGNORE INTO case_members (case_id, party_id) VALUES (?,?)');
    for (const m of members) { this.party(m); ins.run(cid, m); }
    this.event(cid, 'case_created', actor, { code, building, title, unit_reporter: unitReporter, unit_up: unitUp });
    return this.caseFor(cid);
  }

  listCases(pid) {
    this.party(pid);
    return this.db.prepare(`
      SELECT c.* FROM cases c JOIN case_members cm ON cm.case_id=c.id
      WHERE cm.party_id=? ORDER BY c.created_at DESC, c.code`).all(pid);
  }

  // 案件聚合详情（所有读取都过 assertMember）
  caseDetail(caseId, pid) {
    this.assertMember(caseId, pid);
    const c = this.caseFor(caseId);
    const q = (sql, ...a) => this.db.prepare(sql).all(...a);
    return {
      ...c,
      members: q(`SELECT p.* FROM case_members cm JOIN parties p ON p.id=cm.party_id WHERE cm.case_id=?`, caseId),
      statements: q(`SELECT s.*, p.name AS actor_name, p.role AS actor_role FROM statements s
                     JOIN parties p ON p.id=s.party_id WHERE s.case_id=? ORDER BY s.seq`, caseId),
      evidence_versions: q(`SELECT * FROM evidence_versions WHERE case_id=? ORDER BY version`, caseId),
      evidence_items: q(`SELECT * FROM evidence_items WHERE case_id=? ORDER BY seq`, caseId),
      photos: q('SELECT * FROM photos WHERE case_id=? ORDER BY taken_at, uploaded_at', caseId),
      events: q('SELECT * FROM events WHERE case_id=? ORDER BY seq', caseId),
      appointments: q('SELECT * FROM appointments WHERE case_id=? ORDER BY scheduled_at', caseId),
      work_stages: q('SELECT * FROM work_stages WHERE case_id=? ORDER BY started_at', caseId),
      water_tests: q('SELECT * FROM water_tests WHERE case_id=? ORDER BY started_at', caseId),
      conclusions: q('SELECT * FROM conclusions WHERE case_id=? AND active=1 ORDER BY created_at', caseId),
      proposals: q('SELECT * FROM proposals WHERE case_id=? ORDER BY version', caseId)
        .map(p => ({
          ...p,
          repair_plan: JSON.parse(p.repair_plan),
          items: q(`SELECT pi.*, pa.name AS party_name, pa.unit AS party_unit
                    FROM proposal_items pi JOIN parties pa ON pa.id=pi.party_id
                    WHERE pi.proposal_id=? ORDER BY pi.seq`, p.id),
          signatures: q(`SELECT ps.*, pa.name AS party_name FROM proposal_signatures ps
                         JOIN parties pa ON pa.id=ps.party_id WHERE ps.proposal_id=?`, p.id),
        })),
      repairs: q('SELECT * FROM repairs WHERE case_id=? ORDER BY started_at', caseId),
      verifications: q('SELECT * FROM verifications WHERE case_id=? ORDER BY checked_at', caseId),
    };
  }

  // ---------- 登记与陈述（只追加） ----------
  // 本人只能提交自己的陈述；物业可代录。任何人不能修改/删除对方陈述（无修改接口）。
  addStatement(caseId, actorId, { location, damagedParts = [], description, source, forParty }) {
    this.assertMember(caseId, actorId);
    const actor = this.party(actorId);
    let partyId = actorId;
    let src;
    if (source === '物业代录') {
      if (actor.role !== 'manager')
        throw new HttpError(403, 'role_forbidden', '仅物业可代录');
      if (!forParty) throw new HttpError(400, 'for_party_required', '代录须注明被代录住户');
      const target = this.party(forParty);
      if (!target.role.startsWith('resident'))
        throw new HttpError(400, 'bad_target', '代录对象须为住户');
      this.assertMember(caseId, forParty);
      partyId = forParty;
      src = '物业代录';
    } else {
      if (actor.role !== 'resident_reporter' && actor.role !== 'resident_up')
        throw new HttpError(403, 'statement_self_only', '仅住户本人可提交陈述，物业请走代录');
      src = '本人陈述';
    }
    const seq = this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 n FROM statements WHERE case_id=?').get(caseId).n;
    const sid = id('stm');
    this.db.prepare(`INSERT INTO statements (id, case_id, party_id, seq, location, damaged_parts, description, source, created_at)
                     VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(sid, caseId, partyId, seq, location ?? null, JSON.stringify(damagedParts), description, src, this.t);
    this.event(caseId, 'statement_added', actorId, { statement: sid, source: src, party: partyId, location });
    return sid;
  }

  // ---------- 照片 ----------
  addPhoto(caseId, actorId, { buffer, filename, room, caption, takenAt, contentType = 'image/png' }) {
    this.assertMember(caseId, actorId);
    const { width, height } = pngSize(buffer); // 只存原图，展示层负责等比缩放
    const safe = `${id('pho')}${path.extname(filename || '.png') || '.png'}`;
    fs.writeFileSync(path.join(this.photoDir, safe), buffer);
    const pid = id('pho');
    this.db.prepare(`INSERT INTO photos
      (id, case_id, filename, content_type, width, height, room, caption, taken_at, uploaded_at, uploaded_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(pid, caseId, safe, contentType, width, height, room ?? null, caption ?? null,
        takenAt || this.t, this.t, actorId);
    this.event(caseId, 'photo_uploaded', actorId, { photo: pid, room, taken_at: takenAt || this.t });
    return pid;
  }

  photoPath(photoId, pid) {
    const row = this.db.prepare('SELECT * FROM photos WHERE id=?').get(photoId);
    if (!row) throw new HttpError(404, 'photo_not_found', '照片不存在');
    this.assertMember(row.case_id, pid); // 跨户不能看图
    return { row, file: path.join(this.photoDir, row.filename) };
  }

  // 标注：归一化坐标 0..1，叠加在展示层；原始像素文件永不改动
  annotatePhoto(photoId, pid, { x, y, text }) {
    const row = this.db.prepare('SELECT * FROM photos WHERE id=?').get(photoId);
    if (!row) throw new HttpError(404, 'photo_not_found', '照片不存在');
    this.assertMember(row.case_id, pid);
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1))
      throw new HttpError(400, 'bad_coord', '标注坐标须在 0..1');
    const marks = JSON.parse(row.annotations);
    marks.push({ x, y, text, by: pid, at: this.t });
    this.db.prepare('UPDATE photos SET annotations=? WHERE id=?').run(JSON.stringify(marks), photoId);
    this.event(row.case_id, 'photo_annotated', pid, { photo: photoId, x, y, text });
    return marks;
  }

  // ---------- 证据条目与版本 ----------
  _draftSeq(caseId) {
    return this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 n FROM evidence_items WHERE case_id=?').get(caseId).n;
  }

  addEvidencePhoto(caseId, actorId, photoId, caption) {
    this.assertMember(caseId, actorId);
    const ph = this.db.prepare('SELECT * FROM photos WHERE id=?').get(photoId);
    if (!ph || ph.case_id !== caseId) throw new HttpError(404, 'photo_not_found', '照片不属于本案');
    const iid = id('evi');
    this.db.prepare(`INSERT INTO evidence_items (id, case_id, seq, version_id, type, photo_id, caption, created_by, created_at)
                     VALUES (?,?,?,NULL,'photo',?,?,?,?)`)
      .run(iid, caseId, this._draftSeq(caseId), photoId, caption ?? ph.caption, actorId, this.t);
    this.event(caseId, 'evidence_added', actorId, { item: iid, photo: photoId });
    return iid;
  }

  addEvidenceNote(caseId, actorId, caption) {
    this.assertMember(caseId, actorId);
    const iid = id('evi');
    this.db.prepare(`INSERT INTO evidence_items (id, case_id, seq, version_id, type, caption, created_by, created_at)
                     VALUES (?,?,?,NULL,'note',?,?,?)`)
      .run(iid, caseId, this._draftSeq(caseId), caption, actorId, this.t);
    this.event(caseId, 'evidence_added', actorId, { item: iid, caption });
    return iid;
  }

  // 旧照片被误用：勘查人/协商员可对草稿或已入册证据打标（结论保留在链上）
  flagStale(caseId, actorId, itemId, reason) {
    this.assertMember(caseId, actorId);
    const item = this.db.prepare('SELECT * FROM evidence_items WHERE id=? AND case_id=?').get(itemId, caseId);
    if (!item) throw new HttpError(404, 'item_not_found', '证据条目不存在');
    const fid = id('evi');
    this.db.prepare(`INSERT INTO evidence_items (id, case_id, seq, version_id, type, photo_id, caption, flag_reason, created_by, created_at)
                     VALUES (?,?,?,NULL,'stale_flag',?,?, ?, ?, ?)`)
      .run(fid, caseId, this._draftSeq(caseId), item.photo_id, `针对条目 ${itemId} 的旧照片质疑`, reason, actorId, this.t);
    this.addConclusion(caseId, actorId, {
      kind: 'stale_photo', title: '旧照片被误用', detail: `条目 ${itemId}：${reason}`,
    });
    return fid;
  }

  // 冻结当前草稿为不可变版本
  freezeVersion(caseId, actorId, label, note) {
    this.assertMember(caseId, actorId);
    const drafts = this.db.prepare('SELECT * FROM evidence_items WHERE case_id=? AND version_id IS NULL ORDER BY seq')
      .all(caseId);
    if (!drafts.length) throw new HttpError(400, 'empty_version', '没有待冻结的证据');
    const ver = (this.db.prepare('SELECT COALESCE(MAX(version),0)+1 v FROM evidence_versions WHERE case_id=?')
      .get(caseId).v);
    const vid = id('ver');
    this.db.prepare(`INSERT INTO evidence_versions (id, case_id, version, label, note, published_by, created_at)
                     VALUES (?,?,?,?,?,?,?)`)
      .run(vid, caseId, ver, label ?? `证据版本 v${ver}`, note ?? null, actorId, this.t);
    const up = this.db.prepare('UPDATE evidence_items SET version_id=? WHERE id=?');
    for (const d of drafts) up.run(vid, d.id);
    this.db.prepare('UPDATE cases SET current_evidence_version=? WHERE id=?').run(ver, caseId);
    this.event(caseId, 'evidence_version_frozen', actorId, { version: ver, items: drafts.map(d => d.id) }, vid);
    return { id: vid, version: ver, count: drafts.length };
  }

  // ---------- 维修阶段 / 预约 / 试水 ----------
  setStage(caseId, actorId, stage, status, note) {
    this.assertMember(caseId, actorId);
    let row = this.db.prepare('SELECT * FROM work_stages WHERE case_id=? AND stage=?').get(caseId, stage);
    if (!row) {
      const sid = id('stg');
      this.db.prepare(`INSERT INTO work_stages (id, case_id, stage, status, actor, note, started_at)
                       VALUES (?,?,?,?,?,?,?)`)
        .run(sid, caseId, stage, status, actorId, note ?? null, this.t);
      row = this.db.prepare('SELECT * FROM work_stages WHERE id=?').get(sid);
    } else {
      this.db.prepare(`UPDATE work_stages SET status=?, actor=?, note=COALESCE(?,note),
                        finished_at=CASE WHEN ? IN ('done','blocked') THEN ? ELSE finished_at END
                       WHERE id=?`)
        .run(status, actorId, note ?? null, status, this.t, row.id);
      row = this.db.prepare('SELECT * FROM work_stages WHERE id=?').get(row.id);
    }
    this.event(caseId, 'work_stage', actorId, { stage, status, note: note ?? null });
    return row;
  }

  requestAppointment(caseId, actorId, { targetParty, scheduledAt, reason }) {
    this.assertMember(caseId, actorId);
    this.assertMember(caseId, targetParty);
    const aid = id('apt');
    this.db.prepare(`INSERT INTO appointments
      (id, case_id, target_party, scheduled_at, status, reason, created_by, created_at)
      VALUES (?,?,?,?, 'requested', ?,?,?)`)
      .run(aid, caseId, targetParty, scheduledAt, reason ?? null, actorId, this.t);
    this.event(caseId, 'appointment_requested', actorId, { appointment: aid, target: targetParty, scheduled_at: scheduledAt });
    this.ntf.notify({ caseId, toParty: targetParty, channel: 'sms',
      subject: '入户排查预约', body: `物业预约 ${scheduledAt} 入户排查（${reason || '渗漏排查'}），请回复是否同意。`, at: this.t });
    return aid;
  }

  // 接受 / 拒绝 / 改约 —— 拒绝作为「住户拒绝入户」结论保留
  respondAppointment(caseId, aid, actorId, { status, note }) {
    this.assertMember(caseId, actorId);
    const ap = this.db.prepare('SELECT * FROM appointments WHERE id=? AND case_id=?').get(aid, caseId);
    if (!ap) throw new HttpError(404, 'appointment_not_found', '预约不存在');
    if (ap.target_party !== actorId)
      throw new HttpError(403, 'not_target_party', '仅被预约住户本人可回复');
    if (!['accepted', 'refused', 'rescheduled', 'no_show'].includes(status))
      throw new HttpError(400, 'bad_status', '状态不合法');
    this.db.prepare('UPDATE appointments SET status=?, response_note=?, responded_at=? WHERE id=?')
      .run(status, note ?? null, this.t, aid);
    this.event(caseId, 'appointment_responded', actorId, { appointment: aid, status, note: note ?? null });
    if (status === 'refused') {
      this.addConclusion(caseId, actorId, {
        kind: 'access_refused', title: '住户拒绝入户',
        detail: `预约 ${ap.scheduled_at} 被拒绝：${note || '未说明'}`,
      });
      this.setStage(caseId, actorId, 'inspection', 'blocked', '住户拒绝入户，现场勘查无法进行');
    }
    return this.db.prepare('SELECT * FROM appointments WHERE id=?').get(aid);
  }

  addWaterTest(caseId, actorId, t) {
    this.assertMember(caseId, actorId);
    const wid = id('wtr');
    this.db.prepare(`INSERT INTO water_tests
      (id, case_id, method, zone, started_at, ended_at, result, observed_at, leak_point, operator, note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(wid, caseId, t.method, t.zone, t.startedAt, t.endedAt ?? null, t.result,
        t.observedAt ?? null, t.leakPoint ?? null, actorId, t.note ?? null);
    this.event(caseId, 'water_test', actorId, { test: wid, zone: t.zone, result: t.result, leak_point: t.leakPoint ?? null });
    this.setStage(caseId, actorId, 'water_test', 'done',
      `${t.zone} ${t.result === 'positive' ? '重现渗漏' : t.result === 'negative' ? '未重现' : '结果不明'}`);
    return wid;
  }

  // ---------- 结论（多种结论并存，责任意见必须引用证据版本） ----------
  addConclusion(caseId, actorId, { kind, title, detail, evidenceVersionId }) {
    this.assertMember(caseId, actorId);
    let vid = evidenceVersionId ?? null;
    if (kind === 'responsibility') {
      if (!vid) throw new HttpError(400, 'version_required', '责任意见必须引用当时的证据版本');
      const v = this.db.prepare('SELECT * FROM evidence_versions WHERE id=? AND case_id=?').get(vid, caseId);
      if (!v) throw new HttpError(404, 'version_not_found', '证据版本不存在');
    } else if (vid) {
      const v = this.db.prepare('SELECT 1 FROM evidence_versions WHERE id=? AND case_id=?').get(vid, caseId);
      if (!v) throw new HttpError(404, 'version_not_found', '证据版本不存在');
    }
    const cid = id('con');
    this.db.prepare(`INSERT INTO conclusions (id, case_id, kind, title, detail, evidence_version_id, author, active, created_at)
                     VALUES (?,?,?,?,?,?,?,1,?)`)
      .run(cid, caseId, kind, title, detail ?? null, vid, actorId, this.t);
    this.event(caseId, 'conclusion_added', actorId, { conclusion: cid, kind, title, evidence_version: vid }, vid);
    return cid;
  }

  // ---------- 协商方案 ----------
  // 新证据只能触发重新协商：旧方案原样保留，另出新版本方案引用新证据版本
  createProposal(caseId, actorId, { evidenceVersionId, responsibilitySummary, repairPlan = [], warrantyUntil }) {
    this.assertMember(caseId, actorId);
    this.assertRole(actorId, ['negotiator', 'manager']);
    const v = this.db.prepare('SELECT * FROM evidence_versions WHERE id=? AND case_id=?').get(evidenceVersionId, caseId);
    if (!v) throw new HttpError(400, 'version_required', '方案必须引用一个已冻结的证据版本');
    const ver = this.db.prepare('SELECT COALESCE(MAX(version),0)+1 v FROM proposals WHERE case_id=?').get(caseId).v;
    const pid = id('prp');
    this.db.prepare(`INSERT INTO proposals
      (id, case_id, version, status, evidence_version_id, responsibility_summary, repair_plan, warranty_until,
       created_by, created_at)
      VALUES (?,?,?, 'draft', ?,?,?,?,?,?)`)
      .run(pid, caseId, ver, evidenceVersionId, responsibilitySummary ?? null,
        JSON.stringify(repairPlan), warrantyUntil ?? null, actorId, this.t);
    this.event(caseId, 'proposal_created', actorId, { proposal: pid, version: ver, evidence_version: evidenceVersionId }, evidenceVersionId);
    return pid;
  }

  addProposalItem(caseId, proposalId, actorId, { partyId, title, amountCents, basis }) {
    this.assertMember(caseId, actorId);
    this.assertRole(actorId, ['negotiator', 'manager']);
    const pr = this.db.prepare('SELECT * FROM proposals WHERE id=? AND case_id=?').get(proposalId, caseId);
    if (!pr) throw new HttpError(404, 'proposal_not_found', '方案不存在');
    if (pr.status !== 'draft') throw new HttpError(409, 'proposal_locked', '方案已定稿，费用项不可修改（请出新版本重新协商）');
    this.assertMember(caseId, partyId);
    const seq = this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 n FROM proposal_items WHERE proposal_id=?').get(proposalId).n;
    const iid = id('itm');
    this.db.prepare(`INSERT INTO proposal_items (id, proposal_id, party_id, title, amount_cents, basis, seq)
                     VALUES (?,?,?,?,?,?,?)`)
      .run(iid, proposalId, partyId, title, amountCents, basis, seq);
    return iid;
  }

  // 定稿：冻结文档修订号 revision=1，进入待签
  finalizeProposal(caseId, proposalId, actorId) {
    this.assertMember(caseId, actorId);
    this.assertRole(actorId, ['negotiator', 'manager']);
    const pr = this.db.prepare('SELECT * FROM proposals WHERE id=? AND case_id=?').get(proposalId, caseId);
    if (!pr) throw new HttpError(404, 'proposal_not_found', '方案不存在');
    if (pr.status !== 'draft') throw new HttpError(409, 'already_finalized', '方案已定稿');
    const n = this.db.prepare('SELECT COUNT(*) c FROM proposal_items WHERE proposal_id=?').get(proposalId).c;
    if (!n) throw new HttpError(400, 'empty_proposal', '方案至少包含一个费用责任项');
    this.db.prepare("UPDATE proposals SET status='pending', finalized_at=? WHERE id=?").run(this.t, proposalId);
    this.event(caseId, 'proposal_finalized', actorId, { proposal: proposalId });
    for (const pid of this.db.prepare('SELECT DISTINCT party_id FROM proposal_items WHERE proposal_id=?')
      .all(proposalId).map(r => r.party_id)) {
      this.ntf.notify({ caseId, toParty: pid, channel: 'onsite',
        subject: '费用方案待签署', body: `协商方案 v${pr.version} 已定稿，请于物业处核对责任项、金额与依据后签署。`, at: this.t });
    }
    return this.db.prepare('SELECT * FROM proposals WHERE id=?').get(proposalId);
  }

  // 签署：乐观锁 docVersion 必须与当前文档修订号一致；任何一方拒签 → rejected
  signProposal(caseId, proposalId, actorId, { action = 'signed', note, docVersion }) {
    this.assertMember(caseId, actorId);
    const pr = this.db.prepare('SELECT * FROM proposals WHERE id=? AND case_id=?').get(proposalId, caseId);
    if (!pr) throw new HttpError(404, 'proposal_not_found', '方案不存在');
    if (pr.status !== 'pending')
      throw new HttpError(409, 'not_pending', `方案状态为 ${pr.status}，不可签署`);
    // 文档修订号固定为 1（定稿后不可改）；客户端带错即冲突，防止双方就不同文本签署
    const REVISION = 1;
    if (docVersion !== undefined && docVersion !== REVISION)
      throw new HttpError(409, 'doc_version_conflict',
        `方案签署冲突：你手中文本修订号 ${docVersion}，当前为 ${REVISION}，请重新核对后再签`);
    const exists = this.db.prepare('SELECT 1 FROM proposal_signatures WHERE proposal_id=? AND party_id=?')
      .get(proposalId, actorId);
    if (exists) throw new HttpError(409, 'already_signed', '该方已签署，不可重复签署');

    const sid = id('sig');
    this.db.prepare(`INSERT INTO proposal_signatures (id, proposal_id, party_id, action, doc_version, note, signed_at)
                     VALUES (?,?,?,?,?,?,?)`)
      .run(sid, proposalId, actorId, action, REVISION, note ?? null, this.t);
    this.ntf.receive({ caseId, docType: 'proposal_sign', docId: proposalId, partyId: actorId,
      payload: { action, doc_version: REVISION, note: note ?? null }, at: this.t });
    this.event(caseId, 'proposal_signed', actorId, { proposal: proposalId, action, doc_version: REVISION });

    if (action === 'rejected') {
      this.db.prepare("UPDATE proposals SET status='rejected' WHERE id=?").run(proposalId);
      this.addConclusion(caseId, actorId, {
        kind: 'cost_dispute', title: '费用不认可',
        detail: `方案 v${pr.version} 被拒签：${note || '未说明'}。须出新版本重新协商。`,
      });
    }
    return this.db.prepare('SELECT * FROM proposal_signatures WHERE id=?').get(sid);
  }

  // 赔偿批准：只有协商员可以；勘查人不能独自批准赔偿
  approveProposal(caseId, proposalId, actorId) {
    this.assertMember(caseId, actorId);
    const actor = this.assertRole(actorId, ['negotiator']);
    const pr = this.db.prepare('SELECT * FROM proposals WHERE id=? AND case_id=?').get(proposalId, caseId);
    if (!pr) throw new HttpError(404, 'proposal_not_found', '方案不存在');
    const need = this.db.prepare('SELECT DISTINCT party_id FROM proposal_items WHERE proposal_id=?').all(proposalId);
    const signed = this.db.prepare(`SELECT action FROM proposal_signatures WHERE proposal_id=?`)
      .all(proposalId);
    if (signed.some(s => s.action === 'rejected'))
      throw new HttpError(409, 'has_rejection', '存在拒签，不能批准');
    if (!need.every(n => signed.some(s => s.action === 'signed')))
      throw new HttpError(409, 'not_all_signed', '各责任方尚未全部签署，不能批准');
    this.db.prepare("UPDATE proposals SET status='approved', approved_at=?, approved_by=? WHERE id=?")
      .run(this.t, actorId, proposalId);
    this.ntf.receive({ caseId, docType: 'proposal_approve', docId: proposalId, partyId: actorId,
      payload: { by: actor.name }, at: this.t });
    this.event(caseId, 'proposal_approved', actorId, { proposal: proposalId });
    return this.db.prepare('SELECT * FROM proposals WHERE id=?').get(proposalId);
  }

  // ---------- 修复与复验 ----------
  startRepair(caseId, actorId, { proposalId, contractor, scope }) {
    this.assertMember(caseId, actorId);
    const pr = this.db.prepare('SELECT * FROM proposals WHERE id=? AND case_id=?').get(proposalId, caseId);
    if (!pr) throw new HttpError(404, 'proposal_not_found', '方案不存在');
    if (pr.status !== 'approved') throw new HttpError(409, 'not_approved', '方案未批准，不能开工');
    const rid = id('rep');
    this.db.prepare(`INSERT INTO repairs (id, case_id, proposal_id, status, contractor, scope, started_at)
                     VALUES (?,?,?, 'in_progress', ?,?,?)`)
      .run(rid, caseId, proposalId, contractor ?? null, scope ?? null, this.t);
    this.event(caseId, 'repair_started', actorId, { repair: rid, proposal: proposalId });
    return rid;
  }

  finishRepair(caseId, repairId, actorId) {
    this.assertMember(caseId, actorId);
    const r = this.db.prepare('SELECT * FROM repairs WHERE id=? AND case_id=?').get(repairId, caseId);
    if (!r) throw new HttpError(404, 'repair_not_found', '修复不存在');
    this.db.prepare("UPDATE repairs SET status='done', finished_at=? WHERE id=?").run(this.t, repairId);
    this.event(caseId, 'repair_finished', actorId, { repair: repairId });
    return this.db.prepare('SELECT * FROM repairs WHERE id=?').get(repairId);
  }

  // 复验通过 → 观察期后关闭；复验失败（复漏）→ 旧案保留关闭，开新案并继承证据链
  verify(caseId, actorId, { repairId, result, dryDays, observed, photoId }) {
    this.assertMember(caseId, actorId);
    this.assertRole(actorId, ['inspector', 'manager']);
    const r = this.db.prepare('SELECT * FROM repairs WHERE id=? AND case_id=?').get(repairId, caseId);
    if (!r) throw new HttpError(404, 'repair_not_found', '修复不存在');
    if (r.status !== 'done') throw new HttpError(409, 'repair_not_done', '修复未完工，不能复验');
    const vid = id('vrf');
    this.db.prepare(`INSERT INTO verifications
      (id, case_id, repair_id, result, dry_days, observed, photo_id, inspector, checked_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(vid, caseId, repairId, result, dryDays ?? null, observed ?? null, photoId ?? null, actorId, this.t);
    this.event(caseId, 'verification', actorId,
      { verification: vid, result, dry_days: dryDays ?? null, observed: observed ?? null });

    if (result === 'pass') {
      this.db.prepare("UPDATE cases SET status='closed', closed_at=? WHERE id=?").run(this.t, caseId);
      this.event(caseId, 'case_closed', actorId, { verification: vid, dry_days: dryDays ?? null });
      for (const pid of this.db.prepare('SELECT party_id FROM case_members WHERE case_id=?').all(caseId)
        .map(x => x.party_id)) {
        this.ntf.notify({ caseId, toParty: pid, channel: 'sms',
          subject: '复验通过，案件关闭', body: `经 ${dryDays ?? 0} 天观察未再渗漏，案件关闭。`, at: this.t });
      }
      return { reopened: null };
    }

    // 复验失败：复漏结论保留在旧案
    this.addConclusion(caseId, actorId, {
      kind: 'releak', title: '修复后复漏',
      detail: `复验未通过：${observed || '原漏点或相邻位置再次渗漏'}`,
    });
    return { reopened: this._reopen(caseId, actorId, observed) };
  }

  _reopen(parentCaseId, actorId, reason) {
    const parent = this.caseFor(parentCaseId);
    // 旧案关闭并封存
    this.db.prepare("UPDATE cases SET status='closed_reopened', closed_at=? WHERE id=?")
      .run(this.t, parentCaseId);
    const rootId = parent.root_case_id || parent.id;
    const seq = (this.db.prepare(
      'SELECT COALESCE(MAX(reopen_seq),0)+1 s FROM cases WHERE root_case_id=? OR id=?').get(rootId, rootId).s);
    const cid = id('case');
    this.db.prepare(`INSERT INTO cases
      (id, code, building, title, unit_reporter, unit_up, floor_reporter, floor_up, status, created_at,
       root_case_id, reopen_seq, reopen_reason, parent_case_id, current_evidence_version)
      VALUES (?,?,?,?,?,?,?,?,'open',?,?,?,?,?,?)`)
      .run(cid, `${parent.code}-R${seq}`, parent.building, `${parent.title}（复漏重开 ${seq}）`,
        parent.unit_reporter, parent.unit_up, parent.floor_reporter, parent.floor_up, this.t,
        rootId, seq, reason ?? '复验后复漏', parentCaseId, parent.current_evidence_version);
    const mem = this.db.prepare('SELECT party_id FROM case_members WHERE case_id=?').all(parentCaseId);
    const ins = this.db.prepare('INSERT OR IGNORE INTO case_members (case_id, party_id) VALUES (?,?)');
    for (const m of mem) ins.run(cid, m.party_id);
    // 继承已冻结证据版本（新案沿用版本号基线继续累积新证据）
    const vers = this.db.prepare('SELECT * FROM evidence_versions WHERE case_id=? ORDER BY version').all(parentCaseId);
    const verMap = {}; // 父版本 id -> 子版本 id
    for (const v of vers) {
      const nvid = id('ver');
      verMap[v.id] = nvid;
      this.db.prepare(`INSERT INTO evidence_versions (id, case_id, version, label, note, published_by, created_at)
                       VALUES (?,?,?,?,?,?,?)`)
        .run(nvid, cid, v.version, v.label, `继承自 ${parent.code}（原版本 ${v.version}）：${v.note || ''}`,
          v.published_by, v.created_at);
    }
    // 克隆原案照片行（本地文件共用，不复制字节）与已入册证据条目，挂到继承版本下
    const photoMap = {};
    for (const ph of this.db.prepare('SELECT * FROM photos WHERE case_id=?').all(parentCaseId)) {
      const npid = id('pho');
      photoMap[ph.id] = npid;
      this.db.prepare(`INSERT INTO photos
        (id, case_id, filename, content_type, width, height, room, caption, taken_at, uploaded_at, uploaded_by, annotations)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(npid, cid, ph.filename, ph.content_type, ph.width, ph.height, ph.room,
          `[继承自 ${parent.code}] ${ph.caption ?? ''}`, ph.taken_at, ph.uploaded_at, ph.uploaded_by, ph.annotations);
    }
    const frozen = this.db.prepare('SELECT * FROM evidence_items WHERE case_id=? AND version_id IS NOT NULL ORDER BY seq')
      .all(parentCaseId);
    for (const it of frozen) {
      this.db.prepare(`INSERT INTO evidence_items
        (id, case_id, seq, version_id, type, photo_id, caption, flag_reason, created_by, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(id('evi'), cid, it.seq, verMap[it.version_id] || null, it.type,
          it.photo_id ? photoMap[it.photo_id] : null, it.caption, it.flag_reason, it.created_by, it.created_at);
    }
    this.event(cid, 'case_reopened', actorId,
      { parent: parentCaseId, root: rootId, seq, reason: reason ?? '复验后复漏' });
    this.event(parentCaseId, 'case_reopened_link', actorId, { child: cid, seq });
    this.ntf.receive({ caseId: cid, docType: 'reopen', docId: cid, partyId: actorId,
      payload: { parent: parentCaseId, reason: reason ?? '复验后复漏' }, at: this.t });
    for (const pid of mem.map(m => m.party_id)) {
      this.ntf.notify({ caseId: cid, toParty: pid, channel: 'sms',
        subject: '复漏重开通知', body: `复验发现复漏，案件 ${parent.code}-R${seq} 已重新立案，将重新勘查协商。`, at: this.t });
    }
    return this.caseFor(cid);
  }
}

module.exports = { Service, HttpError };
