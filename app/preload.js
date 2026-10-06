// 渲染进程 ↔ 主进程 的安全桥：只暴露杜比/DTS 转码所需的最小接口
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('dolby', {
  available: true,
  // 优先传本机路径（免拷贝）；拖拽生成的 File 拿不到路径时回退为传内容
  async convert(file, channels) {
    let p = '';
    try { p = webUtils.getPathForFile(file); } catch (e) { /* 无路径 */ }
    if (p) return ipcRenderer.invoke('dolby:convert', { path: p, size: file.size, channels });
    const data = await file.arrayBuffer();
    return ipcRenderer.invoke('dolby:convert', { name: file.name, size: file.size, data, channels });
  },
  // 探测采样率（Hz，失败 0）：页面侧解析文件头失败时的兜底
  async probe(file) {
    let p = '';
    try { p = webUtils.getPathForFile(file); } catch (e) { /* 无路径 */ }
    if (p) return ipcRenderer.invoke('dolby:probe', { path: p });
    const data = await file.arrayBuffer();
    return ipcRenderer.invoke('dolby:probe', { name: file.name, data });
  },
  // 探测时长（秒，失败 0）：杜比/DTS/视频的时长 Chromium 估不准，用 ffmpeg 解析
  async probeDur(file) {
    let p = '';
    try { p = webUtils.getPathForFile(file); } catch (e) { /* 无路径 */ }
    if (p) return ipcRenderer.invoke('dolby:probedur', { path: p });
    const data = await file.arrayBuffer();
    return ipcRenderer.invoke('dolby:probedur', { name: file.name, data });
  },
});

// 无边框窗口控制（最小化 / 最大化·还原 / 关闭）
contextBridge.exposeInMainWorld('winControls', {
  minimize() { ipcRenderer.send('win:minimize'); },
  toggleMaximize() { ipcRenderer.send('win:toggle-maximize'); },
  close() { ipcRenderer.send('win:close'); },
});

// B站音频下载：解析链接 / 取音质清单 / 下载（进度回调）/ 取消 / 选目录 / Cookie
contextBridge.exposeInMainWorld('bili', {
  available: true,
  resolve(input) { return ipcRenderer.invoke('bili:resolve', input); },
  streams(req) { return ipcRenderer.invoke('bili:streams', req); },
  download(req) { return ipcRenderer.invoke('bili:download', req); },
  cancel(taskId) { ipcRenderer.send('bili:cancel', taskId); },
  pickDir(cur) { return ipcRenderer.invoke('bili:pickdir', cur); },
  reveal(p) { return ipcRenderer.invoke('bili:reveal', p); },
  setCookie(c) { return ipcRenderer.invoke('bili:setcookie', c); },
  getCookie() { return ipcRenderer.invoke('bili:getcookie'); },
  loginGen() { return ipcRenderer.invoke('bili:login-gen'); },
  loginPoll(key) { return ipcRenderer.invoke('bili:login-poll', key); },
  getUser() { return ipcRenderer.invoke('bili:user'); },
  logout() { return ipcRenderer.invoke('bili:logout'); },
  onProgress(cb) { ipcRenderer.on('bili:progress', (e, p) => { try { cb(p); } catch (err) { /* 忽略回调异常 */ } }); },
});

// 已保存歌单支持：凭保存的路径取回文件内容 / 查询 File 的本机路径
contextBridge.exposeInMainWorld('desktopFiles', {
  available: true,
  async read(p) { return ipcRenderer.invoke('fs:read', p); },
  getPath(file) {
    try { return webUtils.getPathForFile(file); } catch (e) { return ''; }
  },
  async exportAudio(p, name) { return ipcRenderer.invoke('audio:export', { path: p, name }); },
});
