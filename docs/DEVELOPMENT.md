# 开发与测试

## 1. 环境要求

- Node.js **22.5 或更新版本**（推荐 24）。
- 不需要 `npm install`：项目没有第三方运行时依赖。
- 可选：Cloudflare 账号与 Wrangler CLI，用于远程部署调试。

```bash
node -v
npm start
```

## 2. 本地开发

### 2.1 启动

```bash
git clone https://github.com/your-account/unlimited-mailbox.git
cd unlimited-mailbox
npm start
```

默认地址：<http://127.0.0.1:8787/>，SMTP 端口 `2525`。

`server.mjs` 会自动读取项目根目录的 `.env`（如果存在）：

```ini
MAIL_DOMAIN=example.com
ACCESS_TOKEN=本地调试口令
PORT=8787
SMTP_PORT=2525
```

也可以直接修改 `config.json`。

### 2.2 演示数据

```bash
node test/seed-demo.mjs --domain example.com
```

会向 root 的主邮箱写入几封演示邮件，方便调试列表、搜索、附件和 HTML 渲染。

### 2.3 发送测试邮件

```bash
node test/send-test-mail.mjs --to admin-demo@example.com
node test/send-raw.mjs --from a@qq.com --to verify-abc@example.com
```

## 3. npm scripts

| 命令 | 作用 |
| --- | --- |
| `npm start` | 启动本地版（HTTP + SMTP） |
| `npm run build:worker` | 由模板 + MIME + 前端生成 `worker.mjs` |
| `npm run test:worker` | 多用户核心逻辑测试（44 项断言） |
| `npm run test:migrate` | 旧库升级测试 |
| `npm run test:edge` | 脏邮件解析测试 |
| `npm run test:mail` | 发送一封测试邮件 |
| `npm run demo` | 写入演示邮件 |
| `npm run check:dns -- example.com` | 检查域名 MX / SPF |
| `npm run check:worker` | 检查线上 Worker 登录页 / 接口 / 域名 |
| `npm run check:inbox` | 直接查询 D1 中的邮件 |
| `npm run deploy` | 用 `CF_TOKEN` 更新线上 Worker |
| `npm run setup` | 一键配置 Cloudflare（D1 + Worker + Email Routing） |

## 4. 代码约定

### 4.1 `worker.mjs` 是生成物

不要直接编辑 `worker.mjs`。修改以下源文件后重新构建：

- `mime.mjs`：MIME 解析；
- `worker.template.mjs`：Worker 业务逻辑；
- `public/index.html`、`public/app.js`、`public/style.css`：前端。

```bash
node build-worker.mjs
```

构建脚本会检查：

- 模板占位符是否全部替换；
- 输出中是否残留 `import` 语句（Cloudflare 单文件不允许）。

### 4.2 运行时兼容

- Worker 侧只能使用 Cloudflare Workers 支持的 Web API（`fetch`、`crypto.subtle`、`Request`、`Response`、`URL` 等）。
- Node 侧通过 `server.mjs` 的 D1 适配层兼容 `env.DB.prepare().bind().run()/all()/first()`。
- 不要使用 Node 专有模块（`node:fs` 等）到 `worker.template.mjs`，否则 Cloudflare 部署失败。

### 4.3 新增 API

在 `worker.template.mjs` 的 `handleApi()` 中按现有风格添加：

```js
if (p === '/api/example' && method === 'GET') {
  return json({ ok: true, data: '...' });
}
```

注意：

- 放在 `if (!user) return bad('未登录', 401);` 之后即要求登录；
- 管理接口放在 `if (p.startsWith('/api/admin/') && !isAdmin) ...` 之后；
- 所有查询带 `user_id` 条件；
- 所有用户输入做类型与长度校验；
- 返回统一使用 `json()` / `bad()`。

### 4.4 数据库变更

`ensureSchema()` 在每次请求时执行：

1. 建表（`CREATE TABLE IF NOT EXISTS`）；
2. 检查老表缺列并 `ALTER TABLE ... ADD COLUMN`；
3. 执行 `migrateLegacy()`；
4. `ensureRoot()`。

新增字段时：

- 在 `SCHEMA` 中加列；
- 在迁移逻辑中为老库补列；
- 更新 `test/migrate-worker.mjs` 覆盖升级路径。

## 5. 测试体系

### 5.1 核心逻辑测试

```bash
node test/simulate-worker.mjs
```

使用本地 SQLite 模拟 D1，直接加载 `worker.mjs`，覆盖 44 项断言：注册、登录、会话、隔离、子地址、一邮多用、管理后台、限流等。

### 5.2 旧库迁移测试

```bash
node test/migrate-worker.mjs
```

构造单用户旧库，验证升级后历史邮件不丢失、别名正确挂到 root 名下。

### 5.3 MIME 解析测试

```bash
node test/edge-cases.mjs
```

覆盖 GBK 编码、缺失头部、LF 换行、multipart 嵌套、附件文件名编码等边界。

### 5.4 端到端冒烟

先启动本地服务，再执行：

```bash
ACCESS_TOKEN=你的口令 node test/live-check.mjs
```

覆盖注册 / 登录 / 隔离 / 子地址 / 后台开关等 37 项。

### 5.5 线上检查

```bash
node scripts/check-worker.mjs
node scripts/check-inbox.mjs 20
node test/check-dns.mjs example.com
```

- `check-worker`：检查线上页面、`/api/bootstrap`、域名列表和口令；
- `check-inbox`：通过 Cloudflare API 直接查 D1 最近的邮件；
- `check-dns`：检查 MX / SPF 是否指向 Cloudflare Email Routing。

## 6. 调试技巧

- 本地启动日志会打印 root 账号、随机密码、数据库路径。
- Cloudflare Worker 日志：控制台 → Workers & Pages → `mailbox` → **Logs**。
- D1 查询：控制台 → D1 → `mailbox` → **Console**。
- 常见错误：
  - `1101` + `Pbkdf2 failed: iteration counts above 100000`：PBKDF2 迭代次数超限；
  - `no such table`：`ensureSchema()` 未执行或 D1 绑定变量名不是 `DB`；
  - `D1_ERROR: string or blob too big`：附件超过 1 MB 限制；
  - `Cannot read properties of undefined (reading 'prepare')`：Worker 没有绑定 D1，或变量名写错。

## 7. 发布检查清单

- [ ] `node build-worker.mjs` 已重新生成 `worker.mjs`
- [ ] `node test/simulate-worker.mjs` 全部通过
- [ ] `node test/migrate-worker.mjs` 全部通过
- [ ] `node test/edge-cases.mjs` 全部通过
- [ ] `rg -n "SECRET_|BEGIN .*PRIVATE KEY|re_[A-Za-z0-9]{12,}"` 无命中
- [ ] README / docs 中的示例域名已替换为 `example.com`
- [ ] 确认 `.env`、`data/`、`config.local.json` 未被提交
- [ ] 更新 `CHANGELOG.md`（如有）
