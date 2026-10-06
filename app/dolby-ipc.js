// 杜比 / DTS / WMA 等 Chromium 解不了的编码 → ffmpeg 转 PCM 的主进程侧 IPC
// 由 main.js（正式应用）与 verify-dolby.js（链路验证）共用，保证测试的就是正式代码
const { app, ipcMain, dialog, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

function ffmpegPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'ffmpeg.exe')
    : require('@ffmpeg-installer/ffmpeg').path;
}

const tmpRoot = () => path.join(app.getPath('temp'), 'hibiki-player-dolby');

// 本机 ffmpeg 构建只有 mov 族（mp4/mov/m4a…）解复用器支持 -ignore_editlist；
// mka/mkv/ts/裸流（eac3/ac3/dts/thd）没有该选项，传入会导致整个命令直接报错退出
const MOV_LIKE = /\.(mp4|m4a|m4b|m4v|mov|3gp|3g2)$/i;

// 诊断日志：追加写入 userData 下的 av-debug.log（排查转码/导出问题时只看这个文件即可）
function dbg(msg) {
  try {
    const f = path.join(app.getPath('userData'), 'av-debug.log');
    fs.appendFileSync(f, new Date().toISOString() + ' ' + msg + '\n');
  } catch (e) { /* 日志失败不影响功能 */ }
}
// 从 WAV 字节流头解析声道数与采样率（供日志与校验用）
function wavHeaderInfo(bytes) {
  try {
    const dv = bytes instanceof DataView ? bytes : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.byteLength < 16 || dv.getUint32(0, true) !== 0x46464952) return null;
    let off = 12;
    while (off + 8 <= dv.byteLength) {
      const id = dv.getUint32(off, true), size = dv.getUint32(off + 4, true);
      if (id === 0x20746D66) return { ch: dv.getUint16(off + 10, true), rate: dv.getUint32(off + 12, true) };
      off += 8 + size + (size & 1);
    }
  } catch (e) { /* ignore */ }
  return null;
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(err.trim() || ('ffmpeg 退出码 ' + code)))));
  });
}

// 转成 PCM WAV（保留原始采样率与声道布局）；channels>0 时重编码到指定声道数
// （如设备仅支持 5.1 时把 7.1 下混为 5.1，而非一路降到立体声）。
// 结果按 来源+大小+目标声道 缓存在临时目录。
// 并发安全：同一文件正在转码时后续请求直接等同一结果（双击触发的两个请求只跑一次 ffmpeg）；
// 输出先写 .tmp-* 再原子改名——任何时刻读到的缓存文件都是完整文件，绝不出现半截 WAV。
const inFlight = new Map();   // hash -> Promise

// —— 临时目录体积控制 ——
// 多声道 PCM 体积很大（5.1@96k ≈ 1.15 MB/s，一首曲子几百 MB），只在退出时清理会让会话期间
// 的临时目录涨到数 GB。超出预算时按修改时间从旧到新淘汰；正在转码（inFlight）与刚生成
// （2 分钟内）的文件一律跳过，绝不删到正在被读取/写入的文件。
const TMP_BUDGET = 1.5e9;
function pruneTmpDir(dir, keepFile, budget) {
  try {
    const limit = budget || TMP_BUDGET;
    const files = [];
    let total = 0;
    for (const name of fs.readdirSync(dir)) {
      if (!/\.wav$/i.test(name)) continue;
      const p = path.join(dir, name);
      let st;
      try { st = fs.statSync(p); } catch (e) { continue; }
      if (!st.isFile()) continue;
      files.push({ p, size: st.size, mtime: st.mtimeMs });
      total += st.size;
    }
    if (total <= limit) return;
    files.sort((a, b) => a.mtime - b.mtime);
    const now = Date.now();
    for (const f of files) {
      if (total <= limit) break;
      if (keepFile && path.resolve(f.p) === path.resolve(keepFile)) continue;
      if (now - f.mtime < 120000) continue;               // 刚生成的：可能正被读取/转码
      const base = path.basename(f.p);
      let busy = false;
      for (const h of inFlight.keys()) if (base.startsWith(h)) { busy = true; break; }
      if (busy) continue;
      try { fs.unlinkSync(f.p); total -= f.size; } catch (e) { /* 文件被占用：跳过 */ }
    }
  } catch (e) { /* 清理失败不影响功能 */ }
}

ipcMain.handle('dolby:convert', async (event, req) => {
  const srcLabel = (req && (req.path || req.name)) || '(data)';
  const ac = Number.isInteger(req.channels) && req.channels >= 1 && req.channels <= 8
    ? req.channels : 0;
  const dir = tmpRoot();
  fs.mkdirSync(dir, { recursive: true });
  // 清理历史遗留的半成品临时文件（上次进程被强杀时可能残留）
  try {
    for (const f of fs.readdirSync(dir))
      if (f.includes('-tmp')) { try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* ignore */ } }
  } catch (e) { /* ignore */ }
  const hash = crypto.createHash('md5')
    .update(req.path || req.name || '')
    .update(':' + req.size)
    .update(':' + ac)
    .digest('hex').slice(0, 16);
  const out = path.join(dir, hash + '.wav');
  if (!fs.existsSync(out)) {
    let task = inFlight.get(hash);
    if (!task) {
      task = (async () => {
        let src = req.path;
        let tmpSrc = null;
        if (!src) {
          tmpSrc = path.join(dir, hash + '.src');
          fs.writeFileSync(tmpSrc, Buffer.from(req.data));
          src = tmpSrc;
        }
        // 临时名必须以 .wav 结尾（ffmpeg 按扩展名推断输出格式），再加 -f wav 显式指定
        const tmpOut = path.join(dir, hash + '-tmp' + process.pid + '-' + Date.now() + '.wav');
        try {
          // DSD（dsf/dff）：ffmpeg 按 1/8 采样率解成 PCM（DSD64→352.8kHz）体积过大，
          // 统一压到 176.4kHz（DSD 常见 PCM 输出率），其余格式保持原始采样率
          const isDSD = /\.(dsf|dff)$/i.test(src);
          // MOV 族才加 -ignore_editlist（忽略 MP4/MOV 编辑列表，否则部分视频音轨会被裁短；
          // 其余容器/裸流的解复用器没有该选项，硬传会报 Option not found）；
          // 不指定 -map：让 ffmpeg 自动挑选「默认」音轨（多音轨视频里避免选到短小的辅轨）
          await runFFmpeg(['-hide_banner', '-loglevel', 'error', '-y',
            ...(MOV_LIKE.test(src) ? ['-ignore_editlist', '1'] : []),
            '-i', src, '-vn',
            ...(isDSD ? ['-ar', '176400'] : []),
            ...(ac ? ['-ac', String(ac)] : []),
            '-c:a', 'pcm_s16le', '-f', 'wav', tmpOut]);
          fs.renameSync(tmpOut, out);   // 原子完成：并发调用者绝不会读到半截文件
        } finally {
          if (tmpSrc) try { fs.unlinkSync(tmpSrc); } catch (e) { /* 已删 */ }
          try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch (e) { /* ignore */ }
        }
      })();
      inFlight.set(hash, task);
      // 完成/失败都从表中移除：失败后下一次请求会真正重试 ffmpeg，
      // 而不是永远复用这个 rejected Promise（表现为同一文件再也解码不了，只能重启应用）。
      const clear = () => { if (inFlight.get(hash) === task) inFlight.delete(hash); };
      task.then(clear, clear);
    }
    await task;
    if (!fs.existsSync(out)) throw new Error('未找到可解码的音频轨');
  }
  const buf = fs.readFileSync(out);
  pruneTmpDir(dir, out);
  const hi = wavHeaderInfo(buf);
  dbg('convert src=' + srcLabel + ' size=' + (req && req.size) + ' ac=' + ac + ' -> ' + buf.length + 'B' +
      (hi ? ' ch=' + hi.ch + ' rate=' + hi.rate + ' dur=' + (buf.length / (hi.rate * hi.ch * 2)).toFixed(2) + 's' : ' (no wav header)'));
  return buf;
});

// 探测音频采样率：ffmpeg -i 只读流信息不产出文件（退出码非 0），从 stderr 解析 "N Hz"。
// 页面侧文件头解析不出时（mka / moov 在尾部的 mp4 等）的兜底。
ipcMain.handle('dolby:probe', async (event, req) => {
  const dir = tmpRoot();
  fs.mkdirSync(dir, { recursive: true });
  let src = req.path;
  let tmpSrc = null;
  if (!src) {
    tmpSrc = path.join(dir, 'probe-' + Date.now() + '.src');
    fs.writeFileSync(tmpSrc, Buffer.from(req.data));
    src = tmpSrc;
  }
  let err = '';
  try {
    err = await new Promise(res => {
      const p = spawn(ffmpegPath(), ['-hide_banner', '-i', src], { windowsHide: true });
      let e = '';
      p.stderr.on('data', d => { e += d; });
      p.on('error', () => res(''));
      p.on('close', () => res(e));
    });
  } finally {
    if (tmpSrc) try { fs.unlinkSync(tmpSrc); } catch (e) { /* 已删 */ }
  }
  const m = /Audio:.*?(\d+)\s*Hz/.exec(err);
  const r = m ? Number(m[1]) : 0;
  return r >= 3000 && r <= 768000 ? r : 0;
});

// 探测时长（秒，失败 0）：解析 ffmpeg -i 的 Duration 行。
// 容器文件（mp4/mka…）为精确元数据；裸流（eac3/ac3/thd/dts）按码率估算——
// 对杜比编码 Chromium 无法解码，其估算不可信，这里用 ffmpeg 的结果作为歌单行时长。
ipcMain.handle('dolby:probedur', async (event, req) => {
  let src = req && req.path;
  let tmpSrc = null;
  if (!src) {
    if (!req || !req.data) return 0;
    try { fs.mkdirSync(tmpRoot(), { recursive: true }); } catch (e) { /* ignore */ }
    tmpSrc = path.join(tmpRoot(), 'pd-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.src');
    fs.writeFileSync(tmpSrc, Buffer.from(req.data));
    src = tmpSrc;
  }
  let err = '';
  try {
    err = await ffmpegStderr(['-hide_banner', '-i', src]);
  } finally {
    if (tmpSrc) try { fs.unlinkSync(tmpSrc); } catch (e) { /* 已删 */ }
  }
  const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(err);
  const dur = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
  dbg('probedur src=' + src + ' -> ' + (isFinite(dur) && dur > 0 ? dur.toFixed(2) + 's' : 'FAIL'));
  return isFinite(dur) && dur > 0 ? dur : 0;
});

// 视频/容器文件的音频导出：原样导出视频中的音轨（流拷贝，不重编码、不加任何内容）。
// 关键点：
// 1. 用「解码实测」得到每条音轨的真实时长（不信任容器 Duration 元数据——杜比/TS 等容器
//    的时长元数据常常是错的，之前按它 -t 截断导致只导出不到一分钟）；
// 2. 多音轨视频选时长最长的那条（避免选到短小的辅轨）；
// 3. -c:a copy 原样拷贝；-fflags +genpts / -ignore_editlist 修复时间戳与编辑列表
//    导致的拷贝截断。
const EXPORT_EXT = {
  aac: 'm4a', mp3: 'mp3', ac3: 'ac3', eac3: 'eac3', dts: 'dts',
  flac: 'flac', opus: 'opus', vorbis: 'ogg', pcm_s16le: 'wav',
  pcm_s24le: 'wav', pcm_f32le: 'wav', pcm_f64le: 'wav',
  wmav2: 'wma', wmapro: 'wma', alac: 'm4a', truehd: 'thd', mlp: 'thd',
};
function ffmpegStderr(args) {
  return new Promise(res => {
    const p = spawn(ffmpegPath(), args, { windowsHide: true });
    let e = '';
    p.stderr.on('data', d => { e += d; });
    p.on('error', () => res(''));
    p.on('close', () => res(e));
  });
}
function parseAudioStreams(stderr) {
  const out = [];
  const re = /Stream #0:(\d+)(?:\[[^\]]*\])?(?:\([^)]*\))?: Audio:\s*([A-Za-z0-9_]+)/g;
  let m;
  while ((m = re.exec(stderr))) {
    const lineEnd = stderr.indexOf('\n', m.index);
    const seg = lineEnd < 0 ? stderr.slice(m.index) : stderr.slice(m.index, lineEnd);
    out.push({ idx: Number(m[1]), codec: m[2].toLowerCase(), def: /\(default\)/.test(seg) });
  }
  return out;
}
// 解码实测音轨真实时长（秒）：ffmpeg 解码整条流输出到 null，
// 用 -progress 文件拿到精确的 out_time_us（stderr 统计行在非终端下不可靠）
function measureStreamDuration(src, streamIdx) {
  return new Promise(res => {
    try { fs.mkdirSync(tmpRoot(), { recursive: true }); } catch (e) { /* ignore */ }
    const progFile = path.join(tmpRoot(), 'prog-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.txt');
    const p = spawn(ffmpegPath(),
      ['-hide_banner', '-loglevel', 'error', '-i', src, '-map', '0:' + streamIdx,
       '-f', 'null', '-', '-progress', progFile],
      { windowsHide: true });
    p.on('error', () => res(0));
    p.on('close', () => {
      let dur = 0;
      try {
        const txt = fs.readFileSync(progFile, 'utf8');
        const times = [...txt.matchAll(/out_time_us=(\d+)/g)];
        if (times.length) dur = Number(times[times.length - 1][1]) / 1e6;
      } catch (e) { /* ignore */ }
      try { fs.unlinkSync(progFile); } catch (e) { /* ignore */ }
      res(dur);
    });
  });
}
// 解码实测「导出产物」的真实时长（秒）：单音轨文件按 0:0 取第一条流
function verifyFileDuration(file) {
  return new Promise(res => {
    const progFile = path.join(tmpRoot(), 'prog-v-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.txt');
    const p = spawn(ffmpegPath(),
      ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:0',
       '-f', 'null', '-', '-progress', progFile],
      { windowsHide: true });
    p.on('error', () => res(0));
    p.on('close', () => {
      let dur = 0;
      try {
        const txt = fs.readFileSync(progFile, 'utf8');
        const times = [...txt.matchAll(/out_time_us=(\d+)/g)];
        if (times.length) dur = Number(times[times.length - 1][1]) / 1e6;
      } catch (e) { /* ignore */ }
      try { fs.unlinkSync(progFile); } catch (e) { /* ignore */ }
      res(dur);
    });
  });
}
ipcMain.handle('audio:export', async (event, req) => {
  try {
    const src = req && req.path;
    if (typeof src !== 'string' || !src) return { ok: false, error: '无效的文件路径' };
    if (!fs.existsSync(src)) return { ok: false, error: '文件不存在或已移动' };
    // 列出音频流（默认音轨优先）
    const streams = parseAudioStreams(await ffmpegStderr(['-hide_banner', '-i', src]));
    if (!streams.length) return { ok: false, error: '未找到音频轨' };
    const candidates = streams.slice().sort((a, b) => (b.def ? 1 : 0) - (a.def ? 1 : 0));
    // 解码实测各候选音轨真实时长，选最长的一条
    let best = null;
    for (const s of candidates) {
      const dur = await measureStreamDuration(src, s.idx);
      dbg('export measure stream#0:' + s.idx + ' ' + s.codec + ' -> ' + dur.toFixed(2) + 's');
      if (best == null || dur > best.dur) best = { idx: s.idx, codec: s.codec, dur };
    }
    const ext = (best.codec && EXPORT_EXT[best.codec]) || 'mka';
    const base = path.basename(src, path.extname(src));
    const win = BrowserWindow.fromWebContents(event.sender);
    const opts = {
      title: '导出音频',
      defaultPath: path.join(app.getPath('downloads'), base + '.' + ext),
      filters: [{ name: '音频文件', extensions: [ext] }],
    };
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return { ok: false, error: '已取消' };
    // 原样流拷贝（不加任何内容、不重编码）；拷贝完成后解码实测产物，短于源流 85% 视为截断
    const copyArgs = toFile => ['-hide_banner', '-loglevel', 'error', '-y',
      '-fflags', '+genpts',
      ...(MOV_LIKE.test(src) ? ['-ignore_editlist', '1'] : []),
      '-i', src, '-vn', '-map', '0:' + best.idx, '-c:a', 'copy', toFile];
    let outPath = res.filePath;
    let note = (best.codec || '').toUpperCase() + ' 原样导出';
    await runFFmpeg(copyArgs(outPath));
    if (!fs.existsSync(outPath)) return { ok: false, error: '导出失败（未生成文件）' };
    let outDur = await verifyFileDuration(outPath);
    const short = best.dur > 0 && outDur > 0 && outDur < best.dur * 0.85;
    if (short) {
      // 第 1 级修复：改为 MKA（Matroska）封装重拷贝——仍是流拷贝、字节级原声，
      // 但按时间戳收尾，对编辑列表/时间戳怪异的杜比文件更稳
      const alt = outPath.replace(/\.[^.]+$/, '') + '.mka';
      await runFFmpeg(copyArgs(alt));
      const altDur = await verifyFileDuration(alt);
      if (best.dur <= 0 || altDur <= 0 || altDur >= best.dur * 0.85) {
        try { fs.unlinkSync(outPath); } catch (e) { /* ignore */ }
        outPath = alt; outDur = altDur;
        note = (best.codec || '').toUpperCase() + ' 原样导出（MKA 封装）';
      } else {
        // 第 2 级修复：解码为 PCM WAV——保证内容完整（仅在流拷贝仍截断时使用）
        const wav = outPath.replace(/\.[^.]+$/, '') + '.wav';
        await runFFmpeg(['-hide_banner', '-loglevel', 'error', '-y',
          ...(MOV_LIKE.test(src) ? ['-ignore_editlist', '1'] : []),
          '-i', src, '-vn', '-map', '0:' + best.idx, '-c:a', 'pcm_s16le', wav]);
        const wavDur = await verifyFileDuration(wav);
        try { fs.unlinkSync(alt); } catch (e) { /* ignore */ }
        try { fs.unlinkSync(outPath); } catch (e) { /* ignore */ }
        outPath = wav; outDur = wavDur;
        note = 'PCM 解码导出（流拷贝截断，已保证完整）';
      }
    }
    dbg('export done file=' + outPath + ' size=' + (fs.existsSync(outPath) ? fs.statSync(outPath).size : -1) +
        ' outDur=' + outDur.toFixed(2) + 's note=' + note);
    return { ok: true, file: outPath, duration: outDur > 0 ? outDur : best.dur, note };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

app.on('will-quit', () => {
  try { fs.rmSync(tmpRoot(), { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
});

// 供离线自测使用（main.js 不使用导出）
module.exports = { _internals: { pruneTmpDir, inFlight } };
