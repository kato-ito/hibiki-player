// 生成应用图标：深色圆角底 + 绿色声波频谱条，输出多尺寸 .ico
// 纯 Node 实现（zlib 压缩 PNG），无任何外部依赖
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  // 每行前置过滤字节 0
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- 以 4x 超采样绘制，再盒式降采样抗锯齿 ----------
function drawIcon(size) {
  const S = 4; // 超采样倍数
  const W = size * S;
  const px = new Float64Array(W * W * 4); // 先累加再平均
  const set = (x, y, r, g, b, a) => {
    const i = (y * W + x) * 4;
    // 简单 alpha 合成（新像素在下层之上）
    const na = a + px[i + 3] * (1 - a);
    if (na > 0) {
      px[i] = (r * a + px[i] * px[i + 3] * (1 - a)) / na;
      px[i + 1] = (g * a + px[i + 1] * px[i + 3] * (1 - a)) / na;
      px[i + 2] = (b * a + px[i + 2] * px[i + 3] * (1 - a)) / na;
      px[i + 3] = na;
    }
  };

  const bg = [16, 20, 24];      // #101418 与页面背景一致
  const green = [55, 214, 122]; // #37d67a 主题绿
  const radius = W * 0.18;

  // 圆角矩形底
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const cx = Math.min(Math.max(x, radius), W - 1 - radius);
      const cy = Math.min(Math.max(y, radius), W - 1 - radius);
      const dx = x - cx, dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      const cover = Math.min(Math.max(radius - d + 0.5, 0), 1); // 距离场抗锯齿
      if (cover > 0) set(x, y, bg[0], bg[1], bg[2], cover);
    }
  }

  // 声波频谱条：中间高、两侧低的对称包络 + 少量起伏
  const bars = size >= 48 ? 15 : 9;
  const gap = W * 0.055;
  const barW = (W - gap * (bars + 1)) / bars;
  const heights = [];
  for (let i = 0; i < bars; i++) {
    const t = i / (bars - 1);              // 0..1
    const env = Math.sin(Math.PI * t);     // 两边低中间高
    const wob = 1 + 0.35 * Math.sin(i * 2.4 + 1.3);
    heights.push(Math.max(0.12, env * 0.78 * wob));
  }
  for (let i = 0; i < bars; i++) {
    const h = heights[i] * W * 0.62;
    const x0 = gap + i * (barW + gap);
    const y0 = (W - h) / 2;
    // 亮度和高度轻微渐变：左暗右亮，模拟能量
    const shade = 0.72 + 0.5 * (i / (bars - 1)) * 0.6;
    const col = green.map(c => Math.min(255, c * Math.min(shade, 1.15)));
    for (let y = Math.floor(y0); y < Math.ceil(y0 + h); y++) {
      for (let x = Math.floor(x0); x < Math.ceil(x0 + barW); x++) {
        const covX = Math.min(Math.max(Math.min(x + 1 - x0, x0 + barW - x), 0), 1);
        const covY = Math.min(Math.max(Math.min(y + 1 - y0, y0 + h - y), 0), 1);
        const cover = covX * covY;
        if (cover > 0 && x >= 0 && x < W && y >= 0 && y < W) {
          set(x, y, col[0], col[1], col[2], cover);
        }
      }
    }
  }

  // 降采样到目标尺寸
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const i = ((y * S + sy) * W + (x * S + sx)) * 4;
          r += px[i]; g += px[i + 1]; b += px[i + 2]; a += px[i + 3];
        }
      }
      const n = S * S, o = (y * size + x) * 4;
      // 预乘 alpha 编码：PNG RGBA 为非预乘，除以 alpha 恢复
      const alpha = a / n;
      out[o] = alpha > 0 ? Math.round(r / n / alpha) : 0;
      out[o + 1] = alpha > 0 ? Math.round(g / n / alpha) : 0;
      out[o + 2] = alpha > 0 ? Math.round(b / n / alpha) : 0;
      out[o + 3] = Math.round(alpha * 255);
    }
  }
  return encodePNG(size, size, out);
}

// ---------- 封装 ICO（PNG 条目，Vista+ 支持）----------
function buildIco(pngs) {
  // pngs: [{size, buf}]
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  const datas = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, buf } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; // palette
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4);  // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += buf.length;
    entries.push(e);
    datas.push(buf);
  }
  return Buffer.concat([header, ...entries, ...datas]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map(s => ({ size: s, buf: drawIcon(s) }));
const outDir = path.join(__dirname, 'build');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.ico'), buildIco(pngs));
fs.writeFileSync(path.join(outDir, 'icon.png'), pngs[pngs.length - 1].buf);
console.log(`OK: build/icon.ico (${sizes.join(',')} px), build/icon.png (256px)`);
