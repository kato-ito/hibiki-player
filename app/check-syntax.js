// 提取 html 内联脚本做语法检查：hibiki-player.html（网页版源）与 app/index.html（打包副本）
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const files = [
  path.join(__dirname, '..', 'hibiki-player.html'),
  path.join(__dirname, 'index.html'),
];
let failed = false;
for (const f of files) {
  if (!fs.existsSync(f)) { console.log('跳过（不存在）：' + f); continue; }
  const html = fs.readFileSync(f, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) { console.error('NO SCRIPT FOUND in ' + f); failed = true; continue; }
  const out = path.join(__dirname, '.extracted-' + path.basename(f) + '.js');
  fs.writeFileSync(out, m[1]);
  try {
    execFileSync(process.execPath, ['--check', out], { stdio: 'pipe' });
    console.log('OK  ' + path.basename(f) + '  script ' + m[1].length + ' chars');
  } catch (e) {
    failed = true;
    console.error('语法错误 in ' + f + ':\n' + e.stderr);
  }
}
process.exit(failed ? 1 : 0);
