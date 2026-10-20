/**
 * content.js — 内容脚本（所有 frame 注入，仅顶层 frame 挂按钮）
 * 职责：
 *   1) 顶层 frame 注入右下角悬浮按钮（Shadow DOM 隔离）
 *   2) 点击后执行受控滚动扫描触发懒加载
 *   3) 请求 background 执行跨 frame 提取，然后打开结果页
 */

(function () {
  'use strict';

  // 仅顶层 frame 挂 UI，子 frame 不参与
  if (window !== window.top) return;

  const HOST_ID = '__ecom_ext_btn_host__';
  const state = { busy: false, mounted: false };

  /* ---------- 工具 ---------- */
  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function raf2() {
    return new Promise(function (resolve) {
      requestAnimationFrame(function () { requestAnimationFrame(resolve); });
    });
  }

  function sendMessage(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (resp) {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(resp || { ok: false, error: '空响应' });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  /* ---------- 受控滚动扫描（触发懒加载） ---------- */
  async function scrollScan(opts) {
    const timeoutMs = (opts && opts.timeoutMs) || 12000;
    const maxSteps = (opts && opts.maxSteps) || 60;
    const startedAt = Date.now();
    const startY = window.scrollY;
    const el = document.scrollingElement || document.documentElement;
    const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
    let steps = 0;
    let timedOut = false;

    while (steps < maxSteps) {
      if (Date.now() - startedAt > timeoutMs) {
        timedOut = true;
        break;
      }
      const before = el.scrollTop;
      // 必须使用瞬时滚动，smooth 会跳过 IntersectionObserver 回调
      window.scrollTo(0, before + step);
      await raf2();
      await sleep(120);
      steps++;
      const after = el.scrollTop;
      if (after === before) {
        // 到底了，再等一次确认是否有懒加载内容补充
        await sleep(300);
        if (el.scrollTop === before) break;
      }
    }
    // 恢复原始滚动位置
    window.scrollTo(0, startY);
    await sleep(200);
    return { steps: steps, timedOut: timedOut, durationMs: Date.now() - startedAt };
  }

  /* ---------- 悬浮按钮（Shadow DOM） ---------- */
  const BUTTON_STYLES = `
    :host { all: initial; }
    .ext-btn {
      all: initial;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 0 18px;
      height: 44px;
      border-radius: 10px;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
      font-size: 14px;
      font-weight: 500;
      color: #ffffff;
      background: rgba(31, 41, 55, 0.92);
      border: 1px solid rgba(255, 255, 255, 0.12);
      cursor: pointer;
      user-select: none;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
      transition: background 0.15s ease, transform 0.1s ease, opacity 0.15s ease;
      opacity: 0.92;
    }
    .ext-btn:hover { background: #111827; opacity: 1; }
    .ext-btn:active { transform: scale(0.97); }
    .ext-btn:disabled { cursor: progress; opacity: 0.75; }
    .ext-icon {
      width: 16px; height: 16px;
      display: inline-block;
      background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='3' width='18' height='18' rx='2'/><circle cx='8.5' cy='8.5' r='1.5'/><path d='M21 15l-5-5L5 21'/></svg>");
      background-size: contain;
      background-repeat: no-repeat;
    }
    .ext-btn[data-state="scanning"] .ext-icon {
      background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='2' stroke-linecap='round'><path d='M21 12a9 9 0 1 1-6.2-8.5'/></svg>");
      animation: ext-spin 0.9s linear infinite;
    }
    .ext-btn[data-state="done"] { background: #059669; }
    .ext-btn[data-state="error"] { background: #dc2626; }
    @keyframes ext-spin { to { transform: rotate(360deg); } }
  `;

  function setButtonState(stateName, label) {
    const host = document.getElementById(HOST_ID);
    if (!host || !host.shadowRoot) return;
    const btn = host.shadowRoot.querySelector('.ext-btn');
    if (!btn) return;
    btn.dataset.state = stateName;
    btn.disabled = stateName === 'scanning';
    const lbl = btn.querySelector('.ext-label');
    if (lbl) lbl.textContent = label || '获取图片';
  }

  function mountButton() {
    if (document.getElementById(HOST_ID)) return;

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText =
      'position:fixed;right:24px;bottom:24px;z-index:2147483647;display:block;';

    const shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = BUTTON_STYLES;

    const btn = document.createElement('button');
    btn.className = 'ext-btn';
    btn.type = 'button';
    btn.dataset.state = 'idle';

    const icon = document.createElement('span');
    icon.className = 'ext-icon';

    const label = document.createElement('span');
    label.className = 'ext-label';
    label.textContent = '获取图片';

    btn.appendChild(icon);
    btn.appendChild(label);
    btn.addEventListener('click', onExtractClick);

    shadow.appendChild(style);
    shadow.appendChild(btn);

    // 等待页面首屏渲染完成后再出现，减少视觉干扰
    setTimeout(function () {
      if (!document.body.contains(host)) document.body.appendChild(host);
      state.mounted = true;
    }, 1200);
  }

  /* ---------- 点击主流程 ---------- */
  async function onExtractClick() {
    if (state.busy) return;
    state.busy = true;
    setButtonState('scanning', '正在扫描页面…');

    try {
      const scan = await scrollScan({ timeoutMs: 12000, maxSteps: 60 });

      const resp = await sendMessage({
        type: 'EXTRACT_PAGE',
        pageUrl: location.href,
        pageTitle: document.title
      });

      if (!resp || !resp.ok) {
        throw new Error((resp && resp.error) || '提取失败');
      }

      const total = resp.result && resp.result.stats ? resp.result.stats.total : 0;
      if (scan.timedOut && resp.result && resp.result.stats) {
        resp.result.stats.timedOut = true;
        resp.result.stats.scanDurationMs = scan.durationMs;
        // 二次写入，让结果页能提示"可能未完整"
        chrome.storage.session.set({ latest: resp.result }).catch(function () {});
      }

      setButtonState('done', '已获取 ' + total + ' 张');

      await sendMessage({ type: 'OPEN_GALLERY' });

      setTimeout(function () {
        setButtonState('idle', '获取图片');
        state.busy = false;
      }, 1600);
    } catch (e) {
      console.error('[电商图片提取]', e);
      setButtonState('error', '提取失败，请重试');
      setTimeout(function () {
        setButtonState('idle', '获取图片');
        state.busy = false;
      }, 1800);
    }
  }

  /* ---------- 初始化与 SPA 场景自愈 ---------- */
  function boot() {
    mountButton();

    // 监听按钮宿主被页面框架移除（SPA 路由切换），自动重新挂载
    const observer = new MutationObserver(function () {
      if (!document.getElementById(HOST_ID) && document.body) {
        mountButton();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();