# 测试报告 — theme-publisher 1.0.1

测试基线：SillyTavern 1.19.0 release 的 UI Extension / Theme 结构。

## 已执行

- `manifest.json` / `index.js` / `src/*.js`：Node 语法检查通过。
- CSS `url(...)` 扫描：双引号、单引号、无引号、CSS 变量、`background-image`、`mask-image`、重复 URL 均通过。
- `@import`：保持原内容，不纳入素材迁移。
- CSS 注释和普通字符串中的伪 `url(...)`：不会误扫描。
- PNG / JPEG / WebP / GIF / SVG / AVIF：二进制特征识别通过。
- SHA-256：浏览器同算法测试向量通过。
- 去重：相同二进制 Hash 只保留一个 canonical asset。
- GitHub Git Data API：使用 mock REST 响应完整跑通 `branch HEAD -> tree -> blob -> tree -> commit -> PATCH ref`，验证一次发布只创建一个 commit；已有文件直接复用。
- jsDelivr URL：完整 commit SHA + UTF-8 主题目录路径编码通过。
- 私有仓库保护：连接测试会拒绝 private repo，避免 jsDelivr 不可用。
- 20 MB 单文件保护：常量和扫描保护已加入。
- 发布版 JSON：序列化/反序列化通过；按 SillyTavern 1.19.0 `getNewTheme()` 的字段消费逻辑验证 `name`、主题字段和 `custom_css` 可正常读取；未知字段仍保留在发布 JSON 中。
- PC 布局：Chromium 1440×900 实测，面板 680×760，固定居中，不溢出视口，素材区内部滚动。
- 手机布局：Chromium 390×844 实测，面板 376×830，四边保留 7px 安全空间，不溢出视口，内部滚动，移动端主要按钮最小高度 44px。
- 半透明主题背景：使用低 alpha `--SmartThemeBlurTintColor` 实测，面板会强制提升为约 0.97 alpha，不会跟着主题透明到难以阅读。

## 无法在无凭据环境中替用户执行的测试

没有填写真实 `GITHUB_OWNER / GITHUB_REPO / GITHUB_BRANCH / GITHUB_TOKEN`，因此没有对你的真实素材仓库执行写入。真实 GitHub 写入前请先点插件中的 **测试 GitHub 连接**。GitHub 写入所需 REST 流程已按官方 Git Data API 结构实现并用 mock 集成测试覆盖。

## 最终发布版兼容性

输出文件仍是普通 SillyTavern Theme JSON；插件不会往 JSON 中加入运行时依赖或 Token。普通用户导入时只会看到被替换后的 `custom_css` CDN URL，因此不要求安装 theme-publisher。


## v1.0.1 regression

- Added a fetch receiver-binding regression test. Native-style fetch is now invoked with `globalThis` as receiver, preventing `Failed to execute 'fetch' on 'Window': Illegal invocation`.
