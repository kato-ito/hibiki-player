// 用用户真实 userData 复现：启动恢复歌单 → 追加导入导出的 eac3 → 查看时长显示 → 播放
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const UD = process.argv[2];                       // 复制的用户数据目录
const EAC3 = process.argv[3];
app.setPath('userData', UD);
require('./fs-ipc');
require('./dolby-ipc');

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: 1120, height: 900, show: false,
      webPreferences: {
        contextIsolation: true, nodeIntegration: false, spellcheck: false,
        preload: path.join(__dirname, 'preload.js'),
      },
    });
    await win.loadFile('index.html');
    const js = code => win.webContents.executeJavaScript(code);

    await new Promise(r => setTimeout(r, 4000));
    console.log('=== 启动后状态 ===');
    console.log('状态栏:', await js('statusEl.textContent'));
    console.log('当前歌单行:', JSON.stringify(await js('[...document.querySelectorAll("#playlist li:not(.pl-hint)")].map(li => li.querySelector(".pl-name").textContent + " | " + li.querySelector(".pl-dur").textContent)')));
    console.log('dolbyMode:', await js('dolbyOutMode'));

    console.log('=== 追加导入导出的 eac3 ===');
    await js(`(async () => {
      const data = await window.desktopFiles.read(${JSON.stringify(EAC3)});
      const f = new File([data], ${JSON.stringify(path.basename(EAC3))});
      setPlaylist([f], 0, true);
    })()`);
    await new Promise(r => setTimeout(r, 5000));
    console.log('导入后歌单行:', JSON.stringify(await js('[...document.querySelectorAll("#playlist li:not(.pl-hint)")].map(li => li.querySelector(".pl-name").textContent + " | " + li.querySelector(".pl-dur").textContent)')));
    console.log('导入后状态栏:', await js('statusEl.textContent'));

    console.log('=== 双击播放 eac3 ===');
    await js('playIndex(plTracks.length - 1)');
    let t0 = Date.now(), status = '';
    while (Date.now() - t0 < 120000) {
      await new Promise(r => setTimeout(r, 500));
      status = await js('statusEl.textContent');
      if (/正在播放|解码失败|无法播放/.test(status)) break;
    }
    await new Promise(r => setTimeout(r, 3000));
    console.log('播放状态栏:', status);
    console.log('plTracks[last].dur =', JSON.stringify(await js('plTracks[plTracks.length-1].dur')));
    console.log('mediaElem.duration =', JSON.stringify(await js('mediaElem ? mediaElem.duration : null')));
    console.log('歌单最后一行:', JSON.stringify(await js('[...document.querySelectorAll("#playlist li:not(.pl-hint)")].pop().querySelector(".pl-dur").textContent')));
    app.exit(0);
  } catch (e) { console.error(e); app.exit(1); }
});
