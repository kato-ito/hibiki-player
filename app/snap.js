// UI 验证：加载应用并截取四种状态截图
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

async function shot(win, name) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, name), img.toPNG());
  console.log('saved', name);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1120, height: 950, show: true });
  await win.loadFile('index.html');
  const js = code => win.webContents.executeJavaScript(code).catch(e => console.log('js err:', e.message));

  await new Promise(r => setTimeout(r, 900));
  await shot(win, 'snap1-default.png');

  await js(`setPlaylist([
    new File([new Uint8Array(4000)], '晴天 - 示例.mp3'),
    new File([new Uint8Array(4000)], '夜曲 - 示例.flac'),
    new File([new Uint8Array(4000)], 'Lemon - 示例.m4a'),
    new File([new Uint8Array(4000)], '起风了 - 示例.mp3'),
  ])`);
  await new Promise(r => setTimeout(r, 800));
  await shot(win, 'snap2-playlist.png');

  await js(`applyTheme('light'); skinPanel.hidden = false;`);
  await new Promise(r => setTimeout(r, 400));
  await shot(win, 'snap3-light-skin.png');

  await js(`(function(){
    const c = document.createElement('canvas'); c.width = 900; c.height = 560;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 900, 560);
    g.addColorStop(0, '#1a2a6c'); g.addColorStop(.5, '#b21f1f'); g.addColorStop(1, '#fdbb2d');
    x.fillStyle = g; x.fillRect(0, 0, 900, 560);
    applyTheme('violet'); skinPanel.hidden = false;
    applyBG(c.toDataURL('image/jpeg', 0.9), 0.45);
    document.getElementById('bgFileName').textContent = 'demo-bg.jpg';
  })()`);
  await new Promise(r => setTimeout(r, 500));
  await shot(win, 'snap4-violet-bg.png');

  app.quit();
}).catch(e => { console.error(e); app.exit(1); });
