# 安全政策

## 报告安全问题

请不要在公开 Issue 中披露安全漏洞。请通过以下方式私下联系维护者：

- 邮箱：`security@example.com`（替换为你自己的联系方式）
- 或在 GitHub 使用 **Security → Report a vulnerability**

报告时请包含：

- 受影响的版本 / commit；
- 复现步骤或 PoC；
- 影响范围（越权、XSS、SSRF、信息泄露等）；
- 建议的修复方式（可选）。

我们会在 72 小时内确认收到，并在修复后公开致谢（如果你愿意）。

## 支持范围

| 版本 | 支持 |
| --- | --- |
| 最新 main 分支 | ✅ |
| 更早版本 | 尽力而为 |

## 部署者注意事项

- 部署后立即修改 root 网页密码；`ACCESS_TOKEN` 只保存在 Worker Secret 中。
- 不要将 `.env`、`data/`、`worker-token.txt` 提交到版本库。
- 生产环境务必启用 HTTPS。
- 定期备份 D1 或 `data/mail.db`。
- 如果站点开放公网注册，建议开启 `requireQQ`，并根据需要增加邀请码 / 注册审核。
