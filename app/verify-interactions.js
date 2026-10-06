// 交互功能端到端验证：播放/暂停/继续 · 长按拖动排序 · 空歌单保存说明
// 用法：npx electron verify-interactions.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('./fs-ipc');   // 注册 fs:read（懒加载播放需要）

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) failed++;
};

// 生成 5 秒 44.1 kHz 立体声静音 WAV
function makeWav(p) {
  const sr = 44100, n = sr * 5;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  fs.writeFileSync(p, buf);
}

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-ui-'));
  const paths = [1, 2, 3].map(i => path.join(dir, '曲目' + i + '.wav'));
  paths.forEach(makeWav);

  const win = new BrowserWindow({ width: 1120, height: 950, show: false,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js') } });
  const js = code => win.webContents.executeJavaScript(code);

  await win.loadFile('index.html');
  await js(`localStorage.clear()`);
  // 直接构造懒加载歌单（3 首真实文件），立即播放第 1 首
  await js(`plTracks = ${JSON.stringify(paths)}.map((p, i) => ({
              file: null, path: p, name: '曲目' + (i + 1) + '.wav', dur: null, dolby: false }));
            plIndex = 0; plGen++; curSavedName = null;
            playlistPanel.hidden = false; plRender(); playIndex(0);`);
  await new Promise(r => setTimeout(r, 1200));

  console.log('— 功能 1：播放 / 暂停 / 继续');
  ok(await js(`!!mediaElem && !mediaElem.paused && plIndex === 0`), '点击曲目后正常播放');
  await js(`playlistEl.querySelectorAll('li')[0].dispatchEvent(new MouseEvent('click', {bubbles: true}))`);
  ok(await js(`mediaElem.paused`), '点击正在播放的曲目 → 暂停');
  await js(`playlistEl.querySelectorAll('li')[0].dispatchEvent(new MouseEvent('click', {bubbles: true}))`);
  ok(await js(`!mediaElem.paused`), '再次点击 → 继续播放');
  await js(`togglePlayPause(); togglePlayPause();`);
  ok(await js(`!mediaElem.paused`), '⏸/▶ 按钮（togglePlayPause）同样可暂停后继续');

  console.log('— 功能 2：长按拖动调整播放顺序');
  const drag = await js(`(async function () {
    const lis = () => [...playlistEl.querySelectorAll('li:not(.pl-hint)')];
    const rect = el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
    const from = rect(lis()[2]);
    const r0 = lis()[0].getBoundingClientRect();
    const to = { x: r0.left + r0.width / 2, y: r0.top + 3 };   // 按住第 3 首拖到第 1 首上方（中点以左/以上 = 插到它前面）
    lis()[2].dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, cancelable: true,
      clientX: from.x, clientY: from.y, button: 0, buttons: 1, pointerId: 7, isPrimary: true}));
    await new Promise(r => setTimeout(r, 450));              // 超过长按时长 → 进入拖动
    const armed = !!(plDrag && plDrag.armed);
    lis()[2].dispatchEvent(new PointerEvent('pointermove', {bubbles: true, cancelable: true,
      clientX: to.x, clientY: to.y, buttons: 1, pointerId: 7}));
    window.dispatchEvent(new PointerEvent('pointerup', {bubbles: true, pointerId: 7}));
    await new Promise(r => setTimeout(r, 60));
    return { armed, order: plTracks.map(t => t.name), idx: plIndex,
             dragEnded: plDrag === null, idxShown: [...playlistEl.querySelectorAll('.pl-idx')].map(n => n.textContent) };
  })()`);
  ok(drag.armed, '长按 0.45 秒进入拖动状态');
  ok(JSON.stringify(drag.order) === JSON.stringify(['曲目3.wav', '曲目1.wav', '曲目2.wav']),
    '拖动后顺序变为 曲目3, 曲目1, 曲目2（原 ' + drag.order.join(',') + '）');
  ok(drag.idx === 1, '正在播放的 曲目1 下标自动跟随为 1');
  ok(JSON.stringify(drag.idxShown) === JSON.stringify(['1', '2', '3']), '行号重新编号 1,2,3');
  ok(await js(`!mediaElem.paused && mediaElem !== null`), '拖动排序不打断播放');
  const early = await js(`(async function () {                          // 反例：未长按就移动 → 不进入拖动
    const lis = () => [...playlistEl.querySelectorAll('li:not(.pl-hint)')];
    const r0 = lis()[2].getBoundingClientRect();
    lis()[2].dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, cancelable: true,
      clientX: r0.left + 5, clientY: r0.top + 5, button: 0, buttons: 1, pointerId: 9, isPrimary: true}));
    await new Promise(r => setTimeout(r, 80));
    window.dispatchEvent(new PointerEvent('pointermove', {bubbles: true, clientX: r0.left + 80, clientY: r0.top + 80, pointerId: 9}));
    await new Promise(r => setTimeout(r, 400));
    const armed = !!(plDrag && plDrag.armed);
    window.dispatchEvent(new PointerEvent('pointerup', {bubbles: true, pointerId: 9}));
    await new Promise(r => setTimeout(r, 30));
    return { armed, order: plTracks.map(t => t.name) };
  })()`);
  ok(!early.armed && JSON.stringify(early.order) === JSON.stringify(['曲目3.wav', '曲目1.wav', '曲目2.wav']),
    '短按即移动（未长按）不触发拖动，顺序不变');

  console.log('— 功能 3：空歌单保存说明');
  await js(`openNameInput('new'); plNameInput.value = '空测试';
            document.getElementById('plNameOk').click();`);
  ok(await js(`!!playlistEl.querySelector('.pl-hint')`), '空歌单列表内显示引导文案');
  await js(`document.getElementById('plSaveBtn').click();`);
  ok(await js(`getSavedPlaylists().length === 0`), '空歌单无法保存为新歌单（不落库）');
  ok(await js(`plNameRow.hidden`), '空歌单点 💾 不弹命名框，直接提示');
  ok(await js(`statusEl.textContent.indexOf('添加歌曲') >= 0`), '状态栏说明"需先添加歌曲"');
  await js(`curSavedName = null; document.getElementById('plSaveBtn').click();`);
  ok(await js(`plNameRow.hidden && statusEl.textContent.indexOf('添加歌曲') >= 0`),
    '未命名空歌单点 💾 同样给出说明');
  // 加歌后即可正常保存
  await js(`plTracks = ${JSON.stringify(paths)}.map((p, i) => ({
              file: null, path: p, name: '曲目' + (i + 1) + '.wav', dur: null, dolby: false }));
            plRender(); doSavePlaylist('加歌后');`);
  ok(await js(`getSavedPlaylists()[0].name === '加歌后' && getSavedPlaylists()[0].items.length === 3`),
    '添加歌曲后可正常保存为新歌单');

  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'snap6-interactions.png'), img.toPNG());
  console.log('saved snap6-interactions.png');
  console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
  app.exit(failed ? 1 : 0);
}).catch(e => { console.error(e); app.exit(1); });
