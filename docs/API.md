# HTTP API 参考

Base URL：`https://mail.example.com`（或你的 Worker 域名）。所有接口返回 JSON，编码为 UTF-8。

## 通用约定

### 认证方式

- 网页会话：登录后服务端设置 Cookie `mb_sess=<token>`，后续请求自动携带。
- 管理接口：除登录态外，用户角色必须为 `admin` 或 `root`。
- 投递接口 `/api/ingest`：使用请求头 `x-token: <ACCESS_TOKEN>` 或查询参数 `?token=<ACCESS_TOKEN>`。

### 响应格式

成功：

```json
{ "ok": true, "...": "..." }
```

失败：

```json
{ "ok": false, "error": "错误说明" }
```

### 常见状态码

| 状态码 | 含义 |
| --- | --- |
| 200 | 成功 |
| 400 | 请求参数错误 |
| 401 | 未登录 / 口令错误 |
| 403 | 权限不足 / 账号停用 |
| 404 | 资源不存在 |
| 409 | 地址冲突 / 状态冲突 |
| 413 | 请求体过大 |
| 429 | 请求过于频繁 |
| 500 | 服务端错误 |
| 502 | 上游发信服务失败 |

---

## 1. 认证

### `POST /api/auth/verify/start`

发送注册邮箱验证码。

请求：

```json
{ "email": "user@qq.com" }
```

响应：

```json
{
  "ok": true,
  "mode": "code",
  "token": "验证会话 token",
  "expiresIn": 600,
  "sentTo": "u***@qq.com",
  "hint": "验证码已发到 u***@qq.com，10 分钟内有效"
}
```

说明：需要服务端配置 `RESEND_API_KEY`；未配置返回 503。

### `POST /api/auth/verify/confirm`

校验注册验证码。

```json
{ "token": "验证会话 token", "code": "123456" }
```

成功：`{ "ok": true, "verified": true, "email": "user@qq.com" }`

### `GET /api/auth/verify/status?token=...`

查询验证状态：

```json
{ "ok": true, "verified": false, "expired": false, "email": "user@qq.com" }
```

### `POST /api/auth/register`

注册并自动登录。

```json
{
  "email": "user@qq.com",
  "password": "至少8位",
  "phone": "13800138000",
  "nickname": "小明",
  "mailbox": "bili",
  "domain": "example.com",
  "token": "验证会话 token"
}
```

响应：

```json
{ "ok": true, "user": { "id": "...", "email": "user@qq.com", "role": "user" } }
```

同时返回 `Set-Cookie: mb_sess=...`。

### `POST /api/auth/login`

```json
{ "email": "user@qq.com", "password": "密码" }
```

应急方式（旧接口兼容）：只传 `password` 且等于 `ACCESS_TOKEN`，直接以 root 登录：

```json
{ "password": "ACCESS_TOKEN" }
```

成功返回用户信息与 `Set-Cookie`。

### `GET /api/auth/qq`

QQ 互联预留接口，当前返回 501：

```json
{ "ok": false, "error": "QQ 一键登录待接入...", "code": "QQ_OAUTH_NOT_CONFIGURED" }
```

### `POST /api/auth/logout`

删除当前会话并清除 Cookie：

```json
{ "ok": true }
```

### `POST /api/auth/reset/start`

申请找回密码验证码：

```json
{ "email": "user@qq.com" }
```

响应：`{ "ok": true, "sentTo": "u***@qq.com", "expiresIn": 600 }`

### `POST /api/auth/reset/confirm`

```json
{ "email": "user@qq.com", "code": "123456", "password": "新密码" }
```

成功后该用户所有旧会话失效。

---

## 2. 启动信息

### `GET /api/bootstrap`

未登录时返回公开配置：

```json
{
  "ok": true,
  "authenticated": false,
  "domain": "example.com",
  "config": { "smsEnabled": false, "requireQQ": true, "mailerEnabled": true }
}
```

已登录时返回完整启动数据：

```json
{
  "ok": true,
  "authenticated": true,
  "user": { "id": "...", "email": "...", "role": "user", "nickname": "..." },
  "domain": "example.com",
  "domains": [{ "name": "example.com" }],
  "mailboxes": [
    {
      "id": "...",
      "localPart": "bili",
      "domain": "example.com",
      "label": "主邮箱",
      "subaddresses": [{ "localPart": "bili-shop", "source": "manual" }]
    }
  ],
  "mailbox": "当前选中的邮箱 ID",
  "externals": [],
  "messages": [],
  "total": 0,
  "stats": { "mailboxes": 1, "messages": 0, "unread": 0, "bytes": 0 },
  "caps": { "realtime": false, "eml": false, "multiUser": true, "admin": false },
  "config": {
    "subAddressAuto": true,
    "smsEnabled": false,
    "keepDays": 0,
    "requireQQ": true,
    "catchAll": true
  }
}
```

可选查询参数 `?mailbox=<id>` 指定当前邮箱。

---

## 3. 邮件投递

### `POST /api/ingest`

供外部 SMTP 网关 / Cloudflare Worker 投递原始邮件。需要 `ACCESS_TOKEN`。

请求头：

```
x-token: <ACCESS_TOKEN>
Content-Type: message/rfc822
```

查询参数：`?to=demo@example.com`（多个收件人用逗号分隔）。

也支持 JSON：

```json
{
  "to": "demo@example.com",
  "rawBase64": "base64 编码的原始邮件",
  "text": "纯文本内容"
}
```

响应：

```json
{ "ok": true, "saved": [{ "mailboxId": "...", "alias": "demo", "messageId": "..." }] }
```

限制：原始邮件不超过 25 MB。

---

## 4. 个人资料

### `POST /api/me`

修改昵称、手机号、密码。

```json
{
  "nickname": "新昵称",
  "phone": "13800138000",
  "oldPassword": "当前密码",
  "password": "新密码"
}
```

- 修改手机号需要 `oldPassword`；
- 修改密码需要 `oldPassword`；
- 新密码至少 8 位。

响应：`{ "ok": true, "user": { ... } }`

### `POST /api/me/email`

换绑登录邮箱，需要先完成新邮箱验证。

```json
{
  "email": "new@qq.com",
  "password": "当前密码",
  "token": "验证会话 token"
}
```

成功返回更新后的用户信息。

---

## 5. 邮箱与子地址

### `GET /api/mailboxes`

```json
{
  "ok": true,
  "mailboxes": [
    {
      "id": "...",
      "localPart": "bili",
      "domain": "example.com",
      "label": "主邮箱",
      "subaddresses": [
        { "localPart": "bili-shop", "source": "manual" },
        { "localPart": "bili-qq", "source": "external" }
      ]
    }
  ]
}
```

### `POST /api/mailboxes`

新建主邮箱（普通用户限 1 个，admin / root 不限）。

```json
{ "name": "bili", "domain": "example.com", "label": "主邮箱" }
```

### `PATCH /api/mailboxes/:id`

修改邮箱标签：

```json
{ "label": "工作邮箱" }
```

### `DELETE /api/mailboxes/:id`

删除邮箱及其所有邮件、子地址、附件。不可恢复。

### `POST /api/subaddresses`

新建子地址。`name` 可以只写后缀，系统自动补成 `主邮箱名-后缀`。

```json
{ "name": "shop" }
```

响应：

```json
{
  "ok": true,
  "localPart": "bili-shop",
  "address": "bili-shop@example.com",
  "mailboxes": [...]
}
```

### `DELETE /api/subaddresses/:name`

删除子地址。自动登记的子地址会变成 `blocked` 墓碑，之后来信拒收；手动子地址直接删除。已收到的邮件保留。

---

## 6. 一邮多用

### `GET /api/external`

```json
{
  "ok": true,
  "externals": [
    {
      "id": "...",
      "provider": "qq",
      "address": "123456@qq.com",
      "intakeLocal": "bili-qq",
      "intakeDomain": "example.com",
      "status": "active",
      "mailCount": 12
    }
  ],
  "providers": [{ "key": "qq", "name": "QQ 邮箱", "hint": "设置 → 账户 → 自动转发" }]
}
```

### `POST /api/external`

```json
{ "provider": "qq", "address": "123456@qq.com", "label": "我的QQ" }
```

响应：

```json
{
  "ok": true,
  "external": {
    "id": "...",
    "intakeLocal": "bili-qq",
    "intakeDomain": "example.com",
    "status": "active"
  },
  "externals": [...]
}
```

### `DELETE /api/external/:id`

停用接入并删除对应子地址；已收邮件保留。

---

## 7. 邮件

### `GET /api/messages`

查询参数：

| 参数 | 说明 |
| --- | --- |
| `mailboxId` / `mailbox` | 按主邮箱筛选 |
| `alias` | 按子地址 local part 筛选 |
| `q` | 搜索发件人、主题、摘要 |
| `limit` | 条数，默认 60，最大 200 |
| `offset` | 偏移量，默认 0 |

响应：

```json
{
  "ok": true,
  "messages": [
    {
      "id": "...",
      "mailboxId": "...",
      "alias": "bili-shop",
      "to": "bili-shop@example.com",
      "from": { "name": "GitHub", "address": "noreply@github.com" },
      "subject": "验证码",
      "snippet": "你的验证码是 123456",
      "date": 1760000000000,
      "size": 12345,
      "unread": true,
      "extSource": ""
    }
  ],
  "total": 1,
  "stats": { "mailboxes": 1, "messages": 1, "unread": 1, "bytes": 12345 }
}
```

### `GET /api/messages/:id`

读取邮件详情，同时标记为已读：

```json
{
  "ok": true,
  "message": {
    "id": "...",
    "alias": "bili-shop",
    "to": "bili-shop@example.com",
    "from": { "name": "GitHub", "address": "noreply@github.com" },
    "subject": "验证码",
    "text": "纯文本正文",
    "html": "<p>HTML 正文</p>",
    "attachments": [
      {
        "id": 1,
        "filename": "账单.pdf",
        "contentType": "application/pdf",
        "size": 1234,
        "url": "/api/attachments/1"
      }
    ]
  }
}
```

### `DELETE /api/messages/:id`

删除邮件及其附件。

### `GET /api/messages/:id/eml`

下载原始邮件，`Content-Type: message/rfc822`。

### `POST /api/messages/read-all`

```json
{ "mailboxId": "可选，不传则全部邮箱" }
```

### `GET /api/attachments/:id`

下载附件。服务端会校验附件所属邮件是否属于当前用户。

---

## 8. 管理后台

以下接口需要 `admin` 或 `root` 角色，否则返回 403。

### `GET /api/admin/overview`

```json
{
  "ok": true,
  "stats": {
    "users": 10,
    "activeUsers": 9,
    "mailboxes": 15,
    "messages": 100,
    "unread": 5,
    "bytes": 123456,
    "domains": 1,
    "sessions": 3
  },
  "domains": [{ "name": "example.com", "mailboxes": 15, "total": 100 }],
  "config": {
    "subAddressAuto": true,
    "smsEnabled": false,
    "requireQQ": true,
    "catchAll": true,
    "keepDays": 0
  },
  "dropped": [
    { "domain": "example.com", "localPart": "nobody", "fromAddr": "a@b.com", "subject": "hi", "date": 1760000000000 }
  ]
}
```

### `GET /api/admin/users?q=关键词`

返回用户列表，含邮箱数、邮件数、未读、占用空间、主地址。手机号脱敏。

### `PATCH /api/admin/users/:id`

```json
{ "status": "disabled", "role": "admin", "nickname": "新昵称", "phone": "13800138000" }
```

字段均可选。停用会清除该用户所有会话。

### `DELETE /api/admin/users/:id`

级联删除用户及其邮箱、子地址、邮件、附件、会话。不能删除自己或 root。

### `POST /api/admin/users/:id/reset-password`

生成 10 位临时密码并清空该用户会话：

```json
{ "ok": true, "password": "Ab3xY9kL2m" }
```

### `GET /api/admin/mailboxes`

列出全部主邮箱（含所属用户、邮件数、子地址数）。

### `POST /api/admin/mailboxes`

给指定用户分配主邮箱：

```json
{ "userId": "用户ID", "name": "newbox", "domain": "example.com", "label": "管理员分配" }
```

也支持用 `email` 代替 `userId`。

### `GET /api/admin/domains`

返回域名列表。

### `POST /api/admin/domains`

```json
{ "name": "mail.example.com", "note": "备用域名" }
```

### `PATCH /api/admin/domains/:name`

```json
{ "note": "新备注" }
```

### `DELETE /api/admin/domains/:name`

删除域名及其下所有邮箱、子地址、邮件。不可恢复。

### `POST /api/admin/config`

更新全局开关，字段均可选：

```json
{
  "subAddressAuto": true,
  "requireQQ": false,
  "smsEnabled": false,
  "catchAll": true,
  "keepDays": 30
}
```

`keepDays = 0` 表示永久保留。

---

## 9. 静态资源

非 `/api/*` 的 GET / HEAD 请求返回内联在 `worker.mjs` 中的前端资源：

- `/` → `index.html`
- `/index.html`
- `/app.js`
- `/style.css`

不存在的路径返回 404 纯文本。
