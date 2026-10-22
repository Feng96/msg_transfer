# 消息传输助手

一个免登录的文字聊天网页。手机和电脑打开**同一个完整房间链接**，即可发送消息并查看共享历史记录。前端每 3 秒检查新消息，消息保存在 Sites D1 数据库。

## 使用

1. 打开网页，发送第一条消息。
2. 点“分享链接”，将完整链接发到另一台设备。链接中的 `#r=...` 是房间密钥，不能省略。
3. 两台设备打开同一链接，就能看到同一段聊天。当前设备会记住最近使用的房间。

任何获得完整链接的人都可以读写该房间。请勿在公开位置发布链接。这个项目目前只传输文字和网址，不传文件。

## 开发与部署

- `web/`：聊天页面、样式和浏览器逻辑。
- `worker/index.js`：消息 API，房间密钥验证、限额和页面响应。
- `drizzle/0000_messages.sql`：D1 数据库迁移。
- `.openai/hosting.json`：Sites 项目 ID 和 D1 绑定。

无需安装 npm 依赖。使用 `node scripts/build.mjs` 构建，`node scripts/validate-artifact.mjs` 验证打包结果，`node --test tests/api.test.mjs` 运行 API 测试。Sites 发布流程会将 `drizzle/` 中的迁移应用到托管数据库。GitHub 仓库只保存源码，在线服务及历史消息由 Sites 托管；单独启用 GitHub Pages 不会提供跨设备同步。

