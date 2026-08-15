# MeshMind 第二阶段设计：工程债偿还

日期：2026-08-16
状态：已确认，待编写实施计划

## 1. 背景

MVP 已完成并可用（见 `2026-08-15-meshmind-mvp-design.md`），随后的一轮缺陷修复也已落地：Rust 177 个测试、前端 135 个测试全绿。

本阶段**不增加任何用户可见功能**，交付三样能力：

1. 改动 UI 时有自动化能兜住 —— 目前 DOM 相关逻辑零覆盖，每改一行都要重跑人工清单
2. Windows 侧第一次被真实验证 —— 到今天为止，Windows 代码路径一行都没在真机或 CI 上跑过
3. 能给自己发版本 —— 目前没有分发渠道，装了就再也收不到更新

### 明确不做

代码签名与公证（需要 Apple 开发者账号，用户明确不做）、jsdom + testing-library 组件测试栈（与 Playwright 覆盖重叠，只搭一套）、tauri-driver 端到端（macOS 不支持，见 §3）。

## 2. 执行顺序

顺序有依赖，不能乱：

| 序 | 工作 | 排这个位置的理由 |
|---|---|---|
| A | 仓库上线 + CI 双平台跑绿 | Windows 至今零验证。CI 一开就可能暴露问题（bundled SQLite 的 MSVC 编译、路径、哨兵字符编码、行尾），这些问题影响后续所有工作，越晚发现越贵 |
| B | Playwright + mock IPC 测试栈 | 不依赖 A，但排在 A 后面，免得 Windows 问题与测试基建问题搅在一起难以定位 |
| C | CSP 收紧 + 自动更新 | 两者都需要真机交互验证，集中验一轮；自动更新还依赖 A 提供的 Releases |

**A 中若 Windows 暴露问题，当场修到绿**，不记录后移。Windows 是明确要求同等对待的平台，带着已知的红继续走后面两份计划，等于让后续验证建立在不确定的地基上。

## 3. Playwright + mock IPC

### 为什么不是 tauri-driver

Tauri 官方的端到端方案基于 WebDriver，**在 macOS 上不可用** —— WKWebView 没有 WebDriver 实现。日常开发在 macOS 上进行，若采用 tauri-driver，本地跑不了，只能推到 CI 才知道结果，反馈循环从秒级变成十几分钟。且它同样覆盖不了热键、托盘这些系统集成。

改为：Playwright 驱动浏览器访问 vite dev server，把 `window.__TAURI_INTERNALS__` 替换成可控的假实现。

### 要顶掉的内部接口

用 `page.addInitScript` 在应用加载前注入。不只是 `invoke`：

| 内部接口 | 用途 | 假实现职责 |
|---|---|---|
| `invoke(cmd, args)` | 全部 IPC | 分发到内存假存储 |
| `metadata.currentWindow.label` | `main.tsx` 据此分流主窗口 / 快捕窗口 | 按测试需要返回 `main` 或 `capture` |
| `transformCallback` | 事件系统底层 | 回调注册 |
| `plugin:event\|listen` / `emit` | `note-saved`、`app-quit-requested` | 事件要能在两个 page 之间真的传递 |

### mock 兼做间谍（关键设计）

假实现会与 Rust 真实行为漂移，**一个骗人的 mock 比没有 mock 更糟** —— 测试全绿但应用是坏的。

对策：mock 同时记录每一次 `invoke` 的命令名与参数，测试**既断言渲染结果、也断言发出去的调用形状**。

这不是形式主义。本项目已确证的三个真实缺陷全部是调用形状的缺陷：

- 自动保存漏传 `attachmentIds` → 附件被解绑 → GC 删掉图片文件
- `matched_terms` 混入标点 → 前端把全文每个逗号刷成高亮
- 托盘退出未落盘 → 最后 800ms 的编辑静默丢失

这三个用「断言 invoke 参数」全能抓住，用「断言页面长什么样」一个都抓不住。

### 覆盖范围

优先覆盖**手工几乎复现不了**的场景：

- 保存失败 → 用户切换笔记 → 内容不丢
- 保存慢 + 继续打字 → 不并发写同一条笔记
- 删除正在保存的那条笔记 → 不弹假错误
- 快捕保存 → 跨窗口事件 → 主窗口列表刷新（两个 page 实例）
- 退出前落盘：`app-quit-requested` → flush → `confirm_quit` 的完整时序
- 设置面板三个开关失败后 UI 回滚到真实状态
- 分页终止态、标签切换时的串写守卫

### 明确验不到的

写下来，免得日后误以为有覆盖：真实 Rust 逻辑、SQLite 行为、全局热键、托盘、窗口显示隐藏、系统权限、CSP。这些仍靠 `docs/manual-verification.md` 的人工清单与 Rust 侧的 177 个测试。

## 4. CSP 收紧

现状 `"security": { "csp": null }`，即完全关闭。

### 候选生产策略

```
default-src 'self';
img-src 'self' blob: data:;
style-src 'self' 'unsafe-inline';
script-src 'self';
connect-src 'self' ipc: http://ipc.localhost;
object-src 'none'; base-uri 'self'; frame-ancestors 'none'
```

三条需要解释：

- **`img-src` 必须带 `blob:`**：附件图片全部走 blob URL 渲染。漏了它每一张图都碎。这是最容易漏、后果最直观的一条。
- **`style-src` 暂留 `'unsafe-inline'`**：TipTap / ProseMirror 会在节点上写内联样式（拖拽时尤其）。可以试着去掉观察，但不要为洁癖赌上编辑器。
- **`connect-src` 放行 IPC 自定义协议**：Tauri v2 的 IPC 走 `ipc:` / `http://ipc.localhost`，漏了它整个应用与后端断联。

dev 环境需单独一份更宽松的 `devCsp`，因为 vite 的 HMR 需要内联脚本与 websocket。

### 收敛方式

最终字符串**由实测决定，不由推测决定**：写候选 → `pnpm tauri dev` 开 devtools 走全流程 → 按控制台 violation 逐条放宽 → 在 release 包上复验（dev 与 prod 是两份策略，dev 过不代表 prod 过）。

改动只是一个配置字段，随时可回退，但**验证必须用户在场** —— CSP 写错的表现是白屏或图片全碎，自动化在 vite dev server 上验不到（CSP 由 Tauri 注入真实 webview）。

## 5. 发布链路与自动更新

### 链路

```
密钥生成（本地，永不进仓库）
  ├→ 公钥写进 tauri.conf.json（可提交）
  └→ 私钥存本地 + 设为 GitHub Actions secret
       └→ 打 tag v0.2.0 触发发布工作流
            ├→ macOS runner 出 .dmg + 更新包
            ├→ Windows runner 出 .msi + 更新包
            └→ 生成 latest.json 清单，与安装包一起发到 GitHub Release
                 └→ 客户端启动静默查 latest.json，有新版才提示
```

仓库为**公开**（用户决定），Release 资源可匿名下载，更新器无需任何凭据。这是选公开仓库换来的最大便利。

### 与代码签名的关系

更新器的私钥是 Tauri 自己的 minisign 密钥对，**不是** Apple 代码签名，不需要开发者账号。因此「不做签名 + 做自动更新」是自洽的。

代价两条，要让用户知道：

1. 首次安装仍需右键打开绕过 Gatekeeper（更新器解决不了第一次）
2. 更新包由应用自行下载解压替换，不走浏览器下载的隔离标记流程；实践中可用，但比签名版本脆弱

### 密钥管理规则

私钥有一个不可逆的性质：

> **私钥一旦丢失，所有已安装的客户端永远无法再收到更新** —— 它们只信任内置的那把公钥。只能改用新密钥重新发版，并让每个用户手动重装一次。

因此规矩定死：

- 私钥生成在**仓库之外**（`~/.meshmind/updater.key`），永不提交，**永不打印到对话或日志中**
- 公钥写进 `tauri.conf.json`，可提交 —— 它本来就是要分发给客户端的
- CI 用 `gh secret set --body-file` 从文件读入设为 Actions secret，命令行中不出现密钥内容
- 私钥加密码，密码单独存密码管理器。这挡不住 CI secret 泄露（两者一起泄），但保护本地那份文件

**实施完成后必须明确告知用户私钥位置并要求其自行备份。这是本阶段唯一一件无法自动化、必须用户亲自跟进的事。**

### 客户端更新体验

- **启动时静默检查**：没有新版就什么都不显示。不要用「已是最新版本」的弹窗打扰人
- **有新版**：一条不打断操作的横幅
- **设置面板另有手动「检查更新」**：这个必须给明确结果 —— 手动点了却没反应最让人困惑
- **下载进度与失败原因都要可见**，不能只进 console（本项目已在「粘贴图片失败静默」上吃过一次这个教训）

### 版本号单一来源

`tauri.conf.json`、`package.json`、`src-tauri/Cargo.toml` 三处都有版本号，是典型的漂移源。实施时必须确立单一来源并在计划中验证同步机制，不能靠人工记得改三处。

## 6. 计划拆分

| 计划 | 内容 | 独立交付什么 |
|---|---|---|
| A | 仓库上线 + CI 双平台跑绿 + 修 Windows 暴露的问题 | 一个可协作、双平台持续验证的仓库 |
| B | Playwright + mock IPC 测试栈 | 一套能在本地秒级反馈的交互测试 |
| C | CSP 收紧 + 自动更新 | 一个安全策略收紧、且能自我更新的应用 |

每份计划自身即可交付可运行、可验证的产物。

## 7. 完成标准

- GitHub 公开仓库存在，CI 在 macOS 与 Windows 上均绿
- Windows 上首次完成构建、测试与打包
- Playwright 测试覆盖 §3 列出的全部关键场景，本地可跑、CI 可跑
- `tauri.conf.json` 的 CSP 不再是 `null`，且经真机验证全流程无 violation
- 打 tag 能自动出双平台安装包与 `latest.json`，客户端能检测并应用更新
- 私钥已安全存放，用户已被明确告知其位置与丢失后果
