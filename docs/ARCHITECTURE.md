# 技术架构

本文说明项目内部如何运转，适合需要二次开发、审计或排查问题的读者。使用操作见 [USAGE.md](USAGE.md)，部署步骤见 [DEPLOYMENT.md](DEPLOYMENT.md)。

---

## 1. 总体架构

```
┌─────────────────────────────┐
│        浏览器（网页端）       │
│  public/index.html + app.js  │
└──────────────┬──────────────┘
               │ HTTPS / JSON
┌──────────────▼──────────────┐
│      Worker / Node HTTP      │
│  worker.template.mjs         │
│  ├─ 会话与权限               │
│  ├─ 邮箱 / 子地址 / 邮件 API │
│  ├─ 管理后台 API             │
│  └─ 静态资源（内联）          │
└───────┬──────────────┬───────┘
        │              │
        │ D1 / SQLite  │ Resend HTTP API（可选）
┌───────▼───────┐  ┌───▼─────────────┐
│  数据库        │  │  发信通道        │
│  D1 / mail.db │  │  验证码 / 找回    │
└───────────────┘  └─────────────────┘
        ▲
        │ Email Routing / SMTP
┌───────┴──────────────────────┐
│  Cloudflare Email Worker      │
│  worker.email(message, env)   │
│  → parseMime → storeIncoming  │
└──────────────────────────────┘
```

三种运行形态共用同一套业务代码：

1. **Cloudflare Worker**：`worker.mjs` 同时导出 `fetch`（HTTP）和 `email`（收信）两个入口，数据库为 D1。
2. **本机 Node**：`server.mjs` 用 `node:sqlite` 实现 D1 兼容层，把所有 HTTP 请求交给 `worker.fetch()`，SMTP 收信交给 `worker.email()`。
3. **测试环境**：`test/simulate-worker.mjs` 在本地 SQLite 上直接加载 `worker.mjs`，模拟 Cloudflare 的 `env.DB`。

因此本地行为与线上行为保持一致，差异只在数据库驱动和静态资源读取方式。

---

## 2. 代码组织与构建

### 2.1 源文件

| 文件 | 职责 |
| --- | --- |
| `worker.template.mjs` | Worker 主逻辑：路由、认证、数据访问、管理后台、邮件入库 |
| `mime.mjs` | 零依赖 MIME 解析器：头部解码、multipart、附件、HTML/纯文本提取 |
| `public/index.html` | 页面结构 |
| `public/app.js` | 前端状态与交互 |
| `public/style.css` | 样式 |
| `build-worker.mjs` | 构建脚本：把 MIME 解析器和前端资源内联进模板，生成 `worker.mjs` |
| `server.mjs` | 本地版 HTTP + SMTP 入口，D1 → SQLite 适配 |
| `smtp.mjs` | 零依赖 SMTP 服务端，接收邮件后调用 `worker.email()` |

### 2.2 构建流程

```bash
node build-worker.mjs
```

执行逻辑：

1. 读取 `mime.mjs` 和 `worker.template.mjs`；
2. 读取 `public/index.html`、`app.js`、`style.css`，序列化为 `ASSETS` 对象；
3. 替换模板中的 `/*__MIME__*/` 和 `/*__ASSETS__*/` 占位符；
4. 检查残留占位符与 `import` 语句；
5. 写出单文件 `worker.mjs`。

`worker.mjs` 是**生成物**，不要直接修改；所有改动都应落在模板或 `public/`，然后重新构建。

### 2.3 零依赖约束

- Worker 代码不能包含 `import`，因为 Cloudflare 控制台要求单文件自包含。
- Node 版只使用内置模块（`node:http`、`node:sqlite`、`node:crypto` 等），不依赖 npm 包。
- 测试同样不引入外部框架，使用自定义断言函数。

---

## 3. 数据模型

所有表在第一次请求时由 `ensureSchema()` 自动创建；老库会执行 `migrateLegacy()` 补列和迁移。

### 3.1 `domains`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `name` | TEXT PK | 域名，例如 `example.com` |
| `note` | TEXT | 备注 |
| `created_at` | INTEGER | 创建时间（毫秒时间戳） |

### 3.2 `users`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | 用户 ID |
| `email` | TEXT UNIQUE | 登录邮箱（QQ 邮箱等） |
| `pass_hash` | TEXT | `pbkdf2$100000$<salt>$<hash>` |
| `phone` | TEXT | 手机号，可空 |
| `nickname` | TEXT | 昵称 |
| `role` | TEXT | `user` / `admin` / `root` |
| `status` | TEXT | `active` / `disabled` |
| `created_at` | INTEGER | 创建时间 |
| `last_login_at` | INTEGER | 最后登录时间 |

### 3.3 `sessions`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `token_hash` | TEXT PK | 会话明文令牌的 SHA-256 |
| `user_id` | TEXT | 所属用户 |
| `created_at` / `expires_at` | INTEGER | 创建 / 过期时间（30 天） |
| `ip` / `ua` | TEXT | 登录来源信息 |

### 3.4 `mailboxes`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | 邮箱 ID |
| `user_id` | TEXT | 所属用户 |
| `local_part` | TEXT | 邮箱名前缀 |
| `domain` | TEXT | 域名 |
| `label` | TEXT | 标签（`主邮箱`、`历史别名` 等） |
| `created_at` | INTEGER | 创建时间 |

约束：`UNIQUE(domain, local_part)`，保证地址全局唯一。

### 3.5 `subaddresses`

记录已登记的子地址。

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | 子地址 ID |
| `mailbox_id` | TEXT | 归属主邮箱 |
| `local_part` / `domain` | TEXT | 完整地址 |
| `source` | TEXT | `auto` / `manual` / `external` / `blocked` |
| `created_at` | INTEGER | 创建时间 |

`blocked` 是删除自动子地址后的墓碑：侧栏不再显示，来信直接丢弃。

### 3.6 `messages`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | 邮件 ID |
| `mailbox_id` | TEXT | 归属主邮箱 |
| `domain` | TEXT | 域名 |
| `alias` | TEXT | 实际收件人 local part |
| `to_addr` | TEXT | 完整收件地址 |
| `from_name` / `from_addr` | TEXT | 发件人 |
| `subject` / `snippet` | TEXT | 主题 / 摘要 |
| `date` | INTEGER | 邮件时间 |
| `size` | INTEGER | 原始大小 |
| `raw` | BLOB | 原始邮件（用于导出 `.eml`） |
| `text_body` / `html_body` | TEXT | 解析后的正文 |
| `unread` | INTEGER | 1 未读 / 0 已读 |
| `created_at` | INTEGER | 入库时间 |
| `ext_source` | TEXT | 一邮多用来源（`qq`、`gmail` 等） |

### 3.7 `attachments`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | INTEGER PK | 附件 ID |
| `message_id` | TEXT | 所属邮件 |
| `idx` | INTEGER | 附件序号 |
| `filename` / `content_type` | TEXT | 文件名 / MIME 类型 |
| `size` | INTEGER | 大小 |
| `cid` | TEXT | Content-ID（内嵌图片） |
| `data` | BLOB | 附件内容，超过 900 KB 不保存 |

### 3.8 其他表

- `external_accounts`：外部邮箱转发绑定（provider、address、intake_local/domain、status、mail_count）。
- `settings`：全局开关键值对（`subAddressAuto`、`requireQQ`、`smsEnabled`、`catchAll`、`keepDays`、`domain`）。
- `dropped_mail`：未登记地址被丢弃的审计记录。
- `login_attempts`：登录限流记录。
- `signup_verifications`：注册邮箱验证（token、code、status、expires_at）。
- `reset_codes`：找回密码验证码。

### 3.9 索引

`messages(domain, date)`、`messages(date)`、`messages(mailbox_id, date)`、`attachments(message_id)`、`mailboxes(user_id)`、`subaddresses(mailbox_id)`、`sessions(user_id)`、`users(phone)`、`external_accounts(user_id)`、`external_accounts(intake_domain, intake_local)`。

---

## 4. 身份与权限

### 4.1 角色

| 角色 | 权限 |
| --- | --- |
| `user` | 自己的邮件、自己的邮箱/子地址、账号设置 |
| `admin` | 普通用户权限 + 管理后台（用户、域名、全局开关） |
| `root` | 超级管理员；不能被停用、删除或改角色 |

### 4.2 认证流程

1. 用户提交登录邮箱 + 密码。
2. `verifyPassword()` 解析 `pbkdf2$迭代次数$盐$哈希`，用 WebCrypto 重新派生并恒定时间比较。
3. 成功后生成 32 字节随机令牌，`Set-Cookie: mb_sess=<token>; HttpOnly; SameSite=Lax`。
4. 数据库只保存令牌的 SHA-256，不保存明文。
5. 每次请求 `currentUser()` 从 Cookie 读取令牌，哈希后查 `sessions`，校验过期时间并关联用户。

### 4.3 应急口令

`ACCESS_TOKEN` 具有双重用途：

- root 账号的初始密码；
- `POST /api/ingest` 的投递口令。

登录接口允许只提交 `password`（不提交邮箱）且等于 `ACCESS_TOKEN` 时直接以 root 身份登录，用于忘记密码或自动化场景。

### 4.4 租户隔离

所有邮件、邮箱、子地址、外部邮箱查询都带 `user_id` 条件。访问不属于自己的资源统一返回 404，避免泄露资源存在性。

---

## 5. 收信流程

### 5.1 Cloudflare Email Worker

```js
async email(message, env, ctx) {
  await ensureSchema(env);
  const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
  const parsed = parseMime(raw);
  const to = message.to || (parsed.to[0] && parsed.to[0].address) || '';
  await storeIncoming(env, raw, parsed, [to]);
}
```

### 5.2 `storeIncoming()` 步骤

对每个收件人：

1. **归一化地址**：拆出 `local` 与 `domain`，统一小写。
2. **解析归属**：
   - 先精确匹配 `mailboxes(domain, local_part)`；
   - 再在同域名主邮箱中查找满足 `isSubOf(local, main)` 且 `local_part` 最长的候选（最长前缀优先，避免 `bili` 与 `bili-shop` 冲突）。
3. **未命中**：
   - `catchAll` 开启 → 投到 root 的「未登记地址」邮箱（`local_part = catchall`），`alias` 保留真实收件人；
   - `catchAll` 关闭 → 写入 `dropped_mail` 并丢弃。
4. **子地址登记**：命中子地址且尚未登记时，`subAddressAuto` 开启则写入 `subaddresses(source = auto)`；关闭则丢弃。
5. **外部邮箱入口**：先按 `(intake_domain, intake_local)` 查 `external_accounts`，命中则把 `messages.ext_source` 写成 provider。
6. **入库**：插入 `messages`，附件逐条插入 `attachments`；超过 900 KB 的附件跳过。
7. **清理**：`keepDays > 0` 时按概率抽样删除过期邮件（降低每次收信的开销）。

### 5.3 子地址判定

```js
function isSubOf(local, main) {
  if (!local || !main || local === main) return false;
  if (!local.startsWith(main)) return false;
  const rest = local.slice(main.length);
  if (/^\d+$/.test(rest)) return true;      // bili1, bili2024
  return /^[-._+]/.test(rest);              // bili-shop, bili.shop, bili_x, bili+x
}
```

注册与建邮箱时 `nameConflict()` 会双向检查：新名字不能吞并已有主邮箱，也不能被已有主邮箱吞并。

---

## 6. HTTP 请求流程

```
请求 → worker.fetch()
  ├─ ensureSchema()         建表 / 迁移 / 确保 root
  ├─ /api/* → handleApi()
  │    ├─ currentUser()     解析会话
  │    ├─ 认证接口          无需登录
  │    ├─ /api/ingest       校验 ACCESS_TOKEN
  │    ├─ 业务接口          要求登录
  │    └─ /api/admin/*      要求 admin / root
  └─ 其他路径 → serveAsset() 从内联 ASSETS 返回静态文件
```

错误统一返回：

```json
{ "ok": false, "error": "错误说明" }
```

HTTP 状态码：`400` 参数错误、`401` 未登录、`403` 权限不足、`404` 不存在、`409` 冲突、`413` 过大、`429` 限流、`500` 服务端错误、`502` 上游发信失败。

---

## 7. 一邮多用

`external_accounts` 一行代表「外部邮箱 → 本站入口地址」的绑定：

1. 用户选择 provider、填写外部地址；
2. `createExternal()` 生成 `主邮箱名-后缀@域名` 的入口地址（重名自动加序号）；
3. 同时写入 `subaddresses(source = external)`，让入口在侧栏可见；
4. 外部邮箱的自动转发把信发到入口；
5. `storeIncoming()` 先匹配 `external_accounts`，命中后给邮件打 `ext_source` 标签；
6. 删除接入时把 `status` 改为 `disabled` 并删除子地址记录；入口地址保留为墓碑，后续来信直接丢弃。

设计上不使用 IMAP：Workers 没有长连接 TCP，且保存第三方邮箱密码风险更高。自动转发是各邮箱官方支持的功能，验证邮件也会进入本站收件箱。

---

## 8. 发信通道

`hasMailer(env)` 检查 `RESEND_API_KEY` 是否存在。`sendMail()` 调用 Resend HTTP API：

```http
POST https://api.resend.com/emails
Authorization: Bearer <RESEND_API_KEY>
Content-Type: application/json

{
  "from": "noreply@example.com",
  "to": "user@qq.com",
  "subject": "...",
  "text": "...",
  "html": "..."
}
```

未配置时：

- 注册页提示用户改用「发确认邮件」方式；
- 忘记密码提示联系管理员重置；
- 系统其他功能不受影响。

---

## 9. 安全设计

| 项目 | 实现 |
| --- | --- |
| 密码存储 | PBKDF2-SHA256，100,000 次迭代，16 字节随机盐，格式 `pbkdf2$...` |
| 会话 | 32 字节随机令牌，库中只存 SHA-256；Cookie `HttpOnly` + `SameSite=Lax` |
| 登录限流 | 同一 `IP + 邮箱` 15 分钟 20 次失败锁定；验证码接口单独限流 |
| 越权防护 | 所有资源查询绑定 `user_id`；管理员接口统一检查角色 |
| XSS | 前端输出转义；邮件 HTML 放在 `sandbox` iframe，禁用脚本 |
| 附件下载 | `Content-Disposition: attachment`、`X-Content-Type-Options: nosniff` |
| 路径穿越 | 本地静态文件服务限制在 `public/` 目录内 |
| 请求大小 | HTTP 30 MB，邮件 25 MB，D1 单行 1 MB |
| 密钥管理 | `ACCESS_TOKEN`、`RESEND_API_KEY` 只存 Worker Secret 或服务端环境变量 |

### 已知限制

- 只收不发（除验证码 / 找回密码的系统邮件）。
- D1 单行 1 MB，大附件不落库。
- Cloudflare WebCrypto PBKDF2 上限 100,000 次，不能调高。
- 手机号短信验证仅为预留开关。
- `ACCESS_TOKEN` 同时作为 root 初始密码和投递口令，部署后应尽快修改 root 网页密码；但 `ACCESS_TOKEN` 本身仍应妥善保管。

---

## 10. 扩展点

| 需求 | 建议改法 |
| --- | --- |
| QQ 互联登录 | 实现 `/api/auth/qq` 的 code → openid 流程，在 `users` 加 `qq_openid` 列 |
| 短信验证码 | 接入短信服务，在注册 / 换绑手机号流程中校验 `smsEnabled` |
| 邀请码 / 注册审核 | 增加 `inviteOnly` 设置与邀请码表 |
| 邮件转发到真实邮箱 | 收信后调用 `sendMail()` 转发一份到用户绑定邮箱 |
| 验证码高亮 | 在 `messages.snippet` 入库前正则提取 4–6 位数字，前端展示 |
| 全文搜索 | D1 支持 FTS5 时可建虚拟表；当前使用 `LIKE` 模糊匹配 |
| 多租户团队 | 增加 `organizations` 表和 `users.org_id`，把权限检查扩展到组织级 |
