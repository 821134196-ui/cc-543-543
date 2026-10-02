'use strict';
// 种子数据：构造一条完整「报修→拒绝入户→分阶段排查→误用旧照→责任意见→
// 费用争议→重新协商→签署批准→修复→复验失败复漏→再开案→复验通过」事件链。
const fs = require('node:fs');
const path = require('node:path');
const { generate } = require('./png');
const { Service } = require('./service');

function iso(day, hm) {
  return `2026-09-${String(day).padStart(2, '0')}T${hm}:00+08:00`;
}
function isoOct(day, hm) {
  return `2026-10-${String(day).padStart(2, '0')}T${hm}:00+08:00`;
}

function seed(db, adapters, photoDir, { reset = false } = {}) {
  const existing = db.prepare("SELECT COUNT(*) c FROM cases").get().c;
  if (existing && !reset) return { skipped: true };

  let cur = iso(20, '08:00');
  const clock = () => cur;
  const at = (s) => { cur = s; };

  const svc = new Service(db, adapters, { photoDir, clock });

  function photo(opts) {
    const buf = generate(opts);
    return { buffer: buf, filename: opts.name || 'scene.png' };
  }

  const putParty = (id, role, name, unit, building) =>
    db.prepare('INSERT INTO parties (id, role, name, unit, building) VALUES (?,?,?,?,?)')
      .run(id, role, name, unit ?? null, building ?? null);

  // ---- 3号楼 601/701 当事人 ----
  putParty('p_601', 'resident_reporter', '周敏（3栋601）', '3栋601', '3栋');
  putParty('p_701', 'resident_up', '吴建国（3栋701）', '3栋701', '3栋');
  putParty('p_mgr', 'manager', '林芳·物业管家', null, '3栋');
  putParty('p_insp', 'inspector', '赵磊·维修勘查', null, '3栋');
  putParty('p_neg', 'negotiator', '陈静·协商员', null, '3栋');
  putParty('p_org', 'manager', '和景物业·3号楼服务中心', null, '3栋');

  // ---- 2号楼 502/602（用于跨户隐私隔离）----
  putParty('p_502', 'resident_reporter', '孙莉（2栋502）', '2栋502', '2栋');
  putParty('p_602', 'resident_up', '郑海（2栋602）', '2栋602', '2栋');

  // ============ 案件 A：3栋 601/701（复漏主案例）============
  at(iso(20, '08:52'));
  const A = svc.createCase({
    code: 'LS-2026-0907', building: '3栋',
    title: '3栋601天花板渗漏排查',
    unitReporter: '3栋601', unitUp: '3栋701',
    floorReporter: 6, floorUp: 7,
    members: ['p_601', 'p_701', 'p_mgr', 'p_insp', 'p_neg', 'p_org'],
    actor: 'p_mgr',
  });

  // ① 物业登记 + 各方描述（只追加，不可改）
  at(iso(20, '08:55'));
  svc.addStatement(A.id, 'p_601', {
    location: '主卧靠窗天花板、次卧顶角',
    damagedParts: ['主卧吊顶腻子', '次卧顶角墙面', '主卧木地板（边缘泡水）'],
    description: '凌晨发现主卧天花板滴水，拿盆接了一夜；早上次卧顶角也湿了，两个房间同时漏。',
  });
  at(iso(20, '09:10'));
  svc.addStatement(A.id, 'p_mgr', {
    source: '物业代录', forParty: 'p_701',
    location: '3栋701户内',
    damagedParts: [],
    description: '701称家里地面没有积水，最近没动过水管，认为不是自己家的问题。（物业代录）',
  });
  at(iso(20, '09:15'));
  svc.addConclusion(A.id, 'p_mgr', {
    kind: 'multi_room_leak', title: '多个房间同时渗漏',
    detail: '主卧与次卧同时出现渗水，水源暂不能凭单点判断，需关阀与分区试水排查。',
  });

  // ② 现场照片（不同比例，保留原图）
  const phCeil = photo({ name: 'master-ceiling.png', width: 800, height: 600,
    base: [224, 227, 230], stain: [63, 99, 116],
    spots: [{ fx: 0.46, fy: 0.4, r: 0.17, alpha: 0.6 }, { fx: 0.62, fy: 0.62, r: 0.05, alpha: 0.35 }] });
  at(iso(20, '09:03'));
  const ceilId = svc.addPhoto(A.id, 'p_601', { ...phCeil, room: '主卧', caption: '主卧靠窗天花板水渍，持续滴水', takenAt: iso(20, '08:48') });

  const phCorner = photo({ name: 'second-bedroom.png', width: 600, height: 800,
    base: [228, 229, 226], stain: [74, 108, 122],
    spots: [{ fx: 0.3, fy: 0.22, r: 0.13, alpha: 0.55 }] });
  at(iso(20, '09:05'));
  const cornerId = svc.addPhoto(A.id, 'p_601', { ...phCorner, room: '次卧', caption: '次卧顶角新发潮痕', takenAt: iso(20, '08:50') });

  // 旧照片（今年3月第一次报修时拍，后被误收入证据）
  const phOld = photo({ name: 'old-march.png', width: 640, height: 480,
    base: [214, 214, 210], stain: [96, 110, 112],
    spots: [{ fx: 0.5, fy: 0.55, r: 0.2, alpha: 0.3 }] });
  at(iso(20, '09:40'));
  const oldId = svc.addPhoto(A.id, 'p_mgr', { ...phOld, room: '主卧', caption: '档案夹内历史照片（拍摄于3月）', takenAt: iso(18, '10:02') });

  svc.annotatePhoto(ceilId, 'p_601', { x: 0.46, y: 0.4, text: '滴水点（接水盆位置）' });
  svc.annotatePhoto(cornerId, 'p_insp', { x: 0.3, y: 0.22, text: '潮痕沿管线方向延伸' });

  // ③ 入户预约：先被拒绝（结论保留），改约后成行
  at(iso(20, '09:20'));
  const apt1 = svc.requestAppointment(A.id, 'p_mgr', {
    targetParty: 'p_701', scheduledAt: iso(20, '19:00'), reason: '首次入户查看管根与地面含水',
  });
  at(iso(20, '11:30'));
  svc.respondAppointment(A.id, apt1, 'p_701', { status: 'refused', note: '最近加班没空，不要动我家管子，漏的是她家吊顶。' });

  at(iso(22, '10:02'));
  const apt2 = svc.requestAppointment(A.id, 'p_mgr', {
    targetParty: 'p_701', scheduledAt: iso(23, '09:00'), reason: '关阀排查+卫生间闭水，物业全程在场',
  });
  at(iso(22, '12:15'));
  svc.respondAppointment(A.id, apt2, 'p_701', { status: 'accepted', note: '周末可以，但要当天恢复供水。' });

  // ④ 分阶段维修：关阀 → 排查 → 试水
  at(iso(23, '09:05'));
  svc.setStage(A.id, 'p_insp', 'valve', 'in_progress', '关闭701户内给水总阀');
  at(iso(23, '09:20'));
  svc.setStage(A.id, 'p_insp', 'valve', 'done', '总阀已关，压力表串接');

  const phGauge = photo({ name: 'gauge.png', width: 800, height: 450,
    base: [210, 216, 220], stain: [80, 100, 110], spots: [{ fx: 0.5, fy: 0.5, r: 0.22, alpha: 0.18 }] });
  const gaugeId = svc.addPhoto(A.id, 'p_insp', { ...phGauge, room: '701厨房', caption: '给水管保压0.8MPa，30分钟压降0.01MPa', takenAt: iso(23, '09:55') });

  at(iso(23, '10:00'));
  svc.addWaterTest(A.id, 'p_insp', {
    method: '给水管道保压', zone: '701全屋给水管',
    startedAt: iso(23, '09:25'), endedAt: iso(23, '09:55'),
    result: 'inconclusive', observedAt: iso(23, '09:55'),
    note: '压降在允许误差边缘，且601顶板仍慢渗，无法据此定位水源。',
  });
  at(iso(23, '10:05'));
  svc.addConclusion(A.id, 'p_insp', {
    kind: 'source_unlocated', title: '水源暂时无法定位',
    detail: '保压结果不明确，关阀后顶板仍慢渗；不能排除防水/立管/雨水多种来源，须继续闭水与分区测试。',
  });

  const phPipe = photo({ name: 'pipe-root.png', width: 700, height: 700,
    base: [212, 214, 214], stain: [58, 96, 116],
    spots: [{ fx: 0.55, fy: 0.58, r: 0.14, alpha: 0.7 }, { fx: 0.4, fy: 0.4, r: 0.04, alpha: 0.4 }] });
  at(iso(23, '14:40'));
  const pipeId = svc.addPhoto(A.id, 'p_insp', { ...phPipe, room: '701主卫', caption: '主卫地漏与立管管根周边长期潮湿，防水层发鼓', takenAt: iso(23, '14:35') });
  svc.annotatePhoto(pipeId, 'p_insp', { x: 0.55, y: 0.58, text: '管根积水，闭水15分钟下渗' });

  at(iso(23, '15:20'));
  svc.addWaterTest(A.id, 'p_insp', {
    method: '卫生间地面闭水', zone: '701主卫',
    startedAt: iso(23, '13:00'), endedAt: iso(23, '15:00'),
    result: 'positive', observedAt: iso(23, '14:35'),
    leakPoint: '701主卫地漏/立管管根防水层',
    note: '闭水2小时后601主卧顶板渗漏明显增大，点位与管根投影重合。',
  });
  svc.setStage(A.id, 'p_insp', 'inspection', 'done', '定位：701主卫防水层老化，管根处下渗');

  // ⑤ 证据成册：新证据 + 误用的旧照片 → 质疑标记 → 冻结 v1
  at(iso(23, '16:00'));
  svc.addEvidencePhoto(A.id, 'p_insp', ceilId, '601主卧顶板滴水（报修当日）');
  svc.addEvidencePhoto(A.id, 'p_insp', cornerId, '601次卧顶角潮痕');
  svc.addEvidencePhoto(A.id, 'p_insp', gaugeId, '给水管保压记录');
  svc.addEvidencePhoto(A.id, 'p_insp', pipeId, '701主卫管根潮湿点');
  const oldItem = svc.addEvidencePhoto(A.id, 'p_mgr', oldId, '历史情况照片（拟附卷）');
  svc.addEvidenceNote(A.id, 'p_insp', '两次试水记录：保压不明确、闭水阳性；漏点与701主卫管根重合。');

  at(iso(24, '09:30'));
  svc.flagStale(A.id, 'p_insp', oldItem,
    '该照片拍摄于2026-03-18上次报修，现状已变化，被误当作本次现场照附卷；不得作为本次责任判断依据。');
  at(iso(24, '10:00'));
  const v1 = svc.freezeVersion(A.id, 'p_insp', '勘查证据 v1（关阀/试水/现场照）',
    '含旧照质疑标记；旧照仅留档、不采信');

  // 责任意见必须引用当时证据版本
  at(iso(24, '10:30'));
  svc.addConclusion(A.id, 'p_insp', {
    kind: 'responsibility', title: '责任意见（依据证据 v1）',
    detail: '闭水试验阳性且漏点投影重合，认定701主卫防水层老化为本次渗漏主要水源；给水保压不构成漏水证据；2026-03历史照片不采信。建议701重做主卫防水并修复601顶板。',
    evidenceVersionId: v1.id,
  });

  // ⑥ 协商方案 v1：费用按责任项列明 → 701不认可 → 拒签
  at(iso(25, '14:00'));
  const pr1 = svc.createProposal(A.id, 'p_neg', {
    evidenceVersionId: v1.id,
    responsibilitySummary: '依据证据 v1：701主卫防水层老化负主要责任；物业已尽排查义务。',
    repairPlan: ['拆除701主卫地砖及老化防水层', '管根节点加强处理，重做闭水', '恢复601主卧/次卧顶板腻子涂料'],
    warrantyUntil: '2027-10-08',
  });
  svc.addProposalItem(A.id, pr1, 'p_neg', {
    partyId: 'p_701', title: '主卫防水重做（含拆除/找平/防水/闭水）',
    amountCents: 380000, basis: '责任意见·证据 v1：闭水阳性，701主卫防水层为漏点',
  });
  svc.addProposalItem(A.id, pr1, 'p_neg', {
    partyId: 'p_701', title: '601顶板及墙面腻子涂料修复',
    amountCents: 120000, basis: '责任意见·证据 v1：渗漏导致楼下受损恢复费用',
  });
  at(iso(25, '14:30'));
  svc.finalizeProposal(A.id, pr1, 'p_neg');
  at(iso(26, '10:00'));
  svc.signProposal(A.id, pr1, 'p_601', { action: 'signed', docVersion: 1, note: '认可勘查与金额。' });
  at(iso(26, '15:10'));
  svc.signProposal(A.id, pr1, 'p_701', { action: 'rejected', docVersion: 1, note: '防水我可以修，但601墙面翻新只认一半，凭什么全算我的。' });

  // ⑦ 新证据（再闭水复测确认波及范围）只能触发重新协商 → 证据 v2 → 方案 v2
  at(iso(27, '09:00'));
  svc.addEvidenceNote(A.id, 'p_insp', '复测补充：管根节点渗漏量与次卧顶角潮痕存在连通路径，墙面受损范围未扩大。');
  svc.addEvidencePhoto(A.id, 'p_insp', pipeId, '复测同点位照片（沿用已上传原图）');
  at(iso(27, '09:30'));
  const v2 = svc.freezeVersion(A.id, 'p_neg', '协商补充证据 v2', '复测连通路径说明，用于费用重新协商');

  at(iso(27, '10:00'));
  const pr2 = svc.createProposal(A.id, 'p_neg', {
    evidenceVersionId: v2.id,
    responsibilitySummary: '依据证据 v2：701负防水主责；物业承担公共立管检测与协调修复部分费用，促成修复。',
    repairPlan: ['701主卫防水重做并闭水合格', '601顶板墙面修复', '物业负责立管检测及质保期内跟踪'],
    warrantyUntil: '2028-10-20',
  });
  svc.addProposalItem(A.id, pr2, 'p_neg', {
    partyId: 'p_701', title: '主卫防水重做', amountCents: 360000,
    basis: '证据 v2 责任意见：防水主责在701（较v1核减200元，拆除垃圾清运由物业承担）',
  });
  svc.addProposalItem(A.id, pr2, 'p_neg', {
    partyId: 'p_org', title: '公共立管检测+601墙面修复补贴', amountCents: 60000,
    basis: '证据 v2：立管排查由物业实施；为促成邻里修复，物业承担600墙面费用的一半',
  });
  at(iso(27, '11:00'));
  svc.finalizeProposal(A.id, pr2, 'p_neg');
  at(iso(27, '19:30'));
  svc.signProposal(A.id, pr2, 'p_701', { action: 'signed', docVersion: 1, note: '这个分担可以接受。' });
  svc.signProposal(A.id, pr2, 'p_org', { action: 'signed', docVersion: 1, note: '服务中心确认承担。' });
  svc.signProposal(A.id, pr2, 'p_601', { action: 'signed', docVersion: 1, note: '同意，要求质保两年。' });
  at(iso(28, '09:00'));
  svc.approveProposal(A.id, pr2, 'p_neg'); // 勘查人无权批准，由协商员批准

  // ⑧ 修复施工
  at(isoOct(8, '08:40'));
  const rep1 = svc.startRepair(A.id, 'p_mgr', {
    proposalId: pr2, contractor: '老杨防水班组', scope: '701主卫防水重做+601顶墙面修复',
  });
  at(isoOct(9, '17:30'));
  svc.finishRepair(A.id, rep1, 'p_mgr');

  // ⑨ 复验：失败（复漏）→ 旧案关闭并开新案
  const phReleak = photo({ name: 'releak.png', width: 600, height: 800,
    base: [224, 226, 228], stain: [52, 90, 110],
    spots: [{ fx: 0.34, fy: 0.3, r: 0.12, alpha: 0.75 }] });
  at(isoOct(16, '10:20'));
  const releakId = svc.addPhoto(A.id, 'p_601', { ...phReleak, room: '次卧', caption: '修复7天后次卧顶角再次滴水', takenAt: isoOct(16, '09:50') });
  const vfail = svc.verify(A.id, 'p_insp', {
    repairId: rep1, result: 'fail', dryDays: 7,
    observed: '次卧顶角原位附近再次滴水，主卫闭水合格但淋浴时渗漏加重。',
    photoId: releakId,
  });
  const B = vfail.reopened;
  // 复漏照片已随案件链继承克隆到新案（同一本地文件，新案独立引用）
  const releakInB = db.prepare("SELECT id FROM photos WHERE case_id=? AND taken_at=? ORDER BY uploaded_at LIMIT 1")
    .get(B.id, isoOct(16, '09:50')).id;

  // ============ 案件 B：复漏再开案 ============
  at(isoOct(16, '11:00'));
  svc.addStatement(B.id, 'p_701', {
    location: '主卫淋浴区',
    damagedParts: ['淋浴混水阀暗管'],
    description: '一开热水混水阀墙角就阴水，装修时的暗管没换过，这次配合修。',
  });
  svc.addEvidencePhoto(B.id, 'p_601', releakInB, '复漏当日次卧滴水照片');

  const phHidden = photo({ name: 'hidden-pipe.png', width: 720, height: 540,
    base: [210, 213, 215], stain: [56, 92, 112],
    spots: [{ fx: 0.42, fy: 0.5, r: 0.1, alpha: 0.7 }] });
  at(isoOct(16, '14:00'));
  const hiddenId = svc.addPhoto(B.id, 'p_insp', { ...phHidden, room: '701主卫', caption: '开凿后暗管接口渗漏点', takenAt: isoOct(16, '13:40') });
  svc.addWaterTest(B.id, 'p_insp', {
    method: '淋浴热水管分段打压', zone: '701主卫混水阀暗管',
    startedAt: isoOct(16, '13:00'), endedAt: isoOct(16, '13:50'),
    result: 'positive', observedAt: isoOct(16, '13:40'),
    leakPoint: '混水阀暗管接口', note: '首次排查防水层时暗管缺陷被防水漏点掩盖，属第二漏点。',
  });
  svc.addEvidencePhoto(B.id, 'p_insp', hiddenId, '暗管接口渗漏点（开凿确认）');
  const v3 = svc.freezeVersion(B.id, 'p_insp', '复漏勘查 v3（暗管漏点）', '新案在继承 v1/v2 基础上增补的新证据');
  svc.addConclusion(B.id, 'p_insp', {
    kind: 'responsibility', title: '复漏责任意见（依据证据 v3）',
    detail: '复漏为第二漏点：混水阀暗管接口老化，与首次防水漏点并存。701主责，物业在质保期内继续协调，施工班组承担返工费用。',
    evidenceVersionId: v3.id,
  });

  at(isoOct(17, '09:00'));
  const prB = svc.createProposal(B.id, 'p_neg', {
    evidenceVersionId: v3.id,
    responsibilitySummary: '依据证据 v3：暗管接口为复漏水源；返工费用由原施工班组承担，701配合开凿恢复。',
    repairPlan: ['更换混水阀暗管及接口并打压合格', '墙面瓷砖恢复', '601次卧顶角返工修复', '重做闭水+连续7天观察'],
    warrantyUntil: '2029-10-17',
  });
  svc.addProposalItem(B.id, prB, 'p_neg', {
    partyId: 'p_701', title: '暗管更换（业主自购管材差价）', amountCents: 30000,
    basis: '证据 v3：701户内暗管老化；施工返工与人工由班组承担，业主仅承担管材升级差价',
  });
  svc.addProposalItem(B.id, prB, 'p_neg', {
    partyId: 'p_org', title: '返工协调及601顶面返修（质保）', amountCents: 0,
    basis: '证据 v3：质保期内返工，物业督促班组承担人工与涂料，不向住户收取',
  });
  at(isoOct(17, '10:00'));
  svc.finalizeProposal(B.id, prB, 'p_neg');
  at(isoOct(17, '19:00'));
  svc.signProposal(B.id, prB, 'p_701', { action: 'signed', docVersion: 1 });
  svc.signProposal(B.id, prB, 'p_org', { action: 'signed', docVersion: 1 });
  svc.signProposal(B.id, prB, 'p_601', { action: 'signed', docVersion: 1 });
  at(isoOct(18, '09:00'));
  svc.approveProposal(B.id, prB, 'p_neg');

  at(isoOct(19, '08:30'));
  const rep2 = svc.startRepair(B.id, 'p_mgr', {
    proposalId: prB, contractor: '老杨防水班组（返工）', scope: '暗管更换+墙顶恢复',
  });
  at(isoOct(19, '17:00'));
  svc.finishRepair(B.id, rep2, 'p_mgr');

  const phDry = photo({ name: 'dry-ceiling.png', width: 800, height: 600,
    base: [232, 233, 232], stain: [120, 138, 142],
    spots: [{ fx: 0.4, fy: 0.35, r: 0.12, alpha: 0.08 }] });
  at(isoOct(27, '10:00'));
  const dryId = svc.addPhoto(B.id, 'p_insp', { ...phDry, room: '601次卧', caption: '连续观察8天，顶面干燥无新增水痕', takenAt: isoOct(27, '09:30') });
  svc.verify(B.id, 'p_insp', {
    repairId: rep2, result: 'pass', dryDays: 8,
    observed: '冷热水交替使用、闭水均无渗漏，顶面板干燥。', photoId: dryId,
  });

  // ============ 案件 C：2栋 502/602（独立在办案件，用于跨户隔离）============
  at(iso(28, '16:20'));
  const C = svc.createCase({
    code: 'LS-2026-0911', building: '2栋',
    title: '2栋502厨房吊顶渗漏',
    unitReporter: '2栋502', unitUp: '2栋602',
    floorReporter: 5, floorUp: 6,
    members: ['p_502', 'p_602', 'p_mgr', 'p_insp'],
    actor: 'p_mgr',
  });
  at(iso(28, '16:40'));
  svc.addStatement(C.id, 'p_502', {
    location: '厨房水槽上方吊顶',
    damagedParts: ['厨房铝扣板吊顶', '吊柜侧板'],
    description: '晚饭时吊顶缝往下滴水，吊柜里的米面受潮。',
  });
  svc.requestAppointment(C.id, 'p_mgr', {
    targetParty: 'p_602', scheduledAt: iso(29, '18:30'), reason: '厨房给水管排查',
  });

  return {
    skipped: false,
    caseA: A.id, caseB: B.id, caseC: C.id,
    proposalV1: pr1, proposalV2: pr2, proposalB: prB,
    versions: { v1: v1.id, v2: v2.id, v3: v3.id },
  };
}

module.exports = { seed };
