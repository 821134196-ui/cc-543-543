'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { Service, HttpError } = require('./service');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function createServer({ db, adapters, photoDir, clock, publicDir }) {
  const svc = new Service(db, adapters, { photoDir, clock });

  function body(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', c => { size += c.length; if (size > 8 * 1024 * 1024) { reject(new HttpError(413, 'too_large', '请求体过大')); req.destroy(); } chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;
      const q = url.searchParams;
      const as = req.headers['x-party-id'] || q.get('as') || null;
      const send = (code, data) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(data));
      };

      // ---- 静态 ----
      if (req.method === 'GET' && (p === '/' || p.startsWith('/js/'))) {
        const file = path.join(publicDir, p === '/' ? 'index.html' : p);
        if (!file.startsWith(publicDir)) throw new HttpError(403, 'forbidden', '路径非法');
        const buf = fs.readFileSync(file);
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
        return res.end(buf);
      }
      if (req.method === 'GET' && p === '/styles.css') {
        res.writeHead(200, { 'content-type': MIME['.css'] });
        return res.end(fs.readFileSync(path.join(publicDir, 'styles.css')));
      }

      // ---- 照片原图（权限校验后按字节返回）----
      let m;
      if (req.method === 'GET' && (m = p.match(/^\/api\/photos\/([\w]+)$/))) {
        if (!as) throw new HttpError(401, 'no_identity', '请先选择身份');
        const { file, row } = svc.photoPath(m[1], as);
        res.writeHead(200, {
          'content-type': row.content_type,
          'cache-control': 'private, no-store',
          'x-original-width': row.width,
          'x-original-height': row.height,
        });
        return res.end(fs.readFileSync(file));
      }

      if (!p.startsWith('/api/')) throw new HttpError(404, 'not_found', '路径不存在');
      if (!as && p !== '/api/parties') throw new HttpError(401, 'no_identity', '请先选择身份（X-Party-Id）');

      let json = {};
      if (req.method !== 'GET') {
        const raw = await body(req);
        if ((req.headers['content-type'] || '').includes('application/json')) {
          json = raw.length ? JSON.parse(raw.toString('utf8')) : {};
        } else if ((req.headers['content-type'] || '').includes('image/')) {
          json = { __rawImage: raw, filename: q.get('filename') || 'upload.png',
            room: q.get('room'), caption: q.get('caption'), takenAt: q.get('taken_at'),
            contentType: req.headers['content-type'].split(';')[0] };
        }
      }

      const cid = () => json.caseId || null;
      let out;

      // 身份
      if (p === '/api/parties' && req.method === 'GET')
        out = db.prepare('SELECT * FROM parties ORDER BY role, id').all();

      else if (p === '/api/cases' && req.method === 'GET')
        out = svc.listCases(as);

      else if (p === '/api/cases' && req.method === 'POST')
        out = svc.createCase({ ...json, actor: as });

      else if ((m = p.match(/^\/api\/cases\/([\w]+)$/)) && req.method === 'GET')
        out = svc.caseDetail(m[1], as);

      else if ((m = p.match(/^\/api\/cases\/([\w]+)\/statements$/)) && req.method === 'POST')
        out = { id: svc.addStatement(m[1], as, json) };

      else if ((m = p.match(/^\/api\/cases\/([\w]+)\/photos$/)) && req.method === 'POST') {
        let buf;
        if (json.__rawImage) buf = json.__rawImage;
        else if (json.dataBase64) buf = Buffer.from(json.dataBase64, 'base64');
        else throw new HttpError(400, 'no_image', '缺少照片数据');
        out = { id: svc.addPhoto(m[1], as, { buffer: buf, ...json, contentType: json.contentType || 'image/png' }) };
      }

      else if ((m = p.match(/^\/api\/photos\/([\w]+)\/annotations$/)) && req.method === 'POST')
        out = { annotations: svc.annotatePhoto(m[1], as, json) };

      else if ((m = p.match(/^\/api\/cases\/([\w]+)\/evidence$/)) && req.method === 'POST') {
        if (json.type === 'photo') out = { id: svc.addEvidencePhoto(m[1], as, json.photoId, json.caption) };
        else out = { id: svc.addEvidenceNote(m[1], as, json.caption) };
      }

      else if ((m = p.match(/^\/api\/cases\/([\w]+)\/evidence\/flag-stale$/)) && req.method === 'POST')
        out = { id: svc.flagStale(m[1], as, json.itemId, json.reason) };

      else if ((m = p.match(/^\/api\/cases\/([\w]+)\/evidence\/freeze$/)) && req.method === 'POST')
        out = svc.freezeVersion(m[1], as, json.label, json.note);

      else if ((m = p.match(/^\/api\/cases\/([\w]+)\/stages$/)) && req.method === 'POST')
        out = svc.setStage(m[1], as, json.stage, json.status, json.note);

      else if ((m = p.match(/^\/api\/cases\/([\w]+)\/appointments$/)) && req.method === 'POST')
        out = { id: svc.requestAppointment(m[1], as, json) };

      else if ((m = p.match(/^\/api\/cases\/([\w]+)\/appointments\/([\w]+)\/respond$/)) && req.method === 'POST')
        out = svc.respondAppointment(m[1], m[2], as, json);

      else if ((m = p.match(/^\/api\/cases\/([\w]+)\/water-tests$/)) && req.method === 'POST')
        out = { id: svc.addWaterTest(m[1], as, json) };

      else if ((m = p.match(/^\/api\/cases\/([\w]+)\/conclusions$/)) && req.method === 'POST')
        out = { id: svc.addConclusion(m[1], as, json) };

      else if ((m = p.match(/^\/api\/cases\/([\w]+)\/proposals$/)) && req.method === 'POST')
        out = { id: svc.createProposal(m[1], as, json) };

      else if ((m = p.match(/^\/api\/proposals\/([\w]+)\/items$/)) && req.method === 'POST')
        out = { id: svc.addProposalItem(json.caseId, m[1], as, json) };

      else if ((m = p.match(/^\/api\/proposals\/([\w]+)\/finalize$/)) && req.method === 'POST')
        out = svc.finalizeProposal(json.caseId, m[1], as);

      else if ((m = p.match(/^\/api\/proposals\/([\w]+)\/sign$/)) && req.method === 'POST')
        out = svc.signProposal(json.caseId, m[1], as, json);

      else if ((m = p.match(/^\/api\/proposals\/([\w]+)\/approve$/)) && req.method === 'POST')
        out = svc.approveProposal(json.caseId, m[1], as);

      else if ((m = p.match(/^\/api\/cases\/([\w]+)\/repairs$/)) && req.method === 'POST')
        out = { id: svc.startRepair(m[1], as, json) };

      else if ((m = p.match(/^\/api\/repairs\/([\w]+)\/finish$/)) && req.method === 'POST')
        out = svc.finishRepair(json.caseId, m[1], as);

      else if ((m = p.match(/^\/api\/cases\/([\w]+)\/verify$/)) && req.method === 'POST')
        out = svc.verify(m[1], as, json);

      else throw new HttpError(404, 'not_found', `未实现的接口：${req.method} ${p}`);

      return send(200, { ok: true, data: out });
    } catch (e) {
      if (e instanceof HttpError) {
        res.writeHead(e.status, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: { code: e.code, message: e.message } }));
      }
      console.error(e);
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: { code: 'internal', message: e.message } }));
    }
  });

  server.service = svc;
  return server;
}

module.exports = { createServer };
