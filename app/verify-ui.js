// UI 修复验证：1) 双击歌单行（缓存命中瞬间启动）不应被第二下暂停；
// 2) 点击迷你条音量滑杆不应触发进入播放界面
const { app, BrowserWindow } = require('electron');
const path = require('path');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require('./fs-ipc');
require('./dolby-ipc');
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ width: 1120, height: 900, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') } });
    await win.loadFile('index.html');
    const js = code => win.webContents.executeJavaScript(code);
    const EAC3 = process.argv[2], MP4 = process.argv[3];

    await js(`(async () => {
      const d1 = await window.desktopFiles.read(${JSON.stringify(EAC3)});
      const d2 = await window.desktopFiles.read(${JSON.stringify(MP4)});
      setPlaylist([new File([d1], ${JSON.stringify(path.basename(EAC3))}), new File([d2], ${JSON.stringify(path.basename(MP4))})]);
    })()`);
    // 等第一首（eac3）播放起来（首次转码较慢）
    let t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      await new Promise(r => setTimeout(r, 500));
      const s = await js('statusEl.textContent');
      if (/正在播放/.test(s)) break;
    }
    // 播第二首（mp4）让两首都有缓存
    await js('playIndex(1)');
    t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      await new Promise(r => setTimeout(r, 500));
      const s = await js('statusEl.textContent');
      if (/正在播放/.test(s) && /MP4|mp4/.test(s)) break;
    }
    await new Promise(r => setTimeout(r, 1500));

    // —— 测试 1：双击第 0 行（eac3，缓存命中 → 瞬间启动 → 第二下不得暂停）——
    await js(`(async () => {
      const li = [...document.querySelectorAll('#playlist li:not(.pl-hint)')][0];
      li.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(r => setTimeout(r, 120));
      li.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    })()`);
    await new Promise(r => setTimeout(r, 3000));
    console.log('=== 双击测试 ===');
    console.log('状态栏:', await js('statusEl.textContent'));
    console.log('plIndex:', await js('plIndex'));
    console.log('paused:', await js('mediaElem ? mediaElem.paused : "no-media"'));
    console.log('playing(eac3):', await js('plTracks[plIndex].name'));

    // —— 测试 2：点击音量滑杆不应切换界面 ——
    await js(`(async () => {
      const vol = document.getElementById('miniVol');
      vol.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    })()`);
    await new Promise(r => setTimeout(r, 500));
    console.log('=== 音量点击测试 ===');
    console.log('uiMode 仍为:', await js('uiMode'), '（应为 list，未被切到 player）');
    app.exit(0);
  } catch (e) { console.error(e); app.exit(1); }
});
