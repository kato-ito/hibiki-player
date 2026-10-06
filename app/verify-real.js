// 真杜比歌单实测：用真实文件走「路径懒加载 → 探测 → 播放」全流程
// 用法：npx electron verify-real.js <eac3路径> <mp4路径>
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const EAC3 = process.argv[2], MP4 = process.argv[3];
const OUT_PATH = path.join(app.getPath('temp'), 'av-real-export.eac3');
dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT_PATH });
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

    /* Part 1: 探测阶段（导入后、未播放）——Chromium 对裸 .eac3 报什么时长 */
    console.log('=== Part 1: probe 裸 eac3（未播放） ===');
    await js(`(async () => {
      const data = await window.desktopFiles.read(${JSON.stringify(EAC3)});
      const f = new File([data], ${JSON.stringify(path.basename(EAC3))});
      plTracks = [{ file: f, name: f.name, dur: null, path: ${JSON.stringify(EAC3)},
                    dolby: true, lrcFile: null, lrcPath: "", lrcText: null, meta: null }];
      plIndex = 0; plGen++; plRender(); probeDurations();
    })()`);
    await new Promise(r => setTimeout(r, 4000));
    console.log('probe 后 plTracks[0].dur =', JSON.stringify(await js('plTracks[0] ? plTracks[0].dur : null')));
    console.log('probe 后歌单时长单元格 =', JSON.stringify(await js('document.querySelector(".pl-dur") ? document.querySelector(".pl-dur").textContent : "no-cell"')));

    /* Part 2: 双击播放裸 eac3（路径懒加载 → ffmpeg 转码） */
    console.log('=== Part 2: 播放裸 eac3 ===');
    await js('playIndex(0)');
    let t0 = Date.now(), status = '';
    while (Date.now() - t0 < 120000) {
      await new Promise(r => setTimeout(r, 500));
      status = await js('statusEl.textContent');
      if (/正在播放|解码失败|无法播放/.test(status)) break;
    }
    await new Promise(r => setTimeout(r, 2500));
    console.log('状态栏:', status);
    console.log('plTracks[0].dur =', JSON.stringify(await js('plTracks[0].dur')));
    console.log('mediaElem.duration =', JSON.stringify(await js('mediaElem ? mediaElem.duration : null')));
    console.log('歌单时长单元格 =', JSON.stringify(await js('document.querySelector(".pl-dur").textContent')));

    /* Part 3: 播放 DV 视频（路径懒加载，转码默认音轨） */
    console.log('=== Part 3: 播放 DV mp4 ===');
    await js(`(async () => {
      plTracks = [{ file: null, name: ${JSON.stringify(path.basename(MP4))}, dur: null, path: ${JSON.stringify(MP4)},
                    dolby: true, lrcFile: null, lrcPath: "", lrcText: null, meta: null }];
      plIndex = 0; plGen++; plRender(); probeDurations();
    })()`);
    await new Promise(r => setTimeout(r, 4000));
    console.log('mp4 probe 后 dur =', JSON.stringify(await js('plTracks[0].dur')));
    console.log('mp4 歌单时长单元格 =', JSON.stringify(await js('document.querySelector(".pl-dur").textContent')));
    await js('playIndex(0)');
    t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      await new Promise(r => setTimeout(r, 500));
      status = await js('statusEl.textContent');
      if (/正在播放|解码失败|无法播放/.test(status)) break;
    }
    await new Promise(r => setTimeout(r, 2500));
    console.log('mp4 状态栏:', status);
    console.log('mp4 plTracks[0].dur =', JSON.stringify(await js('plTracks[0].dur')));
    console.log('mp4 mediaElem.duration =', JSON.stringify(await js('mediaElem ? mediaElem.duration : null')));
    console.log('mp4 歌单时长单元格 =', JSON.stringify(await js('document.querySelector(".pl-dur").textContent')));

    /* Part 4: 从 mp4 导出音频（真实 IPC） */
    console.log('=== Part 4: 导出 mp4 音轨 ===');
    const exp = await js('window.desktopFiles.exportAudio(' + JSON.stringify(MP4) + ', "dv.mp4")');
    console.log('export 结果:', JSON.stringify(exp));
    app.exit(0);
  } catch (e) { console.error(e); app.exit(1); }
});
