'use strict';
/* 渗漏台账前端：楼层叠放、证据时间线、等比照片标注、预约/试水、费用方案、复验 */
let PARTIES = [];
let CASES = [];
let CURRENT = null;
let me = null;

const STATUS_TEXT = { open: '在办', closed: '已关闭', closed_reopened: '已封存·转再开案' };
const ROLE_TEXT = {
  resident_reporter: '报修户（楼下）', resident_up: '楼上住户',
  manager: '物业', inspector: '勘查维修', negotiator: '协商员',
};
const EVENT_TEXT = {
  case_created: '立案登记', statement_added: '陈述/登记追加', photo_uploaded: '上传带时间照片',
  photo_annotated: '照片标注', evidence_added: '证据入册', evidence_version_frozen: '冻结证据版本',
  work_stage: '维修分阶段', appointment_requested: '入户预约', appointment_responded: '预约回复',
  water_test: '试水记录', conclusion_added: '形成结论',
  proposal_created: '起草协商方案', proposal_finalized: '方案定稿待签',
  proposal_signed: '方案签署/拒签', proposal_approved: '赔偿批准',
  repair_started: '修复开工', repair_finished: '修复完工',
  verification: '修复复验', case_closed: '复验通过关闭',
  case_reopened: '复漏再开案', case_reopened_link: '关联再开案',
};
const CONCL_TEXT = {
  source_unlocated: '水源暂时无法定位', multi_room_leak: '多个房间同时渗漏',
  access_refused: '住户拒绝入户', stale_photo: '旧照片被误用',
  releak: '修复后复漏', cost_dispute: '双方对费用不认可', responsibility: '责任意见',
};
const STAGE_TEXT = { valve: '关阀', inspection: '排查', water_test: '试水' };
const STAGE_STATUS = { planned: '计划', in_progress: '进行中', done: '完成', blocked: '受阻' };
const APT_STATUS = { requested: '待回复', accepted: '同意入户', refused: '拒绝入户', rescheduled: '改约', completed: '已完成', no_show: '爽约' };
const TEST_RESULT = { positive: '渗漏重现', negative: '未重现', inconclusive: '结果不明' };
const PROP_STATUS = { draft: '草稿', pending: '待签署', signed: '已签齐', rejected: '已拒签', approved: '已批准' };

async function init() {
  PARTIES = await Api.parties();
  const sel = document.getElementById('partySelect');
  sel.innerHTML = PARTIES.map(p => `<option value="${p.id}">${esc(p.name)}${p.unit ? '' : ''}</option>`).join('');
  if (!Api.getParty() || !PARTIES.some(p => p.id === Api.getParty())) Api.setParty(PARTIES[0].id);
  sel.value = Api.getParty();
  bindIdentity();
  document.getElementById('refreshBtn').onclick = loadAll;
  await loadAll();
}

function bindIdentity() {
  const sel = document.getElementById('partySelect');
  sel.onchange = async () => {
    Api.setParty(sel.value);
    CURRENT = null;
    await loadAll();
  };
}

async function loadAll() {
  me = PARTIES.find(p => p.id === Api.getParty());
  document.getElementById('partyRole').textContent = me ? (ROLE_TEXT[me.role] || me.role) : '';
  try {
    CASES = await Api.cases();
  } catch (e) {
    CASES = [];
    toast(e.message, 'err');
  }
  renderRail();
  if (CURRENT && CASES.some(c => c.id === CURRENT)) await openCase(CURRENT);
  else { CURRENT = null; document.getElementById('detail').innerHTML = '<div class="empty-hint">请选择左侧案件</div>'; }
}

function renderRail() {
  const ul = document.getElementById('caseList');
  if (!CASES.length) { ul.innerHTML = '<li class="muted" style="padding:8px;font-size:12px">当前身份没有关联案件。</li>'; return; }
  ul.innerHTML = CASES.map(c => `
    <li class="case-item ${c.id === CURRENT ? 'active' : ''}" data-id="${c.id}">
      <div class="case-code">${esc(c.code)}</div>
      <div class="case-title">${esc(c.title)}</div>
      <div class="case-meta">
        <span class="badge ${c.status}">${STATUS_TEXT[c.status] || c.status}</span>
        <span>${esc(c.unit_up)} ↔ ${esc(c.unit_reporter)}</span>
      </div>
    </li>`).join('');
  ul.querySelectorAll('.case-item').forEach(li => li.onclick = () => openCase(li.dataset.id));
}

async function openCase(id) {
  CURRENT = id;
  renderRail();
  let d;
  try { d = await Api.case(id); }
  catch (e) {
    document.getElementById('detail').innerHTML =
      `<div class="empty-hint">${esc(e.message)}<br><span class="mono">${esc(e.code || '')}</span></div>`;
    return;
  }
  document.getElementById('detail').innerHTML = renderDetail(d);
  bindDetail(d);
}

function memberName(d, pid) {
  const p = d.members.find(m => m.id === pid);
  return p ? p.name : (pid || '—');
}
function verMap(d) {
  const m = {}; d.evidence_versions.forEach(v => { m[v.id] = v; });
  return m;
}

function renderDetail(d) {
  const vm = verMap(d);
  return `
  <div class="detail-head">
    <div class="row">
      <h2>${esc(d.title)}</h2>
      <span class="badge ${d.status}">${STATUS_TEXT[d.status] || d.status}</span>
      <span class="case-code mono">${esc(d.code)}</span>
    </div>
    <div class="sub">报修登记 ${fmtTime(d.created_at)}${d.closed_at ? '　·　封存 ' + fmtTime(d.closed_at) : ''}　·　当前证据版本 v${d.current_evidence_version}</div>
    ${d.root_case_id ? `
    <div class="lineage">↻ 本案为复漏再开案（第 ${d.reopen_seq} 次），原案封存保留全部结论与方案；新证据只能触发重新协商。
      <button class="btn ghost small" id="gotoParent">查看原案链</button></div>` : ''}
    ${d.status === 'closed_reopened' ? `
    <div class="lineage">→ 复验发现复漏，已开新案 <b>${esc(d.code)}-R1</b>；本案作为责任与费用历史只读保留。</div>` : ''}
  </div>

  ${renderFloors(d)}

  <div class="two-col">
    ${renderStatements(d)}
    ${renderStages(d)}
  </div>

  <div class="section-grid">
    ${renderAppointments(d)}
    ${renderWaterTests(d)}
  </div>

  ${renderPhotos(d)}
  ${renderConclusions(d)}
  ${renderTimeline(d, vm)}
  ${renderProposals(d, vm)}
  ${renderRepairs(d)}
  ${renderActions(d)}
  `;
}

/* ---------- 楼层叠放 ---------- */
function renderFloors(d) {
  const upMember = d.members.find(m => m.role === 'resident_up');
  const downMember = d.members.find(m => m.role === 'resident_reporter');
  const wetRooms = [...new Set(d.photos.map(p => p.room).filter(Boolean))];
  return `<div class="card"><h3><span class="step-no">↕</span>楼层示意<span class="hint">上下楼位置叠放 · 漏点自上而下</span></h3>
    <div class="floors">
      <div class="floor up">
        <div class="floor-num">${d.floor_up}F</div>
        <div class="floor-unit">${esc(d.unit_up)}<small>${esc(upMember ? upMember.name : '楼上住户')} · 疑似水源层</small></div>
        <div class="floor-tags"><span class="pip">关阀/闭水在此层</span><span class="pip wet">主卫管根</span></div>
      </div>
      <div class="floor-gap">
        <svg class="leak-flow" viewBox="0 0 14 46" preserveAspectRatio="none">
          <path d="M7 0 C 2 12, 12 16, 7 26 C 3 34, 11 38, 7 46"/>
        </svg>
        <span class="gap-label">渗流路径${d.conclusions.some(c => c.kind === 'source_unlocated') ? '（水源待定位）' : ''}</span>
      </div>
      <div class="floor down">
        <div class="floor-num">${d.floor_reporter}F</div>
        <div class="floor-unit">${esc(d.unit_reporter)}<small>${esc(downMember ? downMember.name : '报修户')} · 受损层</small></div>
        <div class="floor-tags">
          ${wetRooms.slice(0, 4).map(r => `<span class="pip wet">${esc(r)}见水印</span>`).join('')}
        </div>
      </div>
    </div>
  </div>`;
}

/* ---------- 陈述 ---------- */
function renderStatements(d) {
  return `<div class="card"><h3><span class="step-no">1</span>登记与各方描述<span class="hint">只可追加，任何人不能修改对方陈述</span></h3>
    ${d.statements.length ? d.statements.map(s => `
      <div style="border-left:3px solid var(--aqua-tint);padding:2px 0 10px 12px;margin-bottom:8px">
        <div><b>${esc(memberName(d, s.party_id))}</b>
          <span class="badge gray">${esc(s.source)}</span>
          <span class="mono">${fmtTime(s.created_at)}</span></div>
        ${s.location ? `<div class="muted" style="font-size:12.5px">位置：${esc(s.location)}</div>` : ''}
        ${(() => { const parts = JSON.parse(s.damaged_parts || '[]'); return parts.length ? `<div class="muted" style="font-size:12.5px">受损部位：${parts.map(esc).join('、')}</div>` : ''; })()}
        <div style="font-size:13px;margin-top:2px">${esc(s.description)}</div>
      </div>`).join('') : '<p class="muted">暂无陈述</p>'}
  </div>`;
}

/* ---------- 阶段 ---------- */
function renderStages(d) {
  const byStage = {};
  d.work_stages.forEach(s => { byStage[s.stage] = s; });
  return `<div class="card"><h3><span class="step-no">3</span>分阶段维修<span class="hint">关阀 → 排查 → 试水</span></h3>
    <div class="stage-row">
      ${['valve', 'inspection', 'water_test'].map(k => {
        const s = byStage[k];
        return `<div class="stage">
          <div class="name">${STAGE_TEXT[k]}</div>
          <span class="st ${s ? s.status : 'planned'}">${s ? STAGE_STATUS[s.status] : '未开始'}</span>
          <div class="note">${esc(s ? s.note : '—')}</div>
          ${s && s.started_at ? `<div class="when">${fmtTime(s.started_at)}${s.finished_at ? ' → ' + fmtTime(s.finished_at) : ''}</div>` : ''}
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

/* ---------- 预约 ---------- */
function renderAppointments(d) {
  return `<div class="card"><h3><span class="step-no">2</span>入户预约<span class="hint">拒绝入户会作为结论保留</span></h3>
    <table class="data">
      <thead><tr><th>预约时间</th><th>对象</th><th>状态</th><th>事由/回复</th></tr></thead>
      <tbody>
      ${d.appointments.length ? d.appointments.map(a => `
        <tr>
          <td class="mono">${fmtTime(a.scheduled_at)}</td>
          <td>${esc(memberName(d, a.target_party))}</td>
          <td><span class="st ${a.status}">${APT_STATUS[a.status] || a.status}</span></td>
          <td>${esc(a.reason || '')}${a.response_note ? `<div class="muted">回复：${esc(a.response_note)}</div>` : ''}</td>
        </tr>`).join('') : '<tr><td colspan="4" class="muted">暂无预约</td></tr>'}
      </tbody>
    </table>
  </div>`;
}

/* ---------- 试水 ---------- */
function renderWaterTests(d) {
  return `<div class="card"><h3><span class="step-no">4</span>试水记录</h3>
    <table class="data">
      <thead><tr><th>方法/区域</th><th>结果</th><th>时间</th><th>漏点/说明</th></tr></thead>
      <tbody>
      ${d.water_tests.length ? d.water_tests.map(t => `
        <tr>
          <td><b>${esc(t.method)}</b><div class="muted">${esc(t.zone)}</div></td>
          <td><span class="st ${t.result}">${TEST_RESULT[t.result] || t.result}</span></td>
          <td class="mono">${fmtTime(t.started_at)}<br>${t.ended_at ? '→ ' + fmtTime(t.ended_at) : ''}</td>
          <td>${esc(t.leak_point || t.note || '—')}</td>
        </tr>`).join('') : '<tr><td colspan="4" class="muted">暂无试水</td></tr>'}
      </tbody>
    </table>
  </div>`;
}

/* ---------- 照片（原比例 + 标注）---------- */
function renderPhotos(d) {
  return `<div class="card"><h3><span class="step-no">5</span>漏点照片<span class="hint">保持原始比例（白/棋盘底），点击照片任意位置可加标注；原文件不修改</span></h3>
    <div class="photo-grid">
      ${d.photos.map(p => {
        const marks = JSON.parse(p.annotations || '[]');
        const stale = /2026-03|历史/.test(p.caption || '');
        return `<div class="photo-cell">
          <div class="photo-frame" data-photo="${p.id}">
            <img src="/api/photos/${p.id}?as=${encodeURIComponent(me.id)}" alt="${esc(p.caption || '')}"
              data-w="${p.width}" data-h="${p.height}">
            ${marks.map(m => `
              <div class="mark" style="left:${m.x * 100}%;top:${m.y * 100}%">
                <span class="dot"></span><span class="tag">${esc(m.text)}</span>
              </div>`).join('')}
          </div>
          <div class="photo-meta">
            <div class="cap ${stale ? 'stale' : ''}">${stale ? '⚠ ' : ''}${esc(p.caption || '现场照片')}</div>
            <div>${esc(p.room || '')}</div>
            <div class="time">拍摄 ${fmtTime(p.taken_at)} · 上传 ${fmtTime(p.uploaded_at)}</div>
            <div class="dim">原始尺寸 ${p.width}×${p.height}（比例 ${(p.width / p.height).toFixed(2)}）· 标注 ${marks.length} 处</div>
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

/* ---------- 结论 ---------- */
function renderConclusions(d) {
  const vm = verMap(d);
  return `<div class="card"><h3><span class="step-no">6</span>不同结论并存<span class="hint">水源未定位/多房间同漏/拒入户/旧照误用/复漏/费用争议各自留痕；责任意见锁定证据版本</span></h3>
    <div class="concl-grid">
      ${d.conclusions.map(c => `
        <div class="concl k-${c.kind}">
          <h4><span>${esc(CONCL_TEXT[c.kind] || c.title)}</span></h4>
          <p>${esc(c.detail || '')}</p>
          <div style="margin-top:6px">
            <span class="mono">${fmtTime(c.created_at)} · ${esc(memberName(d, c.author))}</span>
            ${c.evidence_version_id && vm[c.evidence_version_id] ? `<span class="ver-ref">引用 证据v${vm[c.evidence_version_id].version}</span>` : ''}
          </div>
        </div>`).join('')}
    </div>
  </div>`;
}

/* ---------- 时间线 ---------- */
function renderTimeline(d, vm) {
  const bad = new Set(['appointment_responded', 'proposal_signed', 'verification']);
  const ok = new Set(['case_closed', 'proposal_approved']);
  return `<div class="card"><h3><span class="step-no">7</span>证据与事件时间线<span class="hint">事件链仅追加 · 责任事件带证据版本戳</span></h3>
    <ul class="timeline">
      ${d.events.map(e => {
        let cls = 'key';
        const p = JSON.parse(e.payload || '{}');
        if ((e.type === 'proposal_signed' && p.action === 'rejected') ||
            (e.type === 'verification' && p.result === 'fail') ||
            (e.type === 'appointment_responded' && p.status === 'refused')) cls = 'bad';
        if (ok.has(e.type) || (e.type === 'verification' && p.result === 'pass')) cls = 'ok';
        const v = e.evidence_version_id && vm[e.evidence_version_id];
        return `<li class="${cls}">
          <span class="tl-time">${fmtTime(e.created_at)}</span><span class="tl-type">${EVENT_TEXT[e.type] || e.type}</span>
          <span class="tl-text">${esc(summarizeEvent(e.type, p))}</span>
          ${v ? `<span class="tl-ver">证据v${v.version}</span>` : ''}
        </li>`;
      }).join('')}
    </ul>
  </div>`;
}

function summarizeEvent(type, p) {
  switch (type) {
    case 'case_created': return `${p.building} ${p.unit_reporter} 报 ${p.unit_up} 渗漏`;
    case 'statement_added': return `${p.source || ''} ${p.location || ''}`;
    case 'photo_uploaded': return `${p.room || ''} 照片（拍摄于 ${p.taken_at ? fmtTime(p.taken_at) : ''}）`;
    case 'photo_annotated': return `标注「${p.text}」@(${p.x?.toFixed(2)},${p.y?.toFixed(2)})`;
    case 'evidence_version_frozen': return `冻结 v${p.version}，纳入 ${p.items?.length || 0} 条证据，此后不可修改`;
    case 'work_stage': return `${STAGE_TEXT[p.stage] || p.stage} → ${STAGE_STATUS[p.status] || p.status}${p.note ? '：' + p.note : ''}`;
    case 'appointment_requested': return `预约 ${fmtTime(p.scheduled_at)} 入户`;
    case 'appointment_responded': return APT_STATUS[p.status] || p.status;
    case 'water_test': return `${p.zone}：${TEST_RESULT[p.result] || p.result}${p.leak_point ? '，漏点 ' + p.leak_point : ''}`;
    case 'conclusion_added': return p.title;
    case 'proposal_created': return `方案 v${p.version}`;
    case 'proposal_finalized': return '进入待签署';
    case 'proposal_signed': return p.action === 'rejected' ? `拒签：${p.note || ''}` : '签署同意（文档修订号 ' + p.doc_version + '）';
    case 'proposal_approved': return '协商员批准赔偿';
    case 'repair_started': return '修复开工';
    case 'repair_finished': return '修复完工';
    case 'verification': return p.result === 'pass' ? `复验通过（干燥 ${p.dry_days ?? '?'} 天）` : `复验失败：${p.observed || '复漏'}`;
    case 'case_closed': return '案件关闭';
    case 'case_reopened': return `第 ${p.seq} 次再开案：${p.reason || ''}`;
    case 'case_reopened_link': return `转新案 R${p.seq}`;
    default: return '';
  }
}

/* ---------- 方案 ---------- */
function renderProposals(d, vm) {
  return `<div class="card"><h3><span class="step-no">8</span>协商方案与费用<span class="hint">按责任项列金额与依据；签署后不可改，新证据须出新版本</span></h3>
    ${d.proposals.length ? d.proposals.map(p => {
      const v = vm[p.evidence_version_id];
      const total = p.items.reduce((s, i) => s + i.amount_cents, 0);
      return `<div class="proposal">
        <div class="proposal-head">
          <h4>方案 v${p.version}</h4>
          <span class="st ${p.status === 'approved' ? 'positive' : p.status === 'rejected' ? 'refused' : 'inconclusive'}">${PROP_STATUS[p.status] || p.status}</span>
          <span class="ver-lock">依据 ${v ? '证据v' + v.version : '?'} · 文档修订号 1（定稿即锁定）</span>
          ${p.warranty_until ? `<span class="badge gray">质保至 ${esc(p.warranty_until)}</span>` : ''}
        </div>
        <div class="proposal-body">
          <div class="resp">责任认定：${esc(p.responsibility_summary || '—')}</div>
          ${p.repair_plan?.length ? `<ol class="plan-steps">${p.repair_plan.map(s => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
          <table class="data cost-table">
            <thead><tr><th>责任方</th><th>费用项</th><th style="text-align:right">金额</th><th>依据</th></tr></thead>
            <tbody>
              ${p.items.map(i => `<tr>
                <td>${esc(i.party_name)}<div class="muted">${esc(i.party_unit || '')}</div></td>
                <td>${esc(i.title)}</td>
                <td class="amount">${yuan(i.amount_cents)}</td>
                <td class="basis">${esc(i.basis)}</td>
              </tr>`).join('')}
              <tr class="total"><td colspan="2">合计</td><td class="amount">${yuan(total)}</td><td></td></tr>
            </tbody>
          </table>
          <div class="sig-row">
            ${p.signatures.length ? p.signatures.map(s =>
              `<span class="sig ${s.action}">${s.action === 'rejected' ? '✕ ' : '✓ '}${esc(s.party_name)} · 修订号${s.doc_version}${s.note ? '：' + esc(s.note) : ''}</span>`).join('')
              : '<span class="muted" style="font-size:12px">暂无签署</span>'}
          </div>
          ${renderProposalActions(d, p)}
        </div>
      </div>`;
    }).join('') : '<p class="muted">暂无方案</p>'}
  </div>`;
}

function renderProposalActions(d, p) {
  const isNeg = me.role === 'negotiator' || me.role === 'manager';
  const mine = p.items.some(i => i.party_id === me.id);
  const signedByMe = p.signatures.some(s => s.party_id === me.id);
  let html = '';
  if (p.status === 'draft' && isNeg) {
    html += `<details class="actbox"><summary>+ 增加费用责任项</summary>
      <div class="field"><label>责任方</label><select data-k="partyId">${d.members.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></div>
      <div class="field"><label>费用项</label><input data-k="title" placeholder="如 主卫防水重做"></div>
      <div class="field"><label>金额（元）</label><input data-k="amount" type="number" step="0.01" min="0"></div>
      <div class="field"><label>依据（引用证据/责任项）</label><input data-k="basis" placeholder="如 证据v2：闭水阳性"></div>
      <button class="btn small" data-act="add-item" data-proposal="${p.id}">添加</button>
    </details>`;
    html += `<div class="action-bar"><button class="btn small" data-act="finalize" data-proposal="${p.id}">定稿并通知各方签署</button></div>`;
  }
  if (p.status === 'pending' && mine && !signedByMe) {
    html += `<div class="action-bar">
      <button class="btn small" data-act="sign" data-proposal="${p.id}" data-action="signed">同意并签署</button>
      <button class="btn small danger" data-act="sign" data-proposal="${p.id}" data-action="rejected">不认可·拒签</button>
      <button class="btn ghost small" data-act="sign-stale" data-proposal="${p.id}">模拟用旧文本(修订号0)签署</button>
    </div>`;
  }
  if (p.status === 'pending' && me.role === 'negotiator') {
    html += `<div class="action-bar"><button class="btn small ghost" data-act="approve" data-proposal="${p.id}">协商员批准（需各方签齐）</button></div>`;
  }
  return html;
}

/* ---------- 修复与复验 ---------- */
function renderRepairs(d) {
  const cards = d.repairs.map(r => {
    const vs = d.verifications.filter(v => v.repair_id === r.id);
    return `<div class="card">
      <h3><span class="step-no">9</span>修复与复验<span class="hint">${esc(r.contractor || '')}</span></h3>
      <p style="margin:0 0 8px"><b>${esc(r.scope || '修复施工')}</b>
        <span class="badge ${r.status === 'done' ? 'closed' : 'open'}">${r.status === 'done' ? '已完工' : '施工中'}</span>
        <span class="mono">${fmtTime(r.started_at)}${r.finished_at ? ' → ' + fmtTime(r.finished_at) : ''}</span></p>
      ${vs.map(v => `
        <div class="card verify ${v.result}" style="margin-bottom:8px">
          <div class="vbadge">${v.result === 'pass' ? '✅' : '⚠️'}</div>
          <div>
            <b>复验${v.result === 'pass' ? '通过' : '失败（复漏）'}</b>
            <span class="mono">${fmtTime(v.checked_at)} · 干燥观察 ${v.dry_days ?? '—'} 天 · ${esc(memberName(d, v.inspector))}</span>
            <div style="margin-top:3px">${esc(v.observed || '')}</div>
          </div>
        </div>`).join('')}
    </div>`;
  }).join('');
  return cards;
}

/* ---------- 操作面板 ---------- */
function renderActions(d) {
  const isManager = me.role === 'manager';
  const isInsp = me.role === 'inspector' || isManager;
  const isResident = me.role === 'resident_reporter' || me.role === 'resident_up';
  return `<div class="card"><h3><span class="step-no">⚙</span>操作（以「${esc(me.name)}」身份）<span class="hint">权限由后端强制：越权会被拒绝</span></h3>
    <details class="actbox" ${isResident || isManager ? '' : 'disabled'}><summary>追加陈述 / 物业代录</summary>
      <div class="field"><label>位置</label><input data-form="stmt" data-k="location"></div>
      <div class="field"><label>受损部位（顿号分隔）</label><input data-form="stmt" data-k="damagedParts"></div>
      <div class="field"><label>描述</label><textarea data-form="stmt" data-k="description"></textarea></div>
      ${isManager ? `<label class="field"><input type="checkbox" data-form="stmt" data-k="asProxy"> 物业代录（对象）
        <select data-form="stmt" data-k="forParty">${d.members.filter(m => m.role.startsWith('resident')).map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></label>` : ''}
      <button class="btn small" data-act="stmt">提交陈述</button>
    </details>

    <details class="actbox"><summary>在照片上点位置即可标注；也可这里对指定照片加标注</summary>
      <div class="field"><label>照片</label><select data-form="anno" data-k="photoId">${d.photos.map(p => `<option value="${p.id}">${esc(p.caption || p.id)}</option>`).join('')}</select></div>
      <div class="two-col"><div class="field"><label>x(0-1)</label><input data-form="anno" data-k="x" type="number" step="0.01" min="0" max="1"></div>
      <div class="field"><label>y(0-1)</label><input data-form="anno" data-k="y" type="number" step="0.01" min="0" max="1"></div></div>
      <div class="field"><label>标注文字</label><input data-form="anno" data-k="text"></div>
      <button class="btn small" data-act="anno">提交标注</button>
    </details>

    ${isManager ? `<details class="actbox"><summary>发起入户预约</summary>
      <div class="field"><label>对象</label><select data-form="apt" data-k="targetParty">${d.members.filter(m => m.role === 'resident_up' || m.role === 'resident_reporter').map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></div>
      <div class="field"><label>时间</label><input data-form="apt" data-k="scheduledAt" value="2026-10-30T10:00:00+08:00"></div>
      <div class="field"><label>事由</label><input data-form="apt" data-k="reason"></div>
      <button class="btn small" data-act="apt">发起预约</button>
      ${d.appointments.filter(a => a.status === 'requested').map(a =>
        `<div class="action-bar" style="align-items:center"><span class="mono">待回复：${fmtTime(a.scheduled_at)}</span>
        <button class="btn small ghost" data-act="apt-ok" data-apt="${a.id}">（以被约户视角）同意</button>
        <button class="btn small danger" data-act="apt-no" data-apt="${a.id}">拒绝入户</button></div>`).join('')}
    </details>` : ''}

    ${isInsp ? `<details class="actbox"><summary>登记试水 / 复验</summary>
      <div class="field"><label>试水方法</label><input data-form="wt" data-k="method" value="卫生间地面闭水"></div>
      <div class="field"><label>区域</label><input data-form="wt" data-k="zone" value="701主卫"></div>
      <div class="two-col"><div class="field"><label>开始</label><input data-form="wt" data-k="startedAt" value="2026-10-30T09:00:00+08:00"></div>
      <div class="field"><label>结果</label><select data-form="wt" data-k="result"><option value="positive">渗漏重现</option><option value="negative">未重现</option><option value="inconclusive">结果不明</option></select></div></div>
      <div class="field"><label>漏点/说明</label><input data-form="wt" data-k="leakPoint"></div>
      <button class="btn small" data-act="wt">提交试水</button>
      <hr style="border:none;border-top:1px solid var(--line);margin:12px 0">
      ${d.repairs.filter(r => r.status === 'done' && !d.verifications.some(v => v.repair_id === r.id)).map(r =>
        `<button class="btn small" data-act="verify-pass" data-repair="${r.id}">复验通过（关闭）</button>
         <button class="btn small danger" data-act="verify-fail" data-repair="${r.id}">复验失败（复漏重开）</button>`).join('') || '<span class="muted" style="font-size:12px">没有待复验的完工修复</span>'}
    </details>` : ''}

    ${(isInsp || me.role === 'negotiator') && d.status === 'open' ? `<details class="actbox"><summary>冻结当前证据为新版本</summary>
      <div class="field"><label>版本标签</label><input data-form="fz" data-k="label" placeholder="如 勘查证据 v4"></div>
      <div class="field"><label>说明</label><input data-form="fz" data-k="note"></div>
      <button class="btn small" data-act="freeze">冻结证据版本</button>
    </details>` : ''}
  </div>`;
}

/* ---------- 交互绑定 ---------- */
function readForm(name) {
  const out = {};
  document.querySelectorAll(`[data-form="${name}"]`).forEach(el => {
    const k = el.dataset.k;
    if (el.type === 'checkbox') out[k] = el.checked;
    else out[k] = el.value;
  });
  return out;
}

async function postAndReload(url, body, okMsg) {
  try {
    await Api.post(url, body);
    toast(okMsg || '已提交', 'ok');
    await openCase(CURRENT);
  } catch (e) { toast(e.message, 'err'); }
}

function bindDetail(d) {
  const gotoParent = document.getElementById('gotoParent');
  if (gotoParent) gotoParent.onclick = async () => {
    const parent = CASES.find(c => c.id === d.parent_case_id);
    if (parent) await openCase(parent.id);
    else { CURRENT = null; await loadAll(); }
  };

  // 照片点击标注（保持比例：用点击处相对图片显示尺寸的归一化坐标）
  document.querySelectorAll('.photo-frame').forEach(frame => {
    frame.onclick = async (ev) => {
      const img = frame.querySelector('img');
      const rect = img.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
      const y = Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height));
      const text = prompt('标注此处（坐标按原图比例归一化，原文件不变）：', '漏点/水痕');
      if (!text) return;
      await postAndReload(`/api/photos/${frame.dataset.photo}/annotations`,
        { x: Number(x.toFixed(4)), y: Number(y.toFixed(4)), text }, '标注已保存');
    };
  });

  document.querySelectorAll('[data-act]').forEach(btn => {
    btn.onclick = async () => {
      const act = btn.dataset.act;
      const cid = d.id;
      if (act === 'stmt') {
        const f = readForm('stmt');
        const body = { location: f.location, damagedParts: f.damagedParts ? f.damagedParts.split(/[、,，]/).filter(Boolean) : [], description: f.description };
        if (f.asProxy) { body.source = '物业代录'; body.forParty = f.forParty; }
        if (!body.description) return toast('请填写描述', 'err');
        return postAndReload(`/api/cases/${cid}/statements`, body, '陈述已追加（不可修改）');
      }
      if (act === 'anno') {
        const f = readForm('anno');
        return postAndReload(`/api/photos/${f.photoId}/annotations`,
          { x: Number(f.x), y: Number(f.y), text: f.text }, '标注已保存');
      }
      if (act === 'apt') {
        const f = readForm('apt');
        return postAndReload(`/api/cases/${cid}/appointments`, f, '预约已发起（模拟短信通知）');
      }
      if (act === 'apt-ok') return postAndReload(`/api/cases/${cid}/appointments/${btn.dataset.apt}/respond`, { status: 'accepted' }, '已同意入户');
      if (act === 'apt-no') return postAndReload(`/api/cases/${cid}/appointments/${btn.dataset.apt}/respond`, { status: 'refused', note: '操作面板演示拒绝' }, '已记录拒绝入户');
      if (act === 'wt') {
        const f = readForm('wt');
        return postAndReload(`/api/cases/${cid}/water-tests`,
          { method: f.method, zone: f.zone, startedAt: f.startedAt, result: f.result, leakPoint: f.leakPoint }, '试水已记录');
      }
      if (act === 'verify-pass') return postAndReload(`/api/cases/${cid}/verify`,
        { repairId: btn.dataset.repair, result: 'pass', dryDays: 7, observed: '连续观察顶面干燥无渗漏。' }, '复验通过，案件关闭');
      if (act === 'verify-fail') return postAndReload(`/api/cases/${cid}/verify`,
        { repairId: btn.dataset.repair, result: 'fail', dryDays: 3, observed: '原漏点附近再次出现滴水（演示复漏）。' }, '复验失败，已再开新案');
      if (act === 'freeze') {
        const f = readForm('fz');
        return postAndReload(`/api/cases/${cid}/evidence/freeze`, { label: f.label, note: f.note }, '证据版本已冻结（不可变）');
      }
      if (act === 'add-item') {
        const box = btn.closest('details');
        const get = k => box.querySelector(`[data-k="${k}"]`).value;
        return postAndReload(`/api/proposals/${btn.dataset.proposal}/items`,
          { caseId: cid, partyId: get('partyId'), title: get('title'), amountCents: Math.round(Number(get('amount')) * 100), basis: get('basis') }, '费用项已加入');
      }
      if (act === 'finalize') return postAndReload(`/api/proposals/${btn.dataset.proposal}/finalize`, { caseId: cid }, '方案已定稿，通知各方签署');
      if (act === 'sign') {
        const note = btn.dataset.action === 'rejected' ? prompt('拒签理由（费用不认可将作为结论保留，并触发重新协商）：', '对费用分摊不认可') : prompt('签署备注：', '认可');
        if (note === null) return;
        return postAndReload(`/api/proposals/${btn.dataset.proposal}/sign`,
          { caseId: cid, action: btn.dataset.action, docVersion: 1, note }, btn.dataset.action === 'rejected' ? '已拒签' : '已签署');
      }
      if (act === 'sign-stale') {
        return postAndReload(`/api/proposals/${btn.dataset.proposal}/sign`,
          { caseId: cid, action: 'signed', docVersion: 0 }, '');
      }
      if (act === 'approve') return postAndReload(`/api/proposals/${btn.dataset.proposal}/approve`, { caseId: cid }, '已批准赔偿');
    };
  });
}

init().catch(e => toast(e.message, 'err'));
