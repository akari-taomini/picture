# SillyTavern 主题素材发布助手

面向 SillyTavern 主题创作者的第三方 UI Extension。制作阶段可以继续使用任意外部图片链接；发布时由插件扫描主题 `custom_css`，下载图片、计算 SHA-256、按主题目录提交到固定 GitHub 素材仓库，并把图片 URL 改写为固定 commit 的 jsDelivr 地址。最终输出仍是普通 SillyTavern Theme JSON，主题使用者不需要安装本插件。

## 兼容基线

- 按 SillyTavern **1.19.0 release** 的 Extension/Theme 结构实现。
- 使用 `manifest.json -> index.js/style.css` UI Extension 形式。
- 入口：魔法棒 `#extensionsMenuButton` -> **主题发布**。
- 读取当前主题时，使用 `SillyTavern.getContext().powerUserSettings`，字段与 1.19.0 官方 `getThemeObject()` 对齐。
- JSON 文件模式不依赖 SillyTavern 内部主题列表，是推荐、稳定的核心入口。

## 先填写 GitHub 配置

打开 `index.js` 顶部，只改下面四项：

```js
export const CONFIG = Object.freeze({
    githubOwner: 'akari-taomini',
    githubRepo: 'picture',
    githubBranch: 'main',
    githubToken: 'GITHUB_TOKEN', // 你只需要填写这一项
});
```

例如：

```js
export const CONFIG = Object.freeze({
    githubOwner: 'your-name',
    githubRepo: 'st-theme-assets',
    githubBranch: 'main',
    githubToken: 'github_pat_xxxxxxxxx',
});
```

> **安全提醒**：这是纯浏览器 UI Extension。把 Token 写进插件意味着任何拿到“配置后插件源码”的人都能看到 Token。只把配置后的版本发给你信任的两位朋友；不要公开上传带 Token 的 ZIP/仓库。如果 Token 泄露，立刻在 GitHub 撤销并重建。

## 创建 Fine-grained Personal Access Token

0. 先创建一个 **Public（公开）** GitHub 素材仓库，并至少完成一次初始化提交（例如创建 README）。jsDelivr 不支持私有 GitHub 仓库。
1. GitHub -> 头像 -> **Settings**。
2. 进入 **Developer settings** -> **Personal access tokens** -> **Fine-grained tokens**。
3. 点击 **Generate new token**。
4. `Resource owner` 选择素材仓库所属账号。
5. `Repository access` 选择 **Only select repositories**，只勾选你的素材仓库。
6. `Repository permissions` 中只需要：
   - **Contents: Read and write**
7. 生成后立即复制 Token，填入 `GITHUB_TOKEN`。
8. 打开插件，点击 **测试 GitHub 连接**。插件会验证：仓库可读取、仓库是 Public、目标 branch 存在，并检查仓库权限信息中是否有 push/write 能力。

## CORS：为什么有些图可以扫，有些图会失败

浏览器直接请求第三方图床时，图床可能没有开放 CORS。插件会：

1. 先直接请求原图；
2. 如果浏览器 CORS/网络读取失败，再自动尝试 SillyTavern 自带 `/proxy/...` CORS 代理；
3. 两种方式都失败时，该素材显示“读取失败”，可以 **重新尝试** 或 **保留原链接**。

SillyTavern 1.19.0 的 CORS proxy 默认关闭。若你们常用的图床不允许浏览器直接读取，可在 SillyTavern 根目录的 `config.yaml` 中设置：

```yaml
enableCorsProxy: true
```

然后重启 SillyTavern。

注意：CORS proxy 是服务端出站代理能力，开启前应理解 SillyTavern 官方关于 SSRF/白名单的安全提示。只在你信任本机扩展和部署环境的情况下开启。

## 安装

### 方式 A：从 Git 仓库安装（推荐）

把**不含私人 Token**的插件源码放到你自己的 Git 仓库后，在 SillyTavern：

`Extensions -> Install Extension -> 粘贴 Git 仓库 URL`

SillyTavern 会管理后续启用、禁用和更新。

### 方式 B：使用本 ZIP 手动安装

当前 SillyTavern 的“Install Extension”界面以 Git URL 为安装源，不是 ZIP 上传器。ZIP 用于手动安装：

1. 解压后得到 `theme-publisher/` 文件夹。
2. 推荐放入当前用户扩展目录：

```text
SillyTavern/data/<user-handle>/extensions/theme-publisher/
```

单用户默认通常是：

```text
SillyTavern/data/default-user/extensions/theme-publisher/
```

旧式全局位置也可用：

```text
SillyTavern/public/scripts/extensions/third-party/theme-publisher/
```

3. 重载 SillyTavern 页面。
4. 在扩展管理中确认 **主题素材发布助手** 已启用。
5. 点击魔法棒 -> **主题发布**。

## 使用方法

1. 打开 **主题发布**。
2. 选择：
   - **读取当前主题**；或
   - **选择主题 JSON**（推荐）。
3. 点击 **扫描**。
4. 插件扫描 `custom_css` 中所有 HTTP/HTTPS `url(...)` 图片；`@import` 保持原样，不迁移。
5. 扫描阶段会：下载二进制、识别真实图片格式、统计实际字节大小、计算 SHA-256、按 hash 去重，并检查目标 GitHub 仓库中对应 `主题名/hash.ext` 是否已存在。
6. 如果某项“读取失败”，可以：
   - **重新尝试**；
   - **保留原链接**。
7. 所有失败项处理完后点击 **一键发布**。
8. 插件使用 GitHub Git Data API 创建 blob/tree/commit，并尽量保证一次主题发布只产生一个 commit；branch 在发布瞬间若发生并发更新，会自动安全重试一次。
9. 发布完成后下载：

```text
主题名称_发布版.json
```

普通用户直接导入这个 JSON 即可，不需要安装本插件。

## 仓库结构与去重

主题名会保留中文、英文和正常字符，并自动替换 GitHub/常见文件系统不适合作为目录名的字符。

```text
Theme A/
├── 91f628bc71af1234.png
├── c890721da1e3abcd.webp
└── ...
```

文件名来自图片**实际二进制内容**的 SHA-256 前 16 位。支持：PNG、JPG/JPEG、WebP、GIF、SVG、AVIF。

由于 jsDelivr 的 GitHub 源默认不支持超过 **20 MB** 的单文件，扫描阶段会直接把这类素材标记为失败，避免出现“GitHub 已上传但 CDN 无法正常分发”的假成功。

同一份二进制：

- 即使来自不同 URL，也只算一个唯一素材；
- 同一个 CSS URL 出现多次也只下载/上传一次；
- 如果 GitHub 中目标 hash 文件已存在，直接复用。

## 固定 Commit CDN

提交成功后使用完整 commit SHA：

```text
https://cdn.jsdelivr.net/gh/OWNER/REPO@COMMIT_SHA/主题目录/hash.ext
```

旧主题 JSON 始终引用旧 commit，因此后续发布同名主题不会改变已经发布出去的旧版本资源。

## 发布 JSON 保留规则

- 原始 JSON 对象不会被修改。
- 所有未知/未来 SillyTavern Theme 字段都会原样保留。
- 只改 `custom_css` 中已经成功迁移的 HTTP/HTTPS 图片 URL。
- `@import` 不修改。
- 选择“保留原链接”的失败素材不修改。
- 引号风格和 `url(...)` 周边 CSS 文本不重新格式化，只替换 URL 字符串本身。

## 测试

源码内带 `tests/run-tests.mjs`，覆盖：

- CSS `url(...)` 扫描；
- `@import` / 注释忽略；
- URL 精确替换；
- 主题目录名清理；
- PNG/JPEG/WebP/GIF/SVG/AVIF 真格式识别；
- SHA-256 内容 hash；
- GitHub Git Data API 的单 commit 发布流程（mock API）；
- 已存在资源复用；
- jsDelivr commit 固定 URL；
- PC/手机关键布局规则静态检查。

运行：

```bash
node tests/run-tests.mjs
```

## 限制与说明

- 这是纯 UI Extension，不包含 server plugin。
- 某些禁止跨域读取且 SillyTavern CORS proxy 也无法访问的图床，只能保留原链接或换可访问图床。
- GitHub API 的真实写入最终取决于你填写的 PAT、仓库规则和 branch protection。若 branch 禁止该 Token 直接 push，GitHub 会拒绝更新 ref，插件会显示 API 错误，不会伪装成成功。
- 素材仓库必须为 **Public**；私有仓库虽然 GitHub API 上传可能成功，但 jsDelivr 无法提供公开 CDN，因此插件会在连接测试阶段直接拒绝。
- 目标 branch 必须已经存在；新建空仓库时请先创建 README 或做一次初始 commit。
- `Fine-grained PAT` 不应出现在公开主题 JSON；插件只把 CDN URL 写进发布 JSON，不会写入 Token。
