# 无限邮箱 · Unlimited Mailbox

> 一个域名 → 无限个收件地址 → 每个账号一个独立网页收件箱。

在线体验：<https://exmail.boluoye.top/>

自建的多用户临时邮箱 / 收件箱系统。收信走 Cloudflare Email Routing（推荐）或本机 SMTP，邮件存 Cloudflare D1 或本地 SQLite，网页端提供登录、注册、子地址归并、一邮多用、管理后台等完整功能。

项目**零第三方运行时依赖**：Node 版只用内置模块，Cloudflare 版是单文件 Worker，复制粘贴即可部署。

```
别人发信 → your-name@example.com
        → Cloudflare Email Routing（catch-all）
        → Email Worker（MIME 解析 + 路由）
        → D1 数据库
        → 网页收件箱（多用户隔离）
```

## 功能

- **多用户**：QQ 邮箱 + 邮箱验证码 + 密码注册登录，手机号可选；账号之间收件箱完全隔离。
- **一个主邮箱 + 无限子地址**：注册 `bili` 即拥有 `bili@example.com`；`bili1@`、`bili-shop@`、`bili.taobao@` 全部自动归到同一个收件箱，并在侧栏按来源折叠。
- **一邮多用**：把 QQ / Gmail / 163 / Outlook 等邮箱的「自动转发」指向专属入口地址，外部来信和本站邮件统一收进一个收件箱，并打来源标签。
- **root 管理后台**：用户管理、停用 / 启用、重置密码、删除账号、多域名管理、全局开关、被丢弃邮件审计。
- **两种部署方式**：
  - 方案 A：Cloudflare Worker + D1 + Email Routing，免费、免服务器、能收真实公网邮件；
  - 方案 B：本机 / 自有服务器 Node 运行，数据完全自持，适合开发调试和内网使用。
- **单文件 Worker**：`worker.mjs` 内联了 MIME 解析器和全部前端资源，Cloudflare 控制台粘贴即可运行。
- **完整测试**：多用户 44 项断言、旧库迁移、脏邮件解析、端到端冒烟测试。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 运行时 | Node.js ≥ 24（`node:sqlite` 无需额外参数；22.5–23 需 `--experimental-sqlite`）或 Cloudflare Workers |
| 数据库 | Cloudflare D1 / `node:sqlite`（Node 内置） |
| 前端 | 原生 HTML + CSS + JavaScript，无框架、无构建 |
| 邮件解析 | 自研零依赖 MIME 解析器（`mime.mjs`） |
| 发信通道（可选） | [Resend](https://resend.com) HTTP API |

## 快速开始

### 方案 A：Cloudflare（推荐，能收真实邮件）

前提：一个自己的域名、一个 Cloudflare 免费账号。完整步骤见 **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**。

最短路径：

1. 域名接入 Cloudflare，开启 **Email Routing**；
2. 创建 D1 数据库 `mailbox`；
3. 新建 Worker，把 [`worker.mjs`](worker.mjs) 全文粘贴进去并部署；
4. 给 Worker 绑定 D1，变量名必须是 **`DB`**；
5. 添加 Secret **`ACCESS_TOKEN`**（16 位以上，root 初始密码）；
6. Email Routing → Catch-all → Send to a Worker → 选择该 Worker；
7. 打开 Worker 域名，用 `admin@你的域名` + `ACCESS_TOKEN` 登录。

也可以使用一键脚本（需要 Cloudflare API Token，权限见部署文档）：

```bash
CF_TOKEN=你的令牌 DOMAIN=example.com ACCESS_TOKEN=你的口令 node scripts/setup-cloudflare.mjs
```

### 方案 B：本机 5 分钟

需要 Node.js 24 或更新版本（22.5–23 需加 `--experimental-sqlite`），无需 `npm install`：

```bash
git clone https://github.com/cyu85289-gif/unlimited-mailbox.git
cd unlimited-mailbox
npm start
```

启动后终端会打印：

```
无限邮箱（多用户版）已启动
网页收件箱  http://127.0.0.1:8787/
收信端口    2525（域名 @example.com）
root 账号   admin@example.com
root 密码   <随机生成，也保存在 data/worker-token.txt>
```

浏览器打开 `http://127.0.0.1:8787/`，用 root 账号登录。发一封测试邮件：

```bash
node test/send-test-mail.mjs --to admin-demo@example.com
```

> 本机版要接收真实公网邮件，需要公网 IP + 25 端口，或使用 Cloudflare Tunnel 把 `/api/ingest` 暴露出去。具体见部署文档。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/USAGE.md](docs/USAGE.md) | 完整使用手册：注册登录、子地址、一邮多用、账号设置、管理后台 |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Cloudflare 从零部署、本机部署、DNS、Resend、多域名、升级与回滚 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构设计、数据模型、收信流程、权限模型、安全设计 |
| [docs/API.md](docs/API.md) | HTTP API 完整参考 |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 本地开发、构建、测试与扩展指南 |

## 项目结构

```
unlimited-mailbox/
├─ server.mjs             本地版入口：HTTP + SMTP，把请求交给 worker.mjs
├─ smtp.mjs               零依赖 SMTP 收信服务器（只收不发）
├─ mime.mjs               零依赖 MIME 解析器（Node / Worker 共用）
├─ worker.template.mjs    Cloudflare Worker 源码模板（多用户 · 多域名 · 子地址）
├─ worker.mjs             构建产物：模板 + MIME + 前端资源内联成的单文件
├─ build-worker.mjs       重新生成 worker.mjs
├─ public/                网页端（原生 JS，无框架）
│  ├─ index.html
│  ├─ app.js
│  └─ style.css
├─ scripts/
│  ├─ setup-cloudflare.mjs  一键：建 D1 + 部署 Worker + 开 Email Routing + 设 Catch-all
│  ├─ deploy-worker.mjs     只更新 Worker 代码
│  ├─ check-worker.mjs      检查线上登录页 / 接口 / 域名
│  ├─ check-inbox.mjs       直接查 D1 里的邮件
│  ├─ bind-domain.mjs       绑定自定义域名
│  └─ restore-mx.mjs        回滚 MX 记录
├─ test/                  单元 / 集成 / 端到端测试
├─ docs/                  使用、部署、架构、API、开发文档
├─ config.json            本地版配置
└─ start.cmd              Windows 双击启动
```

## 开发与测试

```bash
# 改完 mime.mjs / worker.template.mjs / public/* 后重新生成 Worker
node build-worker.mjs

# 多用户核心逻辑：44 项断言（本地 SQLite 模拟 D1）
node test/simulate-worker.mjs

# 旧库升级到多用户结构
node test/migrate-worker.mjs

# 脏邮件解析回归（GBK、缺头、LF 换行）
node test/edge-cases.mjs

# 端到端冒烟（需要本地服务已启动）
ACCESS_TOKEN=你的口令 node test/live-check.mjs
```

更多说明见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 安全说明

- 密码使用 PBKDF2-SHA256（100,000 次迭代、16 字节随机盐）哈希存储；管理员也无法查看明文，只能重置。
- 会话令牌为 32 字节随机数，数据库只存 SHA-256；Cookie 为 `HttpOnly` + `SameSite=Lax`，HTTPS 下自动加 `Secure`。
- 所有邮件查询都带 `mailboxes.user_id` 过滤，越权访问返回 404，不泄露资源是否存在。
- HTML 邮件在 `sandbox` iframe 中渲染，脚本被禁用。
- 登录与验证码接口有基于 `IP + 账号` 的频率限制。
- 单封邮件上限 25 MB；D1 单行上限 1 MB，超过约 900 KB 的附件不会落库（正文照常保存）。

发现安全问题请参考 [SECURITY.md](SECURITY.md)，不要在公开 Issue 中贴出敏感信息。

## 版权与许可

代码以 [MIT License](LICENSE) 开源。第三方服务（Cloudflare、Resend）受各自条款约束。

本项目用于个人收件箱管理、隔离注册邮箱、聚合多邮箱来信等正常场景。请遵守所在地区法律及服务提供商的使用条款。
