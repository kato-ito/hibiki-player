// 复现用户最新会话：用当前 userData 副本 → 追加导入 mp4 → 查看行时长 → 播放 eac3
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const UD = process.argv[2];
const MP4 = process.argv[3];
const EAC3 = process.argv[4];
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
    console.log('启动状态栏:', await js('statusEl.textContent'));
    console.log('当前歌单:', JSON.stringify(await js('plTracks.map(t => t.name + "|dur=" + t.dur)')));
    console.log('dolbyMode:', await js('dolbyOutMode'));

    console.log('=== 追加导入 mp4（模拟右键→导入） ===');
    await js(`(async () => {
      const data = await window.desktopFiles.read(${JSON.stringify(MP4)});
      const f = new File([data], ${JSON.stringify(path.basename(MP4))});
      setPlaylist([f], 0, true);
    })()`);
    await new Promise(r => setTimeout(r, 8000));
    console.log('导入后各行:', JSON.stringify(await js('plTracks.map(t => t.name + "|dur=" + t.dur)')));
    console.log('导入后单元格:', JSON.stringify(await js('[...document.querySelectorAll("#playlist li:not(.pl-hint)")].map(li => li.querySelector(".pl-name").textContent.slice(0,14) + " => " + li.querySelector(".pl-dur").textContent)')));
    console.log('状态栏:', await js('statusEl.textContent'));

    console.log('=== 播放导出的 eac3 ===');
    await js(`(async () => {
      const data = await window.desktopFiles.read(${JSON.stringify(EAC3)});
      const f = new File([data], ${JSON.stringify(path.basename(EAC3))});
      setPlaylist([f], 0, true);
    })()`);
    await js('playIndex(plTracks.length - 1)');
    let t0 = Date.now(), status = '';
    while (Date.now() - t0 < 120000) {
      await new Promise(r => setTimeout(r, 500));
      status = await js('statusEl.textContent');
      if (/正在播放|解码失败|无法播放/.test(status)) break;
    }
    await new Promise(r => setTimeout(r, 4000));
    console.log('播放状态:', status);
    console.log('eac3 track.dur =', JSON.stringify(await js('plTracks[plTracks.length-1].dur')));
    console.log('mediaElem.duration =', JSON.stringify(await js('mediaElem ? mediaElem.duration : null')));
    console.log('dolbyCache 条目:', JSON.stringify(await js('[...dolbyCache.values()].map(e => ({ch: e.ch, rate: e.rate, bytes: e.bytes, dur: e.bytes / (e.rate * e.ch * 2)}))')));
    app.exit(0);
  } catch (e) { console.error(e); app.exit(1); }
});
