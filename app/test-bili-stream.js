// 分P音质挑选规则的自测：node test-bili-stream.js
'use strict';
const assert = require('assert');
const { streamKind, pickStream } = require('./bili-stream');

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '：' + e.message); process.exitCode = 1; }
}

const flac = { id: 30251, codecs: 'fLaC', bandwidth: 999000, baseUrl: 'flac' };
const dolby = { id: 30250, codecs: 'ec-3', bandwidth: 448000, baseUrl: 'dolby' };
const aac192 = { id: 30280, codecs: 'mp4a.40.2', bandwidth: 192000, baseUrl: 'a192' };
const aac132 = { id: 30232, codecs: 'mp4a.40.2', bandwidth: 132000, baseUrl: 'a132' };

t('streamKind 识别 Hi-Res / 杜比 / AAC', () => {
  assert.strictEqual(streamKind('fLaC'), 'flac');
  assert.strictEqual(streamKind('ec-3'), 'dolby');
  assert.strictEqual(streamKind('EAC3'), 'dolby');
  assert.strictEqual(streamKind('mp4a.40.2'), 'aac');
});

t('auto → 该分P最高码率', () => {
  assert.strictEqual(pickStream([aac132, aac192, dolby, flac], 'auto', '').baseUrl, 'flac');
  assert.strictEqual(pickStream([aac132, aac192], null, '').baseUrl, 'a192');
});

t('durl → 不使用 DASH 音轨（交给整段 MP4 兜底）', () => {
  assert.strictEqual(pickStream([aac192], 'durl', ''), null);
});

t('id 精确命中时优先用同一条', () => {
  assert.strictEqual(pickStream([aac132, aac192], '30232', 'mp4a.40.2').baseUrl, 'a132');
});

t('该分P没有所选 id → 退到同类最高码率（本次修复的核心）', () => {
  // P1 选了 Hi-Res，但这一P没有 flac：退到同类的杜比
  assert.strictEqual(pickStream([aac192, dolby, aac132], '30251', 'fLaC').baseUrl, 'dolby');
  // 选了杜比但没有杜比：退到 AAC 最高
  assert.strictEqual(pickStream([aac132, aac192], '30250', 'ec-3').baseUrl, 'a192');
  // 选了 64K 但没有：退到最近一档 AAC
  assert.strictEqual(pickStream([aac132, aac192], '30216', 'mp4a.40.2').baseUrl, 'a192');
});

t('连同类都没有 → 退到清单里最好的一条（与安卓端一致）', () => {
  // 选了 Hi-Res，这一P只有杜比 + AAC → 给杜比（而不是让这个分P失败）
  assert.strictEqual(pickStream([aac192, dolby, aac132], '30251', 'fLaC').baseUrl, 'dolby');
  // 选了杜比，这一P只有 AAC → 给最高码率 AAC
  assert.strictEqual(pickStream([aac132, aac192], '30250', 'ec-3').baseUrl, 'a192');
});

t('该分P完全没有任何 DASH 音轨 → null（由上层决定报错/整段 MP4 兜底）', () => {
  assert.strictEqual(pickStream([], '30251', 'fLaC'), null);
});

console.log('\n' + passed + ' 项通过' + (process.exitCode ? '（有失败）' : ''));
