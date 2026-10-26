# 指尖开花全栈竞赛版设计规格

## 目标

在现有“隔空撸宠”手势宠物单页上增量增加 Vite 构建、Supabase 数据持久化、匿名会话分析和竞赛数据看板，并完成 GitHub 版本管理与 Vercel 部署。现有摄像头识别、触摸判定、宠物状态机、照片木偶渲染和本地上传宠物流程必须继续工作。

## 成功标准

1. `npm run dev` 可启动本地页面，摄像头或鼠标演示可触发宠物动作与开花动画。
2. Supabase 配置存在时，匿名会话和交互事件可批量写入；配置缺失或网络失败时页面照常运行并保留本地统计。
3. `analytics.html` 可显示互动总量、独立访客、摄像头启用次数、手势分布、宠物偏好和平均会话时长。
4. `npm test` 与 `npm run build` 通过，现有 `tools/test-logic.mjs` 继续通过。
5. Git 仓库有首次提交，GitHub 远端可推送；Vercel 构建成功并返回可访问 URL。
6. `docs/competition-guide.md` 说明架构、手势链路、数据指标、隐私、运行和部署步骤。

## 约束

- 保留原生 JavaScript、Canvas 2D 和 MediaPipe Tasks Vision。
- 不重构 `hand.js`、`touch.js`、`pet.js`、`render.js` 的既有业务逻辑；只增加对外事件钩子。
- 摄像头画面和用户上传的宠物照片不得上传到 Supabase。
- Supabase 匿名角色只允许写入，不允许直接读取明细；看板通过聚合 RPC 获取数据。
- 环境变量只从 `.env.local` 或 Vercel 环境变量读取，不提交密钥。
- 现有静态服务器 `tools/serve.ps1` 保留为离线兜底。

## 架构

```text
浏览器
  ├─ index.html / main.js
  │   ├─ HandTracker → TouchTracker → Pet → Canvas
  │   ├─ AnalyticsService → EventQueue → SupabaseRepository
  │   └─ localStorage 兜底统计
  └─ analytics.html / analytics-page.js
      └─ SupabaseRepository.getDashboard() → 聚合 RPC

Supabase
  ├─ guests / sessions / interaction_events
  └─ start_analytics_session() / analytics_dashboard() (SECURITY DEFINER)

构建与发布
  Vite → dist → Vercel
```

### 前端模块

- `js/services/metrics.js`：纯函数汇总事件，供本地兜底和测试使用。
- `js/services/event-queue.js`：批量队列、失败回滚、localStorage 持久化。
- `js/services/analytics.js`：会话、访客标识、事件标准化和生命周期。
- `js/services/supabase.js`：Supabase 客户端、会话创建、批量写事件、聚合读取。
- `js/analytics-page.js`：数据看板 DOM 渲染，不引入图表库。
- `js/main.js`：仅增加初始化与埋点调用，不改变识别和动作算法。

### 数据表

- `guests`：`id uuid`、`first_seen_at`、`last_seen_at`、`device jsonb`。
- `sessions`：`id uuid`、`guest_id uuid`、`started_at`、`ended_at`、`duration_ms`、`page`。
- `interaction_events`：`id bigint`、`session_id uuid`、`guest_id uuid`、`event_type text`、`pet_id text`、`gesture text`、`value numeric`、`metadata jsonb`、`recorded_at timestamptz`。

匿名键写入策略通过 `start_analytics_session` 和受限 INSERT policy 完成。聚合 RPC 仅返回汇总数据，不返回访客标识或事件明细。

### 事件契约

所有事件字段使用 snake_case：

```js
{
  session_id: "uuid",
  guest_id: "uuid",
  event_type: "gesture_triggered",
  pet_id: "orange",
  gesture: "wave",
  value: 1,
  metadata: { direction: 1 },
  recorded_at: "2026-10-26T12:00:00.000Z"
}
```

核心事件为 `session_start`、`session_end`、`camera_started`、`camera_failed`、`demo_started`、`pet_selected`、`touch_started`、`gesture_triggered`、`pet_action` 和 `bloom_toggled`。

## 交互与错误处理

- 首次触摸只记录一次 `touch_started`，离开宠物后重置，避免逐帧写库。
- 挥手、张手、手动调试动作使用相同的事件结构，便于数据分析。
- 队列每 20 条或每 5 秒尝试写入；失败时保留事件，最多缓存 200 条。
- Supabase 未配置时显示“本地统计模式”，不中断用户交互。
- 看板无数据时显示空状态；RPC 失败时回退到本地事件汇总。
- 页面关闭前尝试发送 `session_end`，再刷新队列；失败不影响关闭。

## 验证

- Node 内置测试覆盖汇总、队列成功/失败、事件标准化和配置校验。
- 原有 `node tools/test-logic.mjs` 覆盖宠物状态机与手势动作。
- Vite 生产构建成功，静态模型、wasm、宠物和场景素材均进入 `dist`。
- 浏览器自动化以 `?demo=1` 打开首页，确认画布非空、切换宠物、开花模式和看板可加载。
- 有凭据时执行 Supabase 实际写入与聚合读取；无凭据时明确报告外部集成未完成。

## 外部依赖与边界

- Supabase 项目 URL、anon key、访问权限。
- GitHub 账号登录、目标仓库名和可见性。
- Vercel 账号登录和项目名。
- 当前执行环境需要可运行 Vite 的 Node.js 20+。

这些外部授权未提供时，代码、SQL、构建和本地验证仍可完成，但线上写入和部署不能宣称已通过。
