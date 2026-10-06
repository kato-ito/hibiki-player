'use strict';
/**
 * B 站下载的「分P音质挑选」规则（与安卓端 app3.js 的 biliPickQuality 一一对应）。
 * 抽成独立模块是为了能单独跑单元测试：node test-bili-stream.js
 *
 * 背景：UI 里的音质清单只用 P1 探测，而合集里各分P的音轨可能不同
 * （P1 有 Hi-Res / 杜比，后面的分P没有）。若按 id 严格匹配，这些分P会整条失败，
 * 因此这里按「编码类型」退到同类最高码率。
 */

/** 编码字符串 → 档位类型：flac（Hi-Res 无损）/ dolby（E-AC3 全景声）/ aac */
function streamKind(codec) {
  const s = String(codec || '').toLowerCase();
  if (s.indexOf('flac') >= 0) return 'flac';
  if (s.indexOf('ec-3') >= 0 || s.indexOf('eac3') >= 0) return 'dolby';
  return 'aac';
}

/** 档位优劣顺序（与安卓端 biliParseQualities 的排序一致）：无损 → 杜比 → AAC */
const KIND_RANK = { flac: 0, dolby: 1, aac: 2 };

/**
 * 在某个分P的音轨清单里挑出要下载的那一条。
 * @param all 该分P的全部音轨 [{ id, codecs, bandwidth, baseUrl, backupUrl }]
 * @param wantId 用户选择的档位 id（'auto' = 自动最高，'durl' = 走整段 MP4 兜底）
 * @param wantCodec 用户所选档位的编码（用于 id 缺失时判定同类）
 * @returns 选中的音轨；null 表示这一P没有可用 DASH 音轨
 */
function pickStream(all, wantId, wantCodec) {
  const list = Array.isArray(all) ? all : [];
  const byBandwidth = (a, b) => (b.bandwidth || 0) - (a.bandwidth || 0);
  if (wantId == null || String(wantId) === 'auto') return list.slice().sort(byBandwidth)[0] || null;
  if (String(wantId) === 'durl') return null;
  const exact = list.find(a => String(a.id) === String(wantId));
  if (exact) return exact;
  const kind = streamKind(wantCodec);
  const same = list.filter(a => streamKind(a.codecs) === kind).sort(byBandwidth);
  if (same.length) return same[0];
  // 这一P连同类音轨都没有：与安卓端一致，退到清单里最好的一条（无损 → 杜比 → AAC），
  // 而不是让整个分P下载失败
  return list.slice().sort((a, b) =>
    (KIND_RANK[streamKind(a.codecs)] - KIND_RANK[streamKind(b.codecs)]) || byBandwidth(a, b))[0] || null;
}

module.exports = { streamKind, pickStream };
