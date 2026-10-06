// 杜比链路验证：真实 preload + 真实渲染进程代码完整走一遍 转码→播放
// 用法：npx electron verify-dolby.js <音频文件路径>（如 test.ac3）
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require('./dolby-ipc');   // 注册与正式应用完全相同的 dolby:convert 处理器

const src = process.argv[2];
if (!src || !fs.existsSync(src)) {
  console.error('用法: npx electron verify-dolby.js <音频文件路径>');
  app.exit(2);
}

function grantMediaPermissions() {
  const handler = (webContents, permission, callback) => callback(permission === 'media');
  session.defaultSession.setPermissionRequestHandler(handler);
  session.defaultSession.setPermissionCheckHandler((wc, p) => p === 'media');
}

app.whenReady().then(async () => {
  grantMediaPermissions();
  const win = new BrowserWindow({
    width: 1120, height: 900, show: false,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, spellcheck: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  await win.loadFile('index.html');
  const js = code => win.webContents.executeJavaScript(code);

  // 1) preload 桥已注入
  const avail = await js('window.dolby && window.dolby.available');
  console.log(avail ? 'OK  window.dolby 已注入' : 'FAIL  window.dolby 缺失');
  if (!avail) app.exit(1);

  // 2) 把测试文件字节喂给页面，走真实 setPlaylist → startFile → playViaFFmpeg 全流程
  const b64 = fs.readFileSync(src).toString('base64');
  const name = path.basename(src);
  await js(`(async () => {
    const bytes = Uint8Array.from(atob("${b64}"), c => c.charCodeAt(0));
    const f = new File([bytes], "${name}");
    setPlaylist([f]);
    startFile(plTracks[0].file);
  })()`);

  // 3) 等待转码完成、进入播放状态（最多 30 秒）
  const t0 = Date.now();
  let status = '', dur = 0, err = '';
  while (Date.now() - t0 < 30000) {
    await new Promise(r => setTimeout(r, 500));
    status = await js('statusEl.textContent');
    dur = await js('mediaElem ? mediaElem.duration : 0').catch(() => 0);
    err = await js('mediaElem && mediaElem.error ? mediaElem.error.code : 0').catch(() => 0);
    if (/正在播放/.test(status) || /解码失败/.test(status)) break;
  }
  console.log('状态栏:', status);
  console.log('时长(s):', dur, ' media.error:', err);
  console.log('设备最大输出声道 maxChannelCount:', await js('audioCtx.destination.maxChannelCount'));
  console.log('实际输出声道 destination.channelCount:', await js('audioCtx.destination.channelCount'));
  const wavCh = await js('plTracks[plIndex] && dolbyCache.size ? [...dolbyCache.values()][0].ch : 0');
  console.log('转码 WAV 声道数:', wavCh);
  const multi = /多声道|下混/.test(status);
  const okNative = /正在播放/.test(status) && /转码为 PCM/.test(status) && dur > 1 && !err &&
                   wavCh > 2 && multi;
  console.log(okNative ? 'PASS  [原生直出] 多声道转码播放链路正常' : 'FAIL  [原生直出] 链路异常');

  // 4) 切换为「重编码适配设备」模式重播同一文件（验证二次 -ac 重编码路径）
  await js('setDolbyMode("device"); startFile(plTracks[0].file);');
  const t1 = Date.now();
  let status2 = '';
  while (Date.now() - t1 < 30000) {
    await new Promise(r => setTimeout(r, 500));
    status2 = await js('statusEl.textContent');
    if (/正在播放|解码失败/.test(status2)) { if (/正在播放/.test(status2)) break; }
  }
  console.log('设备模式状态栏:', status2);
  const devCh = await js('[...dolbyCache.values()].map(e => e.ch)');
  console.log('缓存条目声道:', devCh);
  const okDevice = /正在播放/.test(status2) && /转码为 PCM/.test(status2) &&
                   (/重编码|多声道直出|下混/.test(status2));
  console.log(okDevice ? 'PASS  [重编码适配设备] 链路正常' : 'FAIL  [重编码适配设备] 链路异常');
  app.exit(okNative && okDevice ? 0 : 1);
}).catch(e => { console.error(e); app.exit(1); });
