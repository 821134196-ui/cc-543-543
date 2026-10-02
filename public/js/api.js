'use strict';
const Api = (() => {
  let partyId = localStorage.getItem('leak.party') || '';

  function setParty(p) { partyId = p; localStorage.setItem('leak.party', p); }
  function getParty() { return partyId; }

  async function req(method, url, body, raw = false) {
    const opt = { method, headers: {} };
    if (partyId) opt.headers['X-Party-Id'] = partyId;
    if (body !== undefined) {
      if (raw) {
        opt.headers['Content-Type'] = 'image/png';
        opt.body = body;
      } else {
        opt.headers['Content-Type'] = 'application/json';
        opt.body = JSON.stringify(body);
      }
    }
    const res = await fetch(url, opt);
    const j = await res.json();
    if (!j.ok) {
      const e = new Error(j.error.message);
      e.code = j.error.code; e.status = res.status;
      throw e;
    }
    return j.data;
  }

  return {
    setParty, getParty,
    parties: () => req('GET', '/api/parties'),
    cases: () => req('GET', '/api/cases'),
    case: (id) => req('GET', `/api/cases/${id}`),
    post: (url, body) => req('POST', url, body),
  };
})();

function toast(msg, kind = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show ' + kind;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast'; }, 3200);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTime(t) {
  if (!t) return '—';
  return t.replace('T', ' ').replace(/\+08:00$/, '').replace(/:\d{2}$/, m => m);
}
function yuan(c) {
  return '¥' + (c / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
