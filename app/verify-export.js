// 导出 + 歌单时长链路验证（与正式应用共用 dolby-ipc.js / preload.js / index.html）
// 用法：npx electron verify-export.js <dv样片.mp4> <杜比音频.eac3>
// Part A：导出 DV 视频里的音频（patch 掉保存对话框 → 固定输出路径）
// Part B：解码实测导出文件的真实时长/编码
// Part C：导入杜比音频 → 自动播放 → 检查歌单行的时长显示
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const MP4 = process.argv[2];
const EAC3 = process.argv[3];
if (!MP4 || !fs.existsSync(MP4)) { console.error('缺少 mp4 参数'); app.exit(2); }
if (!EAC3 || !fs.existsSync(EAC3)) { console.error('缺少 eac3 参数'); app.exit(2); }
const OUT_PATH = path.join(app.getPath('temp'), 'av-export-test.eac3');

// 绕过保存对话框：导出直接写到固定路径
dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT_PATH });

require('./dolby-ipc');   // 注册与正式应用完全相同的 audio:export / dolby:convert 处理器

// 与 dolby-ipc.js 相同的「解码实测时长」（-progress 文件，读最后一个 out_time_us）
function decodeMeasure(src, mapSpec) {
  return new Promise(res => {
    const ff = require('@ffmpeg-installer/ffmpeg').path;
    const { spawn } = require('child_process');
    const progFile = path.join(app.getPath('temp'), 'av-prog-' + Date.now() + '-' +
      Math.random().toString(36).slice(2, 8) + '.txt');
    const p = spawn(ff, ['-hide_banner', '-loglevel', 'error', '-i', src,
      '-map', mapSpec, '-f', 'null', '-', '-progress', progFile], { windowsHide: true });
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

    /* ---- Part A：导出 DV 视频中的音轨（真实 IPC 全流程） ---- */
    console.log('=== Part A: audio:export ===');
    const exp = await js('window.desktopFiles.exportAudio(' + JSON.stringify(MP4) + ', "dv.mp4")');
    console.log('export 结果:', JSON.stringify(exp));
    let size = 0;
    if (exp && exp.ok && fs.existsSync(exp.file)) size = fs.statSync(exp.file).size;
    console.log('导出文件大小(bytes):', size);

    /* ---- Part B：解码实测导出文件的真实时长与编码 ---- */
    console.log('=== Part B: 导出文件实测 ===');
    if (exp && exp.ok && fs.existsSync(exp.file)) {
      const realDur = await decodeMeasure(exp.file, '0:a:0');
      console.log('导出文件解码实测时长(s):', realDur.toFixed(2));
    }

    /* ---- Part C：歌单内杜比音频的时长显示 ---- */
    console.log('=== Part C: 歌单时长 ===');
    const b64 = fs.readFileSync(EAC3).toString('base64');
    const name = path.basename(EAC3);
    await js(`(async () => {
      const bytes = Uint8Array.from(atob("${b64}"), c => c.charCodeAt(0));
      const f = new File([bytes], ${JSON.stringify(name)});
      setPlaylist([f]);
    })()`);
    const t0 = Date.now();
    let status = '';
    while (Date.now() - t0 < 60000) {
      await new Promise(r => setTimeout(r, 500));
      status = await js('statusEl.textContent');
      if (/正在播放|解码失败|无法播放/.test(status)) break;
    }
    await new Promise(r => setTimeout(r, 1500));
    const tDur = await js('plTracks[0] ? plTracks[0].dur : "no-track"').catch(e => 'ERR ' + e.message);
    const mDur = await js('mediaElem ? mediaElem.duration : "no-media"').catch(e => 'ERR ' + e.message);
    const cell = await js('document.querySelector(".pl-dur") ? document.querySelector(".pl-dur").textContent : "no-cell"');
    const ready = await js('mediaElem ? mediaElem.readyState : -1').catch(() => -1);
    console.log('状态栏:', status);
    console.log('plTracks[0].dur =', JSON.stringify(tDur));
    console.log('mediaElem.duration =', JSON.stringify(mDur), ' readyState =', ready);
    console.log('歌单时长单元格文本 =', JSON.stringify(cell));
    app.exit(0);
  } catch (e) {
    console.error(e);
    app.exit(1);
  }
});
