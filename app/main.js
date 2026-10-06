const { app, BrowserWindow, session, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// —— 项目更名「音频可视化 / 自由播放器」→「Hibiki Player」：首次启动时把旧版本地数据
//    （歌单 / 皮肤与背景设置 / B站登录 Cookie 等）从旧 userData 目录一次性迁移到新目录 ——
(function migrateLegacyUserData() {
  try {
    const appData = app.getPath('appData');
    const cur = app.getPath('userData');
    const legacyNames = ['音频可视化', 'audio-visualizer'];   // 旧安装版 / 旧开发版的数据目录名
    for (const oldName of legacyNames) {
      const old = path.join(appData, oldName);
      if (!old || old === cur || !fs.existsSync(old)) continue;
      if (fs.existsSync(cur)) {
        // 新目录已存在：只补拷新目录里没有的条目，绝不覆盖新数据
        for (const ent of fs.readdirSync(old, { withFileTypes: true })) {
          const s = path.join(old, ent.name), d = path.join(cur, ent.name);
          if (!fs.existsSync(d)) fs.cpSync(s, d, { recursive: true });
        }
      } else {
        fs.mkdirSync(path.dirname(cur), { recursive: true });
        fs.cpSync(old, cur, { recursive: true });
      }
    }
  } catch (e) { /* 迁移失败不影响启动 */ }
})();

require('./dolby-ipc');   // 注册 dolby:convert（ffmpeg 转码）并在退出时清理临时目录
require('./fs-ipc');      // 注册 fs:read（已保存歌单按路径读取音频文件）
require('./bili-ipc');    // 注册 bili:*（B站原始音频下载：解析 → 取流 → 下载 → ffmpeg 无损封装）

// 音频播放器：允许不经用户手势自动续播（歌单连播、拖入即播）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// 允许页面申请麦克风等媒体权限（波形/频谱等实时可视化需要麦克风输入）
function grantMediaPermissions() {
  const handler = (webContents, permission, callback) => {
    callback(permission === 'media');
  };
  session.defaultSession.setPermissionRequestHandler(handler);
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return permission === 'media';
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 875,
    minWidth: 800,
    minHeight: 560,
    title: 'Hibiki Player',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    frame: false,               // 无边框窗口：页面自带标题栏与窗口控制按钮
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // 页面内可能出现的链接交给系统默认浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile('index.html');
}

// 无边框窗口控制：最小化 / 最大化·还原 / 关闭
ipcMain.on('win:minimize', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.minimize(); });
ipcMain.on('win:toggle-maximize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (w.isMaximized()) w.unmaximize(); else w.maximize();
});
ipcMain.on('win:close', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.close(); });

app.whenReady().then(() => {
  grantMediaPermissions();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
