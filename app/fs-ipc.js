// 已保存歌单的文件读取桥：渲染进程凭保存的绝对路径懒加载音频文件
// 由 main.js（正式应用）与 verify-dolby.js（链路验证）共用
const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

ipcMain.handle('fs:read', async (event, p) => {
  if (typeof p !== 'string' || !p) throw new Error('invalid path');
  // 只读常规文件（拒绝目录）；音频文件可能很大，整体读入后经 IPC 传给渲染进程
  const st = fs.statSync(p);
  if (!st.isFile()) throw new Error('not a file: ' + p);
  return fs.readFileSync(p);
});
