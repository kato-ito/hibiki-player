// 并发转码竞态验证：同一文件同时发起两次 convert，两者都必须拿到完整一致的 WAV
const { app, BrowserWindow } = require('electron');
const path = require('path');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require('./fs-ipc');
require('./dolby-ipc');
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ width: 800, height: 600, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') } });
    await win.loadFile('index.html');
    const MP4 = process.argv[2];
    const res = await win.webContents.executeJavaScript("(async () => {" +
      "const data = await window.desktopFiles.read(" + JSON.stringify(MP4) + ");" +
      "const f = new File([data], " + JSON.stringify(path.basename(MP4)) + ");" +
      "const t0 = Date.now();" +
      "const [a, b] = await Promise.all([window.dolby.convert(f, 0), window.dolby.convert(f, 0)]);" +
      "return { ms: Date.now() - t0, lenA: a.length, lenB: b.length, same: a.length === b.length };" +
      "})()");
    console.log(JSON.stringify(res));
    app.exit(0);
  } catch (e) { console.error(e); app.exit(1); }
});
