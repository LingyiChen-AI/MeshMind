# 计划 C：CSP 收紧与自动更新

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**前置：** 计划 A 完成（仓库已上线、CI 双平台绿），计划 B 完成（Playwright 栈就位）。

**Goal:** 把 CSP 从完全关闭收紧到实测可用的策略，并打通「打 tag → 双平台出包 → 客户端自动更新」的完整链路。

**Architecture:** CSP 由 Tauri 注入真实 webview，只能在真机上实测收敛。更新链路用 Tauri 官方的 minisign 密钥对给更新包签名（与 Apple 代码签名无关，不需要开发者账号），产物发到 GitHub Release，客户端启动时静默查 `latest.json`。

**Tech Stack:** tauri-plugin-updater / tauri-plugin-process / tauri-action / GitHub Releases / minisign

**⚠ 本计划有两处必须用户在场：** CSP 的真机验证（Task 3）与私钥备份确认（Task 5）。执行到那里要停下来等用户，不要跳过。

---

### Task 1: 版本号单一来源

三处版本号（`package.json`、`tauri.conf.json`、`src-tauri/Cargo.toml`）是典型漂移源。发版前必须先解决，否则更新器会比较到错误的版本。

**Files:**
- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step 1: 确认当前三处的值**

```bash
cd /Users/chenhao/codes/myself/MeshMind
grep '"version"' package.json | head -1
grep '"version"' src-tauri/tauri.conf.json | head -1
grep '^version' src-tauri/Cargo.toml
```

- [ ] **Step 2: 让 tauri.conf.json 指向 package.json**

Tauri v2 的 `version` 字段接受一个指向 `package.json` 的路径，此时以该文件的 `version` 为准。把 `src-tauri/tauri.conf.json` 里的：

```json
  "version": "0.1.0",
```

改为：

```json
  "version": "../package.json",
```

`src-tauri/Cargo.toml` 的 `version` 保持不变——它是 crate 版本，不参与应用版本号，Tauri 不会用它（`version` 字段存在时优先）。这一点写进 `package.json` 旁边的注释不方便，改为写进 Task 6 的发版说明。

- [ ] **Step 3: 验证生效**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd /Users/chenhao/codes/myself/MeshMind
pnpm build
cargo build -p meshmind
plutil -extract CFBundleShortVersionString raw \
  target/debug/bundle/macos/MeshMind.app/Contents/Info.plist 2>/dev/null \
  || pnpm tauri build --bundles app 2>&1 | tail -3
```

若走了 `tauri build`，构建完后：

```bash
plutil -extract CFBundleShortVersionString raw target/release/bundle/macos/MeshMind.app/Contents/Info.plist
```

Expected: 输出 `0.1.0`，与 `package.json` 一致。

- [ ] **Step 4: 提交**

```bash
git add src-tauri/tauri.conf.json
git commit -m "build: 版本号以 package.json 为单一来源"
```

---

### Task 2: 写候选 CSP

**Files:**
- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step 1: 把 security 段改成候选策略**

`src-tauri/tauri.conf.json` 的 `app.security` 从：

```json
    "security": { "csp": null }
```

改为：

```json
    "security": {
      "csp": "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ipc: http://ipc.localhost; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      "devCsp": "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self' ipc: http://ipc.localhost ws://localhost:1420 http://localhost:1420; font-src 'self' data:; object-src 'none'; base-uri 'self'"
    }
```

三条要点，改的时候要理解而不是照抄：

- **`img-src` 的 `blob:` 是命门**。附件图片全部走 blob URL 渲染，漏了它每一张图都碎。
- **`style-src` 的 `'unsafe-inline'` 暂时留着**。TipTap / ProseMirror 会在节点上写内联样式。Task 3 可以试着去掉观察，但不要为洁癖赌上编辑器。
- **`devCsp` 必须更宽松**。vite 的 HMR 需要内联脚本、eval 与 websocket，用生产策略跑 `tauri dev` 会直接白屏。

- [ ] **Step 2: 确认配置合法**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd /Users/chenhao/codes/myself/MeshMind
cargo build -p meshmind
```

Expected: 编译通过。`tauri.conf.json` 的 schema 校验发生在编译期，字段写错这里就会报。

- [ ] **Step 3: 先不提交**

CSP 未经真机验证前不提交。Task 3 验完再一起提交。

---

### Task 3: CSP 真机收敛（需用户在场）

**Files:**
- 可能 Modify: `src-tauri/tauri.conf.json`

**⚠ 这一步无法自动化。** CSP 由 Tauri 注入真实 webview，Playwright 跑的是 vite dev server，验不到。写错的表现是白屏或图片全碎。

- [ ] **Step 1: 起开发模式并打开 devtools**

```bash
cd /Users/chenhao/codes/myself/MeshMind
pnpm tauri dev
```

在应用窗口里右键 → 检查元素，切到 Console 面板。

- [ ] **Step 2: 走一遍全流程，盯 Console 的 violation**

逐项操作，每项之后看控制台有没有 `Refused to ... because it violates the following Content Security Policy directive`：

- [ ] 应用启动、主窗口渲染
- [ ] 新建笔记、输入文字、等自动保存
- [ ] 粘贴一张截图 → **图片必须显示出来**（这条最容易挂在 `img-src`）
- [ ] ⌘K 搜索、结果高亮
- [ ] 打开设置面板、回收站
- [ ] 在编辑器里拖动图片节点（ProseMirror 会写内联样式）
- [ ] ⌥Space 唤起快捕窗口，粘图并保存

- [ ] **Step 3: 按 violation 逐条放宽，一次只改一条**

每条 violation 会明说是哪个指令挡的。放宽时**加最小的那一项**，不要图省事直接放 `*`。改完重启 `tauri dev` 复验。

若某条 violation 来自 `style-src` 且只在拖拽时出现，说明 `'unsafe-inline'` 确有必要，保留即可，不必纠结。

- [ ] **Step 4: 在 release 包上复验**

**dev 与 prod 是两份策略，dev 过了不代表 prod 过。**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd /Users/chenhao/codes/myself/MeshMind
pnpm tauri build --bundles app
open target/release/bundle/macos/MeshMind.app
```

release 包默认没有 devtools。判断方式改为**功能是否正常**：图片显示、搜索可用、设置面板能开。任何一项异常就是 CSP 太紧。

若需要在 release 包里看控制台，临时在 `tauri.conf.json` 加 `"app": { "withGlobalTauri": false }` 之外的调试手段不可靠，更实际的做法是回到 dev 模式定位。

- [ ] **Step 5: 记录最终策略并提交**

在 `docs/manual-verification.md` 里加一节「CSP 收敛记录」，写清最终策略、以及每一条非默认指令**为什么**需要（尤其 `'unsafe-inline'` 与 `blob:`）。三个月后有人想收紧它，这段能省掉重新踩一遍的时间。

```bash
git add src-tauri/tauri.conf.json docs/manual-verification.md
git commit -m "security: 收紧 CSP 并记录收敛过程"
git push
```

---

### Task 4: 生成更新器密钥（需用户在场确认备份）

**Files:**
- 无仓库内文件改动（公钥在 Task 5 写入配置）

**⚠ 私钥永不进仓库、永不打印到终端输出或对话中。**

- [ ] **Step 1: 建密钥目录**

```bash
mkdir -p ~/.meshmind
chmod 700 ~/.meshmind
```

- [ ] **Step 2: 生成密钥对**

```bash
cd /Users/chenhao/codes/myself/MeshMind
pnpm tauri signer generate -w ~/.meshmind/updater.key
```

命令会提示设置密码。**设一个密码**并让用户记进密码管理器——它挡不住 CI secret 泄露（私钥与密码会一起放进 Actions secrets），但保护本地那份文件。

命令输出里包含公钥。**只取公钥**，私钥内容不要复制、不要 echo、不要写进任何文件之外的地方。

- [ ] **Step 3: 确认文件已生成且权限收紧**

```bash
ls -l ~/.meshmind/
chmod 600 ~/.meshmind/updater.key ~/.meshmind/updater.key.pub
```

Expected: 两个文件，`updater.key`（私钥）与 `updater.key.pub`（公钥）。

- [ ] **Step 4: 停下来告知用户**

把下面这段原话告诉用户，等他确认已备份再继续：

> 更新器私钥在 `~/.meshmind/updater.key`，密码是你刚才设的那个。
>
> **请现在把私钥文件和密码备份到你的密码管理器或别的安全位置。**
>
> 原因：私钥一旦丢失，所有已安装的客户端将永远无法再收到更新——它们只信任内置的那把公钥。届时只能换新密钥重新发版，并让每个用户手动重装一次。这是本阶段唯一一件无法自动化、必须你亲自跟进的事。

---

### Task 5: 接入更新器

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src-tauri/src/main.rs`
- Modify: `package.json`

- [ ] **Step 1: 装插件**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd /Users/chenhao/codes/myself/MeshMind
cargo add -p meshmind tauri-plugin-updater tauri-plugin-process
pnpm add @tauri-apps/plugin-updater @tauri-apps/plugin-process
```

`tauri-plugin-process` 提供 `relaunch()`，更新装完要重启应用才生效。

- [ ] **Step 2: 注册插件**

`src-tauri/src/main.rs` 的 Builder 链上加（单实例插件仍须排第一）：

```rust
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
```

- [ ] **Step 3: 配置更新源与公钥**

`src-tauri/tauri.conf.json` 顶层加 `plugins` 段（若已存在则合并）：

```json
  "plugins": {
    "updater": {
      "endpoints": [
        "https://github.com/LingyiChen-AI/MeshMind/releases/latest/download/latest.json"
      ],
      "pubkey": "<把 Task 4 生成的公钥内容原样贴进来>",
      "windows": { "installMode": "passive" }
    }
  }
```

`installMode: passive` 让 Windows 上的 msi 更新显示进度条但不需要用户交互。

`bundle` 段加：

```json
    "createUpdaterArtifacts": true
```

- [ ] **Step 4: 补权限**

`src-tauri/capabilities/default.json` 的 permissions 追加：

```json
    "updater:default",
    "process:allow-restart"
```

- [ ] **Step 5: 确认编译**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cargo build -p meshmind
cargo clippy -p meshmind --all-targets -- -D warnings
```

Expected: 通过。公钥格式不对会在这里报。

- [ ] **Step 6: 提交**

```bash
git add src-tauri package.json pnpm-lock.yaml Cargo.lock
git commit -m "feat(shell): 接入更新器与进程重启插件"
```

---

### Task 6: 发布工作流

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: 把私钥设为 Actions secret**

用 `--body-file` 从文件读入，密钥内容不会出现在命令行、shell 历史或日志里：

```bash
cd /Users/chenhao/codes/myself/MeshMind
gh secret set TAURI_SIGNING_PRIVATE_KEY --body-file ~/.meshmind/updater.key
```

密码那个 secret 需要交互输入，**让用户自己执行**这一条（避免密码经过任何日志）：

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

确认：

```bash
gh secret list
```

Expected: 两个 secret 都在列表里（只显示名字，不显示值）。

- [ ] **Step 2: 写发布工作流**

`.github/workflows/release.yml`：

```yaml
name: Release

# 打 tag 触发。tag 名必须与 package.json 的 version 一致，
# 否则更新器会比较到错误的版本号。
on:
  push:
    tags: ['v*']
  workflow_dispatch:

jobs:
  release:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-latest
            args: '--target aarch64-apple-darwin'
          - os: windows-latest
            args: ''
    runs-on: ${{ matrix.os }}
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 10

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - uses: dtolnay/rust-toolchain@stable

      - uses: Swatinem/rust-cache@v2

      - run: pnpm install --frozen-lockfile

      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        with:
          tagName: ${{ github.ref_name }}
          releaseName: 'MeshMind ${{ github.ref_name }}'
          releaseBody: '安装包见下方附件。macOS 版本未做代码签名，首次打开需右键点图标选「打开」。'
          releaseDraft: true
          prerelease: false
          args: ${{ matrix.args }}
```

`releaseDraft: true` 是刻意的：两个平台的 job 会往同一个 Release 里追加产物，先建成草稿，等两边都传完再由人工发布。自动发布会出现「Windows 包还没传上去，Release 已经公开」的窗口。

- [ ] **Step 3: 提交并推送**

```bash
git add .github/workflows/release.yml
git commit -m "ci: 发布工作流"
git push
```

---

### Task 7: 客户端更新 UI

**Files:**
- Create: `src/lib/updater.ts`
- Modify: `src/App.tsx`
- Modify: `src/components/SettingsPanel.tsx`
- Modify: `src/styles.css`

- [ ] **Step 1: 封装更新逻辑**

`src/lib/updater.ts`：

```ts
import { relaunch } from '@tauri-apps/plugin-process'
import { check, type Update } from '@tauri-apps/plugin-updater'

export interface UpdateInfo {
  version: string
  notes: string
  handle: Update
}

/// 查有没有新版本。没有返回 null。
/// 网络不通、更新源 404 都会抛——调用方自己决定要不要打扰用户。
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const update = await check()
  if (!update) return null
  return { version: update.version, notes: update.body ?? '', handle: update }
}

/// 下载并安装，装完重启。onProgress 收到的是已下载字节数与总字节数。
export async function applyUpdate(
  info: UpdateInfo,
  onProgress: (downloaded: number, total: number | null) => void,
): Promise<void> {
  let downloaded = 0
  let total: number | null = null
  await info.handle.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      total = event.data.contentLength ?? null
    } else if (event.event === 'Progress') {
      downloaded += event.data.chunkLength
      onProgress(downloaded, total)
    }
  })
  await relaunch()
}
```

- [ ] **Step 2: 启动时静默检查**

`src/App.tsx` 加一个 effect：挂载后调 `checkForUpdate()`。

- 查到新版 → 显示一条不打断操作的横幅（顶部或底部，带「更新」与「稍后」）
- 没有新版 → **什么都不显示**。不要弹「已是最新版本」打扰人
- 查询失败 → **也什么都不显示**，只 `console.warn`。启动时网络不通是常态，为此弹错误条是噪音

- [ ] **Step 3: 设置面板里的手动检查**

`SettingsPanel.tsx` 加一项「检查更新」。与启动检查相反，**手动点必须给明确结果**：

- 有新版 → 显示版本号与更新按钮
- 已是最新 → 明确显示「已是最新版本（0.1.0）」
- 失败 → 显示错误消息

手动点了却没任何反应是最让人困惑的交互。

- [ ] **Step 4: 下载进度与失败可见**

更新过程中显示百分比。失败要走已有的错误栏，**不能只进 console**——本项目已在「粘贴图片失败静默」上吃过一次这个教训。

- [ ] **Step 5: 类型检查与测试**

```bash
cd /Users/chenhao/codes/myself/MeshMind
pnpm exec tsc --noEmit
pnpm test
```

Expected: 零错误、全绿。

- [ ] **Step 6: 给 e2e mock 补上更新器命令**

`e2e/mock/install.ts` 的 `handle` 里加分支，否则设置面板的 e2e 会报「mock 未实现的命令」：

```ts
      case 'plugin:updater|check':
        return null   // 默认无更新；需要测有更新时由测试覆写
      case 'plugin:process|restart':
        return null
```

实际命令名以运行 e2e 时报错信息里的为准。

- [ ] **Step 7: 提交**

```bash
pnpm e2e
git add src e2e
git commit -m "feat(web): 启动静默检查更新与手动检查入口"
git push
```

---

### Task 8: 端到端发一次版本

链路只有真发过一次才算通。

- [ ] **Step 1: 发 0.1.0**

```bash
cd /Users/chenhao/codes/myself/MeshMind
git tag v0.1.0
git push origin v0.1.0
gh run watch $(gh run list --workflow=Release --limit 1 --json databaseId --jq '.[0].databaseId')
```

- [ ] **Step 2: 确认产物齐全**

```bash
gh release view v0.1.0 --json assets --jq '.assets[].name'
```

Expected: 至少包含 macOS 的 `.dmg`、`.app.tar.gz` 与 `.app.tar.gz.sig`，Windows 的 `.msi`、`.msi.zip` 与 `.msi.zip.sig`，以及 `latest.json`。

**`.sig` 文件缺失说明签名没生效**——检查 Actions secret 是否设对。

- [ ] **Step 3: 人工发布草稿**

```bash
gh release edit v0.1.0 --draft=false
```

- [ ] **Step 4: 确认更新源可匿名访问**

```bash
curl -sL https://github.com/LingyiChen-AI/MeshMind/releases/latest/download/latest.json | head -20
```

Expected: 返回 JSON，含 `version`、`platforms` 与各平台的 `signature` / `url`。**这一步验的是「公开仓库让更新器免凭据」这个前提真的成立。**

- [ ] **Step 5: 真机验证更新（需用户在场）**

1. 装上 0.1.0 的 dmg
2. 把 `package.json` 的 version 改成 `0.1.1`，提交，打 tag `v0.1.1`，等 Release 出来并发布
3. 启动装好的 0.1.0，确认出现更新提示
4. 点更新，确认下载进度可见、装完自动重启
5. 重启后在设置面板里确认版本号变成 0.1.1

这一步跑通，链路才算真的通。跑不通的常见原因：`latest.json` 里的版本号与 tag 不一致（Task 1 的版本号单一来源没生效）、签名校验失败（公钥与私钥不配对）、endpoint 404（仓库名或路径写错）。

---

## 完成标准

- `tauri.conf.json` 的 CSP 不再是 `null`，且经真机全流程验证无 violation、功能正常
- CSP 的收敛过程与每条非默认指令的理由已记录
- 版本号以 `package.json` 为单一来源，且已验证生效
- 更新器私钥已生成、已设为 Actions secret、**用户已确认备份**
- 打 tag 能自动产出双平台安装包、更新包与 `latest.json`
- 已完成一次真实的 0.1.0 → 0.1.1 更新验证

## 明确不做

Apple 代码签名与公证（用户明确不做，首次安装仍需右键打开绕过 Gatekeeper）、增量更新、回滚机制、多渠道（stable/beta）分发。
