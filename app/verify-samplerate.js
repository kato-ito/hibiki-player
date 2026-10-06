// 采样率自适应链路端到端验证：不同采样率 WAV 播放 → 分析上下文与频谱上限跟随切换；
// 192 kHz 源压到 96 kHz 分析并标注；AC3 转码保留原始采样率；detectRate 文件头单测 + probe IPC
// 用法：npx electron verify-samplerate.js
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
require('./dolby-ipc');   // 注册 dolby:convert / dolby:probe（与 main.js 一致）

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) failed++;
};

// 生成 2 秒立体声正弦 WAV（10 kHz 音调，截图里能看到谱线）
function makeWav(p, sr) {
  const n = sr * 2, dataBytes = n * 4;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin(2 * Math.PI * 10000 * i / sr) * 12000);
    buf.writeInt16LE(v, 44 + i * 4);
    buf.writeInt16LE(v, 44 + i * 4 + 2);
  }
  fs.writeFileSync(p, buf);
}

// 合成最小 MP4/M4A（ftyp + moov/trak/mdia：hdlr=soun + mdhd timescale）
function box(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, payload]);
}
function makeMiniMp4(timescale) {
  const hdlr = box('hdlr', (() => {
    const b = Buffer.alloc(25);            // ver/flags + pre_defined + 'soun' + reserved + name
    b.write('soun', 8, 'ascii');
    return b;
  })());
  const mdhd = box('mdhd', (() => {
    const b = Buffer.alloc(20);            // ver0：ver/flags + ctime + mtime + timescale + duration
    b.writeUInt32BE(timescale, 12);
    return b;
  })());
  return Buffer.concat([box('ftyp', (() => { const b = Buffer.alloc(8); b.write('M4A ', 0, 'ascii'); return b; })()),
                        box('moov', box('trak', box('mdia', Buffer.concat([hdlr, mdhd]))))]);
}

// 页面侧代码：把 base64 字节变成 File 塞进歌单并播放（与真实拖入/选择路径一致）
const feedAndPlay = (p, b64) => `
  (async () => {
    const bytes = Uint8Array.from(atob("${b64}"), c => c.charCodeAt(0));
    setPlaylist([new File([bytes], "${path.basename(p)}")]);
    startFile(plTracks[0].file);
  })()`;

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((wc, p, cb) => cb(p === 'media'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-sr-'));
  const w44 = path.join(dir, 'tone-44k.wav'), w96 = path.join(dir, 'tone-96k.wav');
  const w192 = path.join(dir, 'tone-192k.wav'), w8 = path.join(dir, 'tone-8k.wav');
  makeWav(w44, 44100); makeWav(w96, 96000); makeWav(w192, 192000); makeWav(w8, 8000);

  // 44.1 kHz 的 AC3（ffmpeg lavfi 生成）→ 验证转码保留原始采样率
  const ac3 = path.join(dir, 'tone-44k.ac3');
  const ff = require('@ffmpeg-installer/ffmpeg').path;
  const r = spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=2',
    '-ac', '2', '-c:a', 'ac3', ac3]);
  if (r.status !== 0) { console.error('生成 AC3 失败:', r.stderr.toString()); app.exit(2); }

  const win = new BrowserWindow({ width: 1120, height: 950, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false,
                      preload: path.join(__dirname, 'preload.js') } });
  await win.loadFile('index.html');
  const js = code => win.webContents.executeJavaScript(code);
  const b64 = p => fs.readFileSync(p).toString('base64');

  // 播放并等状态栏出现「正在播放」/「失败」
  async function play(p, ms = 25000) {
    await js(feedAndPlay(p, b64(p)));
    const t0 = Date.now();
    let status = '';
    while (Date.now() - t0 < ms) {
      await new Promise(res => setTimeout(res, 300));
      status = await js('statusEl.textContent');
      if (/正在播放|失败|无法/.test(status)) break;
    }
    return status;
  }
  // 断言上下文采样率 + 两个表头的频率上限
  async function assertAxis(rate, axis) {
    ok(await js(`audioCtx && audioCtx.sampleRate === ${rate}`),
       `AudioContext 采样率 → ${rate} Hz（实际 ${await js('audioCtx ? audioCtx.sampleRate : 0')}）`);
    ok(await js(`document.getElementById('specAxis').textContent === "${axis}"`),
       `频谱表头上限 → ${axis}（实际 ${await js(`document.getElementById('specAxis').textContent`)}）`);
    ok(await js(`document.getElementById('sonoAxis').textContent === "${axis}"`),
       `声谱图表头上限 → ${axis}`);
  }

  console.log('— 不同采样率 WAV：上下文与频率上限跟随切换');
  await play(w44);  await assertAxis(44100, '0–22.05 kHz');
  await play(w96);  await assertAxis(96000, '0–48 kHz');
  const st192 = await play(w192);
  await assertAxis(96000, '0–48 kHz');
  ok(/源 192000 Hz · 分析 96000 Hz/.test(st192), '192 kHz 源在状态栏标注压限（' + st192 + '）');
  await play(w8);   await assertAxis(8000, '0–4 kHz');

  console.log('— AC3（44.1 kHz）转码播放：保留原始采样率');
  const stAc3 = await play(ac3);
  await assertAxis(44100, '0–22.05 kHz');
  ok(/转码为 PCM/.test(stAc3), '状态栏标注转码（' + stAc3 + '）');

  console.log('— detectRate 文件头解析（合成头）');
  const cases = [];
  const push = (name, rate, bytes) => cases.push([name, rate, Buffer.from(bytes).toString('base64')]);
  push('x.wav', 44100, fs.readFileSync(w44).slice(0, 64));                       // WAV fmt 块
  { // FLAC STREAMINFO：fLaC + 4 字节块头 + 34 字节（采样率 20 位在偏移 18）
    const b = Buffer.alloc(42); b.write('fLaC', 0, 'ascii');
    b.writeUInt32BE(34, 4);                       // 块头：type 0（STREAMINFO），长度 34
    const v = 96000; b[18] = v >> 12; b[19] = (v >> 4) & 0xFF; b[20] = (v & 15) << 4;
    push('x.flac', 96000, b);
  }
  push('x.mp3', 44100, Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0, 0, 0, 0, 0, 0, 0]),   // ID3 空标签
    Buffer.from([0xFF, 0xFB, 0x90, 0x00]), Buffer.alloc(64)]));                              // + MPEG1 帧 + 填充
  { // Ogg Vorbis：OggS + 填充 + 0x01"vorbis" 识别头（+12 处 44100 LE）
    const b = Buffer.alloc(64); b.write('OggS', 0, 'ascii'); b[28] = 1;
    b.write('vorbis', 29, 'ascii'); b.writeUInt32LE(44100, 40);
    push('x.ogg', 44100, b);
  }
  { // Ogg Opus：OpusHead → 按 48 kHz 分析
    const b = Buffer.alloc(64); b.write('OggS', 0, 'ascii'); b.write('OpusHead', 28, 'ascii');
    push('x.opus', 48000, b);
  }
  push('x.m4a', 44100, makeMiniMp4(44100));
  push('x.bin', 0, Buffer.alloc(64));
  for (const [name, rate, b] of cases) {
    const got = await js(`detectRate(Uint8Array.from(atob("${b}"), c => c.charCodeAt(0)).buffer, "${name}")`);
    ok(got === rate, `detectRate(${name}) → ${rate} Hz（实际 ${got}）`);
  }

  console.log('— 桌面版 probe 兜底（ffmpeg 读流信息）');
  const probed = await js(`(async () => {
    const bytes = Uint8Array.from(atob("${b64(w44)}"), c => c.charCodeAt(0));
    return window.dolby.probe(new File([bytes], "tone-44k.wav"));
  })()`);
  ok(probed === 44100, `dolby.probe → 44100 Hz（实际 ${probed}）`);

  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'snap7-samplerate.png'), img.toPNG());
  console.log('saved snap7-samplerate.png');
  console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
  app.exit(failed ? 1 : 0);
}).catch(e => { console.error(e); app.exit(1); });
