AGENTS.md
本文件面向在本仓库中工作的 AI 编码助手（Claude Code / Cursor / Codex 等）。开始任何任务前请完整阅读。它与 PRD.md、TECH_DESIGN.md 共同构成项目的事实来源；三者冲突时，以本文件的硬性约束为准，并在 PR 描述中说明冲突点。

1. 项目概述
是什么：Chrome 扩展（Manifest V3），在淘宝/天猫、京东、拼多多商家版商品详情页右下角注入「获取图片」按钮，提取页面全部商品图（主图 / SKU 图 / 详情图 / 背景图），在新标签页网格展示，用户勾选后批量下载，统一输出 PNG。

架构定性（务必牢记）：

没有后端，没有数据库，没有远程请求。所有处理在浏览器本地完成。

「后端」= MV3 Service Worker（仅做消息路由 + 下载队列）。

「数据库」= chrome.storage.session（会话结果）/ chrome.storage.local（用户偏好）。数据量 KB 级。

任何引入服务端、遥测 SDK、远程配置拉取的改动都是架构级变更，必须先获得人工确认，不得自行实现。

技术栈：TypeScript 5（strict）+ Preact 10 + WXT（Vite 基座）+ 原生 CSS/CSS Modules + Shadow DOM。测试用 Vitest + Playwright。

当前阶段：MVP（V1.0）。范围严格对齐 PRD「MVP 功能表」，表外功能（pHash 去重、ZIP 打包、自定义文件名 UI、多标签页聚合）默认不做，除非任务明确要求。

核心风险区（改动此处需格外谨慎，详见 §6）：跨域图片 PNG 转换、懒加载扫描、iframe 穿透、URL 归一化去重、平台选择器维护。

2. 常用命令
bash
pnpm install          # 安装依赖
pnpm dev              # WXT 开发模式（HMR，加载 .output/chrome-mv3-dev）
pnpm build            # 生产构建（.output/chrome-mv3）
pnpm zip              # 打包上传商店
pnpm typecheck        # tsc --noEmit，提交前必须通过
pnpm lint             # ESLint，提交前必须通过
pnpm test             # Vitest 单元测试
pnpm test:e2e         # Playwright 冒烟（需登录态 storageState，见 §7.3）
提交前本地必须全绿：pnpm typecheck && pnpm lint && pnpm test。

3. 项目结构与分层约束
text
entrypoints/          # WXT 约定入口：background.ts / content.ts / result/
src/shared/           # 三端共享：types / messages / storage / constants / filename
src/platforms/        # 平台适配层：taobao / jd / pdd + index 匹配
src/extractor/        # 提取核心（纯 DOM 逻辑，禁止依赖 Preact）
src/content-ui/       # 悬浮按钮（Shadow DOM）
src/background/       # SW：router / session-store / download-queue
src/result/           # 结果页 UI + 下载闭环（png-converter / downloader）
tests/unit/  tests/e2e/
硬性分层规则（Code Review 必查）：

src/shared/ 禁止 import extractor/、result/、content-ui/。它是最底层。

src/extractor/ 禁止 import Preact 或任何 UI 库。它是纯 DOM 逻辑，必须可被 Vitest 在 Node 环境单测。

平台差异只能写在 src/platforms/*.ts。在 extractor/、background/、result/ 中出现 if (hostname.includes('jd.com')) 一律拒绝，改为扩展 PlatformConfig。

src/result/ 只消费 storage.session 中的数据，不得直接做 DOM 提取。

Service Worker 代码禁止访问 document / window / Image / canvas。

跨上下文通信必须通过 src/shared/messages.ts 的类型化封装，禁止散落的裸 chrome.runtime.sendMessage。

新增平台适配：只在 platforms/ 加一个文件 + 在 platforms/index.ts 注册 + 在 wxt.config.ts 补 host_permissions，不改核心链路。

4. 开发规范
4.1 平台适配层
所有选择器、懒加载属性名、CDN 域、URL 归一化规则都写在 PlatformConfig 中（见 src/shared/types.ts）。

选择器数组按优先级排列，必须提供至少一个启发式兜底选择器（基于 class 含 main/sku/desc/detail 与元素尺寸），不得只依赖精确类名。

新增或修改归一化正则，必须同步在 tests/unit/url-normalizer.spec.ts 加正例与反例（反例尤其重要：避免把有效 URL 剥坏）。

改动某平台配置后，跑该平台的 Playwright 冒烟（§7.3）。

4.2 提取核心
提取流程固定为：滚动扫描 → 采集 → 过滤 → 归一化 → 去重 → 返回，顺序不要打乱。

滚动扫描必须遵守：瞬时 scrollTo（禁止 behavior: 'smooth'）、可中断、受 scanTimeoutMs 约束、结束时恢复用户原滚动位置。

去重键 = normalize(url) 的 hash；下载目标用采集到的最高分辨率原始 URL，不要用归一化后的 URL 去下载（可能 404）。

子 frame 结果只由 frameId === 0 的主 frame 汇总；汇总需有等待窗口，不得提前返回。

过滤占位图/图标后，必须在 stats.filteredOut 中计数，不要静默丢弃。

4.3 下载与 PNG 转换（最高风险，改动需谨慎）
转换链路必须是：

text
fetch(url, { credentials: 'omit' }) → blob → createImageBitmap → OffscreenCanvas.drawImage → convertToBlob({ type: 'image/png' })
禁止回退到 <img crossOrigin> + canvas.toBlob() 的老方案（会触发 canvas taint）。

必须 bitmap.close()；必须 URL.revokeObjectURL() 释放每个 object URL。

降级链路严格为三级：转换成功 → fallback（保存原格式但 .png 后缀，UI 标注）→ failed（可重试）。不得跳过 fallback 直接失败。

并发数从 UserPreferences.concurrency 读取，默认 4，上限 8。不要硬编码。

单张失败不得中断批次。

4.4 消息与存储
新增消息类型：先在 shared/messages.ts 的 Message 联合类型中加，再实现收发。禁止 any。

大对象（图片列表）走 storage.session 传递，不走 sendMessage。

SW 启动时必须执行 chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })，否则 content script 写入的数据结果页读不到（静默失败，见 §6.2）。

所有 sendMessage 用 sendWithRetry 封装（SW 未唤醒时首条消息会抛错）。

4.5 UI
悬浮按钮必须在 Shadow DOM 中渲染（attachShadow({ mode: 'closed' })），:host { all: initial }。禁止直接在页面 DOM 注入带 class 的元素。

结果页状态用 Preact signals；不引入 Redux/MobX。

网格必须虚拟滚动或分批渲染（每批 20–30 张）。

「全选」只作用于当前筛选结果。

勾选态用「边框 + 对勾图标」双重表达，不单靠颜色。

空状态、扫描超时、部分失败的提示文案按 PRD §4.4 实现，不要自造文案。

5. 代码风格
TypeScript strict: true。禁止 any、@ts-ignore、非空断言 !（确有必要时用注释说明原因并改为 @ts-expect-error + 原因）。

导出优先具名导出；仅入口/页面组件用 default export。

类型定义集中在 shared/types.ts，组件内部类型就近定义。

命名：类型/接口 PascalCase，函数/变量 camelCase，常量 UPPER_SNAKE，文件名 kebab-case（组件文件 PascalCase.tsx）。

异步一律 async/await，禁止裸 .then 链；所有 await 可能失败的调用要有 try/catch 或显式错误传播。

函数单一职责，超过 ~60 行考虑拆分；extractor/index.ts 只做编排，不写采集细节。

注释只写「为什么」，不写「是什么」。涉及浏览器怪癖的地方（如 storage.session 权限、canvas taint）必须写一行注释说明原因。

不引入新依赖前先评估体积与必要性：扩展总安装体积目标 ≤ 500KB。禁止引入 lodash、moment、dayjs、axios、UI 组件库。新增依赖需在 PR 中说明理由与 gzip 后体积。

CSS：结果页用 CSS Modules；不使用 Tailwind/UnoCSS；颜色、间距用 CSS 变量集中在 result/styles/tokens.css。

Preact 组件禁止 dangerouslySetInnerHTML（pageTitle、productId 来自页面，存在注入面）。

格式化交给 Prettier（仓库已配置），不要手工对齐。

6. 注意事项与常见陷阱
以下每一条都曾导致过（或极易导致）静默 bug，属于本项目的重点防御面。

6.1 MV3 生命周期
Service Worker 空闲约 30s 被终止。禁止在 SW 顶层模块变量保存业务状态；一切状态进 storage.session。

禁止用 keepalive hack 维持 SW 做长任务；长任务（图片转换）必须在结果页执行。

结果页关闭 = 下载中断。这是已接受的约束，不要试图用 chrome.offscreen 修复（属于 V1.2 范围）。

6.2 chrome.storage.session
默认仅扩展页面可读。content script 读写前必须先 setAccessLevel('TRUSTED_AND_UNTRUSTED_CONTEXTS')。写入成功但读取为空，99% 是这个原因。

容量默认 10MB，会话级，浏览器关闭即清。不要把长期数据放这里。

6.3 跨域与 canvas
扩展页面在 host_permissions 覆盖的域上 fetch 不受 CORS 限制——这是 PNG 转换方案成立的前提。不要在 content script 里做转换（content script 的 fetch 仍受页面 CORS 约束）。

新增图片 CDN 域时必须同步更新 manifest 的 host_permissions，否则该域图片转换全部失败。

iframe 穿透需要把 iframe 源域（如 desc.alicdn.com）也加进 host_permissions。

6.4 滚动与懒加载
behavior: 'smooth' 会导致 IntersectionObserver 回调被跳过，禁止使用。

淘宝/京东详情页可能是内部 overflow: auto 容器滚动，先探测滚动目标再用 document.scrollingElement 兜底。

用户切走标签页后 rAF 被节流，扫描应降级为跳步滚动。

必须有最大步数（60）与总时长（scanTimeoutMs）双保险，防止无限滚动页面卡死。

6.5 权限与安全
权限只增不减需慎重：新增 host_permissions 会触发用户重新授权提示。禁止申请 <all_urls>、tabs、webRequest。

下载前校验 URL 协议白名单：仅 https: / http:。拒绝 javascript:、file:、非图片用途的 data:。

禁止任何形式的远程请求、埋点、崩溃上报、远程配置拉取（含「仅用于统计」的）。

依赖安装后跑 pnpm audit；PR 中若引入新依赖需人工确认。

6.6 平台维护
平台改版是常态。改选择器时优先加新选择器到数组头部，不要删旧的，保留兜底。

提取结果主图或详情图为 0 时，必须置 stats 异常标记让 UI 提示，不得把「0 张」当成功返回。

冒烟测试失败时先判断是平台改版还是代码回归，PR 中记录结论。

6.7 性能
批量转换逐张进行，不在内存中同时持有全部原图 Blob。

PNG 无损，体积可能为原 JPEG 的 5–10 倍。这是产品明确要求，不要擅自改成 WebP/JPEG，但可在 UI 上提示体积影响。

缩略图 loading="lazy" decoding="async"。

7. 测试要求
7.1 单元测试（Vitest，必须）
以下模块改动即需补测，覆盖率不作硬性数字要求，但分支需覆盖：

extractor/srcset.ts：多候选、带 w/x 描述符、畸形输入。

extractor/url-normalizer.ts：三平台各至少 3 个正例 + 3 个反例（确保不误伤有效 URL）。

extractor/filter.ts：极小图、占位图、图标过滤边界。

shared/filename.ts：非法字符替换、长度截断、模板占位符缺失。

platforms/index.ts：URL 匹配正确性（含子域、带 query）。

background/download-queue.ts：并发上限、失败不中断、重试。

shared/storage.ts：setAccessLevel 被调用的断言（防止 §6.2 回归）。

测试数据放 tests/fixtures/，DOM 快照用静态 HTML 字符串，不要在单测中访问真实网络。

7.2 类型与静态检查
pnpm typecheck 与 pnpm lint 必须零错误。ESLint 禁用的规则若确需关闭，行内注释说明原因。

7.3 E2E 冒烟（Playwright）
三平台各一个固定商品页，使用持久化登录态（storageState，通过环境变量注入，不得提交到仓库）。

每个平台断言：悬浮按钮出现 → 点击 → 结果页打开 → stats.total ≥ 阈值（主图 ≥1、SKU ≥1、详情 ≥1）→ 勾选 2 张 → 下载产物文件头为 PNG magic number（89 50 4E 47）。

冒烟用例允许在平台改版时更新预期值，但不得通过放宽断言掩盖回归；放宽需在 PR 中说明。

7.4 手工验收清单（发版前）
三平台各测一次真实详情页；

关闭结果页/切标签页的异常路径；

断网下单张失败与重试；

确认 chrome://extensions 无权限警告变更、体积 ≤ 500KB。

8. 禁止事项（Do NOT）
❌ 引入服务端、数据库、任何远程请求或遥测。

❌ 在核心链路中用 <img crossOrigin> + canvas.toBlob 做 PNG 转换。

❌ 在 extractor/ 中写平台特判或依赖 Preact。

❌ 在 Service Worker 中访问 DOM / 做图片转换。

❌ 申请 <all_urls> / tabs / webRequest 权限。

❌ 用 behavior: 'smooth' 做扫描滚动。

❌ 在 SW 模块顶层保存业务状态。

❌ 引入 lodash / moment / axios / UI 组件库等重型依赖。

❌ 实现 PRD MVP 表外的功能（除非任务明确要求）。

❌ 提交含登录态、真实商品快照敏感信息、.env 的文件。

9. 交付约定
提交信息遵循 Conventional Commits：feat: / fix: / refactor: / test: / docs: / chore:，scope 用模块名（如 feat(extractor): ...）。

涉及平台选择器、权限、转换链路的改动，PR 描述中必须包含：改动原因、影响平台、验证方式（跑了哪些测试）、回滚方式。

修改 PRD.md / TECH_DESIGN.md 中的既有决策时，先在本文件对应章节补充约束，再改实现，保持三者一致。

遇到本文件未覆盖的架构级选择（新增存储层、新增消息通道、新增第三方服务），停下来提问，不要自行决定。

