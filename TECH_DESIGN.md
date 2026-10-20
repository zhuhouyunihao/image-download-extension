TECH_DESIGN.md — 电商详情页图片提取下载插件技术设计文档
对应 PRD：V1.0
文档版本：V1.0
架构定性：纯客户端 Chrome 扩展（Manifest V3），无服务端、无数据库

0. 架构定性说明（先回答"后端/数据库用什么"）
PRD 明确要求"所有处理在浏览器本地完成，不向任何远程服务器发送数据"。因此本项目的技术栈不存在传统意义上的后端与数据库，这是有意为之的架构决策，而非缺失：

传统角色	本项目的替代物	职责
后端服务	Service Worker（MV3 后台）	消息路由、下载任务编排、跨上下文状态协调
数据库	chrome.storage.session / local + 内存队列	会话级提取结果、用户偏好、运行时下载状态
文件存储	用户本地下载目录（经 chrome.downloads）	PNG 落盘
不引入服务端的收益：无需服务器成本与运维、隐私合规风险低（无数据出境）、Chrome 商店审核更容易通过（不申请远程通信权限）、离线可用。代价是：无法做跨设备同步、无法做服务端图片处理（如超大图压缩）、平台选择器更新只能靠插件版本迭代（通过配置化 + 灰度发版缓解）。

1. 技术栈选择
1.1 前端（扩展 UI 层）
类别	选型	理由
语言	TypeScript 5.x（strict: true）	多平台选择器、消息协议、图片数据结构都需要类型约束，这是本项目最容易出错的地方
UI 框架	Preact 10 + preact/hooks	压缩后约 3–4KB，远小于 React；结果页只需网格 + 灯箱 + 进度条，不需要重型组件库
构建工具	WXT（备选 CRXJS + Vite）	WXT 基于 Vite，约定式 entrypoints（entrypoints/content.ts、entrypoints/background.ts、entrypoints/result/index.html），内置 MV3 支持、HMR、多浏览器产物；相比 CRXJS 维护更活跃，且天然支持 content script 的 allFrames、matches 声明。若团队坚持 PRD 中的 CRXJS，目录结构可保持本文档设计，仅入口声明方式不同
样式	原生 CSS + CSS Modules（结果页）、Shadow DOM + 内联样式（悬浮按钮）	不引入 Tailwind/UnoCSS 以控制产物体积；悬浮按钮必须走 Shadow DOM 隔离，防止被电商页面全局 CSS 污染
状态管理	Preact signals（结果页内）	结果页状态简单（列表、选中集、筛选、进度），无需 Redux
虚拟滚动	@tanstack/virtual-core（约 3KB）或自写分批渲染	PRD 要求 150+ 图不卡顿
图标	内联 SVG	避免字体/图片资源
1.2 "后端"（MV3 Service Worker）
纯 TypeScript，无框架。

职责边界（重要，避免过度设计）：

做：接收 content script 的提取结果并写入 storage.session；打开结果页；封装 chrome.downloads.download 的调用与并发队列；监听 downloads.onChanged 维护任务状态。

不做：不做图片解码与 PNG 转换（SW 生命周期不稳定，且 Blob 跨上下文传递有坑，见 §4.3）。

生命周期应对：MV3 SW 空闲约 30s 被终止，因此长耗时任务（图片转换）放在结果页执行，SW 只做短事件处理，避免依赖 keepalive hack。

1.3 "数据库"（本地持久层）
存储	用途	容量/生命周期	备注
chrome.storage.session	单次提取结果（图片 URL 列表 + 元数据）	默认 10MB，浏览器会话级，标签页/浏览器关闭清除	需调用 setAccessLevel('TRUSTED_AND_UNTRUSTED_CONTEXTS') 才能让 content script 读取
chrome.storage.local	用户偏好（筛选默认值、命名模板、平台开关）	10MB（可申请 unlimitedStorage）	数据极小，几十字节
内存 Map（结果页）	选中集、下载任务运行时状态、Blob 缓存	页面关闭即释放	逐张处理，不缓存全部原图
IndexedDB	MVP 不引入	—	仅当后续支持"关闭结果页后继续下载"或大图缓存时才需要
结论：本项目不需要服务端数据库；chrome.storage 即是数据层，数据量级为 KB 级。

1.4 测试与质量
类型	工具	覆盖对象
单元测试	Vitest	url-normalizer、srcset 解析、去重、文件名生成、选择器匹配函数（喂 HTML 快照）
端到端冒烟	Playwright + 持久化 storageState（真实登录态）	三平台各一个固定商品页：断言提取数 ≥ 阈值、下载产物为合法 PNG
静态检查	ESLint + tsc --noEmit	—
2. 项目结构
采用单包（single package）+ pnpm，不引入 monorepo 复杂度。

text
ecom-image-extractor/
├── entrypoints/                      # WXT 约定目录
│   ├── background.ts                 # Service Worker 入口
│   ├── content.ts                    # Content Script 入口（注入按钮 + 监听触发）
│   └── result/
│       ├── index.html                # 结果页（扩展页面，新标签页打开）
│       └── main.tsx
├── src/
│   ├── shared/                       # 三端共享，禁止依赖 DOM 专有逻辑
│   │   ├── types.ts                  # 全部数据模型（见 §3）
│   │   ├── messages.ts               # 消息协议常量 + 类型化收发封装
│   │   ├── storage.ts                # storage.session/local 读写封装
│   │   ├── constants.ts              # 并发数、超时、尺寸阈值等
│   │   └── filename.ts               # 文件名模板与冲突规避
│   │
│   ├── platforms/                    # 平台适配层（配置化，与核心逻辑解耦）
│   │   ├── index.ts                  # 按 location 匹配平台，导出 PlatformAdapter
│   │   ├── types.ts                  # PlatformAdapter 接口
│   │   ├── taobao.ts                 # 淘宝/天猫：选择器、iframe 规则、CDN 归一化
│   │   ├── jd.ts                     # 京东
│   │   └── pdd.ts                    # 拼多多
│   │
│   ├── extractor/                    # 提取核心（运行在 content script / 各 frame）
│   │   ├── index.ts                  # 编排：滚动扫描 → 采集 → 过滤 → 归一化 → 去重
│   │   ├── scroll-scanner.ts         # 懒加载触发（IntersectionObserver + 受控滚动）
│   │   ├── dom-collector.ts          # img/srcset/背景图采集 + 平台选择器匹配
│   │   ├── frame-collector.ts        # iframe 穿透合并
│   │   ├── srcset.ts                 # srcset 解析取最大候选
│   │   ├── url-normalizer.ts         # CDN 尺寸后缀剥离、协议相对 URL 统一
│   │   └── filter.ts                 # 图标/占位图/极小图过滤
│   │
│   ├── content-ui/                   # 悬浮按钮
│   │   ├── mount.ts                  # Shadow DOM 挂载 + 位置/层级处理
│   │   └── Button.tsx                # 状态机：idle / scanning / done / error
│   │
│   ├── background/
│   │   ├── router.ts                 # 消息路由分发
│   │   ├── session-store.ts          # 提取结果落 storage.session + 打开结果页
│   │   └── download-queue.ts         # 并发队列（默认 4）+ downloads.onChanged 状态维护
│   │
│   └── result/                       # 结果页 UI 与下载闭环
│       ├── App.tsx
│       ├── components/
│       │   ├── Toolbar.tsx           # 全选/清空/筛选/下载
│       │   ├── ImageGrid.tsx         # 虚拟滚动网格
│       │   ├── ImageCard.tsx
│       │   ├── Lightbox.tsx
│       │   ├── ProgressBar.tsx
│       │   └── EmptyState.tsx
│       ├── hooks/
│       │   ├── useSelection.ts
│       │   └── useDownload.ts
│       └── download/
│           ├── png-converter.ts      # fetch → createImageBitmap → OffscreenCanvas → PNG Blob
│           └── downloader.ts         # Blob → objectURL → chrome.downloads.download
│
├── tests/
│   ├── unit/
│   └── e2e/
├── public/icons/
├── wxt.config.ts
├── tsconfig.json
└── package.json
分层约束（Code Review 检查项）：

shared/ 不得 import extractor/ 或 result/；

extractor/ 不得 import Preact —— 它是纯 DOM 逻辑，必须可单测；

平台差异只能出现在 platforms/*.ts，禁止在 dom-collector.ts 里写 if (host === 'jd.com')；

result/ 不直接操作 DOM 提取，只消费 storage.session 中的数据。

3. 数据模型
全部定义在 src/shared/types.ts。以下为权威定义。

3.1 平台配置
ts
export type PlatformId = 'taobao' | 'jd' | 'pdd';

export interface PlatformConfig {
  id: PlatformId;
  /** location.href 匹配正则 */
  urlPatterns: RegExp[];
  /** 需要追加 host_permissions 的图片 CDN 域 */
  imageCdnHosts: string[];
  /** 需要穿透的 iframe 源域（用于 allFrames 注入判断） */
  iframeHosts?: string[];
  selectors: {
    main: string[];        // 主图，按优先级
    sku: string[];         // SKU 图
    detail: string[];      // 详情图
  };
  /** 懒加载真实 URL 的属性名，按优先级 */
  lazyAttrs: string[];
  /** URL 归一化规则：将多尺寸版本映射回原图标识 */
  normalizeRules: NormalizeRule[];
  /** 是否使用背景图作为图源 */
  includeBackgroundImage: boolean;
}

export interface NormalizeRule {
  /** 如 alicdn 的 /_\d+x\d+\.(jpg|png|webp)$/ 尺寸后缀 */
  pattern: RegExp;
  replacement: string;
}
3.2 提取结果（跨上下文传输的主数据）
ts
export type ImageSource = 'main' | 'sku' | 'detail' | 'background';

export interface ExtractedImage {
  /** 稳定 ID：对归一化 URL 做 hash，用于去重与选中集 key */
  id: string;
  /** 归一化后的原图 URL（实际下载目标） */
  url: string;
  /** 展示用缩略图 URL（可与 url 相同；若平台提供缩略图可优先用） */
  thumbnailUrl: string;
  /** 在 DOM 中出现时的原始 URL，便于排查 */
  rawUrl: string;
  source: ImageSource;
  /** 若能从 DOM 属性/自然尺寸获取则填充，未知为 null */
  width: number | null;
  height: number | null;
  /** 来自哪个 frame（0 = 主文档），排查用 */
  frameId: number;
  /** 采集顺序，用于稳定排序 */
  order: number;
}

export interface ExtractResult {
  /** 会话 ID，结果页凭此从 storage.session 取数据 */
  sessionId: string;
  platformId: PlatformId;
  pageUrl: string;
  pageTitle: string;
  /** 商品 ID（尽力提取，取不到为 null） */
  productId: string | null;
  images: ExtractedImage[];
  /** 统计信息，用于结果页提示"疑似不完整" */
  stats: {
    total: number;
    bySource: Record<ImageSource, number>;
    filteredOut: number;      // 被尺寸/占位图规则过滤的数量
    scanDurationMs: number;
    timedOut: boolean;        // 滚动扫描是否超时
  };
  extractedAt: number;        // epoch ms
}
3.3 下载任务
ts
export type DownloadStatus =
  | 'pending'
  | 'converting'    // 正在做 PNG 转换
  | 'downloading'
  | 'success'
  | 'failed'
  | 'fallback';     // 转换失败，已降级保存原图

export interface DownloadTask {
  imageId: string;
  status: DownloadStatus;
  /** chrome.downloads 返回的 downloadId */
  downloadId?: number;
  /** 失败原因，直接展示给用户 */
  error?: string;
  /** 转换后的字节数，用于 UI 展示 */
  bytes?: number;
  startedAt: number;
  finishedAt?: number;
}

export interface DownloadBatch {
  batchId: string;
  sessionId: string;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  fallbackCount: number;
  status: 'running' | 'done' | 'cancelled';
}
3.4 用户偏好
ts
export interface UserPreferences {
  /** 结果页默认筛选来源 */
  defaultSourceFilter: ImageSource | 'all';
  /** 小于该宽/高的图片在提取阶段直接过滤 */
  minDimension: number;          // 默认 100
  /** 下载文件名模板，支持 {platform} {productId} {source} {index} */
  filenameTemplate: string;      // 默认 '{platform}_{productId}_{index}'
  /** 下载并发数 1–8 */
  concurrency: number;           // 默认 4
  /** 滚动扫描最大时长（ms） */
  scanTimeoutMs: number;         // 默认 12000
  /** 平台开关，用于出问题时临时关闭某平台 */
  enabledPlatforms: Record<PlatformId, boolean>;
}
3.5 消息协议
所有跨上下文通信收敛到这一张表，禁止散落的裸 sendMessage。

ts
export type Message =
  // content → background
  | { type: 'EXTRACT_DONE'; payload: ExtractResult }
  | { type: 'EXTRACT_FAILED'; payload: { reason: string; pageUrl: string } }
  // background → result（通过 storage.session 传递，不直发消息）
  // result → background
  | { type: 'DOWNLOAD_BATCH_START'; payload: { batchId: string; items: DownloadItem[] } }
  | { type: 'DOWNLOAD_CANCEL'; payload: { batchId: string } }
  // background → result（进度推送，result 侧用 onMessage 监听）
  | { type: 'DOWNLOAD_PROGRESS'; payload: DownloadBatch };

export interface DownloadItem {
  imageId: string;
  filename: string;   // 已含 .png 后缀
  blobUrl: string;    // 由结果页创建的 object URL
}
关键设计决策：结果页与 background 之间的"提取结果"不通过 sendMessage 传输，而是写 storage.session 再读。原因：图片列表可能上百条、单条含多个 URL，消息体量较大且 background 可能在传输中途被回收，storage.session 更可靠且天然支持结果页刷新后恢复。

4. 关键技术点
按风险从高到低排列。§4.1–4.4 是 MVP 能否成立的生死线。

4.1 跨域图片转 PNG（最高风险）
问题：电商图片在 CDN 域（img.alicdn.com、360buyimg.com、pddpic.com）。传统做法 <img crossOrigin="anonymous"> → drawImage → toBlob，一旦 CDN 响应缺少 Access-Control-Allow-Origin 头，canvas 被污染，toBlob 直接抛 SecurityError。

正确方案（绕开 canvas taint 而非对抗它）：

ts
async function toPngBlob(url: string, signal: AbortSignal): Promise<Blob> {
  // 1. 在扩展页面上下文中 fetch：命中 host_permissions 的域不受 CORS 限制
  const resp = await fetch(url, { signal, credentials: 'omit', cache: 'force-cache' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const rawBlob = await resp.blob();

  // 2. 从本地 Blob 解码，来源同源，天然不污染
  const bitmap = await createImageBitmap(rawBlob);

  // 3. OffscreenCanvas 转 PNG
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  return canvas.convertToBlob({ type: 'image/png' });
}
要点：

扩展页面（结果页）在 host_permissions 覆盖的域上 fetch 不受 CORS 约束，这是整个方案成立的前提；

createImageBitmap(blob) 解码的是本地数据，drawImage 不产生 taint，因此 convertToBlob 必然成功；

必须 bitmap.close() 释放内存，否则批量处理百张图会明显涨内存；

credentials: 'omit' 避免带 cookie 触发部分 CDN 的防盗链逻辑；

不要用 <img> + crossOrigin 走 canvas 的老路。

降级链路（逐级 fallback，任一成功即止）：

fetch + OffscreenCanvas 转 PNG → success；

失败则尝试 fetch 原始 Blob，直接以 .png 后缀下载（内容为原格式）→ 标记 fallback，UI 明确提示"格式未转换"；

再失败（403/超时/失效）→ failed，提供单张重试。

为什么放在结果页而不是 Service Worker：结果页是有 DOM 的扩展页面，fetch 的 host_permissions 生效、OffscreenCanvas 可用、Blob 无需跨上下文传输；且不会因 SW 空闲被终止而中断。代价是结果页关闭即中断下载——PRD 未要求后台续传，接受此约束。

体积风险：PNG 无损，一张 1000×1000 的 JPEG（约 150KB）转 PNG 后可能 1–2MB。这对批量下载是显著的成本，需在 PRD 后续版本评估"PNG + 可选质量参数"或提示用户。MVP 严格按需求输出 PNG。

4.2 懒加载触发（决定"抓得全不全"）
问题：详情长图大量依赖 IntersectionObserver / 滚动事件懒加载，直接遍历 DOM 只能拿到已加载的少量图片。

方案：scroll-scanner.ts 执行受控扫描：

text
记录 scrollY → 以视口 0.8 倍为步长向下滚动 → 每步 await rAF×2 + 120ms 静置
→ 触底后回滚到原位置 → 等待网络空闲（最多 1.5s）
必须处理的细节：

滚动容器识别：淘宝/京东详情页有时不是 window 滚动，而是内部 overflow: auto 容器。通过 document.scrollingElement 与对目标容器的 scrollHeight > clientHeight 探测确定滚动目标；

节流与可中断：用 requestAnimationFrame + setTimeout 节流；用户点击按钮后若切换到其他标签页（document.visibilityState === 'hidden'），浏览器会节流 rAF，此时改为直接跳步滚动；

超时保护：整体扫描受 scanTimeoutMs（默认 12s）约束，超时即停止并在 stats.timedOut = true，结果页提示"可能未加载完整，建议滚动后重试"；

不动 window.scrollTo({ behavior: 'smooth' })：平滑滚动会导致 IntersectionObserver 回调被跳过，必须瞬时 scrollTo；

禁止无限滚动：拼多多等页面可能有瀑布流，设定最大滚动步数（如 60 步）兜底。

4.3 iframe 穿透与多 frame 聚合
问题：淘宝/天猫详情图常位于 desc 相关的跨域 iframe 中，主文档遍历拿不到。

方案：

Content script 以 allFrames: true 注入（WXT 中配置 matches + allFrames）；

每个 frame 独立执行 dom-collector，然后仅由 frameId === 0 的主 frame 汇总：子 frame 通过 chrome.runtime.sendMessage 上报各自结果，主 frame 收集后统一归一化、去重、落库；

需在 host_permissions 中显式声明 desc.alicdn.com、dsc.taobaocdn.com 等详情 iframe 域，否则无法注入；

汇总设等待窗口（如 800ms 或收到预期 frame 数），避免主 frame 提前触发导致漏图。

注意：不要用 window.postMessage 跨 frame 通信——跨域 iframe 的 origin 校验繁琐且易被页面脚本干扰，扩展消息通道更安全。

4.4 URL 归一化与去重（决定"选得准不准"）
同一张图通常有多个 CDN 尺寸版本，不归一化会出现 60x60 缩略图与原图并存、重复下载。

规则（写入 PlatformConfig.normalizeRules）：

淘宝/天猫：剥离 /_\d+x\d+.*\.(jpg|png|webp)$ 形式的尺寸后缀；srcset 取最大 w 描述符；

京东：s800x800_jfs/、n5/ 等路径段归一化；

拼多多：剥离 ?imageView2/2/w/\d+/h/\d+ 查询参数。

去重键：normalize(url) 后做 FNV-1a 或 SHA-256 取前 16 位作为 ExtractedImage.id。碰撞概率可忽略，且即使碰撞也只影响极少图片的合并。不使用原始 URL 去重（尺寸不同会被当不同图）。

副作用警告：部分平台的"原图"URL 剥离后缀后会 404（只有带后缀的才有效）。因此归一化只用于生成去重 ID，实际下载仍用"采集到的最高分辨率 URL"，并在结果页把 rawUrl 保存在模型里，便于失败时回溯。

4.5 下载并发、文件名与失败重试
并发队列上限默认 4（可配 1–8）。过高会触发 CDN 限速（尤其 pddpic.com）；

文件名由 shared/filename.ts 生成：{platform}_{productId|title截断}_{source}_{index}.png，对非法字符 \ / : * ? " < > | 做替换，长度截断至 100 字符（chrome.downloads 对 filename 有长度限制）；

同名冲突交给 Chrome 自动加 (1)，不使用 onDeterminingFilename（该 API 需要额外权限且行为在批量场景下不稳定）；

单张失败不影响批次，失败项可单张或批量重试；重试走同一 toPngBlob 链路；

objectUrl 用完必须 URL.revokeObjectURL，否则 Blob 常驻内存。

4.6 悬浮按钮的样式隔离与层级
用 Shadow DOM（attachShadow({ mode: 'closed' })）+ 内部 :host { all: initial } 切断继承样式；

容器 position: fixed; right: 24px; bottom: 24px; z-index: 2147483647（最大安全值）；

监听电商页面的动态 DOM 变化（MutationObserver on body）：若按钮宿主节点被页面框架移除（SPA 路由切换），自动重新挂载；

按钮状态机：idle → scanning（禁用 + 旋转指示）→ done（短暂显示"已获取 N 张"）→ idle，防止重复点击。

4.7 Service Worker 生命周期与消息可靠性
SW 可能在任何时刻被回收，禁止在 SW 全局变量里保存业务状态；所有状态写 storage.session；

所有 sendMessage 调用必须 try/catch：SW 未唤醒时首条消息可能抛 Could not establish connection，实现一个 sendWithRetry（最多 2 次，间隔 50ms）；

长任务（转换）在结果页，SW 只处理短事件，因此不需要 keepalive；

打开结果页使用 chrome.tabs.create({ url: chrome.runtime.getURL('result.html') })，不在 popup 中做（popup 失焦即销毁，无法承载网格交互）。

4.8 storage.session 的访问权限坑
默认 chrome.storage.session 仅扩展页面可读，content script 访问会得到空对象。若提取结果由 content script 直接写入，必须在 SW 启动时调用：

ts
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
否则 content script 写入成功但结果页读取失败——这是 MV3 中极易踩的静默 bug，建议加单测覆盖。

4.9 虚拟滚动与预览性能
网格使用虚拟滚动，只渲染视口内 ±1 屏的卡片；

缩略图 loading="lazy" + decoding="async"；

灯箱预览用原图 URL，加载期间显示骨架；预加载相邻 1 张；

选中集用 Set<string>（imageId），"全选"只作用于当前筛选结果，避免误选隐藏项。

4.10 平台改版的持续适配（长期工程风险）
所有选择器、CDN 域、归一化规则收敛在 platforms/*.ts，改版时只改配置；

extractor/index.ts 内置健康度自检：若主图命中 0 张或详情图命中 0 张，返回 stats 标记异常，结果页显示"本次提取可能不完整"提示，而不是静默成功；

每次发版前跑三平台 Playwright 冒烟（断言主图 ≥1、SKU ≥1、详情 ≥1），CI 中保留 HTML 快照做离线回归；

为紧急修复预留"平台开关"（UserPreferences.enabledPlatforms），可在服务端不介入的前提下通过配置下发（后续版本可用 chrome.storage.managed 由企业策略下发）。

4.11 安全与权限落地
manifest 权限清单（最小化）：

json
{
  "permissions": ["activeTab", "scripting", "downloads", "storage"],
  "host_permissions": [
    "*://item.taobao.com/*", "*://detail.tmall.com/*",
    "*://item.jd.com/*", "*://mobile.yangkeduo.com/*",
    "*://*.alicdn.com/*", "*://*.360buyimg.com/*", "*://*.pddpic.com/*",
    "*://desc.alicdn.com/*", "*://dsc.taobaocdn.com/*"
  ]
}
下载前对 URL 做协议白名单校验（仅 https: / http:），拒绝 javascript:、file:、非常规 data:；

不申请 <all_urls>、tabs、webRequest；

结果页对 pageTitle、productId 做 HTML 转义（Preact 默认转义，禁止 dangerouslySetInnerHTML）；

不引入任何分析 SDK；构建产物做一次依赖审计（pnpm audit + 检查无远程请求）。

4.12 已知技术债与后续演进
项	现状	后续
PNG 体积膨胀	严格无损转换	V1.1 增加"PNG / 原格式"二选一，默认仍 PNG
结果页关闭中断下载	接受	V1.2 用 chrome.offscreen + IndexedDB 支持后台续传
pHash 视觉去重	仅 URL 去重	V1.1 引入 dhash（canvas 缩至 9×8 灰度），成本低
拼多多反爬	尽力适配	单独跟踪，必要时用背景图 + 加密 URL 解密兜底
选择器线上热更新	随版本发布	V1.2 用 chrome.storage.managed 或签名配置下发
设计要点回顾：本方案的核心判断是三件事——PNG 转换必须走 fetch + createImageBitmap + OffscreenCanvas 以绕开 canvas taint、懒加载必须靠受控滚动真实触发、平台差异必须配置化以支撑长期维护。其余（UI、虚拟滚动、并发队列）都是成熟工程实践。无后端无数据库不是妥协，而是与"纯本地处理"的产品定位一致的成本最优解。