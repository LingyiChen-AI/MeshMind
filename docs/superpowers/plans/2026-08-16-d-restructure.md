# 计划 D：目录重构

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**前置：** 计划 C 的 agent 已交回工作区（否则改目录会与它正在写的文件撞车）。**必须在发布第一个版本之前完成** —— 发过 v0.1.0 再动目录，发布工作流与产物路径都要返工。

**Goal:** 把目录布局从 `crates/core` + `src-tauri` + `src` 改成 `crates/core` + `crates/shell` + `ui`，让两个 Rust crate 归到一处、前端有个不与 `src-tauri` 混淆的名字。

**Architecture:** 纯机械重命名，不改任何逻辑。风险全在「漏掉某处路径引用」和「Tauri CLI 的目录解析假设」。

**Tech Stack:** git mv / Tauri CLI 2.11 / Vite / Playwright

---

## 一个必须先知道的陷阱

Tauri CLI 通过**在子目录里搜 `tauri.conf.json`** 来定位 Tauri 目录（不是硬编码 `src-tauri`），所以改名本身可行。

但**前端目录是按 Tauri 目录的父目录推断的**。现在 `src-tauri` 的父目录是仓库根，`package.json` 就在那儿，所以 `beforeDevCommand: "pnpm dev"` 能跑。改成 `crates/shell` 之后父目录变成 `crates/`，那里**没有 package.json**。

若 `pnpm tauri dev` / `pnpm tauri build` 报找不到前端目录或 before 命令跑错地方，改用对象形式显式指定工作目录：

```json
    "beforeDevCommand": { "cwd": "../..", "script": "pnpm dev" },
    "beforeBuildCommand": { "cwd": "../..", "script": "pnpm build" },
```

**这一条不要预先改**——先按最简形式跑，真报错了再改，并在报告里说明实际行为。

---

### Task 1: 移动目录

**Files:**
- Rename: `src-tauri/` → `crates/shell/`
- Rename: `src/` → `ui/`

- [ ] **Step 1: 确认工作区干净**

```bash
cd /Users/chenhao/codes/myself/MeshMind
git status --short
```

Expected: 无输出。有残留就先停下来问，不要带着别人的在途改动做重构。

- [ ] **Step 2: 用 git mv 移动**

```bash
git mv src-tauri crates/shell
git mv src ui
git status --short | head -20
```

用 `git mv` 而不是 `mv`，让 git 识别为重命名，diff 可读、历史可追。

- [ ] **Step 3: 先不提交**，配置还没改，此刻仓库是坏的。

---

### Task 2: 改 Rust 侧路径

**Files:**
- Modify: `Cargo.toml`
- Modify: `crates/shell/tauri.conf.json`
- Modify: `.gitignore`

- [ ] **Step 1: 工作区成员**

`Cargo.toml`：

```toml
[workspace]
resolver = "2"
members = ["crates/core", "crates/shell"]
```

- [ ] **Step 2: frontendDist 深一层**

`crates/shell/tauri.conf.json` 的 `build.frontendDist` 从 `"../dist"` 改为 `"../../dist"`。

`crates/core` 的相对路径依赖不用改——`crates/shell/Cargo.toml` 里的 `meshmind-core = { path = "../core" }`（原来是 `../crates/core`），**这一条要改**。

- [ ] **Step 3: 忽略规则**

`.gitignore` 里 `src-tauri/target/` → `crates/shell/target/`，`src-tauri/gen/` → `crates/shell/gen/`。

- [ ] **Step 4: 编译验证**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd /Users/chenhao/codes/myself/MeshMind
cargo build -p meshmind-core
cargo build -p meshmind
cargo test --workspace --locked
```

Expected: 全部通过，Rust 测试 177 个。

---

### Task 3: 改前端与 e2e 路径

**Files:**
- Modify: `tsconfig.json`、`tsconfig.e2e.json`、`vite.config.ts`、`index.html`
- Modify: `e2e/` 下所有引用 `../src/` 的文件

- [ ] **Step 1: 逐个改**

- `tsconfig.json` 的 `"include": ["src"]` → `["ui"]`
- `tsconfig.e2e.json` 里若有 `src` 路径，同步改
- `vite.config.ts` 的 vitest `include: ['src/**/*.test.{ts,tsx}']` → `['ui/**/*.test.{ts,tsx}']`
- `index.html` 的 `<script type="module" src="/src/main.tsx">` → `/ui/main.tsx`

- [ ] **Step 2: 改 e2e 的导入与读路径**

```bash
grep -rn "\.\./src/\|'src/\|\"src/\|src-tauri/" e2e/ | head -20
```

逐条改。**特别注意 `e2e/contract.spec.ts`**：它靠读源码文件工作，里面写死了 `src/lib/ipc.ts` 与 `src-tauri/src/main.rs` 两个路径。

**这是本次重构最危险的一处**：路径读不到时，取决于它的实现，可能不是报错而是拿到空字符串、于是差集为空、于是测试「通过」——那就等于把刚建立的命令契约守卫悄悄拆掉了，而且没有任何红色提示。

改完必须做一次**反证**：故意把 `crates/shell/src/main.rs` 的某个 `generate_handler!` 条目注释掉，确认 `contract.spec.ts` 变红；再还原。不做这个反证，就不能认为守卫还活着。

- [ ] **Step 3: 验证**

```bash
cd /Users/chenhao/codes/myself/MeshMind
pnpm exec tsc --noEmit
pnpm test
pnpm build
pnpm e2e
```

Expected: tsc 零错误、vitest 135 个绿、构建成功、e2e 52 个绿。

---

### Task 4: 改注释与文档里的路径引用

**Files:**
- Modify: `ui/lib/*.ts`、`e2e/mock/install.ts`、`docs/*.md` 中提到旧路径的地方

- [ ] **Step 1: 找出来**

```bash
cd /Users/chenhao/codes/myself/MeshMind
grep -rn "src-tauri\|\bsrc/lib\|src/main.tsx" --include="*.ts" --include="*.tsx" --include="*.md" . 2>/dev/null | grep -v node_modules | grep -v "^./target" | grep -v "docs/superpowers/plans\|docs/superpowers/specs"
```

- [ ] **Step 2: 逐条更新**

代码注释里有多处「必须和 `src-tauri/src/settings.rs` 逐字对齐」这类跨语言契约说明，路径失效会让它们从有用的指路变成误导。

`docs/superpowers/` 下的历史 spec 与 plan **不要改** —— 那些是当时的记录，改了就成了伪造历史。在本计划的完成标准里注明「历史文档中的路径为写作时的布局」即可。

- [ ] **Step 3: 检查 CI 工作流**

```bash
grep -n "src-tauri\|src/" .github/workflows/*.yml
```

有引用就改。特别注意 `release.yml` 里 tauri-action 的产物路径与 `ci.yml` 的 upload-artifact 路径。

---

### Task 5: 提交、推送、双平台验证

- [ ] **Step 1: 全量本地验证**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd /Users/chenhao/codes/myself/MeshMind
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo fmt --all -- --check
pnpm exec tsc --noEmit
pnpm test
pnpm build
pnpm e2e
```

全绿才提交。

- [ ] **Step 2: 确认 Tauri CLI 仍能找到项目**

```bash
pnpm tauri build --bundles app 2>&1 | tail -5
ls -ld target/release/bundle/macos/MeshMind.app
```

Expected: 打包成功。若报找不到前端目录或 before 命令跑错地方，按本文开头「陷阱」一节改成 `{ cwd, script }` 对象形式。

- [ ] **Step 3: 提交推送**

```bash
git add -A
git commit -m "refactor: 目录改为 crates/core + crates/shell + ui

两个 Rust crate 归到 crates/ 下，前端从 src 改名 ui，
避免 src 与 src-tauri 两个名字相邻又相似。纯重命名，无逻辑改动。"
git push
gh run watch $(gh run list --limit 1 --json databaseId --jq '.[0].databaseId')
```

Expected: 双平台 `success`。

---

## 完成标准

- 目录为 `crates/core` + `crates/shell` + `ui`
- 本地七项验证全绿，双平台 CI 绿
- `pnpm tauri build` 能打出包
- **`contract.spec.ts` 的反证做过**：注释掉一个 `generate_handler!` 条目它会红
- 代码注释里的跨语言契约路径已更新（`docs/superpowers/` 下的历史文档保持原样）

> **历史文档中的路径为写作时的布局。** `docs/superpowers/` 下的 spec 与 plan
> （含本文件正文）里出现的 `src/` 与 `src-tauri/` 是当时的真实目录，本次重构
> 刻意不改——改了就成了伪造历史。读到那些路径时按下面的对照表换算：
>
> | 写作时 | 现在 |
> | --- | --- |
> | `src/` | `ui/` |
> | `src-tauri/` | `crates/shell/` |
>
> 活的文档（`docs/manual-verification.md`）与代码注释里的路径已经更新到新布局。

## 明确不做

任何逻辑改动。这是纯重命名，出现「顺手改一下」的冲动就打住——重构和改逻辑混在一起，出了问题没法二分定位。
