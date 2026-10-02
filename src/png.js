'use strict';
// 零依赖 PNG：生成现场示意图照片（原始文件永不变形，标注只在展示层叠加）
const zlib = require('node:zlib');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// 画一个简单场景：底色 + 若干水印斑点 + 底部色条
function drawPixels(w, h, opts = {}) {
  const base = opts.base || [226, 229, 232];     // 水泥灰
  const stain = opts.stain || [74, 111, 126];   // 水迹深蓝灰
  const px = Buffer.alloc(w * h * 4);
  const spots = opts.spots || [{ fx: 0.5, fy: 0.42, r: 0.16 }];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let r = base[0], g = base[1], b = base[2];
      for (const s of spots) {
        const dx = (x / w - s.fx) / s.r;
        const dy = (y / h - s.fy) / (s.r * (w / h));
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < 1) {
          const a = (1 - d) * (s.alpha ?? 0.55);
          r = Math.round(r * (1 - a) + stain[0] * a);
          g = Math.round(g * (1 - a) + stain[1] * a);
          b = Math.round(b * (1 - a) + stain[2] * a);
        }
      }
      // 顶部光带
      if (y < h * 0.12) {
        const a = 0.25 * (1 - y / (h * 0.12));
        r = Math.round(r * (1 - a) + 255 * a);
        g = Math.round(g * (1 - a) + 255 * a);
        b = Math.round(b * (1 - a) + 255 * a);
      }
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
    }
  }
  return px;
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  // 每行加 filter byte 0
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function generate(opts) {
  const w = opts.width, h = opts.height;
  return encodePng(w, h, drawPixels(w, h, opts));
}

function pngSize(buf) {
  // IHDR 紧跟 8 字节签名 + 4 长度 + 4 类型
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

module.exports = { generate, pngSize, encodePng };
