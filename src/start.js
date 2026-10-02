'use strict';
// 一条命令：初始化 SQLite、写入含复漏案例的种子数据、启动本地 Web 服务
const path = require('node:path');
const fs = require('node:fs');
const { openDb } = require('./db');
const { adapters } = require('./adapters');
const { createServer } = require('./server');
const { seed } = require('./seed');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.LEAK_DATA_DIR || path.join(ROOT, 'data');
const DB_FILE = process.env.LEAK_DB || path.join(DATA, 'leak.db');
const PHOTO_DIR = path.join(DATA, 'photos');
const LOG_DIR = path.join(DATA, 'adapters');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 5273);

fs.mkdirSync(DATA, { recursive: true });
const reset = process.argv.includes('--reset');
if (reset && fs.existsSync(DB_FILE)) {
  for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
    try { fs.rmSync(f); } catch { /* ignore */ }
  }
  for (const f of fs.readdirSync(PHOTO_DIR)) if (!f.startsWith('.')) fs.rmSync(path.join(PHOTO_DIR, f), { force: true });
  try { fs.rmSync(path.join(LOG_DIR, 'mock-adapter.log'), { force: true }); } catch { /* ignore */ }
}

const db = openDb(DB_FILE);
const adp = adapters(db, LOG_DIR);
const result = seed(db, adp, PHOTO_DIR, { reset });
const server = createServer({ db, adapters: adp, photoDir: PHOTO_DIR, publicDir: PUBLIC });

server.listen(PORT, () => {
  console.log('渗漏协商台账（零依赖 · Node 内置 SQLite）');
  console.log(`  本地地址：http://localhost:${PORT}`);
  console.log('  数据库：data/leak.db（事件链仅追加）');
  console.log('  照片原件：data/photos/   通知/签收：data/adapters/');
  if (!result.skipped) {
    console.log('已播种：');
    console.log('  • LS-2026-0907 3栋601/701 复漏主案例（拒入户·旧照误用·费用争议·复验失败重开）');
    console.log('  • LS-2026-0907-R1 复漏再开案（暗管第二漏点，复验通过关闭）');
    console.log('  • LS-2026-0911 2栋502/602 在办案例（跨户隐私隔离演示）');
  } else {
    console.log('检测到已有数据，跳过播种（加 --reset 可重建复漏案例）');
  }
});

module.exports = { db };
