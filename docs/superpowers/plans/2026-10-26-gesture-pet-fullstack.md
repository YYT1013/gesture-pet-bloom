# 指尖开花全栈竞赛版实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有手势宠物原型升级为可构建、可分析、可部署的全栈竞赛作品。

**Architecture:** 保留现有 Canvas/MediaPipe 交互主链路，通过窄接口接入异步分析服务。Supabase 只接收匿名指标，看板通过聚合 RPC 读取；Vite 负责本地构建，Vercel 负责静态发布。

**Tech Stack:** Vite、原生 JavaScript、Node.js test runner、Supabase JS、PostgreSQL/RLS、Vercel、Git/GitHub。

**Spec:** `docs/superpowers/specs/2026-10-26-gesture-pet-fullstack-design.md`

## Global Constraints

- 运行环境使用 Node.js 20+。
- 摄像头画面、用户上传的宠物图片和本机 IndexedDB 宠物数据不得上传。
- Supabase anon key 只能通过 `VITE_SUPABASE_URL` 和 `VITE_SUPABASE_ANON_KEY` 注入。
- 现有静态服务器和鼠标演示模式必须保留。
- 新增交互事件不得阻塞 `requestAnimationFrame` 或摄像头识别。
- 每个任务结束时运行对应测试并提交。

## Review Focus

- Supabase 未配置或离线：页面必须照常进入摄像/鼠标模式。由 Task 4、6 测试覆盖。
- 写入失败：事件不得丢失，后续 flush 可重试。由 Task 3 测试覆盖。
- 连续触摸每一帧：只能记录一次 `touch_started`。由 Task 6 测试覆盖。
- 用户隐私：看板 RPC 不得返回访客 ID 或事件明细。由 Task 5 的 SQL 审查覆盖。
- 生产构建路径：模型、wasm、宠物与场景静态文件必须进入 `dist`。由 Task 1、8 构建验证覆盖。

---

### Task 1: 建立 Git 基线并接入 Vite

**Files:**
- Create: `.gitignore`
- Create: `package.json`
- Create: `vite.config.js`
- Create: `vercel.json`
- Test: `tools/test-logic.mjs`（既有）

**Interfaces:**
- Consumes: 现有 `index.html` 与 `js/*.js`。
- Produces: `npm run dev`、`npm run build`、`npm run preview`、`npm test`。

- [ ] **Step 1: 初始化 Git 并确认基线测试**

Run: `git init; node tools/test-logic.mjs`
Expected: 现有逻辑测试全部通过，输出无 `FAIL`。

- [ ] **Step 2: 创建仓库忽略规则与 Vite 配置**

`.gitignore` 排除 `node_modules/`、`dist/`、`.env*`、`refs/`、`用户已故宠物照片.jpg`。`vite.config.js` 将 JS 输出放到 `bundles/`，并复制 `assets/`、`models/`、`lib/` 到构建根目录。

- [ ] **Step 3: 写入 package scripts**

依赖包含 `@supabase/supabase-js`；开发依赖包含 `vite`。`npm test` 运行全部 `tests/*.test.mjs` 和 `tools/test-logic.mjs`。

- [ ] **Step 4: 验证开发构建与生产构建**

Run: `npm install; npm run build`
Expected: 构建退出码 0；`dist/assets/pets/meta.json`、`dist/models/hand_landmarker.task`、`dist/lib/wasm/vision_wasm_internal.wasm` 存在。

- [ ] **Step 5: 提交基线**

Run: `git add .gitignore package.json package-lock.json vite.config.js vercel.json docs/superpowers`
Run: `git commit -m "chore: establish vite full-stack baseline"`

### Task 2: 实现指标汇总纯函数

**Files:**
- Test: `tests/metrics.test.mjs`
- Create: `js/services/metrics.js`

**Interfaces:**
- Consumes: 标准化事件数组。
- Produces: `summarizeEvents(events, now = Date.now()) -> DashboardMetrics`。

`DashboardMetrics` 固定字段为 `total_interactions`、`unique_guests`、`camera_starts`、`gesture_counts`、`pet_counts`、`average_session_ms`、`last_event_at`。

- [ ] **Step 1: 写失败测试**

测试三种输入：空数组返回零值；重复访客只计一次；触摸/手势/动作计入互动但不把 `session_start` 计入。

- [ ] **Step 2: 运行并确认 RED**

Run: `node --test tests/metrics.test.mjs`
Expected: 因 `js/services/metrics.js` 不存在而失败。

- [ ] **Step 3: 实现最小汇总函数**

按 `event_type`、`guest_id`、`gesture`、`pet_id`、`value` 聚合，忽略非法时间。

- [ ] **Step 4: 运行并确认 GREEN**

Run: `node --test tests/metrics.test.mjs`
Expected: 全部测试通过。

- [ ] **Step 5: 提交**

Run: `git add tests/metrics.test.mjs js/services/metrics.js; git commit -m "feat: add interaction metrics summary"`

### Task 3: 实现可重试批量事件队列

**Files:**
- Test: `tests/event-queue.test.mjs`
- Create: `js/services/event-queue.js`

**Interfaces:**
- Consumes: `send(batch): Promise<void>`，可选 `storage` 具有 `getItem/setItem`。
- Produces: `new EventQueue({ send, storage, key, batchSize = 20, maxItems = 200 })`，方法 `enqueue(event)`、`flush()`、`snapshot()`。

- [ ] **Step 1: 写失败测试**

覆盖：达到 batchSize 才发送；成功发送后清空；失败后事件保留；超过 maxItems 丢最旧事件；新实例从 storage 恢复队列。

- [ ] **Step 2: 运行并确认 RED**

Run: `node --test tests/event-queue.test.mjs`
Expected: 模块不存在。

- [ ] **Step 3: 实现 FIFO 队列**

`flush()` 对队首批次调用 `send`；成功移除，失败保留并返回结构化错误，不抛出到调用方。

- [ ] **Step 4: 运行并确认 GREEN**

Run: `node --test tests/event-queue.test.mjs`
Expected: 全部测试通过，无未处理 rejection。

- [ ] **Step 5: 提交**

Run: `git add tests/event-queue.test.mjs js/services/event-queue.js; git commit -m "feat: add retryable analytics queue"`

### Task 4: 实现分析会话与 Supabase 适配层

**Files:**
- Test: `tests/analytics.test.mjs`
- Test: `tests/supabase-config.test.mjs`
- Create: `js/services/analytics.js`
- Create: `js/services/supabase.js`

**Interfaces:**
- Consumes: repository 暴露 `startSession(payload)`、`sendEvents(events)`、`getDashboard()`。
- Produces: `createAnalytics({ repository, storage, now, createId }) -> { start, track, flush, stop, getSession, localSummary }`。
- Produces: `parseSupabaseConfig(env) -> { url, anonKey, configured }` 和 `createSupabaseRepository(config, clientFactory?)`。

- [ ] **Step 1: 写失败测试**

事件测试断言字段名、UUID、时间、session/guest 关联；无 repository 时 `track` 不抛错；stop 产生 `session_end`；配置测试拒绝空值和非 https URL。

- [ ] **Step 2: 运行并确认 RED**

Run: `node --test tests/analytics.test.mjs tests/supabase-config.test.mjs`
Expected: 两个模块缺失导致失败。

- [ ] **Step 3: 实现分析服务和配置解析**

访客 ID 持久化到 `gesture-pet:guest-id`；会话 ID 每次页面加载新建；同步入队，异步 flush 不阻塞交互。

- [ ] **Step 4: 运行并确认 GREEN**

Run: `node --test tests/analytics.test.mjs tests/supabase-config.test.mjs`
Expected: 全部测试通过。

- [ ] **Step 5: 提交**

Run: `git add tests/analytics.test.mjs tests/supabase-config.test.mjs js/services/analytics.js js/services/supabase.js; git commit -m "feat: add anonymous analytics service"`

### Task 5: 建立 Supabase 数据库契约

**Files:**
- Create: `supabase/schema.sql`
- Create: `.env.example`
- Test: `tests/schema-contract.test.mjs`

**Interfaces:**
- Consumes: `start_analytics_session(p_guest_id, p_session_id, p_page, p_device)`。
- Produces: `analytics_dashboard()` 返回与 Task 2 同名字段的 JSON。

- [ ] **Step 1: 写 SQL 契约测试**

读取 `schema.sql`，断言三张表、RLS、匿名 INSERT policy、两个 RPC 和默认拒绝明细 SELECT 的关键语句存在。

- [ ] **Step 2: 运行并确认 RED**

Run: `node --test tests/schema-contract.test.mjs`
Expected: 文件不存在。

- [ ] **Step 3: 编写幂等 SQL**

创建 `guests`、`sessions`、`interaction_events`、索引、RLS、受限函数和权限；函数设置固定 `search_path = public`。

- [ ] **Step 4: 运行契约测试**

Run: `node --test tests/schema-contract.test.mjs`
Expected: 全部断言通过。

- [ ] **Step 5: 提交**

Run: `git add supabase/schema.sql .env.example tests/schema-contract.test.mjs; git commit -m "feat: add supabase analytics schema"`

### Task 6: 接入首页交互埋点

**Files:**
- Modify: `index.html`
- Modify: `js/main.js`
- Test: `tests/event-rules.test.mjs`

**Interfaces:**
- Consumes: Task 4 的 `analytics.start()` 与 `analytics.track(eventType, payload)`。
- Produces: `shouldTrackTouch(previousContact, contact) -> boolean` 和统一动作事件。

- [ ] **Step 1: 写触摸边沿测试**

断言 `false→true` 只返回 true，`true→true` 返回 false，`true→false` 返回 false。

- [ ] **Step 2: 运行并确认 RED**

Run: `node --test tests/event-rules.test.mjs`
Expected: 规则函数不存在。

- [ ] **Step 3: 接入事件**

初始化分析服务；对摄像头、演示模式、切换宠物、首次触摸、挥手、张手、打滚、跑动和开花切换调用 `track`。页面关闭与 `pagehide` 调用 `stop`。

- [ ] **Step 4: 运行测试**

Run: `npm test`
Expected: 新旧测试全部通过。

- [ ] **Step 5: 提交**

Run: `git add index.html js/main.js tests/event-rules.test.mjs; git commit -m "feat: instrument gesture interactions"`

### Task 7: 增加数据分析看板

**Files:**
- Create: `analytics.html`
- Create: `js/analytics-page.js`
- Create: `css/analytics.css`
- Create: `tests/dashboard-render.test.mjs`
- Modify: `index.html`
- Modify: `vite.config.js`

**Interfaces:**
- Consumes: `repository.getDashboard()` 或 `summarizeEvents(localEvents)`。
- Produces: `renderDashboard(root, metrics)`，用于无框架 DOM 渲染。

- [ ] **Step 1: 写失败测试**

使用最小 DOM stub 断言六个 KPI、手势排序和空状态文本；拒绝未转义的宠物名称注入 HTML。

- [ ] **Step 2: 运行并确认 RED**

Run: `node --test tests/dashboard-render.test.mjs`
Expected: 渲染模块不存在。

- [ ] **Step 3: 实现看板**

顶栏提供返回互动页入口；显示数据来源徽标；用 CSS 条形图展示手势和宠物分布；失败时回退本地统计。

- [ ] **Step 4: 构建并检查入口**

Run: `npm run build`
Expected: `dist/index.html` 与 `dist/analytics.html` 均存在。

- [ ] **Step 5: 提交**

Run: `git add analytics.html js/analytics-page.js css/analytics.css tests/dashboard-render.test.mjs index.html vite.config.js; git commit -m "feat: add analytics dashboard"`

### Task 8: 完成竞赛文档和浏览器验收

**Files:**
- Create: `docs/competition-guide.md`
- Create: `docs/DEPLOYMENT.md`
- Modify: `README.md`
- Modify: `START-Windows.bat`
- Test: `tools/e2e-cdp.mjs`

**Interfaces:**
- Consumes: 完整应用和生产构建。
- Produces: 答辩说明、运行说明、环境变量说明和部署检查清单。

- [ ] **Step 1: 编写运行与答辩文档**

记录技术架构、识别链路、手势定义、指标定义、隐私边界、Supabase SQL 导入、Git/Vercel 步骤和常见故障。

- [ ] **Step 2: 运行完整自动测试**

Run: `npm test; npm run build`
Expected: 全部退出码 0。

- [ ] **Step 3: 启动开发服务器并做浏览器验收**

Run: `npm run dev -- --host 127.0.0.1 --port 4173`
Expected: 首页返回 200，控制台无模块加载错误。

Run: `node tools/e2e-cdp.mjs http://127.0.0.1:4173`
Expected: 既有 E2E 输出 `PASS`；新增检查确认画布非空和 `/analytics.html` 可打开。

- [ ] **Step 4: 提交**

Run: `git add README.md START-Windows.bat docs/competition-guide.md docs/DEPLOYMENT.md; git commit -m "docs: add competition and deployment guide"`

### Task 9: 连接外部平台并发布

**Files:**
- Local only: `.env.local`

**Interfaces:**
- Consumes: Supabase 项目凭据、GitHub 登录态、Vercel 登录态。
- Produces: Supabase 实际读写证据、GitHub 远端、Vercel preview URL。

- [ ] **Step 1: 导入 Supabase schema**

Run: `npx supabase db push` 或 Supabase SQL Editor 执行 `supabase/schema.sql`。
Expected: `analytics_dashboard()` RPC 可调用。

- [ ] **Step 2: 验证真实写入和读取**

用匿名配置启动页面，完成一次演示互动；查询 RPC 确认互动和访客计数增加。

- [ ] **Step 3: 创建并推送 GitHub 仓库**

Run: `git remote add origin <repo-url>; git push -u origin main`
Expected: 远端显示全部提交。

- [ ] **Step 4: 配置 Vercel 环境变量并部署**

Run: `npx vercel --prod`
Expected: 返回 HTTPS URL，首页、`/analytics.html` 和摄像头权限可用。

- [ ] **Step 5: 记录发布结果**

将线上 URL、部署时间、Supabase 验证结果写入 `docs/DEPLOYMENT.md` 并提交。
