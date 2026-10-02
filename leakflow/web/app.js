/* LeakFlow 前端：原生 JS，零构建。 */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const STATE = { data: null, actor: null, lb: null };

const TAG_LABELS = {
  source_unlocated: "水源暂未定位",
  multi_room_leak: "多房间同时渗漏",
  upstairs_refused_entry: "上层拒绝入户",
  upstairs_kitchen_valve: "上层厨房角阀渗漏",
  old_photo_misused: "旧照片被误用",
  fee_disputed: "费用不认可",
  releak_after_repair: "修复后复漏",
  bathroom_waterproofing: "卫生间防水层失效",
  distinct_from_first_source: "与首轮水源不同",
};
const STAGE_LABELS = {
  valve_off: "关阀", inspection: "排查", water_test: "试水",
  repair: "修复", reinspection: "复验", report: "登记",
};
const STAGE_CLASS = {
  valve_off: "inspection", inspection: "inspection", water_test: "inspection",
  repair: "inspection", reinspection: "inspection", report: "inspection",
};
const CAT_LABELS = { repair: "修复", compensation: "赔偿", inspection: "勘查复验" };
const ROLE_LABELS = { property: "物业", repair: "维修勘查", negotiator: "协商员", resident: "住户" };
const STATUS_LABELS = {
  open: "待勘查", investigating: "勘查中", negotiating: "协商中",
  resolved: "复验通过", closed: "已结案", reopened: "复漏再开案",
};

function yuan(fen) {
  if (fen === 0) return "￥0.00";
  return "￥" + (fen / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3200);
}
async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || "操作失败");
  return j;
}
async function refresh() {
  const qs = STATE.actor ? `?actor=${encodeURIComponent(STATE.actor)}` : "";
  STATE.data = await (await fetch("/api/case" + qs)).json();
  renderAll();
}

/* ---------------- 案件头 ---------------- */
function renderHead() {
  const d = STATE.data, c = d.case;
  const reg = d.events.find(e => e.type === "case_registered");
  const p = reg ? reg.payload : {};
  const tags = new Set();
  d.opinions.forEach(o => o.conclusion_tags.forEach(t => tags.add(t)));
  const tagHtml = [...tags].map(t =>
    `<span class="tag ${t.includes("refused") || t.includes("disputed") || t.includes("unlocated") || t.includes("misused") ? "warn" : ""} ${t.includes("releak") ? "danger" : ""} ${t.includes("kitchen") || t.includes("waterproofing") ? "aqua" : ""}">${esc(TAG_LABELS[t] || t)}</span>`
  ).join("");
  $("#caseHead").innerHTML = `
    <h1>${esc(c.title)} <span class="mono muted" style="font-size:12px;font-weight:400">${esc(c.code)}</span>
      <span class="status-pill status-${c.status}">${esc(STATUS_LABELS[c.status] || c.status)}</span>
      ${c.round_no > 1 ? `<span class="tag danger">第 ${c.round_no} 轮（复漏再开案）</span>` : ""}
    </h1>
    <div class="case-meta">
      <span>📍 ${esc(c.address)}</span>
      <span>发生时间：${esc(p.happened_at || "")}</span>
      <span>登记位置：${esc(p.location || "")}</span>
    </div>
    <div class="case-meta" style="margin-top:4px">
      <span>受损部位：${esc((p.damaged_parts || []).join("、"))}</span>
    </div>
    <div class="case-tags">${tagHtml}</div>`;
  const dot = $("#chainDot"), txt = $("#chainTxt");
  dot.className = "chain-dot" + (d.chain_ok ? "" : " bad");
  txt.textContent = d.chain_ok ? `事件链完整 · ${d.events.length} 条事件` : "事件链校验失败";
}

/* ---------------- 楼层叠放示意 ---------------- */
function renderFloors() {
  const d = STATE.data;
  const tags = new Set();
  d.opinions.forEach(o => o.conclusion_tags.forEach(t => tags.add(t)));
  const up = d.units.find(u => u.role === "upstairs");
  const down = d.units.find(u => u.role === "downstairs");

  const upRooms = [
    { key: "kitchen", name: "厨房", cls: tags.has("upstairs_kitchen_valve") ? "source" : "",
      note: tags.has("upstairs_kitchen_valve") ? "角阀渗漏 · 第一轮已定位" : "管段" },
    { key: "bath", name: "卫生间", cls: tags.has("bathroom_waterproofing") ? "source" : "",
      note: tags.has("bathroom_waterproofing") ? "防水层失效 · 第二轮闭水确认" : "首轮仅打压" },
    { key: "master", name: "主卧", cls: "", note: "干燥（复验）" },
  ];
  const downRooms = [
    { key: "master", name: "主卧", cls: "leak", note: "顶板滴水 · 灯座旁", via: "对应上层厨房角阀" },
    { key: "bath", name: "卫生间", cls: "leak", note: "吊顶积水", via: "上层给水/防水" },
    { key: "second", name: "次卧", cls: "leak", note: "东墙渗水 · 复漏点", via: "对应上层卫生间" },
  ];
  const roomHtml = (rooms) => rooms.map(r => `
    <div class="room ${r.cls}">
      ${r.cls ? `<span class="pip"></span>` : ""}
      <div class="rname">${esc(r.name)}
        ${r.cls === "source" ? '<span class="tag warn" style="margin-left:6px">水源</span>' : ""}
        ${r.cls === "leak" ? '<span class="tag aqua" style="margin-left:6px">漏点</span>' : ""}
      </div>
      <div class="rnote">${esc(r.note)}</div>
      ${r.via ? `<div class="rnote" style="color:var(--aqua-deep)">↳ ${esc(r.via)}</div>` : ""}
    </div>`).join("");

  $("#panel-floors").innerHTML = `
    <div class="card">
      <h2>上下楼层叠放示意
        <span class="tag muted">上 → 下按实际层位</span>
      </h2>
      <div class="floor-stack">
        <div class="floor up">
          <span class="floor-badge">${up.floor_no}F · 上层被排查户</span>
          <div class="floor-title"><b>${esc(up.room_no)}</b>
            <span class="muted small">住户：${esc(up.resident || "—")} · ${esc(up.scope_note || "")}</span>
          </div>
          <div class="floor-rooms">${roomHtml(upRooms)}</div>
        </div>
        <div class="floor-link" aria-hidden="true">
          <span class="slab"></span>
          <span style="margin:3px 0">楼板 · 渗流方向 ↓</span>
          <span class="slab"></span>
        </div>
        <div class="floor down">
          <span class="floor-badge down">${down.floor_no}F · 下层报修户</span>
          <div class="floor-title"><b>${esc(down.room_no)}</b>
            <span class="muted small">住户：${esc(down.resident || "—")} · ${esc(down.scope_note || "")}</span>
          </div>
          <div class="floor-rooms">${roomHtml(downRooms)}</div>
        </div>
      </div>
      <div class="legend">
        <span><i style="background:var(--warn-tint);border:1px solid #e3c39a"></i>已确认水源</span>
        <span><i style="background:var(--aqua-tint-2);border:1px solid #c9dcea"></i>楼下漏点/受损房间</span>
        <span><i style="background:repeating-linear-gradient(to bottom,#3e7cb1 0 3px,#fff 3px 6px)"></i>水沿楼板缝隙下渗</span>
        <span>多房间同时渗漏、首轮无法定位与复漏的不同结论见「证据时间线 / 协商方案」。</span>
      </div>
    </div>`;
}

/* ---------------- 证据时间线 ---------------- */
function reopenTs() {
  const e = STATE.data.events.find(x => x.type === "case_reopened");
  return e ? e.ts : null;
}
function photoUrl(v) { return "/api/photos/" + encodeURIComponent(v.photo_file); }

function renderTimeline() {
  const d = STATE.data;
  const reopenAt = reopenTs();
  const items = [];

  d.stages.forEach(s => items.push({
    ts: s.started_at, round2: reopenAt && s.started_at >= reopenAt,
    stage: s.kind,
    title: `${STAGE_LABELS[s.kind]} · ${esc(s.operator_name)}`,
    body: s.note ? esc(s.note) + (s.result ? ` <span class="tag muted">${esc(s.result)}</span>` : "") : "",
    kind: "stage",
  }));

  d.evidence.forEach(e => e.versions.forEach(v => {
    const priv = e.visibility !== "all";
    items.push({
      ts: v.uploaded_at, round2: reopenAt && v.uploaded_at >= reopenAt,
      misused: v.status === "misused",
      stage: v.stage, kind: "evidence", ev: e, v,
      title: `${esc(e.title)} <span class="tl-stage">v${v.version_no}</span>` +
        `<span class="badge ${v.status}">${v.status === "valid" ? "有效" : v.status === "misused" ? "误用" : "已取代"}</span>` +
        (priv ? `<span class="badge private">限本户</span>` : ""),
      body: `
        <div class="tl-body">
          ${esc(v.caption)}
          <div class="small muted">拍摄于 ${esc(v.taken_at)} · 上传于 ${esc(v.uploaded_at)}
            · 原比例 ${v.width}×${v.height}px · 证据序号 #${v.version_seq}</div>
          ${v.status === "misused" ? `<div class="snapshot-note" style="margin-top:6px">⚠ 旧照片误用：${esc(v.review_note || "")}（记录保留不删除，不得作为责任依据）</div>` : ""}
        </div>
        <div class="photo-grid" style="margin-top:10px;max-width:560px">
          <div class="photo-card">
            <div class="photo-wrap" data-photo="${v.id}">
              <img src="${photoUrl(v)}" alt="${esc(e.title)}" loading="lazy">
            </div>
            <div class="photo-meta">
              <div class="pt"><span class="mono small muted">E${e.id} · v${v.version_no}</span>
                <button class="link-btn" data-photo="${v.id}">查看大图 / 标注漏点</button>
              </div>
            </div>
          </div>
        </div>`,
    });
  }));

  d.appointments.forEach(a => {
    items.push({
      ts: a.created_at, stage: "report", kind: "appt",
      title: `入户预约 · ${esc(a.room_no)}（${esc(a.resident)}）`,
      body: `<div class="tl-body">预约时间 ${esc(a.scheduled_at)} · 状态：${esc(apptStatus(a))}</div>`,
    });
  });

  d.water_tests.forEach(t => items.push({
    ts: t.observed_at, round2: reopenAt && t.observed_at >= reopenAt,
    stage: "water_test", kind: "test",
    title: `试水记录 · ${esc(t.method)}（${t.duration_min} 分钟）`,
    body: `<div class="tl-body">结论：<b>${testLabel(t.conclusion)}</b>` +
      `<div class="test-points">${t.points.map(pt =>
        `<span class="point"><span class="dot ${pt.result}"></span>${esc(pt.room)}：${esc(pt.note)}</span>`).join("")}</div></div>`,
  }));

  d.opinions.forEach(o => items.push({
    ts: o.created_at, round2: o.round_no > 1, stage: "report", kind: "opinion",
    title: `责任意见 #${o.seq}（第 ${o.round_no} 轮）`,
    body: `<div class="tl-body">${esc(o.rationale)}
      <div class="small muted" style="margin-top:4px">引用证据快照 #≤${o.snapshot_seq} ·
        引用版本 ${o.citations.map(c => `E${c.evidence_id}-v${c.version_no}`).join("、") || "（无）"}</div></div>`,
  }));

  d.plans.forEach(p => items.push({
    ts: p.created_at, round2: p.round_no > 1, stage: "report", kind: "plan",
    title: `费用修复方案 v${p.version_no} <span class="status-pill status-${p.status}">${planStatus(p.status)}</span>`,
    body: `<div class="tl-body">${esc(p.summary)}</div>`,
  }));

  d.reinspections.forEach(r => items.push({
    ts: r.inspected_at, round2: !!r.reopened_round, stage: "reinspection", kind: "reinspect",
    title: r.result === "pass" ? "复验通过 · 结案" : "复验失败 · 复漏再开案",
    body: `<div class="tl-body">${esc(r.note)}${r.reopened_round ? ` <span class="tag danger">进入第 ${r.reopened_round} 轮</span>` : ""}</div>`,
  }));

  items.sort((a, b) => a.ts.localeCompare(b.ts));
  const html = items.map(it => `
    <div class="tl-item ${it.round2 ? "round2" : ""} ${it.misused ? "misused" : ""}">
      <div class="tl-time">${esc(it.ts)}</div>
      <div class="tl-title">${it.title}${it.stage ? `<span class="tl-stage">${STAGE_LABELS[it.stage] || it.stage}</span>` : ""}</div>
      ${it.body}
    </div>`).join("");

  const hidden = d.hidden_versions;
  $("#panel-timeline").innerHTML = `
    <div class="card">
      <h2>证据时间线 <span class="tag muted">按时间排序 · 证据含逻辑序号</span></h2>
      ${STATE.actor && isResident() ? `<div class="privacy-note">🔒 当前以住户视角查看：另一户的室内隐私证据已隐藏${hidden ? `（${hidden} 个版本不可见）` : ""}；工作人员视角可见全部。</div>` : ""}
      ${reopenAt ? `<div class="round-divider">— ${esc(reopenAt)} 复验复漏，此后进入第 2 轮（旧结论保留不改写）—</div>` : ""}
      <div class="timeline">${html}</div>
    </div>`;

  $$("[data-photo]", $("#panel-timeline")).forEach(el =>
    el.addEventListener("click", () => openLightbox(Number(el.dataset.photo))));
}

function apptStatus(a) {
  return { pending: "待回应", accepted: "已同意", refused: "已拒绝", done: "已入户", cancelled: "已取消" }[a.status] || a.status;
}
function testLabel(c) {
  return { leak: "发现渗漏", no_leak: "未发现渗漏", inconclusive: "无法定论" }[c] || c;
}
function isResident() {
  const a = STATE.data.actors.find(x => x.id === STATE.actor);
  return a && a.role === "resident";
}

/* ---------------- 照片大图 + 标注（保持原比例） ---------------- */
function findVersion(vid) {
  for (const e of STATE.data.evidence)
    for (const v of e.versions) if (v.id === vid) return { e, v };
  return null;
}
function openLightbox(vid) {
  const found = findVersion(vid);
  if (!found) return;
  STATE.lb = found;
  const { e, v } = found;
  $("#lbTitle").textContent = `${e.title} · E${e.id}-v${v.version_no}（${v.width}×${v.height}，原图比例）`;
  $("#lbStage").innerHTML = `
    <div class="lb-img-box" id="lbBox">
      <img id="lbImg" src="${photoUrl(v)}" alt="">
    </div>`;
  $("#lbFoot").innerHTML = `
    <span class="small muted">${v.status === "misused" ? "⚠ 该版本为误用旧照，仅供溯源" : "在图上点击可添加漏点标注（工作人员）"}</span>
    <span class="small muted">已有标注：${v.annotations.length} 处</span>`;
  $("#lightbox").hidden = false;
  const img = $("#lbImg");
  const draw = () => {
    $$(".anno", $("#lbBox")).forEach(n => n.remove());
    v.annotations.forEach(a => addPin(a.nx, a.ny, a.label, false));
  };
  img.addEventListener("load", draw);
  if (img.complete) draw();
  $("#lbBox").addEventListener("click", onImageClick);
}
function addPin(nx, ny, label, preview) {
  const box = $("#lbBox");
  const node = document.createElement("div");
  node.className = "anno" + (preview ? " preview" : "");
  node.style.left = (nx * 100) + "%";
  node.style.top = (ny * 100) + "%";
  node.innerHTML = `<span class="lbl">${esc(label)}</span><span class="pin"></span>`;
  box.appendChild(node);
}
function onImageClick(ev) {
  const actor = STATE.data.actors.find(x => x.id === STATE.actor);
  if (!actor || actor.role === "resident") {
    toast("仅物业 / 维修 / 协商员可标注漏点", true);
    return;
  }
  const img = $("#lbImg");
  const r = img.getBoundingClientRect();
  const nx = (ev.clientX - r.left) / r.width;
  const ny = (ev.clientY - r.top) / r.height;
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
  const label = prompt("标注名称（如：角阀渗漏点）", "漏点");
  if (!label) return;
  addPin(nx, ny, label, true);
  api("/api/annotations", {
    case_id: STATE.data.case.id, actor: STATE.actor,
    evidence_id: STATE.lb.e.id, nx: +nx.toFixed(4), ny: +ny.toFixed(4), label,
  }).then(() => { toast("标注已保存（归一化坐标，随原图等比缩放）"); return refresh(); })
    .catch(e => { toast(e.message, true); refresh(); });
}
$("#lbClose").addEventListener("click", () => { $("#lightbox").hidden = true; });
$("#lightbox").addEventListener("click", e => { if (e.target.id === "lightbox") $("#lightbox").hidden = true; });

/* ---------------- 入户预约 + 通知 ---------------- */
function renderAppts() {
  const d = STATE.data;
  const actor = d.actors.find(x => x.id === STATE.actor);
  const appts = d.appointments.map(a => {
    const canRespond = actor && actor.role === "resident" && actor.unit_id === a.unit_id && a.status === "pending";
    return `<div class="appt-block">
      <div class="small muted mono">${esc(a.created_at)}</div>
      <div><b>${esc(a.room_no)} ${esc(a.resident)}</b> 的入户预约 · 计划 ${esc(a.scheduled_at)}
        <span class="tag ${a.status === "refused" ? "danger" : a.status === "accepted" || a.status === "done" ? "ok" : "muted"}">${esc(apptStatus(a))}</span></div>
      ${a.refusal_reason ? `<div class="small" style="color:var(--danger);margin-top:4px">拒绝原因：${esc(a.refusal_reason)}</div>` : ""}
      ${canRespond ? `<div class="row-actions">
          <button class="btn" data-appt-accept="${a.id}">同意入户</button>
          <button class="btn danger" data-appt-refuse="${a.id}">拒绝入户</button>
        </div>` : ""}
    </div>`;
  }).join("");

  const notifs = d.notifications.map(n => {
    const to = d.actors.find(x => x.id === n.to_actor);
    const mine = actor && n.to_actor === actor.id;
    return `<div class="notif">
      <span class="mono small muted">${esc(n.created_at)}</span>
      <span>→ ${esc(to ? to.name : n.to_actor)}：${esc(n.content)}</span>
      <span class="nstate">${n.ack
        ? '<span class="tag ok">已签收 ' + esc(n.acknowledged_at) + "</span>"
        : (mine ? `<button class="btn ghost" data-ack="${n.id}">模拟签收</button>`
                : '<span class="tag muted">待签收</span>')}</span>
    </div>`;
  }).join("");

  $("#panel-appts").innerHTML = `
    <div class="card"><h2>入户预约</h2>${appts || '<div class="empty">暂无预约</div>'}</div>
    <div class="card"><h2>通知与签收 <span class="tag muted">模拟短信适配器</span></h2>
      ${notifs || '<div class="empty">暂无通知</div>'}</div>`;

  $$("[data-appt-accept]").forEach(b => b.onclick = () =>
    respondAppt(Number(b.dataset.apptAccept), true));
  $$("[data-appt-refuse]").forEach(b => b.onclick = () => {
    const reason = prompt("拒绝入户的原因（将如实记录）", "家中无人");
    if (reason !== null) respondAppt(Number(b.dataset.apptRefuse), false, reason);
  });
  $$("[data-ack]").forEach(b => b.onclick = () =>
    api(`/api/notifications/${b.dataset.ack}/ack`, { actor: STATE.actor })
      .then(() => { toast("签收完成"); refresh(); })
      .catch(e => toast(e.message, true)));
}
function respondAppt(id, accept, reason) {
  api(`/api/appointments/${id}/respond`,
    { actor: STATE.actor, accept, reason })
    .then(() => { toast(accept ? "已同意入户" : "已记录拒绝"); refresh(); })
    .catch(e => toast(e.message, true));
}

/* ---------------- 试水记录 ---------------- */
function renderTests() {
  const d = STATE.data;
  const reopenAt = reopenTs();
  const blocks = d.stages.filter(s => ["valve_off", "water_test", "inspection"].includes(s.kind)).map(s => {
    const test = d.water_tests.find(t => t.stage_id === s.id);
    return `<div class="test-block">
      <div class="small muted mono">${esc(s.started_at)}${s.ended_at ? " → " + esc(s.ended_at) : ""}
        ${reopenAt && s.started_at >= reopenAt ? '<span class="tag danger" style="margin-left:6px">第2轮</span>' : ""}</div>
      <div><b>${STAGE_LABELS[s.kind]}</b> · ${esc(s.operator_name)}
        ${s.result ? `<span class="tag ${s.result === "leak" ? "danger" : s.result === "inconclusive" || s.result === "still_seeping" ? "warn" : "ok"}">${esc(s.result)}</span>` : ""}</div>
      <div class="small" style="margin-top:3px">${esc(s.note || "")}</div>
      ${test ? `<div class="small" style="margin-top:6px"><b>${esc(test.method)}</b> · ${test.duration_min} 分钟 · 结论：<b>${esc(testLabel(test.conclusion))}</b>
        <div class="test-points">${test.points.map(pt =>
          `<span class="point"><span class="dot ${pt.result}"></span>${esc(pt.room)}：${esc(pt.note)}</span>`).join("")}</div></div>` : ""}
    </div>`;
  }).join("");
  $("#panel-tests").innerHTML = `
    <div class="card"><h2>分阶段维修与试水记录
      <span class="tag muted">关阀 → 排查 → 试水 → 修复 → 复验</span></h2>${blocks}</div>`;
}

/* ---------------- 协商方案 ---------------- */
function renderPlans() {
  const d = STATE.data;
  const actor = d.actors.find(x => x.id === STATE.actor);
  const units = Object.fromEntries(d.units.map(u => [u.id, u]));

  const opinions = d.opinions.map(o => {
    const newer = o.new_evidence_after_snapshot || [];
    const resp = Object.entries(o.responsibility).map(([k, v]) => {
      const u = units[k];
      return `<span class="tag ${k === "unknown" ? "warn" : "aqua"}">${u ? u.room_no : "责任待定"} ${v}%</span>`;
    }).join(" ");
    return `<div class="card">
      <h2>责任意见 #${o.seq} <span class="tag muted">第 ${o.round_no} 轮</span>
        <span class="tag mono">证据快照 ≤ #${o.snapshot_seq}</span></h2>
      <div style="margin:6px 0">${resp}</div>
      <div class="small" style="margin:6px 0">${esc(o.rationale)}</div>
      <div class="small muted">引用版本（当时证据）：
        ${o.citations.map(c => {
          const ev = d.evidence.find(e => e.id === c.evidence_id);
          const v = ev && ev.versions.find(x => x.version_no === c.version_no);
          const bad = v && v.status === "misused";
          return `<span class="tag ${bad ? "danger" : "muted"} mono">E${c.evidence_id}-v${c.version_no}${bad ? " 误用" : ""}</span>`;
        }).join(" ")}
      </div>
      ${newer.length ? `<div class="snapshot-note">📌 本意见出具后出现 <b>${newer.length}</b> 份新证据（#${newer[0].version_seq} 起）。
        旧意见不被改写，新证据仅能触发<b>重新协商</b>：${newer.slice(0, 3).map(v => `E${v.evidence_id}-v${v.version_no}`).join("、")}${newer.length > 3 ? " …" : ""}</div>` : ""}
    </div>`;
  }).join("");

  const plans = d.plans.map(p => {
    const total = p.items.reduce((s, it) => s + it.amount, 0);
    const rows = p.items.map(it => `
      <tr>
        <td><span class="cat ${it.category}">${CAT_LABELS[it.category] || it.category}</span></td>
        <td>${esc(it.item)}<div class="small muted">承担：${esc(it.unit_no || "待定 / 公共")}</div></td>
        <td class="amount ${it.amount === 0 ? "zero" : ""}">${yuan(it.amount)}</td>
        <td class="small muted">${esc(it.basis)}</td>
      </tr>`).join("");
    const partyUnits = d.units.filter(u => u.role !== "self");
    const sigHtml = partyUnits.map(u => {
      const s = p.signatures.find(x => x.unit_id === u.id);
      const cls = !s ? "pending" : s.decision;
      const txt = !s ? "待签署" : s.decision === "sign" ? "已同意" : "拒绝（费用不认可）";
      return `<div class="sig ${cls}">
        <div class="who">${esc(u.room_no)} · ${esc(u.resident)}</div>
        <div>${txt}</div>
        ${s && s.comment ? `<div class="small muted" style="margin-top:3px">“${esc(s.comment)}”</div>` : ""}
        ${s ? `<div class="small muted mono">${esc(s.signed_at)}</div>` : ""}
      </div>`;
    }).join("");

    const myUnit = actor && actor.role === "resident" ? actor.unit_id : null;
    const mySig = myUnit && p.signatures.some(s => s.unit_id === myUnit);
    const canSign = myUnit && p.status === "proposed" && !mySig;
    const locked = p.status === "superseded";

    return `<div class="card" style="${locked ? "opacity:.72" : ""}">
      <h2>方案 v${p.version_no}
        <span class="status-pill status-${p.status}">${planStatus(p.status)}</span>
        <span class="tag muted">对应意见 #${d.opinions.find(o => o.id === p.opinion_id)?.seq || ""} · 第 ${p.round_no} 轮</span>
      </h2>
      <div class="small" style="margin-bottom:8px">${esc(p.summary)}</div>
      <table class="plan">
        <thead><tr><th style="width:86px">责任项</th><th>内容 / 承担方</th><th style="width:110px;text-align:right">金额</th><th>依据</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="plan-total"><span>合计</span><span class="amount aqua">${yuan(total)}</span></div>
      <div class="sig-row">${sigHtml}</div>
      ${locked ? `<div class="superseded-note">该版本已被后续方案取代，按规则<b>不可再签署</b>；版本与双方意见完整留存。</div>` : ""}
      ${p.status === "disputed" ? `<div class="snapshot-note" style="border-color:#e8c9cd;background:var(--danger-tint)">⚖ 签署冲突：一方拒绝，版本进入「费用不认可」争议状态，需协商员调整后提出新版本。</div>` : ""}
      ${canSign ? `<div class="row-actions">
          <input type="text" id="cmt-${p.id}" placeholder="签署意见（可选）" style="max-width:320px">
          <button class="btn" data-sign="${p.id}">同意并签署</button>
          <button class="btn danger" data-reject="${p.id}">拒绝（不认可费用）</button>
        </div>` : ""}
      ${mySig && p.status === "proposed" ? '<div class="small muted" style="margin-top:8px">本户已作出决定；同一版本不可重复签署，改意见需经重新协商产生新版本。</div>' : ""}
    </div>`;
  }).join("");

  $("#panel-plans").innerHTML =
    `<div class="section-label">责任意见（每份绑定出具时的证据版本）</div>${opinions}` +
    `<div class="section-label" style="margin-top:20px">费用与修复方案（按责任项列明金额与依据）</div>${plans}`;

  $$("[data-sign]").forEach(b => b.onclick = () =>
    signPlan(Number(b.dataset.sign), "sign"));
  $$("[data-reject]").forEach(b => b.onclick = () =>
    signPlan(Number(b.dataset.reject), "reject"));
}
function planStatus(s) {
  return { proposed: "待签署", signed: "双方已签署", rejected: "已拒绝", disputed: "费用争议", superseded: "已被新版本取代" }[s] || s;
}
function signPlan(pid, decision) {
  const comment = $("#cmt-" + pid)?.value?.trim() || null;
  api(`/api/plans/${pid}/sign`, { actor: STATE.actor, decision, comment })
    .then(() => { toast(decision === "sign" ? "已签署" : "已记录拒绝，方案进入争议"); refresh(); })
    .catch(e => toast(e.message, true));
}

/* ---------------- 修复复验 ---------------- */
function renderRepairs() {
  const d = STATE.data;
  const blocks = d.repairs.map(r => {
    const ins = d.reinspections.filter(x => x.repair_id === r.id);
    return `<div class="test-block">
      <div class="small muted mono">${esc(r.started_at || "")} → ${esc(r.finished_at || "施工中")}
        <span class="tag ${r.round_no > 1 ? "danger" : "aqua"}">第 ${r.round_no} 轮 · 方案 v${r.plan_version}</span></div>
      <div><b>${esc(r.scope)}</b></div>
      <div class="small muted">施工方：${esc(r.contractor)} · 状态：${r.status === "done" ? "已完工" : "施工中"}</div>
      ${ins.map(x => `<div class="snapshot-note" style="margin-top:8px;border-color:${x.result === "pass" ? "#c9e2d3" : "#e8c9cd"};background:${x.result === "pass" ? "var(--ok-tint)" : "var(--danger-tint)"}">
        <b>${x.result === "pass" ? "✔ 复验通过" : "✖ 复验发现复漏"}</b> · ${esc(x.inspected_at)}
        <div>${esc(x.note)}</div>
        ${x.reopened_round ? `<div class="small" style="color:var(--danger);margin-top:3px">案件自动再开案 → 第 ${x.reopened_round} 轮；第一轮意见、方案、签署记录全部保留。</div>` : ""}
      </div>`).join("")}
    </div>`;
  }).join("");
  const c = d.case;
  $("#panel-repairs").innerHTML = `
    ${c.status === "reopened" ? '<div class="card" style="border-color:#e8c9cd"><h2 style="color:var(--danger)">复漏再开案中</h2><div class="small">新一轮勘查与协商进行中，历史结论可查但不覆盖。</div></div>' : ""}
    <div class="card"><h2>修复与复验
      <span class="tag muted">复验失败自动开新一轮</span></h2>${blocks || '<div class="empty">暂无修复记录</div>'}</div>`;
}

/* ---------------- 事件链 ---------------- */
function renderChain() {
  const d = STATE.data;
  const rows = d.events.map(e => `
    <details class="ev">
      <summary><span class="seq">#${e.seq}</span>
        <span class="mono small muted">${esc(e.ts)}</span>
        <b>${esc(e.type)}</b>
        <span class="tag muted">${esc(ROLE_LABELS[e.actor_role] || e.actor_role || "系统")}</span>
      </summary>
      <div class="ev-body">
        <pre>${esc(JSON.stringify(e.payload, null, 2))}</pre>
        <div class="hash">prev: ${esc(e.prev_hash)}</div>
        <div class="hash">hash: ${esc(e.hash)}</div>
      </div>
    </details>`).join("");
  $("#panel-chain").innerHTML = `
    <div class="card"><h2>事件哈希链
      <span class="tag ${d.chain_ok ? "ok" : "danger"}">${d.chain_ok ? "校验通过" : "校验失败"}</span></h2>
      <div class="small muted" style="margin-bottom:10px">所有状态变更按序写入 SQLite，逐条引用上一条 SHA-256；任何篡改都会使校验失败。</div>
      ${rows}</div>`;
}

/* ---------------- 装配 ---------------- */
function renderAll() {
  renderHead();
  renderFloors();
  renderTimeline();
  renderAppts();
  renderTests();
  renderPlans();
  renderRepairs();
  renderChain();
}

$("#tabs").addEventListener("click", e => {
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  $$("#tabs button").forEach(x => x.classList.toggle("active", x === b));
  ["floors", "timeline", "appts", "tests", "plans", "repairs", "chain"].forEach(t =>
    ($("#panel-" + t).hidden = t !== b.dataset.tab));
});

$("#actorSel").addEventListener("change", e => {
  STATE.actor = e.target.value || null;
  refresh();
});

async function boot() {
  STATE.data = await (await fetch("/api/case")).json();
  const sel = $("#actorSel");
  sel.innerHTML = `<option value="">（工作人员视角 · 可见全部）</option>` +
    STATE.data.actors.map(a =>
      `<option value="${a.id}">${esc(a.name)}｜${ROLE_LABELS[a.role]}</option>`).join("");
  renderAll();
}
boot();
