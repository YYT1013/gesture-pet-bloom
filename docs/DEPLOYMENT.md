# 指尖开花部署与验收

## 1. 当前交付状态

| 项目 | 状态 | 说明 |
|---|---|---|
| 本地 Vite 开发 | 已验证 | 首页、看板、手势演示和响应式布局可运行 |
| 本地生产构建 | 已验证 | 输出到 `dist/`，包含 wasm、模型和图片资源 |
| Supabase 云端读写 | 已验证 | 匿名写入、聚合读取和 RLS 拒绝路径均已测试 |
| GitHub 远端 | 已验证 | `YYT1013/gesture-pet-bloom`，`main` 分支 |
| GitHub Pages 线上演示 | 已验证 | Actions 已发布；首页、看板、资源、Supabase 和移动布局通过 |

线上地址：

- 互动页：`https://YYT1013.github.io/gesture-pet-bloom/`
- 数据看板：`https://YYT1013.github.io/gesture-pet-bloom/analytics.html`

GitHub Pages 是可公开访问的 HTTPS 静态站点。本项目不使用 Vercel，也不需要额外部署插件；
`main` 分支每次推送都会经过测试、构建并发布 `dist/`。

## 2. 本地运行

要求 Node.js 20.19+ 和 npm 10+。

```bash
npm install
npm test
npm run build
npm run dev -- --host 127.0.0.1 --port 4173
```

打开：

- 互动页：`http://127.0.0.1:4173/`
- 数据看板：`http://127.0.0.1:4173/analytics.html`

Windows 也可以双击 `START-Windows.bat`。脚本优先运行 Vite；没有 npm 或依赖时会回退到静态服务器。

## 3. Supabase 配置

### 3.1 云端项目

当前项目：

- 名称：`gesture-pet-bloom`
- Project Ref：`mrlnhdnlimaltinibjgi`
- Project URL：`https://mrlnhdnlimaltinibjgi.supabase.co`
- 表结构与 RPC：`supabase/schema.sql`
- 前端只使用公开 anon/publishable key，绝不使用 service role key

### 3.2 本地环境变量

项目根目录的 `.env.local` 保留本地凭据，已被 Git 忽略：

```dotenv
VITE_SUPABASE_URL=https://mrlnhdnlimaltinibjgi.supabase.co
VITE_SUPABASE_ANON_KEY=your-public-anon-key
```

重启开发服务器后，互动页会使用云端匿名统计；没有配置时自动回退到 `localStorage`。

### 3.3 线上构建变量

GitHub Actions 从仓库 Variables 读取以下两项：

```text
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
```

可在 GitHub 仓库 `Settings -> Secrets and variables -> Actions -> Variables` 设置。这里放的是浏览器构建期公开配置，不需要也不能放 service role key。变量变更后重新运行 Pages 工作流才会进入新构建。

### 3.4 数据库验收

1. 打开互动页，允许摄像头或点击「先看看」。
2. 用鼠标或手势完成至少一次触摸。
3. 等待约 5 秒触发队列刷新，或触发满 20 条事件。
4. 打开数据看板，确认徽标显示 `Supabase 在线数据` 且指标增长。

在 Supabase SQL Editor 可复查：

```sql
select public.analytics_dashboard();
select count(*) from public.interaction_events;
select count(*) from public.guests;
```

安全边界：

- `guests`、`sessions`、`interaction_events` 均启用 RLS。
- 匿名浏览器只能调用必要的写入 RPC、插入白名单事件和读取聚合 RPC。
- 匿名直接读取访客和互动明细会被拒绝。
- 摄像头帧和用户宠物照片不会上传。

## 4. GitHub Pages 发布

### 4.1 自动发布流程

工作流文件：`.github/workflows/deploy-pages.yml`

每次推送到 `main`，工作流依次执行：

1. 检出仓库并安装 Node.js 22。
2. 执行 `npm ci` 和 `npm test`。
3. 使用 `VITE_BASE_PATH=/gesture-pet-bloom/` 构建。
4. 把 `dist/` 作为 Pages artifact 上传。
5. 通过 GitHub Pages 官方 Actions 发布，无需提交 `dist/` 到 Git。

也可以在仓库 `Actions -> Deploy GitHub Pages -> Run workflow` 手动重跑。

### 4.2 Pages 设置

仓库 `Settings -> Pages -> Build and deployment` 的 Source 必须选择 `GitHub Actions`。如果使用 REST/CLI 初始化：

```bash
gh api --method POST repos/YYT1013/gesture-pet-bloom/pages \
  -f build_type=workflow
```

若站点已存在，改用 `PUT` 或直接在 Settings 页面切换到 `GitHub Actions`。

### 4.3 子路径资源规则

GitHub 项目页不是根域名，页面位于 `/gesture-pet-bloom/`。因此构建必须设置：

```text
VITE_BASE_PATH=/gesture-pet-bloom/
```

`vite.config.js` 会把该值写入 CSS、JavaScript 和 module preload 地址。运行时的模型、wasm、宠物和场景资源使用基于 `import.meta.url` 的 URL，能够跟随打包模块进入同一子目录。

## 5. 线上验收

按顺序检查：

1. 以下地址都返回 HTTP 200，且不跳到 404：

```text
https://YYT1013.github.io/gesture-pet-bloom/
https://YYT1013.github.io/gesture-pet-bloom/analytics.html
https://YYT1013.github.io/gesture-pet-bloom/models/hand_landmarker.task
https://YYT1013.github.io/gesture-pet-bloom/lib/wasm/vision_wasm_internal.wasm
```

2. wasm 响应头为 `Content-Type: application/wasm`：

```powershell
curl.exe -I https://YYT1013.github.io/gesture-pet-bloom/lib/wasm/vision_wasm_internal.wasm
```

3. 首页和看板无控制台错误、无资源 404，桌面和 390px 手机宽度无横向溢出。
4. Chrome/Edge 在 HTTPS 页面成功申请摄像头权限，手动做出触摸和张开手动作。
5. 互动后看板显示 `Supabase 在线数据`，并出现新增指标。

自动回归：

```bash
node tools/e2e-cdp.mjs https://YYT1013.github.io/gesture-pet-bloom ui
```

也可以使用环境变量：

```powershell
$env:PET_BASE='https://YYT1013.github.io/gesture-pet-bloom'
node tools/e2e-cdp.mjs ui
```

CDP 无头浏览器可验证页面、资源、画布和布局；物理摄像头权限仍需在真实浏览器中手动确认。

## 6. 故障排查

| 现象 | 检查 |
|---|---|
| Actions 构建失败 | 查看 `Deploy GitHub Pages` 工作流日志；先本地运行 `npm test` 和 `npm run build` |
| Pages 设置报错 | `Settings -> Pages` 的 Source 选择 `GitHub Actions` |
| 页面 404 | 确认线上路径带 `/gesture-pet-bloom/`，并等待首次部署完成 |
| CSS/JS 404 | 确认 Actions 中设置了 `VITE_BASE_PATH=/gesture-pet-bloom/` |
| 部署后模型 404 | 确认构建命令是 `npm run build`，它会复制 `models/`、`lib/` 和 `assets/` |
| `.mjs` 或 wasm MIME 错误 | 检查 Pages 响应的 `Content-Type`，确认发布的是构建后的 `dist/` artifact |
| 摄像头不可用 | 必须使用 HTTPS；iframe 必须包含 `allow="camera"` |
| 看板一直本地模式 | 检查仓库 Variables 是否设置，并在变量变更后重跑 Pages 工作流 |
| 云端在线但无数据 | 等待队列 5 秒刷新，检查 RPC、匿名 INSERT 权限和网络请求 |

## 7. 最终验收记录

2026-11-02 已完成首次真实 Pages 部署与线上回归：

```text
Commit: 3820cc4
Supabase project: gesture-pet-bloom / mrlnhdnlimaltinibjgi
Supabase write/read: 通过；线上回归期间互动总数 4 -> 7
GitHub remote: https://github.com/YYT1013/gesture-pet-bloom
GitHub Pages URL: https://YYT1013.github.io/gesture-pet-bloom/
GitHub Actions run: https://github.com/YYT1013/gesture-pet-bloom/actions/runs/41413911549
Desktop camera: 线上 HTTPS 摄像头与 MediaPipe 启动通过（640x480）；物理挥动手势需现场复核
Mobile layout: 通过；390x844 无横向溢出
验收人 / 时间: Codex 自动化回归 / 2026-11-02
```
