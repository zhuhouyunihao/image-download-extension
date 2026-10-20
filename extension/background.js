/**
 * background.js — MV3 Service Worker
 * 职责：
 *   1) 接收 content script 的 EXTRACT_PAGE 请求
 *   2) 使用 chrome.scripting.executeScript 在所有 frame 中执行提取函数
 *   3) 合并 / 去重 / 写入 chrome.storage.session
 *   4) 打开 gallery 结果页
 * 注意：SW 可能随时被回收，所有状态均写入 storage，不使用模块级全局变量。
 */

'use strict';

// 允许 content script 读取 session 存储（本项目实际不依赖，但保留以兼容文档约束）
chrome.storage.session
  .setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
  .catch(() => {});

/* ============================================================
 * 平台配置（配置化，新增平台只需在此追加一项）
 * ============================================================ */
const PLATFORMS = {
  taobao: {
    id: 'taobao',
    hosts: ['item.taobao.com', 'detail.tmall.com'],
    minDimension: 100,
    includeBackground: false,
    lazyAttrs: ['data-src', 'data-ks-lazyload', 'data-original', 'data-lazy-img', 'data-lazyload'],
    selectors: {
      main: [
        '.tb-main-pic img',
        '#J_ImgBooth',
        '.tb-gallery img',
        '[class*="mainPic"] img',
        '[class*="MainPic"] img',
        '[class*="PicGallery"] img'
      ],
      sku: [
        '.tb-sku .tb-img img',
        '[class*="sku"] img',
        '[class*="Sku"] img'
      ],
      detail: [
        '#description img',
        '#J_DivItemDesc img',
        '#J_DivItemDesc .detail img',
        '[class*="desc"] img',
        '[class*="Detail"] img'
      ]
    },
    normalizeRules: [
      { pattern: '_\\d+x\\d+.*(\\.(?:jpg|jpeg|png|webp|gif))', flags: 'i', replacement: '$1' }
    ]
  },
  jd: {
    id: 'jd',
    hosts: ['item.jd.com'],
    minDimension: 100,
    includeBackground: false,
    lazyAttrs: ['data-lazyload', 'data-src', 'data-original', 'src'],
    selectors: {
      main: [
        '#spec-img',
        '.spec-img img',
        '#preview img',
        '[class*="main-img"] img'
      ],
      sku: [
        '#choose-attrs img',
        '.sku-img-list img',
        '[class*="sku"] img'
      ],
      detail: [
        '#J-detail-content img',
        '#detail .detail-content img',
        '[class*="detail"] img'
      ]
    },
    normalizeRules: [
      { pattern: 's\\d+x\\d+_jfs', flags: 'i', replacement: 'jfs' },
      { pattern: 'n\\d+', flags: 'i', replacement: '' }
    ]
  },
  pdd: {
    id: 'pdd',
    hosts: ['mobile.yangkeduo.com'],
    minDimension: 100,
    includeBackground: false,
    lazyAttrs: ['data-src', 'data-original', 'data-lazy', 'src'],
    selectors: {
      main: [
        '[class*="main"] img',
        '[class*="Main"] img',
        '[class*="banner"] img'
      ],
      sku: [
        '[class*="sku"] img',
        '[class*="Sku"] img'
      ],
      detail: [
        '[class*="detail"] img',
        '[class*="desc"] img'
      ]
    },
    normalizeRules: [
      { pattern: '\\?imageView2/2/w/\\d+/h/\\d+', flags: 'i', replacement: '' }
    ]
  }
};

/* ============================================================
 * 在目标 frame 内执行的提取函数（必须自包含，禁止外部引用）
 * ============================================================ */
function extractInFrame(config) {
  'use strict';
  const minDim = (config && config.minDimension) || 100;
  const lazyAttrs = (config && config.lazyAttrs) || ['data-src', 'data-original'];
  const selectors = (config && config.selectors) || {};
  const normalizeRules = (config && config.normalizeRules) || [];

  const out = [];
  const seen = new Set();
  let filteredOut = 0;

  function abs(u) {
    try {
      return new URL(u, location.href).href;
    } catch (e) {
      return '';
    }
  }

  function pickSrcset(s) {
    const parts = s.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    let best = '';
    let bestScore = -1;
    for (const p of parts) {
      const bits = p.split(/\s+/);
      const url = bits[0];
      const desc = bits[1] || '1x';
      let score = 1;
      if (desc.charAt(desc.length - 1) === 'w') score = parseFloat(desc) || 1;
      else score = (parseFloat(desc) || 1) * 1000;
      if (score > bestScore) {
        bestScore = score;
        best = abs(url);
      }
    }
    return best;
  }

  function normalize(u) {
    let n = u;
    for (const r of normalizeRules) {
      try {
        n = n.replace(new RegExp(r.pattern, r.flags || ''), r.replacement);
      } catch (e) { /* 规则非法则跳过 */ }
    }
    return n;
  }

  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  function add(rawUrl, source, w, h) {
    if (!rawUrl) return;
    if (!/^https?:/i.test(rawUrl)) return;
    const id = hash(normalize(rawUrl));
    if (seen.has(id)) return;
    seen.add(id);
    out.push({
      id: id,
      url: rawUrl,
      thumbnailUrl: rawUrl,
      rawUrl: rawUrl,
      source: source,
      width: w || null,
      height: h || null,
      order: out.length
    });
  }

  function resolveImgUrl(img) {
    let url = img.currentSrc || img.src || '';
    for (const attr of lazyAttrs) {
      const v = img.getAttribute(attr);
      if (v) { url = abs(v); break; }
    }
    const srcset = img.getAttribute('srcset');
    if (srcset) {
      const b = pickSrcset(srcset);
      if (b) url = b;
    }
    return url;
  }

  function tooSmall(img) {
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if ((w && w < minDim) || (h && h < minDim)) {
      filteredOut++;
      return true;
    }
    return false;
  }

  // 1) 平台专用选择器（主图 / SKU / 详情）
  const handled = new Set();
  ['main', 'sku', 'detail'].forEach(function (src) {
    const list = selectors[src] || [];
    for (const sel of list) {
      let nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch (e) {
        continue;
      }
      nodes.forEach(function (el) {
        const img = el.tagName === 'IMG' ? el : el.querySelector('img');
        if (!img || handled.has(img)) return;
        handled.add(img);
        const url = resolveImgUrl(img);
        if (!url) return;
        if (tooSmall(img)) return;
        add(url, src, img.naturalWidth, img.naturalHeight);
      });
    }
  });

  // 2) 启发式兜底：其余所有 <img>
  document.querySelectorAll('img').forEach(function (img) {
    if (handled.has(img)) return;
    const url = resolveImgUrl(img);
    if (!url) return;
    if (tooSmall(img)) return;
    let source = 'detail';
    const anc = img.closest('[class*="sku"],[class*="Sku"],[class*="main"],[class*="Main"]');
    if (anc) {
      const cls = (anc.className || '').toString();
      if (/sku/i.test(cls)) source = 'sku';
      else if (/main/i.test(cls)) source = 'main';
    }
    add(url, source, img.naturalWidth, img.naturalHeight);
  });

  // 3) 背景图
  if (config && config.includeBackground) {
    document.querySelectorAll('[style*="background-image"]').forEach(function (el) {
      const style = el.getAttribute('style') || '';
      const m = style.match(/url\(['"]?([^'")]+)['"]?\)/);
      if (m) add(abs(m[1]), 'background', null, null);
    });
  }

  return { images: out, filteredOut: filteredOut };
}

/* ============================================================
 * 工具函数
 * ============================================================ */
function detectPlatform(url) {
  try {
    const u = new URL(url);
    for (const id of Object.keys(PLATFORMS)) {
      const cfg = PLATFORMS[id];
      if (cfg.hosts.some(function (h) {
        return u.hostname === h || u.hostname.endsWith('.' + h);
      })) return id;
    }
  } catch (e) { /* ignore */ }
  return null;
}

function extractProductId(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get('id') || u.searchParams.get('sku') || null;
  } catch (e) {
    return null;
  }
}

/* ============================================================
 * 主流程：提取
 * ============================================================ */
async function handleExtract(tabId, pageUrl, pageTitle) {
  const platformId = detectPlatform(pageUrl);
  if (!platformId) {
    return { ok: false, error: '当前页面不在支持的电商平台中' };
  }
  const cfg = PLATFORMS[platformId];

  let scriptResults;
  try {
    scriptResults = await chrome.scripting.executeScript({
      target: { tabId: tabId, allFrames: true },
      func: extractInFrame,
      args: [cfg]
    });
  } catch (e) {
    return { ok: false, error: '页面脚本注入失败：' + String(e) };
  }

  const seen = new Set();
  const images = [];
  let filteredOut = 0;
  const bySource = { main: 0, sku: 0, detail: 0, background: 0 };

  (scriptResults || []).forEach(function (r) {
    const res = r.result;
    if (!res || !Array.isArray(res.images)) return;
    filteredOut += res.filteredOut || 0;
    for (const img of res.images) {
      if (seen.has(img.id)) continue;
      seen.add(img.id);
      img.frameId = r.frameId;
      images.push(img);
      bySource[img.source] = (bySource[img.source] || 0) + 1;
    }
  });

  const result = {
    sessionId: 'sess_' + Date.now().toString(36),
    platformId: platformId,
    pageUrl: pageUrl,
    pageTitle: pageTitle || '',
    productId: extractProductId(pageUrl),
    images: images,
    stats: {
      total: images.length,
      bySource: bySource,
      filteredOut: filteredOut,
      scanDurationMs: 0,
      timedOut: false
    },
    extractedAt: Date.now()
  };

  await chrome.storage.session.set({ latest: result });
  return { ok: true, result: result };
}

/* ============================================================
 * 消息路由
 * ============================================================ */
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;

  if (msg.type === 'EXTRACT_PAGE') {
    if (!sender.tab || sender.tab.id == null) {
      sendResponse({ ok: false, error: '无法获取标签页 ID' });
      return false;
    }
    handleExtract(sender.tab.id, msg.pageUrl, msg.pageTitle)
      .then(sendResponse)
      .catch(function (e) {
        sendResponse({ ok: false, error: String(e) });
      });
    return true; // 异步响应
  }

  if (msg.type === 'OPEN_GALLERY') {
    chrome.tabs.create({ url: chrome.runtime.getURL('gallery.html') }).catch(function (e) {
      sendResponse({ ok: false, error: String(e) });
    });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});