# 部署指南

本项目有两套运行方式，共用同一份 Worker 逻辑：

| | 方案 A：Cloudflare（推荐） | 方案 B：本机 / 自有服务器 |
| --- | --- | --- |
| 需要 | 域名 + Cloudflare 免费账号 | Node.js ≥ 22.5 的机器 |
| 能收公网邮件 | ✅ Email Routing 直接投递 | 需要公网 IP + 25 端口，或 Cloudflare Tunnel |
| 成本 | 0 元 | 电费 / 服务器租金 |
| 数据位置 | Cloudflare D1 | 本地 `data/mail.db` |
| 适合 | 长期使用、多人共用 | 本地开发、内网、数据完全自持 |

---

# 方案 A：Cloudflare 部署

## 1. 前置条件

- 一个可以修改 NS 的域名（阿里云、腾讯云、Namecheap 等购买均可）。
- Cloudflare 免费账号：<https://dash.cloudflare.com/>。
- 可选：Resend 账号（用于发送注册验证码和找回密码邮件）。

整体链路：

```
发件人 → 任意地址@你的域名
      → Cloudflare Email Routing（catch-all）
      → Email Worker（解析 MIME、识别收件人）
      → D1 数据库
      → 网页收件箱（按用户隔离）
```

## 2. 域名接入 Cloudflare

1. 登录 Cloudflare，点击 **Add a site**，输入域名，选择 **Free** 套餐。
2. Cloudflare 会扫描现有 DNS 记录，并给出两个 Nameserver 地址。
3. 回到域名注册商，把域名的 NS 改成这两个地址。
4. 等待状态变为 **Active**（通常 10 分钟到 24 小时）。

> 修改 NS 后，原来的邮箱服务商 MX 记录会失效。这正是切换到自建收信所需要的。

## 3. 开启 Email Routing

1. Cloudflare 控制台 → 选中域名 → 左侧 **Email** → **Email Routing**。
2. 点击 **Enable Email Routing**。
3. 如果检测到旧 MX 记录，选择删除 / 替换旧记录。
4. Cloudflare 会自动添加：
   - `route1.mx.cloudflare.net`（优先级 21）
   - `route2.mx.cloudflare.net`（优先级 41）
   - `route3.mx.cloudflare.net`（优先级 61）
   - TXT：`v=spf1 include:_spf.mx.cloudflare.net ~all`
5. 等待状态变为 **Ready**。

## 4. 创建 D1 数据库

1. 左侧 **Storage & Databases** → **D1 SQL Database** → **Create database**。
2. 名称填 `mailbox`（可自定义，但后面绑定要一致）。
3. 创建后不需要手动建表，Worker 第一次请求时会自动执行 `ensureSchema()`。

## 5. 创建并部署 Worker

### 5.1 控制台粘贴方式（最简单）

1. 左侧 **Workers & Pages** → **Create** → **Worker**。
2. 名称填 `mailbox`，点击 **Deploy**。
3. 点击 **Edit code**，删除编辑器原有内容。
4. 打开本项目的 [`worker.mjs`](../worker.mjs)，全选复制，粘贴到编辑器。
5. 右上角 **Deploy**。

> `worker.mjs` 是单文件构建产物，已内联 MIME 解析器和前端页面；不要手动修改，改源码后运行 `node build-worker.mjs` 重新生成。

### 5.2 Wrangler CLI 方式（可选）

```bash
npm install -g wrangler
wrangler login
wrangler d1 create mailbox
# 将输出的 database_id 写入 wrangler.toml（参考 wrangler.toml.example）
wrangler deploy
```

项目默认以控制台粘贴为主要部署方式，Wrangler 配置仅作为可选方案。

## 6. 绑定 D1

1. 进入 Worker → **Settings** → **Bindings** → **Add binding**。
2. 类型选择 **D1 database**。
3. **Variable name 必须写 `DB`**（区分大小写）。
4. 选择刚创建的 `mailbox` 数据库，保存。

## 7. 设置环境变量与 Secret

Worker → **Settings** → **Variables and Secrets** → **Add**：

| 名称 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `ACCESS_TOKEN` | Secret | ✅ | root 初始密码 + `/api/ingest` 投递口令，至少 16 位 |
| `RESEND_API_KEY` | Secret | 可选 | Resend API Key，配置后才能自助发送验证码 |
| `MAIL_FROM` | Text | 可选 | 发件人地址，默认 `noreply@你的域名` |
| `MAIL_DOMAIN` | Text | 可选 | 默认域名；不设置时使用数据库中的第一个域名 |

保存后重新 **Deploy** 一次，让变量生效。

## 8. 配置 Catch-all

1. Cloudflare → 选中域名 → **Email Routing** → **Routing rules**。
2. 找到 **Catch-all address** → **Edit**。
3. Action 选择 **Send to a Worker**。
4. 选择 `mailbox` Worker，保存。

现在所有 `任意名字@你的域名` 的邮件都会进入 Worker。

## 9. 绑定自定义域名（可选，但强烈建议）

`workers.dev` 在国内经常无法访问。给 Worker 绑定自己的域名：

1. Worker → **Settings** → **Domains & Routes** → **Add** → **Custom domain**。
2. 填写 `mail.example.com`（该域名需已接入 Cloudflare）。
3. 等待证书签发，之后用 `https://mail.example.com/` 访问。

## 10. 配置 Resend 发信（可选）

不配置也能用，只是注册验证和找回密码会退回「用户发确认邮件」的方式。

1. 注册 <https://resend.com>，**Add Domain**，填写你的域名。
2. 按提示添加 DNS 记录：
   - `resend._domainkey` TXT
   - `rsend` CNAME
   - `send` CNAME
   - CNAME 必须设为 **DNS only**（灰色云朵）
3. 等待域名状态 **Verified**。
4. 在 Resend 创建 API Key（`re_` 开头）。
5. 在 Worker 的 Secrets 中添加 `RESEND_API_KEY`。

可选设置 `MAIL_FROM`，例如 `noreply@example.com`。

## 11. 一键脚本部署（可选）

项目提供 `scripts/setup-cloudflare.mjs`，可自动完成建 D1、部署 Worker、开启 Email Routing、设置 Catch-all。

准备一个有权限的 Cloudflare API Token：

- Account → Workers Scripts → Edit
- Account → D1 → Edit
- Zone → Email Routing Rules → Edit
- Zone → DNS → Edit
- Zone → Zone → Read

执行：

```bash
export CF_TOKEN="你的 Cloudflare API Token"
export DOMAIN="example.com"
export ACCESS_TOKEN="至少16位的登录口令"
node scripts/setup-cloudflare.mjs
```

脚本是幂等的，可重复执行；不会删除已有邮件。执行完会打印收件箱地址和验证结果。

> 如果使用 Windows PowerShell：
>
> ```powershell
> $env:CF_TOKEN="你的 Cloudflare API Token"
> $env:DOMAIN="example.com"
> $env:ACCESS_TOKEN="至少16位的登录口令"
> node scripts/setup-cloudflare.mjs
> ```

## 12. 验证部署

1. 打开 Worker 域名或自定义域名。
2. 用 `admin@你的域名` + `ACCESS_TOKEN` 登录。
3. 注册一个普通账号，例如邮箱名 `demo`。
4. 用其他邮箱给 `demo@你的域名` 和 `demo1@你的域名` 各发一封邮件。
5. 刷新收件箱，两封都应出现，且第二封显示为子地址。

DNS 检查：

```bash
node test/check-dns.mjs example.com
```

---

# 方案 B：本机 / 自有服务器部署

## 1. 环境要求

- Node.js **22.5 或更新版本**（推荐 24）。
- 无需 `npm install`，项目不使用第三方运行时依赖。
- 数据库使用 Node 内置 `node:sqlite`。

检查版本：

```bash
node -v
```

## 2. 启动

```bash
git clone https://github.com/your-account/unlimited-mailbox.git
cd unlimited-mailbox
npm start
```

或 Windows 双击 `start.cmd`。

首次启动会：

- 读取 / 生成 `config.json`；
- 创建 `data/mail.db`；
- 生成 root 随机密码并写入 `data/worker-token.txt`；
- 在 `2525` 端口启动 SMTP 收信，在 `8787` 端口启动网页。

打开 `http://127.0.0.1:8787/`，用启动日志中的 root 账号和密码登录。

## 3. 配置 `config.json`

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `domain` | `example.com` | 邮箱域名，影响 root 账号与地址显示 |
| `port` | `8787` | 网页端口 |
| `smtpPort` | `2525` | SMTP 收信端口；正式收信需改 `25` |
| `maxSizeMB` | `25` | 单封邮件大小上限 |
| `keepDays` | `0` | 自动清理天数，0 为永久保留 |
| `token` | 空 | root 初始密码；留空时读取 `data/worker-token.txt` 或随机生成 |

修改后重启服务生效。

## 4. 收一封测试邮件

另开一个终端：

```bash
node test/send-test-mail.mjs --to admin-demo@example.com
```

刷新网页，左侧 `admin` 下会出现 `admin-demo` 子地址。

批量灌入演示邮件：

```bash
node test/seed-demo.mjs --domain example.com
```

## 5. 接收真实公网邮件

本机版自身监听 SMTP，但家庭宽带通常封禁 25 端口。两种可行方式：

### 5.1 公网 IP + 25 端口

1. 服务器有固定公网 IP，安全组 / 防火墙放行 25 端口；
2. `config.json` 的 `smtpPort` 改为 `25`；
3. 域名 MX 指向服务器公网 IP；
4. 配置 SPF、DKIM 以提高送达率。

### 5.2 Cloudflare Email Routing + `/api/ingest`

让 Cloudflare Worker 收信后转发给本机：

1. 按方案 A 部署 Worker；
2. 用 Cloudflare Tunnel 把本机服务暴露到公网，例如 `https://mail-local.example.com`；
3. 修改 Worker 或使用外部转发脚本，把原始邮件 `POST` 到：

```
POST https://mail-local.example.com/api/ingest?to=demo@example.com&token=你的ACCESS_TOKEN
Content-Type: message/rfc822
<原始邮件字节>
```

也支持 JSON：

```json
{
  "to": "demo@example.com",
  "rawBase64": "base64 编码的原始邮件",
  "text": "纯文本邮件内容"
}
```

## 6. Docker 部署

项目根目录提供 `Dockerfile`：

```bash
docker build -t unlimited-mailbox .
docker run -d --name unlimited-mailbox \
  -p 8787:8787 -p 2525:2525 \
  -v $(pwd)/data:/app/data \
  -e MAIL_DOMAIN=example.com \
  -e ACCESS_TOKEN=至少16位口令 \
  unlimited-mailbox
```

数据通过 `-v ./data:/app/data` 持久化。

## 7. systemd 部署（Linux）

```ini
# /etc/systemd/system/unlimited-mailbox.service
[Unit]
Description=Unlimited Mailbox
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/unlimited-mailbox
ExecStart=/usr/bin/node --no-warnings server.mjs
Restart=always
Environment=MAIL_DOMAIN=example.com
Environment=ACCESS_TOKEN=至少16位口令

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now unlimited-mailbox
sudo systemctl status unlimited-mailbox
```

## 8. Nginx 反向代理

```nginx
server {
    listen 80;
    server_name mail.example.com;

    client_max_body_size 30m;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

HTTPS 可使用 Certbot 或 Cloudflare 代理。

---

# 运维

## 更新 Worker 代码

改完源码后：

```bash
node build-worker.mjs
export CF_TOKEN="你的 Cloudflare API Token"
export DOMAIN="example.com"
node scripts/deploy-worker.mjs
```

或直接在 Cloudflare 控制台粘贴新的 `worker.mjs`。已有的 Bindings 和 Secrets 不会因粘贴代码而改变。

## 回滚 MX 记录

如果要从 Cloudflare Email Routing 切回原来的邮箱服务商：

```bash
export CF_TOKEN="你的 Cloudflare API Token"
node scripts/restore-mx.mjs
```

脚本会把腾讯企业邮的 MX 写回。使用前请确认原服务仍可用。

## 备份

- **Cloudflare 版**：D1 控制台支持导出 SQL；重要邮件可在网页端下载 `.eml`。
- **本机版**：复制 `data/` 目录即可，`mail.db` 是完整 SQLite 数据库。
- 建议定期备份 `data/` 或 D1 导出文件，并保存到另一台机器。

## 多域名

1. 新域名接入同一 Cloudflare 账号；
2. 开启 Email Routing，Catch-all 指向同一个 Worker；
3. 管理后台 → 域名 → 添加；
4. 用户注册时即可选择新域名。

## 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 网页提示「服务端还没有配置 ACCESS_TOKEN」 | 添加 Secret `ACCESS_TOKEN` 后重新 Deploy |
| 邮件被退回 550 | Catch-all 未指向 Worker，或收件地址未注册 |
| 一直收不到信 | 检查 Email Routing 是否 Ready、Catch-all 是否正确、Worker 日志 |
| 部分信进入旧邮箱 | 旧 MX 未删干净，DNS 中应只剩 `route*.mx.cloudflare.net` |
| `workers.dev` 打不开 | 绑定自定义域名 |
| D1 报错 `no such table` | Worker 第一次请求会自动建表；检查 D1 绑定变量名是否为 `DB` |
| 附件丢失 | 超过 900 KB 的附件受 D1 单行 1 MB 限制，不会保存 |
| PBKDF2 报错 `iteration counts above 100000` | Cloudflare WebCrypto 上限为 100000，不要调高 |
| 忘记 root 密码 | 用 `ACCESS_TOKEN` 登录，或让其他管理员重置 |
