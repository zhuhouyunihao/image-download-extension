/**
 * gallery.js — 结果页
 * 职责：
 *   1) 从 chrome.storage.session 读取最新提取结果
 *   2) 渲染网格、筛选、勾选
 *   3) PNG 转换（fetch → createImageBitmap → OffscreenCanvas → convertToBlob）
 *   4) 并发下载队列 + 失败降级
 */

'use strict';

const SOURCE_LABEL = {
  main: '主图',
  sku: 'SKU 图',
  detail: '详情图',
  background: '背景图'
};

const state = {
  result: null,
  images: [],
  visible: [],
  selected: new Set(),
  filter: 'all',
  downloading: false,
  lightboxIndex: -1
};

const els = {};

/* ============================================================
 * 初始化
 * ============================================================ */
document.addEventListener('DOMContentLoaded', init);

async function init() {
  els.summary = document.getElementById('summary');
  els.grid = document.getElementById('grid');
  els.empty = document.getElementById('empty');
  els.progress = document.getElementById('progress');
  els.progressFill = document.getElementById('progressFill');
  els.progressText = document.getElementById('progressText');
  els.downloadBtn = document.getElementById('downloadBtn');
  els.selectAll = document.getElementById('selectAll');
  els.clearAll = document.getElementById('clearAll');
  els.filters = document.querySelectorAll('.filters button');
  els.lightbox = document.getElementById('lightbox');
  els.lbImg = document.getElementById('lbImg');

  bindEvents();
  await load();
}

async function load() {
  try {
    const data = await chrome.storage.session.get('latest');
    const latest = data && data.latest;
    if (!latest || !Array.isArray(latest.images) || latest.images.length === 0) {
      showEmpty();
      return;
    }
    state.result = latest;
    state.images = latest.images;

    let summary = '已提取 ' + latest.images.length + ' 张图片';
    if (latest.stats && latest.stats.timedOut) {
      summary += '（扫描超时，可能未完整，建议滚动页面后重试）';
    }
    els.summary.textContent = summary;

    render();
  } catch (e) {
    console.error('[gallery] 读取结果失败', e);
    showEmpty();
  }
}

function showEmpty() {
  els.summary.textContent = '已提取 0 张图片';
  els.grid.innerHTML = '';
  els.empty.hidden = false;
}

/* ============================================================
 * 事件绑定
 * ============================================================ */
function bindEvents() {
  els.filters.forEach(function (btn) {
    btn.addEventListener('click', function () {
      els.filters.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      state.filter = btn.dataset.filter;
      render();
    });
  });

  els.selectAll.addEventListener('click', function () {
    state.visible.forEach(function (img) { state.selected.add(img.id); });
    render();
  });

  els.clearAll.addEventListener('click', function () {
    state.selected.clear();
    render();
  });

  els.downloadBtn.addEventListener('click', downloadSelected);

  els.lightbox.querySelector('.lb-close').addEventListener('click', closeLightbox);
  els.lightbox.querySelector('.lb-prev').addEventListener('click', function () { moveLightbox(-1); });
  els.lightbox.querySelector('.lb-next').addEventListener('click', function () { moveLightbox(1); });
  els.lightbox.addEventListener('click', function (e) {
    if (e.target === els.lightbox) closeLightbox();
  });

  document.addEventListener('keydown', function (e) {
    if (els.lightbox.hidden) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') moveLightbox(-1);
    if (e.key === 'ArrowRight') moveLightbox(1);
  });
}

/* ============================================================
 * 渲染
 * ============================================================ */
function render() {
  const filter = state.filter;
  state.visible = filter === 'all'
    ? state.images.slice()
    : state.images.filter(function (i) { return i.source === filter; });

  if (state.visible.length === 0) {
    els.grid.innerHTML = '';
    els.empty.hidden = false;
    updateDownloadBtn();
    return;
  }
  els.empty.hidden = true;

  const frag = document.createDocumentFragment();
  state.visible.forEach(function (img) {
    frag.appendChild(createCard(img));
  });
  els.grid.innerHTML = '';
  els.grid.appendChild(frag);
  updateDownloadBtn();
}

function createCard(img) {
  const card = document.createElement('div');
  card.className = 'card' + (state.selected.has(img.id) ? ' selected' : '');
  card.dataset.id = img.id;

  const thumb = document.createElement('div');
  thumb.className = 'thumb';

  const im = document.createElement('img');
  im.src = img.thumbnailUrl || img.url;
  im.loading = 'lazy';
  im.decoding = 'async';
  im.alt = '';
  im.addEventListener('error', function () {
    im.style.display = 'none';
  });
  thumb.appendChild(im);

  const meta = document.createElement('div');
  meta.className = 'meta';

  const dims = document.createElement('span');
  dims.className = 'dims';
  dims.textContent = (img.width || '?') + ' × ' + (img.height || '?');

  const tag = document.createElement('span');
  tag.className = 'src-tag';
  tag.textContent = SOURCE_LABEL[img.source] || '图片';

  meta.appendChild(dims);
  meta.appendChild(tag);

  const check = document.createElement('div');
  check.className = 'check';
  check.textContent = '✓';

  card.appendChild(thumb);
  card.appendChild(meta);
  card.appendChild(check);

  card.addEventListener('click', function (e) {
    // 点击右下角区域预览，点击其他区域选择
    if (e.detail === 1) {
      toggleSelect(img.id);
    }
  });

  // 双击打开灯箱
  card.addEventListener('dblclick', function (e) {
    e.preventDefault();
    openLightbox(img.id);
  });

  return card;
}

function toggleSelect(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);

  const card = els.grid.querySelector('.card[data-id="' + id + '"]');
  if (card) card.classList.toggle('selected', state.selected.has(id));
  updateDownloadBtn();
}

function updateDownloadBtn() {
  const n = state.selected.size;
  els.downloadBtn.textContent = '下载所选 (' + n + ')';
  els.downloadBtn.disabled = n === 0 || state.downloading;
}

/* ============================================================
 * 灯箱
 * ============================================================ */
function openLightbox(id) {
  const idx = state.visible.findIndex(function (i) { return i.id === id; });
  if (idx < 0) return;
  state.lightboxIndex = idx;
  els.lightbox.hidden = false;
  showLightboxImage();
}

function closeLightbox() {
  els.lightbox.hidden = true;
  els.lbImg.src = '';
  state.lightboxIndex = -1;
}

function moveLightbox(delta) {
  if (state.lightboxIndex < 0) return;
  const n = state.visible.length;
  state.lightboxIndex = (state.lightboxIndex + delta + n) % n;
  showLightboxImage();
}

function showLightboxImage() {
  const img = state.visible[state.lightboxIndex];
  if (!img) return;
  els.lbImg.src = img.url;
}

/* ============================================================
 * PNG 转换 + 下载
 * ============================================================ */
async function downloadSelected() {
  if (state.downloading) return;
  const targets = state.images.filter(function (img) { return state.selected.has(img.id); });
  if (targets.length === 0) return;

  state.downloading = true;
  updateDownloadBtn();

  const total = targets.length;
  let success = 0;
  let failed = 0;
  let fallback = 0;

  showProgress(total);

  const queue = targets.slice();
  const concurrency = 4; // 与文档一致，避免触发 CDN 限速

  async function worker() {
    while (queue.length > 0) {
      const img = queue.shift();
      try {
        const status = await downloadOne(img);
        if (status === 'fallback') fallback++;
        success++;
      } catch (e) {
        console.warn('[gallery] 下载失败', img.url, e);
        failed++;
      }
      const done = success + failed;
      updateProgress(done, total, success, failed, fallback);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, total); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  state.downloading = false;
  updateDownloadBtn();
  finalizeProgress(success, failed, fallback);
}

async function downloadOne(img) {
  const filename = makeFilename(img);

  try {
    // 关键：在扩展页面上下文中 fetch，host_permissions 覆盖的域不受 CORS 限制
    const resp = await fetch(img.url, { credentials: 'omit', cache: 'force-cache' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);

    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 2D 上下文');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
    const objectUrl = URL.createObjectURL(pngBlob);

    try {
      await chrome.downloads.download({
        url: objectUrl,
        filename: filename,
        saveAs: false
      });
    } finally {
      setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 10000);
    }

    return 'success';
  } catch (e) {
    // 降级：直接下载原始 URL（内容可能非 PNG，但扩展名仍为 .png）
    try {
      await chrome.downloads.download({
        url: img.url,
        filename: filename,
        saveAs: false
      });
      return 'fallback';
    } catch (e2) {
      throw new Error('原图转换与直接下载均失败：' + String(e2));
    }
  }
}

function makeFilename(img) {
  const platform = (state.result && state.result.platformId) || 'ecom';
  const productId = (state.result && state.result.productId) || 'item';
  const source = img.source || 'img';
  const idx = String(state.images.indexOf(img) + 1).padStart(2, '0');

  let base = platform + '_' + productId + '_' + source + '_' + idx;
  base = base.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 100);
  return base + '.png';
}

/* ============================================================
 * 进度 UI
 * ============================================================ */
function showProgress(total) {
  els.progress.hidden = false;
  els.progressFill.style.width = '0%';
  els.progressText.textContent = '准备下载 ' + total + ' 张…';
}

function updateProgress(done, total, success, failed, fallback) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  els.progressFill.style.width = pct + '%';
  let text = '正在下载 ' + done + '/' + total;
  if (failed > 0) text += ' · 失败 ' + failed;
  if (fallback > 0) text += ' · 未转换 ' + fallback;
  els.progressText.textContent = text;
}

function finalizeProgress(success, failed, fallback) {
  els.progressFill.style.width = '100%';
  const parts = ['已完成 ' + success + ' 成功'];
  if (failed > 0) parts.push(failed + ' 失败');
  if (fallback > 0) parts.push(fallback + ' 张格式未转换');
  els.progressText.textContent = parts.join(' · ');

  setTimeout(function () {
    els.progress.hidden = true;
  }, 4000);
}