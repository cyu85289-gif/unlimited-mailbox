# 贡献指南

欢迎提交 Issue 和 Pull Request。

## 开发流程

1. Fork 仓库并创建分支：`git checkout -b feature/your-feature`
2. 修改源码（不要直接改 `worker.mjs`）。
3. 重新构建：`node build-worker.mjs`
4. 运行测试：
   ```bash
   node test/simulate-worker.mjs
   node test/migrate-worker.mjs
   node test/edge-cases.mjs
   ```
5. 提交 PR，说明改动内容和测试结果。

## 代码风格

- 使用 2 空格缩进、单引号、分号。
- 保持零第三方运行时依赖。
- `worker.template.mjs` 中不要使用 `import` 和 Node 专有模块。
- 新增接口必须带权限校验和输入校验。
- 数据库查询必须带 `user_id` 条件（用户侧接口）。

## 提交信息

推荐使用简洁的英文或中文：

```
feat: add invite-code registration
fix: handle GBK encoded subject
docs: update deployment guide
```

## 安全问题

请阅读 [SECURITY.md](SECURITY.md)，不要公开披露漏洞细节。
