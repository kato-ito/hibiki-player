'use strict';
// 桌面端命名规则单元测试（纯 Node，不需要 Electron）：node test-bili-naming.js
const N = require('./bili-naming');
let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 FAIL: ' + name + (extra !== undefined ? '  \u2014 ' + extra : '')); }
}
const eq = (a, b, name) => ok(a === b, name + (a === b ? '' : '  (got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b) + ')'));

console.log('=== 单 P 视频：直接放在下载文件夹里 ===');
eq(N.folderName('校长来啦', false), '', '单 P 不建子文件夹');
eq(N.baseName('校长来啦', '校长来啦', 0, false), '校长来啦', '用视频名');

console.log('=== 合集（多 P）：子文件夹 + 分P名 ===');
eq(N.folderName('合集：某某挑战', true), '合集：某某挑战', '子文件夹用视频名');
eq(N.baseName('合集：某某挑战', 'P1 开场', 1, true), 'P1 开场', '文件名只用分P名');
ok(N.baseName('合集：某某挑战', 'P2 正片', 2, true).indexOf('某某挑战') < 0, '文件名里不再出现视频名');
eq(N.baseName('合集', '', 7, true), 'P7', '分P名为空 → P7');

console.log('=== 非法字符与长度 ===');
eq(N.safe('a/b\\c:d*e?f"g<h>i'), 'a_b_c_d_e_f_g_h_i', '非法字符替换为下划线');
eq(N.folderName('合集: 上 / 下', true), '合集_ 上 _ 下', '文件夹名同样过滤');
ok(N.safe('长'.repeat(200), 60).length === 60, '超长截断');
eq(N.baseName('', '', 0, false), 'bilibili_audio', '空标题兜底');

console.log('=== 播放器里显示的标题 / 专辑（合集只用分P名） ===');
eq(N.metaTitle('合集：某某挑战', 'P3 正片', 3, true), 'P3 正片', '合集内标题 = 分P名');
eq(N.metaTitle('合集：某某挑战', '', 3, true), 'P3', '分P名为空 → P3');
eq(N.metaTitle('合集', '第 5 期：上/下', 5, true), '第 5 期：上/下', '标签不做文件系统过滤');
eq(N.metaAlbum('合集：某某挑战', true), '合集：某某挑战', '合集专辑 = 视频名');
eq(N.metaTitle('校长来啦', '校长来啦', 1, false), '校长来啦', '单 P 标题 = 视频名');
eq(N.metaTitle('视频', '花絮', 2, false), '视频 - 花絮', '单 P 带分P名时保留完整标题');
eq(N.metaAlbum('校长来啦', false), '校长来啦', '单 P 专辑沿用视频名');

console.log('');
console.log('通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
