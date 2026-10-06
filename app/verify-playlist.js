// 歌单保存链路端到端验证：真实 preload + 渲染代码走完 新建→追加→保存→重启恢复→懒加载播放
// 用法：npx electron verify-playlist.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('./fs-ipc');   // 注册 fs:read（与 main.js 一致，懒加载播放测试需要）

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) failed++;
};

// 生成 5 秒 44.1 kHz 立体声静音 WAV，用于懒加载播放测试
function makeWav(p) {
  const sr = 44100, n = sr * 5;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  fs.writeFileSync(p, buf);
}

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-pl-'));
  const wav1 = path.join(dir, 'folderA-示例一.wav');
  const wav2 = path.join(dir, 'folderB-示例二.wav');
  makeWav(wav1); makeWav(wav2);

  const win = new BrowserWindow({ width: 1120, height: 950, show: false,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js') } });
  const js = code => win.webContents.executeJavaScript(code);

  console.log('— 第一轮：启动 → 保存行可见 → 新建 → 跨文件夹追加 → 保存');
  await win.loadFile('index.html');
  ok(await js(`!document.getElementById('plSaveRow').hidden`), '保存行（新建/保存/删除/追加）启动即可见');
  await js(`localStorage.clear()`);   // 清掉旧数据，保证测试从零开始

  // 模拟「新建歌单」：名字关联 + 空列表（注意 openNameInput 会清空输入框，须先打开再填值）
  await js(`openNameInput('new');
            plNameInput.value = '我的歌单';
            document.getElementById('plNameOk').click();`);
  ok(await js(`curSavedName === '我的歌单'`), '新建后关联歌单名');
  ok(await js(`plAppendOn === true`), '新建后自动开启追加导入');

  // 首次导入（append=true 但列表为空 → 走替换路径）：名字必须保留（本次修复点）
  await js(`setPlaylist([new File([new Uint8Array(64)], 'a.wav')], 0, true)`);
  ok(await js(`curSavedName === '我的歌单' && plTracks.length === 1`), '新建后首次导入不丢歌单关联（修复点 1）');

  // 替换导入（append=false）：解除关联
  await js(`setPlaylist([new File([new Uint8Array(64)], 'b.wav')], 0, false)`);
  ok(await js(`curSavedName === null`), '替换导入解除与已保存歌单的关联');

  // 重新模拟带本机路径的导入 + 保存：两个不同“文件夹”
  await js(`openNameInput('new');
            plNameInput.value = '我的歌单';
            document.getElementById('plNameOk').click();`);
  await js(`setPlaylist([new File([new Uint8Array(64)], '示例一.wav')], 0, true);
            plTracks[0].path = ${JSON.stringify(wav1)};
            setPlaylist([new File([new Uint8Array(64)], '示例二.wav')], 0, true);
            plTracks[1].path = ${JSON.stringify(wav2)};
            doSavePlaylist('我的歌单');`);
  const saved = await js(`JSON.stringify(getSavedPlaylists())`);
  const savedList = JSON.parse(saved);
  ok(savedList.length === 1 && savedList[0].name === '我的歌单' &&
     savedList[0].items.length === 2 && savedList[0].items[0].path === wav1,
     '歌单连同本机路径写入 localStorage');
  ok(await js(`localStorage.getItem('av.lastpl') === '我的歌单'`), '记录上次使用的歌单');

  console.log('— 第二轮：重启（重新加载页面）→ 自动恢复');
  await win.loadFile('index.html');
  ok(await js(`curSavedName === '我的歌单' && plTracks.length === 2 && plIndex === 0`),
     '上次歌单自动恢复（不自动播放）（修复点 2）');
  ok(await js(`!playlistPanel.hidden && !document.getElementById('plSaveRow').hidden`), '歌单面板与保存行均显示');
  ok(await js(`plTracks.every(t => !t.file && t.path)`), '恢复的曲目为懒加载（未读入内容）');

  // 懒加载播放：真实 fs:read 路径
  await js(`playIndex(0)`);
  await new Promise(r => setTimeout(r, 1500));
  ok(await js(`plTracks[0].file instanceof File && !plTracks[0].missing`), '点击曲目按路径懒加载成功');
  ok(await js(`!!mediaElem && !mediaElem.paused`), '懒加载后正常播放');

  // 缺失文件标注：删掉第二首的文件再切歌
  fs.unlinkSync(wav2);
  await js(`playIndex(1)`);
  await new Promise(r => setTimeout(r, 800));
  ok(await js(`plTracks[1].missing === true`), '文件被移动/删除后标注缺失');

  // 删除歌单（二次确认）
  await js(`document.getElementById('plSaved').value = '我的歌单';
            deleteSavedPlaylist(); deleteSavedPlaylist();`);
  ok(await js(`getSavedPlaylists().length === 0 && curSavedName === null`), '删除歌单（两次确认）后列表清空、解除关联');

  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'snap5-playlist-save.png'), img.toPNG());
  console.log('saved snap5-playlist-save.png');
  console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
  app.exit(failed ? 1 : 0);
}).catch(e => { console.error(e); app.exit(1); });
