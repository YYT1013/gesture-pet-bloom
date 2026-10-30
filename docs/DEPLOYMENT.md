# 指尖开花部署与验收

## 1. 当前交付状态

| 项目 | 状态 | 说明 |
|---|---|---|
| 本地 Vite 开发 | 已验证 | 首页、看板、手势演示和布局自动化可运行 |
| 本地生产构建 | 已验证 | 输出到 `dist/`，包含 wasm、模型和图片资源 |
| 本地匿名统计 | 已验证 | 无 Supabase 时使用 `localStorage` 和看板回退 |
| Supabase 云端读写 | 待项目凭据 | SQL 和前端适配已完成，需实际项目执行并验收 |
| GitHub 远端 | 待账号与仓库 | 本地 Git 历史已建立，尚无远端地址 |
| Vercel 线上演示 | 待账号授权 | 构建配置已提供，需导入项目并配置环境变量 |

这张表是交付边界：只有真实完成云端写入、远端推送和线上访问后，才能把对应项目改为“已验证”。

本次本地验收环境（2026-10-26）的实际检查结果：

- `supabase projects list` 返回 `AccessTokenRequiredError`，没有项目访问凭据。
- `vercel whoami` 返回 `Logged out`；未登录临时部署也被 Vercel 拒绝。
- 本地 Git 没有配置任何远端，Git Credential Manager 也没有可用的 GitHub 账号。

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

### 3.1 创建项目并导入表结构

1. 在 Supabase 新建项目，等待数据库就绪。
2. 打开 SQL Editor，整体执行 `supabase/schema.sql`。
3. 在 Project Settings -> API 获取 Project URL 和 public anon key。
4. 不要使用 service role key 配置前端。

### 3.2 本地环境变量

在项目根目录创建 `.env.local`：

```dotenv
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-public-anon-key
```

重启开发服务器。`.env.local` 已在 `.gitignore` 中，不应提交。

### 3.3 验证真实写入和读取

1. 打开互动页，允许摄像头或点击「先看看」。
2. 用鼠标/手势选择宠物并完成至少一次触摸。
3. 等待约 5 秒触发队列刷新，或触发满 20 条事件。
4. 打开 `analytics.html`，确认徽标显示 `Supabase 在线数据`，且互动次数增加。
5. 在 SQL Editor 执行：

```sql
select public.analytics_dashboard();
select count(*) from public.interaction_events;
select count(*) from public.guests;
```

预期：匿名看板 RPC 可执行；浏览器使用 anon key 时不能直接 `select * from interaction_events`。

### 3.4 安全验收

- `guests`、`sessions`、`interaction_events` 均启用 RLS。
- anon/authenticated 只获得 `interaction_events` 的 INSERT 权限。
- `analytics_dashboard()` 只返回聚合值。
- 事件类型受 INSERT policy 白名单限制。
- 前端网络请求中不出现摄像头帧或上传照片内容。

## 4. GitHub 发布

本项目已初始化本地 Git 仓库。首次关联远端前，先把占位身份替换成实际团队信息：

```bash
git config user.name "你的名字"
git config user.email "你的邮箱"
git remote add origin https://github.com/<账号>/<仓库>.git
git push -u origin main
```

如果远端由网页创建，选择空仓库，不要自动生成 README。推送后检查：

- `git log --oneline` 能看到分阶段提交。
- GitHub 页面能看到 `main` 分支和最新提交。
- `node_modules/`、`dist/`、`.env.local`、原始参考照片没有进入仓库。

如需 PR 流程，可从 `feat/competition-release` 分支提交 Pull Request，再合并到 `main`。

## 5. Vercel 发布

### 5.1 从 Git 仓库导入

1. 在 Vercel 新建项目并导入 GitHub 仓库。
2. Framework Preset 选择 Vite。
3. Build Command 使用 `npm run build`。
4. Output Directory 使用 `dist`。
5. 在 Environment Variables 添加：

```text
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
```

6. 部署 Production，记录 HTTPS URL。

### 5.2 从 CLI 发布

```bash
npx vercel
npx vercel env add VITE_SUPABASE_URL
npx vercel env add VITE_SUPABASE_ANON_KEY
npx vercel --prod
```

CLI 需要先完成 Vercel 登录。不要把 token 写入仓库。

### 5.3 线上验收

- `https://<domain>/` 返回 200。
- `https://<domain>/analytics.html` 返回 200。
- 页面通过 HTTPS 成功请求摄像头权限。
- wasm 请求的 Content-Type 为 `application/wasm`。
- 模型、宠物图片和场景图片加载无 404。
- 配置 Supabase 后，互动看板显示在线来源且数据增长。
- 手机宽度 390px 下，首页和数据看板没有横向溢出。

## 6. 发布后回归

线上验证至少执行以下检查：

```bash
node tools/e2e-cdp.mjs https://<domain> ui
```

也可以使用环境变量指定线上域名，仅验证已打包页面：

```powershell
$env:PET_BASE='https://<domain>'
node tools/e2e-cdp.mjs ui
```

线上只运行 `ui` 模式；完整自检页 `_e2e.html` 未包含在 `dist` 中。

CDP 无头浏览器能验证页面、资源、画布和布局；物理摄像头权限仍需在 Chrome/Edge 中手动确认。

## 7. 故障排查

| 现象 | 检查 |
|---|---|
| Vercel 构建找不到 Node 版本 | 项目使用 Node 20.19+，必要时在 Vercel 设置 Node.js Version |
| 部署后模型 404 | 确认 Build Command 是 `npm run build`，它会复制模型和 wasm |
| wasm 报 MIME 错误 | 检查 `vercel.json` 的 wasm header 和响应头 |
| 摄像头不可用 | 必须 HTTPS；iframe 必须包含 `allow="camera"` |
| 看板一直本地模式 | 环境变量未注入或未重新部署；变量变更后需要新构建 |
| 云端在线但无数据 | 等待队列 5 秒刷新，确认 SQL RPC 和事件 INSERT 权限 |
| SQL 可写入但看板为空 | 检查 `analytics_dashboard()` 是否存在且 anon 有 EXECUTE 权限 |

## 8. 最终验收记录

发布完成后在此填写：

```text
Commit:
Supabase project:
Supabase write/read:
GitHub remote:
Vercel production URL:
Desktop camera:
Mobile layout:
验收人 / 时间:
```
