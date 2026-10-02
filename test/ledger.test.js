'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb } = require('../src/db');
const { adapters } = require('../src/adapters');
const { Service, HttpError } = require('../src/service');
const { generate } = require('../src/png');
const { createServer } = require('../src/server');
const { seed } = require('../src/seed');

function env() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leak-'));
  const photoDir = path.join(dir, 'photos');
  const logDir = path.join(dir, 'adapters');
  const db = openDb(path.join(dir, 't.db'));
  const adp = adapters(db, logDir);
  let t = '2026-10-01T09:00:00+08:00';
  const clock = () => t;
  const at = (s) => { t = s; };
  const svc = new Service(db, adp, { photoDir, clock });
  const party = (id, role, name, unit) =>
    db.prepare('INSERT INTO parties (id, role, name, unit, building) VALUES (?,?,?,?,?)')
      .run(id, role, name, unit ?? null, 'T栋');
  return { dir, db, adp, svc, at, party, photoDir,
    png: (w = 400, h = 300) => generate({ width: w, height: h, spots: [{ fx: .5, fy: .5, r: .2 }] }) };
}

async function expectHttp(fn, status, code) {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof HttpError, '应为 HttpError，实际：' + e);
    assert.equal(e.status, status);
    if (code) assert.equal(e.code, code);
    return;
  }
  assert.fail('应当抛出 HttpError，但没有抛错');
}

// 构造一个含两名住户 + 物业/勘查/协商员的案件
function fullCase(e, opt = {}) {
  e.party('r', 'resident_reporter', '楼下住户', 'T栋101');
  e.party('u', 'resident_up', '楼上住户', 'T栋201');
  e.party('m', 'manager', '物业管家');
  e.party('i', 'inspector', '勘查员');
  e.party('n', 'negotiator', '协商员');
  e.party('o', 'manager', '物业中心');
  const c = e.svc.createCase({
    code: opt.code || 'T-1', building: 'T栋', title: '测试渗漏',
    unitReporter: 'T栋101', unitUp: 'T栋201', floorReporter: 1, floorUp: 2,
    members: ['r', 'u', 'm', 'i', 'n', 'o'], actor: 'm',
  });
  return c.id;
}

// 走到「已批准方案+完工修复」，返回各 id
function approvedCase(e) {
  const cid = fullCase(e);
  e.at('2026-10-01T10:00:00+08:00');
  e.svc.addStatement(cid, 'r', { location: '天花板', description: '滴水' });
  const pid = e.svc.addPhoto(cid, 'i', { buffer: e.png(600, 400), filename: 'a.png', room: '主卫', takenAt: '2026-10-01T09:30:00+08:00' });
  e.svc.addEvidencePhoto(cid, 'i', pid, '现场照');
  const v = e.svc.freezeVersion(cid, 'i', 'v1');
  e.svc.addConclusion(cid, 'i', { kind: 'responsibility', title: '责任意见', evidenceVersionId: v.id });
  const pr = e.svc.createProposal(cid, 'n', { evidenceVersionId: v.id, repairPlan: ['重做防水'] });
  e.svc.addProposalItem(cid, pr, 'n', { partyId: 'u', title: '防水', amountCents: 10000, basis: '证据v1' });
  e.svc.finalizeProposal(cid, pr, 'n');
  e.svc.signProposal(cid, pr, 'u', { action: 'signed', docVersion: 1 });
  e.svc.approveProposal(cid, pr, 'n');
  const rid = e.svc.startRepair(cid, 'm', { proposalId: pr, contractor: '班组' });
  e.svc.finishRepair(cid, rid, 'm');
  return { cid, pr, rid, version: v, photo: pid };
}

test('证据版本：冻结后不可变，责任意见必须引用版本，新证据另起版本', () => {
  const e = env();
  const cid = fullCase(e);
  const a = e.svc.addEvidenceNote(cid, 'i', '证据A');
  const v1 = e.svc.freezeVersion(cid, 'i', 'v1');
  assert.equal(v1.version, 1);

  // 冻结后没有草稿 → 不能空冻结
  assert.throws(() => e.svc.freezeVersion(cid, 'i', 'v空'), /没有待冻结的证据/);

  // 已入册条目不可删改（数据库触发器兜底）
  assert.throws(() => e.db.prepare('UPDATE evidence_items SET caption=? WHERE id=?').run('篡改', a),
    /不可修改|只读/);
  assert.throws(() => e.db.prepare('DELETE FROM evidence_items WHERE id=?').run(a), /禁止删除|只读/);
  // 版本本身不可改删
  assert.throws(() => e.db.prepare('UPDATE evidence_versions SET label=? WHERE id=?').run('x', v1.id), /不可修改/);

  // 责任意见无版本 → 拒绝
  assert.throws(() => e.svc.addConclusion(cid, 'i', { kind: 'responsibility', title: '无据意见' }),
    /必须引用当时的证据版本/);
  // 引用不存在版本 → 拒绝
  assert.throws(() => e.svc.addConclusion(cid, 'i',
    { kind: 'responsibility', title: 'x', evidenceVersionId: 'ver_nope' }), /证据版本不存在/);

  const cid2 = e.svc.addConclusion(cid, 'i', { kind: 'responsibility', title: '责任意见v1', evidenceVersionId: v1.id });
  assert.ok(cid2);

  // 新证据进入草稿，冻结为 v2；v1 内容不变
  e.svc.addEvidenceNote(cid, 'i', '证据B（复测）');
  const v2 = e.svc.freezeVersion(cid, 'n', 'v2');
  assert.equal(v2.version, 2);
  const v1Rows = e.db.prepare('SELECT COUNT(*) c FROM evidence_items WHERE version_id=?').get(v1.id).c;
  const v2Rows = e.db.prepare('SELECT COUNT(*) c FROM evidence_items WHERE version_id=?').get(v2.id).c;
  assert.equal(v1Rows, 1, 'v1 保持 1 条不变');
  assert.equal(v2Rows, 1);
});

test('证据版本：照片原件保持原比例存储，标注不改动原文件', () => {
  const e = env();
  const cid = fullCase(e);
  const buf = e.png(640, 480);
  const pid = e.svc.addPhoto(cid, 'i', { buffer: buf, filename: 'ratio.png', takenAt: '2026-10-01T09:00:00+08:00' });
  const row = e.db.prepare('SELECT width, height, filename FROM photos WHERE id=?').get(pid);
  assert.equal(row.width, 640);
  assert.equal(row.height, 480);
  const onDisk = fs.readFileSync(path.join(e.photoDir, row.filename));
  assert.ok(onDisk.equals(buf), '磁盘上的就是原图字节');
  e.svc.annotatePhoto(pid, 'i', { x: .25, y: .5, text: '漏点' });
  assert.ok(fs.readFileSync(path.join(e.photoDir, row.filename)).equals(buf), '加标注后原文件不变');
  assert.throws(() => e.svc.annotatePhoto(pid, 'i', { x: 2, y: 0, text: '越界' }), /0\.\.1/);
});

test('跨户隐私：非成员对案件、照片、操作全部 403', () => {
  const e = env();
  const cid = fullCase(e);
  e.party('x', 'resident_reporter', '外栋住户', 'X栋901'); // 不在本案
  return Promise.all([
    expectHttp(() => e.svc.caseDetail(cid, 'x'), 403, 'cross_household_denied'),
    expectHttp(() => e.svc.addStatement(cid, 'x', { description: '偷看' }), 403),
    expectHttp(() => e.svc.freezeVersion(cid, 'x', 'x'), 403),
    expectHttp(() => e.svc.createProposal(cid, 'x', { evidenceVersionId: 'z' }), 403),
  ]);
});

test('跨户隐私：HTTP 层读取他户案件/照片返回 403，案件列表不泄露', async () => {
  const e = env();
  const cid = fullCase(e);
  const pid = e.svc.addPhoto(cid, 'i', { buffer: e.png(), filename: 'p.png' });
  e.party('x', 'resident_reporter', '外人', 'X栋101');
  const server = createServer({ db: e.db, adapters: e.adp, photoDir: e.photoDir, clock: e.svc.clock.bind(e.svc), publicDir: path.join(__dirname, '..', 'public') });
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const get = async (url, who) => (await fetch(base + url, { headers: { 'X-Party-Id': who } })).status;
  assert.equal(await get(`/api/cases/${cid}`, 'x'), 403);
  assert.equal(await get(`/api/photos/${pid}`, 'x'), 403);
  const list = await (await fetch(base + '/api/cases', { headers: { 'X-Party-Id': 'x' } })).json();
  assert.equal(list.data.length, 0, '外人案件列表为空');
  server.close();
});

test('陈述：本人只能陈述自己，物业才可代录；对方陈述不可修改删除', () => {
  const e = env();
  const cid = fullCase(e);
  // 住户不能代录
  assert.throws(() => e.svc.addStatement(cid, 'r',
    { source: '物业代录', forParty: 'u', description: '替楼上说' }), /仅物业可代录/);
  // 物业代录楼上 → party_id 记为楼上
  e.svc.addStatement(cid, 'm', { source: '物业代录', forParty: 'u', description: '楼上称无积水' });
  const s = e.db.prepare('SELECT * FROM statements WHERE case_id=?').get(cid);
  assert.equal(s.party_id, 'u');
  assert.equal(s.source, '物业代录');
  // 数据库层：改删任何陈述都被触发器拒绝（报修方不能改对方陈述）
  assert.throws(() => e.db.prepare('UPDATE statements SET description=? WHERE id=?').run('篡改', s.id), /不可修改/);
  assert.throws(() => e.db.prepare('DELETE FROM statements WHERE id=?').run(s.id), /禁止删除/);
  // 勘查员不能提交住户陈述
  assert.throws(() => e.svc.addStatement(cid, 'i', { description: '越权' }), /仅住户本人/);
});

test('权限：勘查人不能独自批准赔偿，未签齐也不能批准', () => {
  const e = env();
  const cid = fullCase(e);
  e.svc.addEvidenceNote(cid, 'i', 'x');
  const v = e.svc.freezeVersion(cid, 'i', 'v1');
  const pr = e.svc.createProposal(cid, 'n', { evidenceVersionId: v.id });
  e.svc.addProposalItem(cid, pr, 'n', { partyId: 'u', title: 't', amountCents: 100, basis: 'b' });
  e.svc.finalizeProposal(cid, pr, 'n');
  // 勘查人批准 → 角色拒绝
  assert.throws(() => e.svc.approveProposal(cid, pr, 'i'), /需要角色/);
  // 报修户批准 → 角色拒绝
  assert.throws(() => e.svc.approveProposal(cid, pr, 'r'), /需要角色/);
  // 协商员在未签齐时批准 → 拒绝
  assert.throws(() => e.svc.approveProposal(cid, pr, 'n'), /尚未全部签署/);
  e.svc.signProposal(cid, pr, 'u', { action: 'signed', docVersion: 1 });
  const approved = e.svc.approveProposal(cid, pr, 'n');
  assert.equal(approved.status, 'approved');
});

test('方案签署冲突：修订号不一致、重复签署、拒签与重新协商新版本', () => {
  const e = env();
  const cid = fullCase(e);
  e.svc.addEvidenceNote(cid, 'i', 'ev');
  const v1 = e.svc.freezeVersion(cid, 'i', 'v1');
  const pr = e.svc.createProposal(cid, 'n', { evidenceVersionId: v1.id });
  e.svc.addProposalItem(cid, pr, 'n', { partyId: 'u', title: '费用', amountCents: 50000, basis: 'v1' });
  e.svc.finalizeProposal(cid, pr, 'n');

  // 拿着旧文本（修订号 0）签当前文档（修订号 1）→ 冲突
  assert.throws(() => e.svc.signProposal(cid, pr, 'u', { action: 'signed', docVersion: 0 }),
    /方案签署冲突/);
  // 正常签署
  e.svc.signProposal(cid, pr, 'u', { action: 'signed', docVersion: 1 });
  // 重复签署 → 冲突
  assert.throws(() => e.svc.signProposal(cid, pr, 'u', { action: 'signed', docVersion: 1 }), /已签署/);
  // 签署记录不可改
  const sig = e.db.prepare('SELECT id FROM proposal_signatures WHERE proposal_id=?').get(pr).id;
  assert.throws(() => e.db.prepare('UPDATE proposal_signatures SET action=? WHERE id=?').run('rejected', sig), /不可修改/);

  // 另一方案演示拒签：费用不认可留结论，方案锁定，只能出新版本
  const pr2 = e.svc.createProposal(cid, 'n', { evidenceVersionId: v1.id });
  e.svc.addProposalItem(cid, pr2, 'n', { partyId: 'u', title: '费用2', amountCents: 90000, basis: 'v1' });
  e.svc.finalizeProposal(cid, pr2, 'n');
  e.svc.signProposal(cid, pr2, 'u', { action: 'rejected', docVersion: 1, note: '金额不认可' });
  const row = e.db.prepare('SELECT status FROM proposals WHERE id=?').get(pr2);
  assert.equal(row.status, 'rejected');
  assert.ok(e.svc.caseDetail(cid, 'n').conclusions.some(c => c.kind === 'cost_dispute'));
  // 被拒方案不可再签 / 批准
  assert.throws(() => e.svc.signProposal(cid, pr2, 'r', { action: 'signed', docVersion: 1 }), /不可签署/);
  assert.throws(() => e.svc.approveProposal(cid, pr2, 'n'), /不能批准|拒签/);
  // 定稿后不可加费用项（锁定）
  assert.throws(() => e.svc.addProposalItem(cid, pr, 'n', { partyId: 'u', title: 'x', amountCents: 1, basis: 'x' }),
    /不可修改|已定稿/);
});

test('修复复验：失败则旧案封存+再开案并继承证据，通过才关闭；再开案后可重新协商关闭', () => {
  const e = env();
  const { cid, rid, version } = approvedCase(e);
  e.at('2026-10-10T10:00:00+08:00');
  const res = e.svc.verify(cid, 'i', {
    repairId: rid, result: 'fail', dryDays: 3, observed: '原位复漏',
  });
  assert.ok(res.reopened, '应返回新案');
  const parent = e.db.prepare('SELECT * FROM cases WHERE id=?').get(cid);
  assert.equal(parent.status, 'closed_reopened');
  const child = res.reopened;
  assert.equal(child.status, 'open');
  assert.equal(child.parent_case_id, cid);
  assert.equal(child.root_case_id, cid);
  assert.equal(child.reopen_seq, 1);

  // 继承：版本、照片、已入册证据都带到新案（新 id、旧案记录不动）
  const cv = e.db.prepare('SELECT COUNT(*) c FROM evidence_versions WHERE case_id=?').get(child.id).c;
  assert.equal(cv, 1, '继承 1 个证据版本');
  const ci = e.db.prepare('SELECT COUNT(*) c FROM evidence_items WHERE case_id=?').get(child.id).c;
  assert.equal(ci, 1, '继承已入册证据');
  const cp = e.db.prepare('SELECT COUNT(*) c FROM photos WHERE case_id=?').get(child.id).c;
  assert.equal(cp, 1, '继承照片引用（共用本地文件）');
  // 旧案复漏结论保留
  assert.ok(e.svc.caseDetail(cid, 'n').conclusions.some(c => c.kind === 'releak'));
  // 事件链：新案首事件为再开案，旧案有链接事件
  assert.equal(e.db.prepare("SELECT type FROM events WHERE case_id=? ORDER BY seq LIMIT 1").get(child.id).type, 'case_reopened');

  // 新案上累积新证据 → 新版本 → 新方案（旧方案原样保留在旧案）
  e.svc.addEvidenceNote(child.id, 'i', '暗管第二漏点');
  const vNew = e.svc.freezeVersion(child.id, 'i', 'v3');
  assert.equal(vNew.version, 2, '新案在继承版本号之后继续编号');
  const prN = e.svc.createProposal(child.id, 'n', { evidenceVersionId: vNew.id, repairPlan: ['换管'] });
  e.svc.addProposalItem(child.id, prN, 'n', { partyId: 'u', title: '管材差价', amountCents: 0, basis: '质保返工' });
  e.svc.finalizeProposal(child.id, prN, 'n');
  e.svc.signProposal(child.id, prN, 'u', { action: 'signed', docVersion: 1 });
  e.svc.approveProposal(child.id, prN, 'n');
  const r2 = e.svc.startRepair(child.id, 'm', { proposalId: prN, contractor: '返工班组' });
  e.svc.finishRepair(child.id, r2, 'm');
  const res2 = e.svc.verify(child.id, 'i', { repairId: r2, result: 'pass', dryDays: 8, observed: '干燥' });
  assert.equal(res2.reopened, null);
  assert.equal(e.db.prepare('SELECT status FROM cases WHERE id=?').get(child.id).status, 'closed');
  // 旧案始终封存只读
  assert.equal(e.db.prepare('SELECT status FROM cases WHERE id=?').get(cid).status, 'closed_reopened');

  // 模拟适配器写了通知与签收
  assert.ok(fs.existsSync(path.join(e.dir, 'adapters', 'mock-adapter.log')));
  const log = fs.readFileSync(path.join(e.dir, 'adapters', 'mock-adapter.log'), 'utf8');
  assert.match(log, /复漏重开通知/);
  assert.match(log, /RECEIPT reopen/);
});

test('入户拒绝：自动保留「拒绝入户」结论并阻塞排查阶段', () => {
  const e = env();
  const cid = fullCase(e);
  const aid = e.svc.requestAppointment(cid, 'm', { targetParty: 'u', scheduledAt: '2026-10-02T19:00:00+08:00' });
  // 非被约住户不能回复
  assert.throws(() => e.svc.respondAppointment(cid, aid, 'r', { status: 'accepted' }), /被预约住户/);
  e.svc.respondAppointment(cid, aid, 'u', { status: 'refused', note: '不让进' });
  const d = e.svc.caseDetail(cid, 'm');
  assert.ok(d.conclusions.some(c => c.kind === 'access_refused'));
  const insp = d.work_stages.find(s => s.stage === 'inspection');
  assert.equal(insp.status, 'blocked');
  // 适配器发出了预约短信
  const ntf = e.db.prepare("SELECT COUNT(*) c FROM notifications WHERE channel='sms' AND to_party='u'").get().c;
  assert.ok(ntf >= 1);
});

test('种子复漏案例：六种特殊结论齐全，旧案封存/新案关闭，方案 v1 拒签 v2 批准', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leak-seed-'));
  const db = openDb(path.join(dir, 's.db'));
  const adp = adapters(db, path.join(dir, 'adapters'));
  const r = seed(db, adp, path.join(dir, 'photos'), { reset: true });
  assert.equal(r.skipped, false);
  const A = db.prepare('SELECT * FROM cases WHERE code=?').get('LS-2026-0907');
  const R = db.prepare('SELECT * FROM cases WHERE parent_case_id=?').get(A.id);
  assert.equal(A.status, 'closed_reopened');
  assert.equal(R.status, 'closed');
  const kinds = new Set(db.prepare('SELECT kind FROM conclusions WHERE case_id=?').all(A.id).map(x => x.kind));
  for (const k of ['source_unlocated', 'multi_room_leak', 'access_refused', 'stale_photo', 'releak', 'cost_dispute', 'responsibility'])
    assert.ok(kinds.has(k), `应包含结论 ${k}`);
  const p1 = db.prepare('SELECT status FROM proposals WHERE case_id=? AND version=1').get(A.id).status;
  const p2 = db.prepare('SELECT status FROM proposals WHERE case_id=? AND version=2').get(A.id).status;
  assert.equal(p1, 'rejected');
  assert.equal(p2, 'approved');
  // 责任意见全部带版本引用
  const noVer = db.prepare("SELECT COUNT(*) c FROM conclusions WHERE case_id=? AND kind='responsibility' AND evidence_version_id IS NULL")
    .get(A.id).c +
    db.prepare("SELECT COUNT(*) c FROM conclusions WHERE case_id=? AND kind='responsibility' AND evidence_version_id IS NULL")
      .get(R.id).c;
  assert.equal(noVer, 0);
  // 事件链仅追加且连续
  const seqs = db.prepare('SELECT seq FROM events WHERE case_id=? ORDER BY seq').all(A.id).map(x => x.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1));
});
