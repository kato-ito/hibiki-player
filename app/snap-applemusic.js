// 截图 + 回归验证：v1.9.0 网易云结构 + Apple Music 风格播放界面
//（底部播放条 / 设置菜单浮层 / 队列抽屉），以及「播放界面 → 经典界面」切换后
// 整段声谱图 / 声场轨迹是否仍正常解析（问题 3 的回归检查）。
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
require('./fs-ipc');

const b = s => Buffer.from(s, 'latin1');
const be32 = v => { const x = Buffer.alloc(4); x.writeUInt32BE(v >>> 0, 0); return x; };
function makePng() {
  const w = 256, h = 256;
  const crcT = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc32 = buf => { let c = 0xFFFFFFFF; for (const byte of buf) c = crcT[(c ^ byte) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type, 'latin1'), data]); return Buffer.concat([be32(data.length), body, be32(crc32(body))]); };
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (1 + w * 3) + 1 + x * 3;
    raw[o] = 40 + x * 180 / w; raw[o + 1] = 60 + y * 60 / h; raw[o + 2] = 180 - x * 60 / w;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', Buffer.concat([be32(w), be32(h), Buffer.from([8, 2, 0, 0, 0])])),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const PNG = makePng();

function makeMp3() {
  const frame = (id, payload) => Buffer.concat([b(id), be32(payload.length), Buffer.alloc(2), payload]);
  const text = s => Buffer.concat([Buffer.from([3]), Buffer.from(s, 'utf8')]);
  const apic = Buffer.concat([Buffer.from([0]), b('image/png\0'), Buffer.from([3]), Buffer.from([0]), PNG]);
  const frames = Buffer.concat([
    frame('TIT2', text('晴天')),
    frame('TPE1', text('周杰伦')),
    frame('TALB', text('叶惠美')),
    frame('APIC', apic),
  ]);
  const syncsafe = v => Buffer.from([(v >> 21) & 127, (v >> 14) & 127, (v >> 7) & 127, v & 127]);
  return Buffer.concat([b('ID3'), Buffer.from([3, 0, 0]), syncsafe(frames.length), frames, Buffer.alloc(64)]);
}
// 60 秒立体声正弦（左右不同频率 → 声像轨迹有内容），16-bit PCM
function makeWav(sec) {
  const sr = 44100, n = sr * sec;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const l = Math.sin(2 * Math.PI * 440 * i / sr) * 6000;
    const r = Math.sin(2 * Math.PI * 880 * i / sr) * 6000;
    buf.writeInt16LE(l | 0, 44 + i * 4);
    buf.writeInt16LE(r | 0, 44 + i * 4 + 2);
  }
  return buf;
}
const LRC_LINES = ['故事的小黄花', '从出生那年就飘着', '童年的荡秋千', '随记忆一直晃到现在',
  'Re So So Si Do Si La', 'So La Si Si Si Si La Si La So', '吹着前奏望着天空', '我想起花瓣试着掉落',
  '为你翘课的那一天', '花落的那一天', '教室的那一间', '我怎么看不见', '消失的下雨天', '我好想再淋一遍',
  '没想到失去的勇气我还留着', '好想再问一遍', '你会等待还是离开', '刮风这天我试过握着你手',
  '但偏偏雨渐渐大到我看你不见', '还要多久我才能在你身边', '等到放晴的那天也许我会比较好一点',
  '从前从前有个人爱你很久', '但偏偏风渐渐把距离吹得好远'];
const LRC = Array.from({ length: 24 }, (_, i) =>
  `[00:${String(i * 7 + 2).padStart(2, '0')}.50]${LRC_LINES[i] || '……'}`).join('\n') + '\n';

async function shot(win, name) {
  for (let i = 0; i < 10; i++) {
    win.show(); win.focus(); win.moveTop();   // Windows：被遮挡/未合成时 capturePage 会返回空图
    const img = await win.webContents.capturePage();
    const png = img.toPNG();
    if (png.length > 0) { fs.writeFileSync(path.join(__dirname, name), png); console.log('saved', name, png.length, 'bytes'); return true; }
    await new Promise(r => setTimeout(r, 400));
  }
  console.log('FAILED to capture', name);
  return false;
}

// 渲染进程里统计画布“亮像素”（>0 证明整段声谱/声场画出了内容，而非空白/占位文字）
// 外层再包一对括号：插进对象字面量后是 ((id)=>{...})('sonogram') 的 IIFE 形式，否则语法错误
const CANVAS_LIT = `((id) => {
  const cv = document.getElementById(id);
  if (!cv.width || !cv.height) return { w: 0, h: 0, lit: 0 };
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let lit = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] + d[i+1] + d[i+2] > 90) lit++;
  return { w: cv.width, h: cv.height, lit };
})`;

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-ncm-'));
  fs.writeFileSync(path.join(dir, '晴天.mp3'), makeMp3());
  fs.writeFileSync(path.join(dir, '晴天.lrc'), LRC, 'utf8');
  fs.writeFileSync(path.join(dir, '无词曲.wav'), makeWav(60));

  const win = new BrowserWindow({ width: 1280, height: 860, show: true,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js') } });
  win.webContents.on('console-message', (e, level, msg) => { if (msg.includes('STATE')) console.log('[renderer]', msg); });
  const js = code => win.webContents.executeJavaScript(code).catch(e => console.log('js err:', e.message));
  await win.loadFile('index.html');
  await js(`localStorage.clear(); setUIMode('classic')`);
  await new Promise(r => setTimeout(r, 500));

  let failures = 0;
  const expect = (cond, label) => {
    console.log((cond ? '  ✓ ' : '  ✗ ') + label);
    if (!cond) failures++;
  };

  // —— 1. 经典界面播放有歌词曲目，等整段分析完成 ——
  await js(`(async () => {
    const data = await window.desktopFiles.read(${JSON.stringify(path.join(dir, '晴天.mp3'))});
    ingestLRC([new File([await window.desktopFiles.read(${JSON.stringify(path.join(dir, '晴天.lrc'))})], '晴天.lrc')]);
    plTracks = [{ file: new File([data], '晴天.mp3'), name: '晴天.mp3', dur: null, path: '', dolby: false,
                  lrcFile: lrcLib.get('晴天').file, lrcPath: '', lrcText: null, meta: null }];
    plIndex = 0;
    document.getElementById('playlistPanel').hidden = true;
    playIndex(0);
  })()`);
  await js(`(async () => {
    for (let i = 0; i < 50 && !fullSonogram; i++) await new Promise(r => setTimeout(r, 100));
    console.log('STATE-A ' + JSON.stringify({ full: !!fullSonogram, sono: ${CANVAS_LIT}('sonogram'), pan: ${CANVAS_LIT}('panField') }));
  })()`);

  // —— 2. 切到播放界面：底栏结构 + 菜单/抽屉默认收起 ——
  await js(`setUIMode('player')`);
  await new Promise(r => setTimeout(r, 600));
  const b1 = await js(`JSON.stringify({
    mode: document.body.classList.contains('player-mode') ? 'player' : 'classic',
    topTitle: document.getElementById('pvTopTitle').textContent,
    title: document.getElementById('pvTitle').textContent,
    titleInBar: !!document.getElementById('pvTitle').closest('.pv-bar'),
    playInBar: !!document.getElementById('pvPlay').closest('.pv-bar'),
    lrcN: document.querySelectorAll('#pvLyrics .pv-line').length,
    specGone: !document.getElementById('pvSpec'),
    menuClosed: !document.getElementById('pvMenu').classList.contains('open'),
    drawerClosed: !document.getElementById('pvDrawer').classList.contains('open'),
    qCount: document.getElementById('pvQueueCount').textContent,
  })`);
  const sb = JSON.parse(b1);
  console.log('STATE-B ' + b1);
  expect(sb.mode === 'player' && sb.topTitle === '晴天' && sb.title === '晴天', '播放界面 + 顶栏/底栏曲名同步');
  expect(sb.titleInBar && sb.playInBar, '曲名与播放控制都在底部播放条内');
  expect(sb.lrcN === 14, '歌词渲染 14 行');
  expect(sb.specGone, '底部频谱条已移除（只留封面/控制/歌词）');
  expect(sb.menuClosed && sb.drawerClosed, '设置菜单 / 队列抽屉默认收起');
  expect(sb.qCount === ' · 1', '队列计数正确');

  // —— 3. 打开设置菜单：工具栏按钮应收纳其中（分组标题 3 组）——
  await js(`document.getElementById('pvMenuBtn').click()`);
  await new Promise(r => setTimeout(r, 350));
  const m1 = await js(`JSON.stringify({
    open: document.getElementById('pvMenu').classList.contains('open'),
    navH: document.querySelectorAll('#pvNav .pv-nav-h').length,
    btns: document.querySelectorAll('#pvNav .toolbar button').length,
    hasLrc: !!document.getElementById('pvMenuLrc'),
    panelInPlayer: !!document.querySelector('body.player-mode #playlistPanel'),
  })`);
  const sm = JSON.parse(m1);
  console.log('STATE-MENU ' + m1);
  expect(sm.open && sm.navH === 3 && sm.btns === 7, '设置菜单打开：工具栏 7 按钮分 3 组收纳');
  expect(sm.hasLrc, '菜单含「载入歌词」入口');
  await shot(win, 'snap15-ncm-player-menu.png');
  await js(`document.getElementById('pvStage').click()`);   // 点外部关闭
  const closed = await js(`!document.getElementById('pvMenu').classList.contains('open')`);
  expect(closed, '点击菜单外部自动关闭');

  // —— 4. 打开队列抽屉：歌单面板应收纳其中 ——
  await js(`document.getElementById('pvQueueBtn').click()`);
  await new Promise(r => setTimeout(r, 350));
  const d1 = await js(`JSON.stringify({
    open: document.getElementById('pvDrawer').classList.contains('open'),
    plParent: document.getElementById('playlistPanel').parentElement.id,
    items: document.querySelectorAll('#playlist li').length,
  })`);
  const sd = JSON.parse(d1);
  console.log('STATE-DRAWER ' + d1);
  expect(sd.open && sd.plParent === 'pvQueueBody' && sd.items >= 1, '队列抽屉打开：歌单面板收纳其中');
  // 抽屉截图需等待合成完成：与 snap15 内容不同才算成功（Windows 下 capturePage 可能返回旧帧）
  const snap15bytes = fs.readFileSync(path.join(__dirname, 'snap15-ncm-player-menu.png'));
  let ok16 = false;
  for (let i = 0; i < 8 && !ok16; i++) {
    win.show(); win.focus(); win.moveTop();
    await new Promise(r => setTimeout(r, 450));
    const png = (await win.webContents.capturePage()).toPNG();
    if (png.length && !png.equals(snap15bytes)) {
      fs.writeFileSync(path.join(__dirname, 'snap16-ncm-queue-drawer.png'), png);
      console.log('saved snap16-ncm-queue-drawer.png', png.length, 'bytes');
      ok16 = true;
    }
  }
  expect(ok16, '抽屉截图已更新（非旧帧）');
  await js(`document.getElementById('pvDrawerClose').click()`);

  // —— 5. 无歌词曲目（封面居中） ——
  await js(`(async () => {
    const data = await window.desktopFiles.read(${JSON.stringify(path.join(dir, '无词曲.wav'))});
    plTracks = [{ file: new File([data], '无词曲.wav'), name: '无词曲.wav', dur: null, path: '', dolby: false,
                  lrcFile: null, lrcPath: '', lrcText: null, meta: null }];
    plIndex = 0;
    playIndex(0);
    for (let i = 0; i < 50 && !fullSonogram; i++) await new Promise(r => setTimeout(r, 100));
  })()`);
  await new Promise(r => setTimeout(r, 400));
  await shot(win, 'snap17-ncm-player-nolrc.png');

  // —— 6. 核心回归：播放界面 → 经典界面，整段声谱/声场应立即恢复且有内容 ——
  await js(`setUIMode('classic')`);
  await new Promise(r => setTimeout(r, 250));
  const r1 = await js(`JSON.stringify({ full: !!fullSonogram, sono: ${CANVAS_LIT}('sonogram'), pan: ${CANVAS_LIT}('panField') })`);
  console.log('STATE-C(切回经典) ' + r1);
  const c1 = JSON.parse(r1);
  expect(c1.full === true, '切回经典后 fullSonogram 仍在');
  expect(c1.sono.w > 100 && c1.sono.lit > 500, '整段声谱图画布有内容 (lit=' + c1.sono.lit + ')');
  expect(c1.pan.w > 100 && c1.pan.lit > 50, '整段声场轨迹有内容 (lit=' + c1.pan.lit + ')');
  await shot(win, 'snap18-classic-after-switch.png');

  // —— 7. 分析丢失时的自动补跑：清掉 fullSonogram 再切回播放→经典，应自动重跑分析 ——
  await js(`setUIMode('player')`);
  await new Promise(r => setTimeout(r, 300));
  await js(`fullSonogram = null; analysis = null; analysisFailed = false;`);
  await js(`setUIMode('classic')`);
  await js(`(async () => {
    for (let i = 0; i < 60 && !fullSonogram; i++) await new Promise(r => setTimeout(r, 100));
    console.log('STATE-D(补跑) ' + JSON.stringify({ full: !!fullSonogram, sono: ${CANVAS_LIT}('sonogram') }));
  })()`);
  const r2 = await js(`JSON.stringify({ full: !!fullSonogram })`);
  expect(JSON.parse(r2).full === true, '整段分析丢失后切回经典会自动补跑');

  console.log(failures ? `\n${failures} 项检查未通过` : '\n全部检查通过 ✓');
  app.exit(failures ? 1 : 0);
}).catch(e => { console.error(e); app.exit(1); });
