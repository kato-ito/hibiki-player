// 截图：播放界面（有歌词 / 无歌词两种布局）
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
require('./fs-ipc');

const b = s => Buffer.from(s, 'latin1');
const be32 = v => { const x = Buffer.alloc(4); x.writeUInt32BE(v >>> 0, 0); return x; };
const le32 = v => { const x = Buffer.alloc(4); x.writeUInt32LE(v >>> 0, 0); return x; };
function makePng() {
  const w = 256, h = 256;
  const crcT = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc32 = buf => { let c = 0xFFFFFFFF; for (const byte of buf) c = crcT[(c ^ byte) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type, 'latin1'), data]); return Buffer.concat([be32(data.length), body, be32(crc32(body))]); };
  // 渐变色像素（蓝 → 粉，比随机噪点更像封面）
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
function makeWav(sec) {
  const sr = 44100, n = sr * sec;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
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
  // Windows 上窗口首次合成前 capturePage() 可能返回空图：重试直到拿到非空 PNG
  for (let i = 0; i < 10; i++) {
    const img = await win.webContents.capturePage();
    const png = img.toPNG();
    if (png.length > 0) { fs.writeFileSync(path.join(__dirname, name), png); console.log('saved', name, png.length, 'bytes'); return; }
    await new Promise(r => setTimeout(r, 400));
  }
  console.log('FAILED to capture', name);
}

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-snap-'));
  fs.writeFileSync(path.join(dir, '晴天.mp3'), makeMp3());
  fs.writeFileSync(path.join(dir, '晴天.lrc'), LRC, 'utf8');
  fs.writeFileSync(path.join(dir, '无词曲.wav'), makeWav(60));

  const win = new BrowserWindow({ width: 1280, height: 860, show: true,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js') } });
  win.webContents.on('console-message', (e, level, msg) => { if (msg.includes('STATE')) console.log('[renderer]', msg); });
  const js = code => win.webContents.executeJavaScript(code).catch(e => console.log('js err:', e.message));
  await win.loadFile('index.html');
  await js(`localStorage.clear(); setUIMode('classic')`);
  await new Promise(r => setTimeout(r, 600));

  // 有歌词：左侧封面+控制，右侧歌词
  await js(`setUIMode('player')`);
  await js(`(async () => {
    const data = await window.desktopFiles.read(${JSON.stringify(path.join(dir, '晴天.mp3'))});
    ingestLRC([new File([await window.desktopFiles.read(${JSON.stringify(path.join(dir, '晴天.lrc'))})], '晴天.lrc')]);
    plTracks = [{ file: new File([data], '晴天.mp3'), name: '晴天.mp3', dur: null, path: '', dolby: false,
                  lrcFile: lrcLib.get('晴天').file, lrcPath: '', lrcText: null, meta: null }];
    plIndex = 0;
    document.getElementById('playlistPanel').hidden = true;
    playIndex(0);
    await new Promise(r => setTimeout(r, 2500));
  })()`);
  await js(`console.log('STATE8 ' + JSON.stringify({
    mode: document.body.classList.contains('player-mode') ? 'player' : 'classic',
    pvHidden: document.getElementById('playerView').hidden,
    title: document.getElementById('pvTitle').textContent,
    lrcN: document.querySelectorAll('#pvLyrics .pv-line').length,
  }))`);
  await shot(win, 'snap8-player-lyrics.png');

  // 无歌词：左侧居中
  await js(`(async () => {
    const data = await window.desktopFiles.read(${JSON.stringify(path.join(dir, '无词曲.wav'))});
    plTracks = [{ file: new File([data], '无词曲.wav'), name: '无词曲.wav', dur: null, path: '', dolby: false,
                  lrcFile: null, lrcPath: '', lrcText: null, meta: null }];
    plIndex = 0;
    playIndex(0);
    await new Promise(r => setTimeout(r, 1500));
  })()`);
  await shot(win, 'snap9-player-nolrc.png');

  // 杜比独立面板
  await js(`document.getElementById('dolbyBtn').click(); stop();`);
  await new Promise(r => setTimeout(r, 300));
  await shot(win, 'snap10-dolby-panel.png');

  app.exit(0);
}).catch(e => { console.error(e); app.exit(1); });
