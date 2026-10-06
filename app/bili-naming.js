'use strict';
/**
 * B 站下载的命名规则（与安卓端 app/src/main/java/.../BiliNaming.kt 一一对应）。
 * 抽成独立模块是为了能单独跑单元测试：node test-bili-naming.js
 *
 *   · 单 P 视频    → 视频名.m4a
 *   · 合集 / 多 P  → 下载文件夹/<视频名>/<分P名>.m4a
 */

/** 去掉文件系统不接受的字符，压掉多余空白并限长（可返回空串） */
function safe(s, max) {
  const lim = max || 80;
  let base = String(s == null ? '' : s).trim()
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (base.length > lim) base = base.slice(0, lim).trim();
  return base;
}

/** 合集子文件夹名；空字符串表示不建子文件夹 */
function folderName(title, collection) {
  if (!collection) return '';
  return safe(title, 60);
}

/** 文件名主体（不含扩展名）：合集内只用分P名，单 P 用视频名（多 P 时补 P 序号） */
function baseName(title, part, page, collection) {
  if (collection) {
    const p = safe(part, 60);
    if (p) return p;
    return 'P' + (Number(page) > 0 ? Number(page) : 1);
  }
  let base = safe(title, 80) || 'bilibili_audio';
  const pg = Number(page) || 0;
  if (pg > 0) base += ' P' + pg;
  return base;
}

/**
 * 写进文件的标题标签（播放器里显示的就是它）：
 * 合集内只用分P名（与文件名一致），单 P 用视频名（必要时补 - 分P名）。
 */
function metaTitle(title, part, page, collection) {
  const t = String(title == null ? '' : title).trim();
  const p = String(part == null ? '' : part).trim();
  if (collection) return p || ('P' + (Number(page) > 0 ? Number(page) : 1));
  if (p && p !== t && p !== 'P1') return t ? (t + ' - ' + p) : p;
  return t || p;
}

/** 专辑标签：合集用视频名（同一合集的分P在播放器里归到一张专辑），单 P 沿用视频名 */
function metaAlbum(title, collection) {
  const t = String(title == null ? '' : title).trim();
  if (collection && t) return t;
  return t || 'Bilibili';
}

module.exports = { safe, folderName, baseName, metaTitle, metaAlbum };
