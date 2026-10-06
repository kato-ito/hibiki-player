// 端到端验证：🎼 播放界面（封面/标签/歌词/切换）· 🔊 杜比输出独立开关
// 用法：npx electron verify-player-view.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
require('./fs-ipc');   // 注册 fs:read（懒加载播放需要）

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) failed++;
};

/* ---- 测试素材 ---- */
const b = s => Buffer.from(s, 'latin1');
const be32 = v => { const x = Buffer.alloc(4); x.writeUInt32BE(v >>> 0, 0); return x; };
const le32 = v => { const x = Buffer.alloc(4); x.writeUInt32LE(v >>> 0, 0); return x; };
const fullBox = (type, payload) => Buffer.concat([be32(8 + payload.length), b(type), payload]);
// 真实 PNG（64×64 随机像素，体积 > 100 字节，能通过解析器的垃圾保护）
function makePng() {
  const w = 64, h = 64;
  const crcT = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crcT[n] = c >>> 0;
  }
  const crc32 = buf => {
    let c = 0xFFFFFFFF;
    for (const byte of buf) c = crcT[(c ^ byte) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    return Buffer.concat([be32(data.length), body, be32(crc32(body))]);
  };
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761 >>> 8) & 255;   // 伪随机（不可压缩）
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', Buffer.concat([be32(w), be32(h), Buffer.from([8, 6, 0, 0, 0])])),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const PNG = makePng();

// ID3v2.3：TIT2 / TPE1 / APIC（帧头 = ID(4) + 大小(4) + 标志(2) + 数据）
function makeMp3() {
  const frame = (id, payload) => Buffer.concat([b(id), be32(payload.length), Buffer.alloc(2), payload]);
  const text = s => Buffer.concat([Buffer.from([3]), Buffer.from(s, 'utf8')]);
  const apic = Buffer.concat([Buffer.from([0]), b('image/png\0'), Buffer.from([3]), Buffer.from([0]), PNG]);
  const frames = Buffer.concat([
    frame('TIT2', text('夜曲（测试）')),
    frame('TPE1', text('测试歌手')),
    frame('APIC', apic),
  ]);
  const syncsafe = v => Buffer.from([(v >> 21) & 127, (v >> 14) & 127, (v >> 7) & 127, v & 127]);
  return Buffer.concat([b('ID3'), Buffer.from([3, 0, 0]), syncsafe(frames.length), frames, Buffer.alloc(64)]);
}

// FLAC：VORBIS_COMMENT（TITLE/ARTIST）+ PICTURE
function makeFlac() {
  const vc = (k, v) => { const s = Buffer.from(k + '=' + v, 'utf8'); return Buffer.concat([le32(s.length), s]); };
  const vcBody = Buffer.concat([
    le32(0), le32(2), vc('TITLE', 'Flac 标题'), vc('ARTIST', 'Flac 艺人'),
  ]);
  const pic = Buffer.concat([
    be32(3), le32(9), b('image/png'), le32(0),
    Buffer.alloc(16), le32(PNG.length), PNG,
  ]);
  const blk = (t, body, last) =>
    Buffer.concat([Buffer.from([(last ? 0x80 : 0) | t]), Buffer.from([body.length >> 16 & 255, body.length >> 8 & 255, body.length & 255]), body]);
  return Buffer.concat([b('fLaC'), blk(4, vcBody, false), blk(6, pic, true)]);
}

// M4A：moov → udta → meta → ilst（©nam / ©ART / covr）
function makeM4a() {
  const data = (flag, payload) => fullBox('data', Buffer.concat([be32(flag), Buffer.alloc(4), payload]));
  const ilst = fullBox('ilst', Buffer.concat([
    fullBox('\xA9nam', data(1, Buffer.from('M4A 标题', 'utf8'))),
    fullBox('\xA9ART', data(1, Buffer.from('M4A 艺人', 'utf8'))),
    fullBox('covr',   data(14, PNG)),
  ]));
  const meta = Buffer.concat([be32(8 + 4 + ilst.length), b('meta'), Buffer.alloc(4), ilst]);
  const udta = fullBox('udta', meta);
  return fullBox('moov', udta);
}

// 可播放的 8 秒静音 WAV
function makeWav() {
  const sr = 44100, n = sr * 8;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  return buf;
}

const LRC = '[ti:测试]\n[00:01.00]第一行歌词\n[00:03.50][00:09.00]重复时间戳行\n[00:05.00]第二行歌词\n[00:99]越界行\n无时间标签行\n';

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-pv-'));
  fs.writeFileSync(path.join(dir, 'tagged.mp3'), makeMp3());
  fs.writeFileSync(path.join(dir, 'tagged.flac'), makeFlac());
  fs.writeFileSync(path.join(dir, 'tagged.m4a'), makeM4a());
  fs.writeFileSync(path.join(dir, '无名氏.wav'), makeWav());
  fs.writeFileSync(path.join(dir, '无名氏.lrc'), LRC, 'utf8');

  const win = new BrowserWindow({ width: 1120, height: 950, show: false,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js') } });
  const js = code => win.webContents.executeJavaScript(code);
  // 看门狗：任何一步卡死则退出并报错
  setTimeout(() => { console.log('✗ 看门狗超时（某一步卡住）'); app.exit(3); }, 120000).unref();
  win.webContents.on('render-process-gone', (e, det) =>
    console.log('renderer gone:', det && det.reason));

  await win.loadFile('index.html');
  await js(`localStorage.clear(); setUIMode('classic')`);   // 启动恢复可能已带入上次的播放界面模式，先归位

  /* ===== ① 解析器单元验证（parseLRC / parseID3 / parseFLAC / parseMP4） ===== */
  console.log('\n① 标签与歌词解析器');
  {
    const r = await js(`parseLRC(${JSON.stringify(LRC)})`);
    ok(r.length === 5, 'parseLRC：5 条有效行（重复时间戳展开、无标签行忽略）→ ' + r.length);
    ok(Math.abs(r[1].t - 3.5) < 1e-9 && Math.abs(r[3].t - 9) < 1e-9 &&
       r[3].text === '重复时间戳行', 'parseLRC：一行多时间戳展开为两条');
    ok(r[2].t === 5 && r[2].text === '第二行歌词', 'parseLRC：时间排序正确');
  }
  {
    const r = await js(`(async () => {
      const f = new File([Uint8Array.from(atob(${JSON.stringify(makeMp3().toString('base64'))}), c => c.charCodeAt(0))], 'tagged.mp3');
      return await parseID3(f);
    })()`);
    ok(r && r.title === '夜曲（测试）' && r.artist === '测试歌手', 'parseID3：标题/歌手（UTF-8）');
    ok(r && r.cover && r.cover.startsWith('data:image/png;base64,'), 'parseID3：APIC 封面 → dataURL');
  }
  {
    const r = await js(`(async () => {
      const f = new File([Uint8Array.from(atob(${JSON.stringify(makeFlac().toString('base64'))}), c => c.charCodeAt(0))], 'tagged.flac');
      return await parseFLAC(f);
    })()`);
    ok(r && r.title === 'Flac 标题' && r.artist === 'Flac 艺人', 'parseFLAC：VORBIS_COMMENT 标题/歌手');
    ok(r && r.cover && r.cover.startsWith('data:image/png;base64,'), 'parseFLAC：PICTURE 封面');
  }
  {
    const r = await js(`(async () => {
      const f = new File([Uint8Array.from(atob(${JSON.stringify(makeM4a().toString('base64'))}), c => c.charCodeAt(0))], 'tagged.m4a');
      return await parseMP4(f);
    })()`);
    ok(r && r.title === 'M4A 标题' && r.artist === 'M4A 艺人', 'parseMP4：ilst ©nam/©ART');
    ok(r && r.cover && r.cover.startsWith('data:image/png;base64,'), 'parseMP4：covr 封面');
  }

  /* ===== ② 新旧界面切换 + 持久化 ===== */
  console.log('\n② 🎼 界面切换');
  {
    await js(`document.getElementById('uiModeBtn').click()`);
    let st = await js(`({ player: document.body.classList.contains('player-mode'),
                          pvShown: !document.getElementById('playerView').hidden,
                          panelHidden: getComputedStyle(document.querySelector('.panel')).display === 'none',
                          barHidden: getComputedStyle(document.getElementById('playerBar')).display === 'none',
                          noteHidden: getComputedStyle(document.querySelector('.note')).display === 'none',
                          noLrc: document.getElementById('playerView').classList.contains('no-lrc') })`);
    ok(st.player && st.pvShown && st.panelHidden && st.barHidden && st.noteHidden, '切换到播放界面：经典面板/播放条/说明隐藏，播放界面显示');
    ok(st.noLrc, '初始无曲目：no-lrc 居中布局');
    const saved = await js(`localStorage.getItem('av.uimode')`);
    ok(saved === 'player', '界面模式已持久化');
    await js(`document.getElementById('uiModeBtn').click()`);
    st = await js(`({ player: document.body.classList.contains('player-mode'),
                      pvShown: !document.getElementById('playerView').hidden,
                      panelShown: getComputedStyle(document.querySelector('.panel')).display !== 'none' })`);
    ok(!st.player && !st.pvShown && st.panelShown, '切回经典界面：面板恢复、播放界面隐藏');
    await js(`document.getElementById('uiModeBtn').click()`);   // 留在播放界面继续测
  }

  /* ===== ③ 杜比输出独立开关 ===== */
  console.log('\n③ 🔊 杜比输出独立开关');
  {
    const sep = await js(`document.getElementById('skinPanel').querySelector('.dolby-opt') === null &&
                         document.getElementById('dolbyPanel').querySelector('.dolby-opt') !== null`);
    ok(sep, '杜比选项已从皮肤面板移出、位于独立面板');
    const t1 = await js(`(function(){
      document.getElementById('dolbyBtn').click();
      const shown = !document.getElementById('dolbyPanel').hidden;
      document.querySelector('.dolby-opt[data-dolby-mode="device"]').click();
      return { shown, mode: localStorage.getItem('av.dolbymode') };
    })()`);
    ok(t1.shown && t1.mode === 'device', '🔊 按钮开关面板且模式切换持久化');
    await js(`document.querySelector('.dolby-opt[data-dolby-mode="native"]').click();
              document.getElementById('dolbyBtn').click()`);   // 恢复 native 并收起
  }

  /* ===== ④ 完整播放流程：WAV + 同名 LRC ===== */
  console.log('\n④ 播放流程（懒加载歌单 · 同名 .lrc 配对）');
  {
    // 直接构造曲目（文件内容 + 歌词本机路径），播放与歌词懒加载走 desktopFiles
    await js(`(async () => {
      const data = await window.desktopFiles.read(${JSON.stringify(path.join(dir, '无名氏.wav'))});
      plTracks = [{ file: new File([data], '无名氏.wav'), name: '无名氏.wav', dur: null, path: '', dolby: false,
                    lrcFile: null, lrcPath: ${JSON.stringify(path.join(dir, '无名氏.lrc'))}, lrcText: null, meta: null }];
      plIndex = 0;
      document.getElementById('playlistPanel').hidden = false;
      plRender();
      playIndex(0);
      await new Promise(r => setTimeout(r, 2500));
    })()`);
    let st = await js(`({ title: document.getElementById('pvTitle').textContent,
                          grad: document.getElementById('pvArt').style.background,
                          imgHidden: document.getElementById('pvArtImg').hidden,
                          lrcN: document.querySelectorAll('#pvLyrics .pv-line').length,
                          noLrc: document.getElementById('playerView').classList.contains('no-lrc'),
                          paused: document.getElementById('playerView').classList.contains('paused'),
                          playing: !!mediaElem && !mediaElem.paused })`);
    console.log('   ④状态:', JSON.stringify(st));
    ok(st.playing, 'WAV 已开始播放');
    ok(st.title === '无名氏' && st.imgHidden && /linear-gradient/.test(st.grad), '无标签：文件名标题 + 渐变占位封面');
    ok(!st.noLrc && st.lrcN === 5, '同名 .lrc 已配对并渲染 5 行（右侧歌词显示、左侧不居中）');
    ok(!st.paused, '播放中封面不缩小');
    // 歌词高亮 + 点击行跳转
    await js(`mediaElem.currentTime = 3.6; pvUpdateLyrics()`);
    let idx = await js(`pvLineEls.findIndex(e => e.classList.contains('cur'))`);
    ok(idx === 1, '3.6s 高亮第 2 行（[00:03.50]）→ ' + idx);
    await js(`(async () => { document.querySelectorAll('#pvLyrics .pv-line')[2].click();
              await new Promise(r => setTimeout(r, 100)); })()`);
    const t = await js(`mediaElem.currentTime`);
    ok(Math.abs(t - 5) < 0.35, '点击第 3 行跳转到 [00:05.00] → ' + t.toFixed(2) + 's');
    // 暂停 → 封面缩小、按钮变化
    await js(`togglePlayPause(); new Promise(r => setTimeout(r, 150))`);
    st = await js(`({ paused: document.getElementById('playerView').classList.contains('paused'),
                      icon: document.getElementById('pvPlay').textContent })`);
    ok(st.paused && st.icon === '▶', '暂停：封面缩小类 + 播放按钮变 ▶');
    await js(`togglePlayPause(); new Promise(r => setTimeout(r, 150))`);
    // 进度条拖动
    await js(`seekBy(1); new Promise(r => setTimeout(r, 200))`);
    st = await js(`({ cur: document.getElementById('pvCur').textContent,
                      dur: document.getElementById('pvDur').textContent,
                      fill: document.getElementById('pvSeekFill').style.width })`);
    ok(/^\d+:\d\d$/.test(st.cur) && /^-\d/.test(st.dur) && parseFloat(st.fill) > 0, `进度条联动：${st.cur} / 剩余 ${st.dur} / ${st.fill}`);
    // ⏭ 下一首边界（只有 1 首 → 循环回到自己，界面应恢复而非空白）
    await js(`document.getElementById('pvNext').click(); new Promise(r => setTimeout(r, 2000))`);
    st = await js(`({ title: document.getElementById('pvTitle').textContent, lrcN: document.querySelectorAll('#pvLyrics .pv-line').length })`);
    ok(st.title === '无名氏' && st.lrcN === 5, '⏭ 切歌后播放界面从曲目缓存恢复');
  }

  /* ===== ⑤ 带标签 MP3 播放：封面/标题/歌手上屏 ===== */
  console.log('\n⑤ 带标签曲目（MP3 ID3）');
  {
    await js(`(async () => {
      const data = await window.desktopFiles.read(${JSON.stringify(path.join(dir, 'tagged.mp3'))});
      plTracks = [{ file: new File([data], 'tagged.mp3'), name: 'tagged.mp3', dur: null, path: '', dolby: false,
                    lrcFile: null, lrcPath: '', lrcText: null, meta: null }];
      plIndex = 0;
      playIndex(0);
      await new Promise(r => setTimeout(r, 1500));
    })()`);
    const st = await js(`({ title: document.getElementById('pvTitle').textContent,
                            artist: document.getElementById('pvArtist').textContent,
                            src: document.getElementById('pvArtImg').src,
                            bg: document.getElementById('pvBg').style.backgroundImage })`);
    ok(st.title === '夜曲（测试）' && st.artist === '测试歌手', 'ID3 标题/歌手上屏');
    ok(st.src.startsWith('data:image/png;base64,') && st.bg.includes('url("data:image/png'), '封面与大图模糊背景上屏');
    // 移除歌词曲目 → no-lrc 居中
    await js(`(async () => {
      const data = await window.desktopFiles.read(${JSON.stringify(path.join(dir, 'tagged.flac'))});
      plTracks = [{ file: new File([data], 'tagged.flac'), name: 'tagged.flac', dur: null, path: '', dolby: false,
                    lrcFile: null, lrcPath: '', lrcText: null, meta: null }];
      plIndex = 0;
      playIndex(0);
      await new Promise(r => setTimeout(r, 1200));
    })()`);
    const st2 = await js(`({ title: document.getElementById('pvTitle').textContent,
                             artist: document.getElementById('pvArtist').textContent,
                             noLrc: document.getElementById('playerView').classList.contains('no-lrc'),
                             lrcShown: getComputedStyle(document.getElementById('pvLyrics')).display !== 'none' })`);
    ok(st2.title === 'Flac 标题' && st2.artist === 'Flac 艺人', 'FLAC 标签上屏');
    ok(st2.noLrc && !st2.lrcShown, '无歌词：右侧歌词隐藏、左侧整体居中');
  }

  /* ===== ⑥ 停止 → 占位状态；界面模式重开恢复 ===== */
  console.log('\n⑥ 停止与持久化');
  {
    await js(`stop()`);
    const st = await js(`({ title: document.getElementById('pvTitle').textContent,
                            noLrc: document.getElementById('playerView').classList.contains('no-lrc') })`);
    ok(st.title === '未在播放' && st.noLrc, '停止后回到占位状态');
    const mode = await js(`localStorage.getItem('av.uimode')`);
    ok(mode === 'player', '界面模式保持在播放界面');
  }

  console.log('\n' + (failed ? `✗ ${failed} 项失败` : '✓ 全部通过'));
  app.exit(failed ? 1 : 0);
}).catch(e => { console.error('验证脚本异常：', e); app.exit(1); });
