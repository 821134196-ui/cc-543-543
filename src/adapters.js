'use strict';
// 模拟适配器：短信/上门通知 + 纸质签收。仅落库与写本地日志，不发真实请求。
const fs = require('node:fs');
const path = require('node:path');
const { id } = require('./util');

function adapters(db, logDir) {
  if (logDir) fs.mkdirSync(logDir, { recursive: true });

  function appendLog(line) {
    if (!logDir) return;
    fs.appendFileSync(path.join(logDir, 'mock-adapter.log'), line + '\n');
  }

  function notify({ caseId, toParty, channel, subject, body, at }) {
    const nid = id('ntf');
    db.prepare(`INSERT INTO notifications (id, case_id, channel, to_party, subject, body, status, sent_at)
                VALUES (?,?,?,?,?,?, 'simulated', ?)`)
      .run(nid, caseId ?? null, channel, toParty, subject, body, at);
    appendLog(`[${at}] SIM-${channel.toUpperCase()} -> ${toParty} | ${subject} | ${body}`);
    return id;
  }

  function receive({ caseId, docType, docId, partyId, payload, at }) {
    const rid = id('rcp');
    db.prepare(`INSERT INTO receipts (id, case_id, doc_type, doc_id, party_id, payload, signed_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(rid, caseId ?? null, docType, docId, partyId, JSON.stringify(payload), at);
    appendLog(`[${at}] RECEIPT ${docType}/${docId} party=${partyId} ${JSON.stringify(payload)}`);
    return id;
  }

  return { notify, receive };
}

module.exports = { adapters };
