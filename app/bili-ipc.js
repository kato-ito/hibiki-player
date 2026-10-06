// B站音频下载桥：主进程侧完成「解析 → 取流 → 下载 → ffmpeg 无损封装（可选内嵌封面/标签）」
// 管线参考 bilidown：view 接口取视频信息、playurl(fnval=4048) 取 DASH 音频流、
// 带 Referer / User-Agent（可选 SESSDATA Cookie）直连 CDN 下载，最后 ffmpeg 流拷贝封装为
// 播放器可直接播放的音频文件（AAC→M4A、Hi-Res→FLAC、杜比→EAC3），不重编码，保持原始音频。
// 由 main.js 加载，仅供桌面版使用。
const { app, ipcMain, dialog, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const { URL } = require('url');
const NAMING = require('./bili-naming');   // 命名规则（与安卓端 BiliNaming.kt 一致）
const STREAM = require('./bili-stream');   // 分P音质挑选（id 缺失时按编码类型退到同类最高码率）

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36';
const BILI_REFERER = 'https://www.bilibili.com';
const API_TIMEOUT = 20000;

function ffmpegPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'ffmpeg.exe')
    : require('@ffmpeg-installer/ffmpeg').path;
}

function dbg(msg) {   // 诊断日志：与杜比转码共用 av-debug.log
  try {
    const f = path.join(app.getPath('userData'), 'av-debug.log');
    fs.appendFileSync(f, new Date().toISOString() + ' [bili] ' + msg + '\n');
  } catch (e) { /* 日志失败不影响功能 */ }
}

/* ---------- 通用 HTTP(S) GET：跟随重定向，返回 { buffer, finalUrl } ---------- */
function biliGet(urlStr, headers = {}, redirects = 8) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('无效链接：' + urlStr)); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(u, {
      method: 'GET',
      headers: { 'User-Agent': UA, Referer: BILI_REFERER, Accept: '*/*', ...headers },
      timeout: API_TIMEOUT,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        biliGet(new URL(res.headers.location, u).toString(), headers, redirects - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode + '：' + urlStr));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), finalUrl: u.toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时：' + urlStr)));
    req.end();
  });
}

// 解析 B 站 JSON 接口（code!==0 时抛出官方 message）
async function biliJSON(urlStr, headers = {}) {
  const { buffer } = await biliGet(urlStr, headers);
  let j;
  try { j = JSON.parse(buffer.toString('utf8')); } catch (e) { throw new Error('接口返回的不是 JSON'); }
  if (!j || j.code !== 0) throw new Error((j && j.message) || ('B站接口错误 code=' + (j && j.code)));
  return j.data;
}

/* ---------- Cookie：可选 SESSDATA（登录解锁会员音质）+ 自动 buvid3 ---------- */
let userCookie = '';
const cookieFile = () => path.join(app.getPath('userData'), 'bili-cookie.txt');
try { userCookie = fs.readFileSync(cookieFile(), 'utf8').trim(); } catch (e) { /* 无 */ }

let buvid3 = '', buvidTried = false;
async function ensureBuvid() {
  if (buvidTried) return;
  buvidTried = true;
  try {
    const { buffer } = await biliGet('https://api.bilibili.com/x/frontend/finger/spi');
    const j = JSON.parse(buffer.toString('utf8'));
    if (j && j.code === 0 && j.data) buvid3 = j.data.b_3 || '';
  } catch (e) { /* 拿不到 buvid 也能下，成功率略低 */ }
}
function cookieHeader() {
  const parts = [];
  if (buvid3) parts.push('buvid3=' + buvid3);
  if (userCookie) parts.push(userCookie.replace(/;\s*$/, ''));
  return parts.join('; ');
}

/* ---------- 任务取消 ---------- */
const tasks = new Map();   // taskId -> { canceled, req, res, proc }
function taskState(taskId) {
  if (!tasks.has(taskId)) tasks.set(taskId, { canceled: false, req: null, res: null, proc: null });
  return tasks.get(taskId);
}
function canceledError() { const e = new Error('已取消'); e.canceled = true; return e; }

ipcMain.on('bili:cancel', (event, taskId) => {
  const t = tasks.get(String(taskId));
  if (!t) return;
  t.canceled = true;
  if (t.req) { try { t.req.destroy(new Error('已取消')); } catch (e) { /* ignore */ } }
  if (t.res) { try { t.res.destroy(new Error('已取消')); } catch (e) { /* ignore */ } }   // 下载流进行中：销毁响应即可立即中止
  if (t.proc) { try { t.proc.kill(); } catch (e) { /* ignore */ } }
});

/* ---------- 流式下载到文件（跟随重定向 / 进度回调 / 可取消） ---------- */
/* ---------- 裸流：前置 ID3v2.3 标签（标题/UP主/专辑/封面） ----------
   裸 eac3 / ac3 / dts 容器装不下 attached_pic 视频流（ffmpeg 只允许单流），
   这里手工构造 ID3v2 标签前置到文件头；实测 ffmpeg 仍能识别 eac3 流、读出标签并解码。 */
const RAW_STREAM_EXTS = new Set(['eac3', 'ac3', 'dts', 'dtshd', 'dtsma', 'thd', 'truehd', 'wma', 'wmav2', 'wmapro', 'ape', 'wv']);

function id3Frame(id, data) {
  const head = Buffer.alloc(10);
  head.write(id, 0, 'ascii');
  head.writeUInt32BE(data.length, 4);            // ID3v2.3 用普通 32 位长度
  return Buffer.concat([head, data]);
}
function id3Text(id, text) {
  if (!text) return Buffer.alloc(0);
  return id3Frame(id, Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8')]));
}
function id3Picture(cover) {
  if (!cover || !cover.length) return Buffer.alloc(0);
  const mime = (cover[0] === 0x89 && cover[1] === 0x50) ? 'image/png' : 'image/jpeg';
  return id3Frame('APIC', Buffer.concat([
    Buffer.from([0]), Buffer.from(mime + '\0', 'latin1'), Buffer.from([3]),
    Buffer.from('cover\0', 'latin1'), cover,
  ]));
}
/** 给裸流文件前置 ID3v2 标签；返回是否写入 */
function writeId3ToRaw(file, meta) {
  const ext = (path.extname(file).slice(1) || '').toLowerCase();
  if (!RAW_STREAM_EXTS.has(ext)) return false;
  const frames = Buffer.concat([
    id3Text('TIT2', meta.title), id3Text('TPE1', meta.artist),
    id3Text('TALB', meta.album), id3Text('TSSE', 'Hibiki Player'),
    id3Picture(meta.cover),
  ]);
  if (!frames.length) return false;
  const head = Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.from([3, 0, 0]),
    Buffer.from([(frames.length >> 21) & 0x7f, (frames.length >> 14) & 0x7f, (frames.length >> 7) & 0x7f, frames.length & 0x7f])]);
  const original = fs.readFileSync(file);
  let start = 0;
  if (original.length > 10 && original[0] === 0x49 && original[1] === 0x44 && original[2] === 0x33) {
    const n = ((original[6] & 0x7f) << 21) | ((original[7] & 0x7f) << 14) | ((original[8] & 0x7f) << 7) | (original[9] & 0x7f);
    if (10 + n < original.length) start = 10 + n;
  }
  fs.writeFileSync(file, Buffer.concat([head, frames, original.slice(start)]));
  return true;
}

function downloadToFile(urlStr, dest, headers, taskId, onProgress, speedKbps) {
  return new Promise((resolve, reject) => {
    const follow = (u, depth) => {
      const t = taskState(taskId);
      if (t.canceled) return reject(canceledError());
      let parsed;
      try { parsed = new URL(u); } catch (e) { return reject(new Error('无效下载链接')); }
      const mod = parsed.protocol === 'http:' ? http : https;
      const req = mod.request(parsed, {
        method: 'GET',
        headers: { 'User-Agent': UA, Referer: BILI_REFERER, Accept: '*/*', ...headers },
        timeout: 30000,
      }, res => {
        t.res = res;              // 保留响应引用：下载进行中的取消靠销毁响应流实现
        t.req = null;
        // 错误统一走 fail：取消状态下返回 canceledError，避免把取消误报成网络错误
        const fail = e => reject(t.canceled ? canceledError() : new Error('下载中断：' + ((e && e.message) || e)));
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth > 0) {
          res.resume();
          t.res = null;
          return follow(new URL(res.headers.location, parsed).toString(), depth - 1);
        }
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          t.res = null;
          return reject(new Error('下载失败 HTTP ' + res.statusCode));
        }
        const total = Number(res.headers['content-length']) || 0;
        let loaded = 0, lastEmit = 0, lastBytes = 0, lastTime = Date.now();
        const limitKbps = Number(speedKbps) || 0;      // 0 = 不限速
        const startedAt = Date.now();
        const ws = fs.createWriteStream(dest);
        res.on('data', c => {
          loaded += c.length;
          const now = Date.now();
          if (now - lastEmit >= 200) {   // 进度节流：每 200ms 上报一次
            const speed = (loaded - lastBytes) / Math.max(1, (now - lastTime) / 1000);
            lastEmit = now; lastBytes = loaded; lastTime = now;
            if (onProgress) onProgress({ loaded, total, speed });
          }
          // 限速：按「已用时间 vs 应下载字节」暂停/恢复，保持平均速率
          if (limitKbps > 0) {
            const targetMs = loaded * 1000 / (limitKbps * 1024);
            const behind = targetMs - (Date.now() - startedAt);
            if (behind > 20) {
              res.pause();
              setTimeout(() => { if (!t.canceled) res.resume(); }, Math.min(behind, 500));
            }
          }
        });
        res.pipe(ws);
        ws.on('error', fail);
        res.on('error', fail);
        ws.on('close', () => {
          t.res = null;
          if (t.canceled) {
            try { fs.unlinkSync(dest); } catch (e) { /* ignore */ }
            return reject(canceledError());
          }
          if (onProgress) onProgress({ loaded, total, speed: 0 });
          resolve(total);
        });
      });
      t.req = req;
      req.on('error', e => reject(t.canceled ? canceledError() : new Error('下载中断：' + ((e && e.message) || e))));
      req.on('timeout', () => { if (t.req === req) { t.req = null; req.destroy(new Error('下载超时')); } });
      req.end();
    };
    follow(urlStr, 8);
  });
}

/* ---------- ffmpeg 封装（支持取消） ---------- */
function runFFmpeg(args, taskId) {
  return new Promise((resolve, reject) => {
    const t = taskState(taskId);
    if (t.canceled) return reject(canceledError());
    const p = spawn(ffmpegPath(), args, { windowsHide: true });
    t.proc = p;
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => {
      t.proc = null;
      if (t.canceled) return reject(canceledError());
      if (code === 0) resolve();
      else reject(new Error((err || '').trim().slice(-400) || ('ffmpeg 退出码 ' + code)));
    });
  });
}

/* ---------- 工具 ---------- */
function safeName(s) {
  let n = String(s || '').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!n) n = 'bilibili_audio';
  return n.slice(0, 120);
}
function uniqueOut(dir, base, ext) {
  const first = path.join(dir, base + '.' + ext);
  if (!fs.existsSync(first)) return first;
  for (let i = 2; i < 10000; i++) {
    const p = path.join(dir, base + ' (' + i + ').' + ext);
    if (!fs.existsSync(p)) return p;
  }
  return path.join(dir, base + '-' + Date.now() + '.' + ext);
}

/* ================= IPC ================= */

// 解析链接 → 视频信息（含分P列表）
ipcMain.handle('bili:resolve', async (event, input) => {
  try {
    let u = typeof input === 'string' ? input.trim() : '';
    if (!u) throw new Error('请粘贴 B 站视频链接（支持 BV 链接与 b23.tv 短链）');
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    let bvid = null;
    const m = /(BV[0-9A-Za-z]{10})/.exec(u);
    if (m) bvid = m[1];
    else {
      const res = await biliGet(u, {}, 8);   // b23.tv 等短链：跟随重定向找 BV 号
      const m2 = /(BV[0-9A-Za-z]{10})/.exec(res.finalUrl || '');
      if (m2) bvid = m2[1];
    }
    if (!bvid) throw new Error('未在链接中找到 BV 号（支持 b23.tv 短链 / www.bilibili.com/video/BV… 链接）');
    await ensureBuvid();
    const headers = cookieHeader() ? { Cookie: cookieHeader() } : {};
    const d = await biliJSON('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, headers);
    const pages = (d.pages && d.pages.length ? d.pages
      : [{ cid: d.cid, page: 1, part: d.title || 'P1', duration: d.duration || 0 }])
      .map(p => ({ cid: p.cid, page: p.page, part: p.part || ('P' + p.page), duration: p.duration || 0 }));
    dbg('resolve ok bvid=' + bvid + ' title=' + (d.title || '') + ' pages=' + pages.length);
    return {
      bvid: d.bvid || bvid, aid: d.aid || 0,
      title: d.title || '', pic: (d.pic || '').replace(/^\/\//, 'https://'),
      owner: (d.owner && d.owner.name) || '', duration: d.duration || 0,
      multi: pages.length > 1, pages,
    };
  } catch (err) {
    dbg('resolve fail: ' + ((err && err.message) || err));
    return { error: (err && err.message) || String(err) };
  }
});

// 取某一分P的音频流清单（DASH 音频；Hi-Res FLAC / 杜比 EAC3 优先展示）
ipcMain.handle('bili:streams', async (event, req) => {
  try {
    const bvid = req && req.bvid, cid = req && req.cid;
    if (!bvid || !cid) throw new Error('参数不完整');
    await ensureBuvid();
    const headers = cookieHeader() ? { Cookie: cookieHeader() } : {};
    // 注意：不能带 platform/otype 参数——带了会被当成老接口返回 durl，拿不到 DASH 音频（bilidown 实测）
    const d = await biliJSON(
      'https://api.bilibili.com/x/player/playurl?bvid=' + encodeURIComponent(bvid) +
      '&cid=' + encodeURIComponent(cid) + '&fourk=1&fnver=0&fnval=4048',
      headers);
    const streams = [];
    const seen = new Set();
    const push = a => {
      if (!a || typeof a !== 'object') return;
      const url = a.baseUrl || a.base_url || '';
      if (!url || seen.has(a.id)) return;
      seen.add(a.id);
      streams.push({
        id: a.id, codec: a.codecs || '', bandwidth: a.bandwidth || 0,
        baseUrl: url, backupUrl: (a.backupUrl && a.backupUrl.length)
          ? a.backupUrl : (a.backup_url || []),
      });
    };
    if (d.dash) {
      if (d.dash.flac && d.dash.flac.audio) push(d.dash.flac.audio);   // Hi-Res 无损
      if (d.dash.dolby && d.dash.dolby.audio) d.dash.dolby.audio.forEach(push);  // 杜比全景声
      (d.dash.audio || []).forEach(push);
    }
    streams.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    // 老接口兜底（极少数内容无 DASH）：整段 MP4，下载后由 ffmpeg 抽取音轨
    const durl = (!streams.length && d.durl && d.durl.length) ? (d.durl[0].url || '') : '';
    return { streams, durl, timelength: d.timelength || 0 };
  } catch (err) {
    return { error: (err && err.message) || String(err) };
  }
});

// 下载单条音频：取流 → 下载 m4s → ffmpeg 无损封装（可选内嵌封面 + 标签）
ipcMain.handle('bili:download', async (event, req) => {
  const taskId = String((req && req.taskId) || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)));
  const send = p => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win && !win.isDestroyed()) win.webContents.send('bili:progress', Object.assign({ taskId }, p));
    } catch (e) { /* 窗口已关闭 */ }
  };
  const t = taskState(taskId);
  t.canceled = false;
  const tmpDir = path.join(app.getPath('temp'), 'hibiki-player-bili');
  let segPath = null, coverPath = null;
  try {
    const bvid = req && req.bvid, cid = req && req.cid;
    if (!bvid || !cid) throw new Error('参数不完整');
    const outDir = (req && req.outDir && typeof req.outDir === 'string') ? req.outDir : app.getPath('music');
    try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { throw new Error('无法写入保存目录：' + outDir); }
    const fmt = req && req.fmt === 'mp3' ? 'mp3' : 'orig';
    const embedCover = !!(req && req.embedCover) && !!(req && req.pic);

    // 1) 取流（baseUrl 有时效，下载前重新取一遍）
    send({ phase: 'meta', text: '获取音频流…' });
    await ensureBuvid();
    const headers = cookieHeader() ? { Cookie: cookieHeader() } : {};
    // 注意：不能带 platform/otype 参数——带了会被当成老接口返回 durl，拿不到 DASH 音频（bilidown 实测）
    const d = await biliJSON(
      'https://api.bilibili.com/x/player/playurl?bvid=' + encodeURIComponent(bvid) +
      '&cid=' + encodeURIComponent(cid) + '&fourk=1&fnver=0&fnval=4048',
      headers);
    const all = [];
    const push = a => {
      if (!a || typeof a !== 'object') return;
      const url = a.baseUrl || a.base_url || '';
      if (url) all.push({
        id: a.id, baseUrl: url,
        backupUrl: (a.backupUrl && a.backupUrl.length) ? a.backupUrl : (a.backup_url || []),
        codecs: a.codecs || '', bandwidth: a.bandwidth || 0,
      });
    };
    if (d.dash) {
      if (d.dash.flac && d.dash.flac.audio) push(d.dash.flac.audio);
      if (d.dash.dolby && d.dash.dolby.audio) d.dash.dolby.audio.forEach(push);
      (d.dash.audio || []).forEach(push);
    }
    const durl = (!all.length && d.durl && d.durl.length) ? (d.durl[0].url || '') : '';
    const wantId = req && req.streamId;
    // 合集里各分P的音轨可能不同（P1 有 Hi-Res / 杜比，后面的分P没有）：
    // 只按 id 严格匹配会让这些分P整条失败。与安卓端一致，按「编码类型」退到同类最高码率。
    const stream = STREAM.pickStream(all, wantId, req && req.streamCodec);
    if (stream && String(wantId) !== 'auto' && wantId != null && String(stream.id) !== String(wantId))
      dbg('stream id=' + wantId + ' 不在本分P，退到同类 ' + STREAM.streamKind(req && req.streamCodec) + ' id=' + stream.id);
    // 既没有可用音轨、也没有整段 MP4 兜底 → 这个分P才算真的下不了
    if (!stream && !durl) {
      throw new Error(String(wantId) !== 'auto' && wantId != null && String(wantId) !== 'durl'
        ? '所选音质已不可用（可能已过期），请重新解析后再试'
        : '未找到可下载的音频流（该视频可能不支持音频下载）');
    }

    // 2) 目标格式：AAC→M4A、FLAC→FLAC、EAC3→MP4 容器（音频码流一律 -c:a copy 不重编码）；MP3 为转码
    const codec = stream ? String(stream.codecs || '').toLowerCase() : 'mp4a';
    const isFlac = codec.startsWith('flac');
    const isEac3 = codec.startsWith('ec-3') || codec.startsWith('eac3');
    // 杜比 E-AC-3 也装进 MP4 容器：裸 .eac3 的封装器只允许一条流，装不下封面；
    // MP4 才能把 covr 封面与标题/UP主/专辑写进同一个文件（与安卓端一致）
    const ext = fmt === 'mp3' ? 'mp3' : (isFlac ? 'flac' : 'm4a');
    // .m4a 的默认 muxer 是 ipod，不接受 ec-3 编码 → 必须显式指定 -f mp4
    const container = isEac3 ? 'mp4' : null;
    // 合集（多 P）视频：在所选文件夹里建一个以视频名命名的子文件夹，文件名只用分P名
    const sub = NAMING.folderName(req && req.folder, !!(req && req.folder && String(req.folder).trim()));
    let destDir = outDir;
    if (sub) {
      try {
        destDir = path.join(outDir, sub);
        fs.mkdirSync(destDir, { recursive: true });
      } catch (e) {
        dbg('mkdir collection dir failed: ' + ((e && e.message) || e));
        destDir = outDir;                       // 建不出来就退回写在所选文件夹里
      }
    }
    const base = NAMING.baseName((req && req.title) || 'bilibili', req && req.part, req && req.page, destDir !== outDir);
    const finalPath = uniqueOut(destDir, base, ext);

    // 3) 下载音频分片（用 .mp4 作临时扩展名：本机 ffmpeg 按扩展名识别容器，.m4s 识别不了）
    fs.mkdirSync(tmpDir, { recursive: true });
    segPath = path.join(tmpDir, 'seg-' + taskId + '.mp4');
    const candidates = stream ? [stream.baseUrl].concat(stream.backupUrl || []) : [durl];
    let lastErr = null, got = false;
    for (const u of candidates) {
      if (t.canceled) throw canceledError();
      try {
        send({ phase: 'download', text: '下载音频流…', loaded: 0, total: 0 });
        await downloadToFile(u, segPath, headers, taskId, p => {
          send({ phase: 'download', text: '下载音频流…', loaded: p.loaded, total: p.total, speed: p.speed });
        }, req.speedKbps);
        got = true; break;
      } catch (e) {
        if (e && e.canceled) throw e;
        if (t.canceled) throw canceledError();   // 取消后不再尝试备用 CDN
        lastErr = e;
        try { if (fs.existsSync(segPath)) fs.unlinkSync(segPath); } catch (e2) { /* ignore */ }
      }
    }
    if (!got) throw lastErr || new Error('下载失败');
    if (t.canceled) throw canceledError();

    // 4) 封面（失败不影响下载）
    if (embedCover) {
      coverPath = path.join(tmpDir, 'cover-' + taskId + '.jpg');
      try {
        await downloadToFile(String(req.pic).replace(/^\/\//, 'https://'), coverPath, {}, taskId, () => {});
      } catch (e) { coverPath = null; }
      if (t.canceled) throw canceledError();
    }

    // 5) ffmpeg 封装（先带封面；个别封装不接受内嵌图时退回无封面）
    send({ phase: 'mux', text: '封装音频…' });
    // 合集内标题只用分P名（与文件名一致），专辑写视频名 —— 播放器里不再显示「视频名 - 分P名」
    const isCollection = !!String(sub || '').trim();
    const metaTitle = NAMING.metaTitle(req.title || '', req.part || '', req.page || 0, isCollection);
    const metaArgs = [];
    if (metaTitle) metaArgs.push('-metadata', 'title=' + metaTitle);
    if (req.owner) metaArgs.push('-metadata', 'artist=' + req.owner);
    const metaAlbumName = NAMING.metaAlbum(req.title || '', isCollection);
    if (metaAlbumName) metaArgs.push('-metadata', 'album=' + metaAlbumName);
    if (req.sourceUrl) metaArgs.push('-metadata', 'comment=' + req.sourceUrl);
    const rawStream = RAW_STREAM_EXTS.has(ext);      // 裸流：封面/标签靠前置 ID3v2，不交给 ffmpeg
    const mkArgs = (out, withCover) => {
      const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', segPath];
      if (withCover && coverPath && !rawStream) args.push('-i', coverPath);
      // 不用 -vn：它会连封面视频流一起丢弃；-map 0:a 已保证只输出音轨（durl MP4 的视频流同样被排除）
      if (fmt === 'mp3') args.push('-c:a', 'libmp3lame', '-q:a', '2');
      else args.push('-c:a', 'copy');
      args.push('-map', '0:a');
      if (withCover && coverPath && !rawStream)
        args.push('-map', '1:v', '-c:v', 'copy', '-disposition:v:0', 'attached_pic');
      if (rawStream) { args.push('-f'); args.push(ext); }   // 裸流：显式容器，保证是原始格式
      else args.push.apply(args, metaArgs);
      if (container) args.push('-f', container);            // 杜比：mp4 容器（covr 封面 + 标签）
      if (ext === 'm4a') args.push('-movflags', '+faststart');
      if (fmt === 'mp3') args.push('-id3v2_version', '3');
      args.push(out);
      return args;
    };
    let muxed = false;
    try {
      await runFFmpeg(mkArgs(finalPath, true), taskId);
      muxed = true;
    } catch (e) {
      if (e && e.canceled) throw e;
      if (coverPath) {
        dbg('mux with cover failed (' + ((e && e.message) || e) + '), retry without cover');
        try { await runFFmpeg(mkArgs(finalPath, false), taskId); muxed = true; }
        catch (e2) { if (e2 && e2.canceled) throw e2; throw new Error('封装失败：' + ((e2 && e2.message) || e2)); }
      } else throw e;
    }
    if (!muxed || !fs.existsSync(finalPath)) throw new Error('封装失败：未生成输出文件');
    // 裸流：把标题/UP主/专辑/封面写进前置 ID3v2（音频码流原样不动，扩展名仍是 .eac3）
    if (rawStream && embedCover !== false) {
      try {
        const coverBytes = (coverPath && fs.existsSync(coverPath)) ? fs.readFileSync(coverPath) : null;
        writeId3ToRaw(finalPath, { title: metaTitle, artist: req.owner, album: req.title, cover: coverBytes });
      } catch (e) {
        dbg('id3 write failed: ' + ((e && e.message) || e));
      }
    }

    const size = fs.statSync(finalPath).size;
    dbg('download done file=' + finalPath + ' size=' + size + ' ext=' + ext);
    send({ phase: 'done', text: '完成', file: finalPath, size });
    return { ok: true, file: finalPath, name: path.basename(finalPath), size,
             duration: req.duration || d.timelength || 0, ext };
  } catch (err) {
    const canceled = !!(err && err.canceled) || t.canceled;
    dbg('download fail task=' + taskId + ' canceled=' + canceled + ' err=' + ((err && err.message) || err));
    send({ phase: canceled ? 'canceled' : 'error', text: canceled ? '已取消' : ((err && err.message) || String(err)) });
    return { ok: false, canceled, error: (err && err.message) || String(err) };
  } finally {
    try { if (segPath && fs.existsSync(segPath)) fs.unlinkSync(segPath); } catch (e) { /* ignore */ }
    try { if (coverPath && fs.existsSync(coverPath)) fs.unlinkSync(coverPath); } catch (e) { /* ignore */ }
  }
});

// 选择保存目录
ipcMain.handle('bili:pickdir', async (event, cur) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const opts = {
    title: '选择 B 站音频保存目录',
    defaultPath: (cur && typeof cur === 'string') ? cur : app.getPath('music'),
    properties: ['openDirectory', 'createDirectory'],
  };
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return (res.canceled || !res.filePaths || !res.filePaths.length) ? null : res.filePaths[0];
});

// 资源管理器定位已下载文件
ipcMain.handle('bili:reveal', async (event, p) => {
  if (typeof p === 'string' && fs.existsSync(p)) shell.showItemInFolder(p);
  return true;
});

// 登录 Cookie（SESSDATA，可选；写入 userData 持久化）
ipcMain.handle('bili:setcookie', async (event, c) => {
  userCookie = typeof c === 'string' ? c.trim() : '';
  try { fs.writeFileSync(cookieFile(), userCookie); } catch (e) { /* ignore */ }
  return { saved: true, has: !!userCookie };
});
ipcMain.handle('bili:getcookie', async () => userCookie);

/* ================= B 站扫码登录（效仿 bilidown：生成二维码 → 轮询 → 解析跨域回调 Cookie） ================= */
// 隐私承诺：登录信息仅写入本机 userData/bili-cookie.txt，只随请求发送到 *.bilibili.com 官方接口
// （view / playurl / nav / passport 登录接口），绝不发往任何第三方服务器，也没有任何遥测上报。

// ===== 登录回调 Cookie 提取（三层兜底，兼容 B 站各登录流程变体） =====
// ① 回调 URL 查询参数（bilidown 方式，经典 crossDomain 流程）
// ② 跟随回调页面收集每一跳的 Set-Cookie 响应头（新 h5 流程可能把 Cookie 放在响应头里）
// ③ 白名单找不到时退化为「任意 key=value」（与 bilidown 一致，仅排除已知非 Cookie 参数）
const LOGIN_COOKIE_NAMES = new Set(['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']);
const LOGIN_NON_COOKIE = new Set(['gourl', 'navhide', 'callback', 'qrcode_key', 'refresh_token',
  'timestamp', 'code', 'message', 'ttl', 'Expires', 'expires']);

// 访问登录回调 URL，收集每一跳响应里的 Set-Cookie（浏览器等价行为；访问失败不阻断）。
// 返回 { jar: ['name=value', …], finalUrl }——重定向终点 URL 的查询参数也一并交回上层解析。
function collectSetCookies(urlStr, maxRedirects = 8) {
  return new Promise(resolve => {
    const jar = [];
    const follow = (u, depth) => {
      let parsed;
      try { parsed = new URL(u); } catch (e) { return resolve({ jar, finalUrl: '' }); }
      const mod = parsed.protocol === 'http:' ? http : https;
      const req = mod.request(parsed, {
        method: 'GET',
        headers: { 'User-Agent': UA, Referer: BILI_REFERER, Accept: '*/*' },
        timeout: API_TIMEOUT,
      }, res => {
        const sc = res.headers['set-cookie'];
        if (Array.isArray(sc)) for (const c of sc) { const p = String(c).split(';')[0]; if (p && p.indexOf('=') > 0) jar.push(p); }
        else if (typeof sc === 'string' && sc) { const p = sc.split(';')[0]; if (p && p.indexOf('=') > 0) jar.push(p); }
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth > 0) {
          res.resume();
          follow(new URL(res.headers.location, parsed).toString(), depth - 1);
          return;
        }
        res.resume();
        resolve({ jar, finalUrl: parsed.toString() });
      });
      req.on('error', () => resolve({ jar, finalUrl: '' }));
      req.on('timeout', () => { try { req.destroy(); } catch (e) { /* ignore */ } resolve({ jar, finalUrl: '' }); });
      req.end();
    };
    follow(urlStr, maxRedirects);
  });
}

// 从登录成功回调中提取 Cookie 串；拿不到任何 Cookie 时返回 null
async function extractLoginCookies(urlStr) {
  try {
    const found = new Map();
    // ① 查询参数（值已百分号编码，解码后存入）
    const q = String(urlStr || '').indexOf('?');
    if (q >= 0) {
      for (const kv of urlStr.slice(q + 1).split('&')) {
        const eq = kv.indexOf('=');
        if (eq <= 0) continue;
        const name = kv.slice(0, eq);
        if (!/^[A-Za-z0-9_]+$/.test(name)) continue;
        let value = kv.slice(eq + 1);
        try { value = decodeURIComponent(value); } catch (e) { /* 保持原样 */ }
        if (!value) continue;
        found.set(name, value);
      }
    }
    // ② Set-Cookie 响应头（覆盖同名查询参数，与浏览器一致）
    const visited = await collectSetCookies(urlStr);
    for (const c of visited.jar) {
      const eq = c.indexOf('=');
      if (eq <= 0) continue;
      const name = c.slice(0, eq).trim();
      if (!/^[A-Za-z0-9_]+$/.test(name)) continue;
      const value = c.slice(eq + 1).trim();
      if (!value) continue;
      found.set(name, value);
    }
    // ③ 重定向终点 URL 的查询参数（可能由中间跳转携带）
    if (visited.finalUrl) {
      const fq = visited.finalUrl.indexOf('?');
      if (fq >= 0) {
        for (const kv of visited.finalUrl.slice(fq + 1).split('&')) {
          const eq = kv.indexOf('=');
          if (eq <= 0) continue;
          const name = kv.slice(0, eq);
          if (!/^[A-Za-z0-9_]+$/.test(name) || found.has(name)) continue;
          let value = kv.slice(eq + 1);
          try { value = decodeURIComponent(value); } catch (e) { /* 保持原样 */ }
          if (value) found.set(name, value);
        }
      }
    }
    // 组装：白名单优先；白名单全缺时取其余参数（排除已知非 Cookie 项）
    let parts = [];
    for (const n of LOGIN_COOKIE_NAMES) if (found.has(n)) parts.push(n + '=' + found.get(n));
    if (!parts.length) {
      for (const [n, v] of found) {
        if (!LOGIN_NON_COOKIE.has(n)) parts.push(n + '=' + v);
      }
    }
    return parts.length ? parts.join('; ') : null;
  } catch (e) { return null; }
}

// 脱敏诊断：回调 URL 只留 域名/路径/参数名，敏感值只记长度（写入本机 av-debug.log）
function maskUrl(u) {
  try {
    const p = new URL(String(u));
    const params = [...p.searchParams.entries()].map(([k, v]) => {
      const sensitive = LOGIN_COOKIE_NAMES.has(k);
      return k + '=' + (sensitive ? '***len' + String(v).length : (String(v).length > 6 ? String(v).slice(0, 6) + '…' : v));
    });
    return p.origin + p.pathname + (params.length ? '?' + params.join('&') : '');
  } catch (e) { return String(u).slice(0, 200); }
}
function cookieNames(c) {
  try { return String(c).split(';').map(s => s.split('=')[0].trim()).filter(Boolean).join(','); } catch (e) { return '?'; }
}

// 当前登录用户信息（含会员状态）；仅请求 B 站官方 nav 接口
async function fetchUserInfo() {
  try {
    const headers = cookieHeader() ? { Cookie: cookieHeader() } : {};
    const d = await biliJSON('https://api.bilibili.com/x/web-interface/nav', headers);
    const vip = d.vipStatus === 1;
    return {
      isLogin: !!d.isLogin, uname: d.uname || '',
      face: (d.face || '').replace(/^\/\//, 'https://'),
      vip, vipLabel: (d.vipLabel && d.vipLabel.text) || (vip ? '大会员' : ''),
      level: (d.level_info && d.level_info.current_level) || 0,
    };
  } catch (e) {
    return { isLogin: false, uname: '', face: '', vip: false, vipLabel: '', level: 0 };
  }
}

// 生成登录二维码（只返回官方登录 URL 与 qrcode_key，二维码图片由渲染进程本地生成）
ipcMain.handle('bili:login-gen', async (event) => {
  try {
    const d = await biliJSON('https://passport.bilibili.com/x/passport-login/web/qrcode/generate');
    return { url: (d && d.url) || '', key: (d && d.qrcode_key) || '' };
  } catch (err) {
    return { error: (err && err.message) || String(err) };
  }
});

// 轮询扫码状态：86101 未扫码 / 86090 已扫码待确认 / 86038 失效 / 0 成功（回调 URL 带 Cookie）
ipcMain.handle('bili:login-poll', async (event, key) => {
  try {
    if (!key) throw new Error('缺少 qrcode_key');
    const d = await biliJSON('https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(key));
    const code = d && d.code, message = (d && d.message) || '';
    if (code === 0 && (d.url || d.refresh_token)) {
      const cookies = await extractLoginCookies(d.url || '');
      if (!cookies) {
        dbg('login fail: no cookies. url=' + maskUrl(d.url || '') + ' refresh=' + (d.refresh_token ? 'yes' : 'no') +
            ' raw=' + JSON.stringify({
              code: d.code, message: d.message, timestamp: d.timestamp,
              urlLen: (d.url || '').length, refreshLen: (d.refresh_token || '').length,
            }));
        throw new Error('登录回调里没有 Cookie 数据（已重试解析；若仍失败请查看 userData/av-debug.log 的诊断信息）');
      }
      userCookie = cookies;
      try { fs.writeFileSync(cookieFile(), userCookie); } catch (e) { /* ignore */ }
      dbg('login ok cookies=' + cookieNames(userCookie));
      const user = await fetchUserInfo();
      return { status: 'success', user, cookies: userCookie };
    }
    if (code === 86101) return { status: 'waiting', message };
    if (code === 86090) return { status: 'scanned', message };
    if (code === 86038) return { status: 'expired', message };
    return { status: 'error', message: message || ('未知状态 code=' + code) };
  } catch (err) {
    return { error: (err && err.message) || String(err) };
  }
});

// 查询当前登录状态（无 Cookie 时 nav 返回 -101，按未登录处理）
ipcMain.handle('bili:user', async (event) => fetchUserInfo());

// 退出登录：仅清除本机保存的 Cookie（内存 + userData 文件），不涉及其他任何数据
ipcMain.handle('bili:logout', async (event) => {
  userCookie = '';
  try { fs.unlinkSync(cookieFile()); } catch (e) { /* 无文件 */ }
  dbg('logout done');
  return { ok: true };
});

// 退出时清理残留的分片 / 封面临时文件
app.on('will-quit', () => {
  try { fs.rmSync(path.join(app.getPath('temp'), 'hibiki-player-bili'), { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
});

// 供离线自测 / 诊断使用（main.js 不使用导出）
module.exports = { _internals: { biliGet, downloadToFile, runFFmpeg, safeName, uniqueOut, cookieHeader, ffmpegPath, extractLoginCookies, collectSetCookies, maskUrl, fetchUserInfo, pickStream: STREAM.pickStream } };
