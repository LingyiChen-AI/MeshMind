# MeshMind 外壳与前端 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**前置：** Plan 1（`docs/superpowers/plans/2026-08-15-meshmind-core.md`）必须已完成，`meshmind-core` 全部测试通过。本计划直接调用该 crate 的公开 API，签名以 Plan 1 为准。

**Goal:** 在 `meshmind-core` 之上建 Tauri 2.0 桌面外壳与 React 前端，交付一个能安装使用的 MVP：全局热键快捕、块式富文本编辑、图片粘贴、Cmd+K 搜索、托盘常驻、双平台打包。

**Architecture:** Tauri 主进程持有 `Mutex<Connection>` 与附件根目录作为应用状态，`commands.rs` 是薄适配层，把 core 的函数暴露成 IPC 命令并把 `CoreError` 转成可序列化的错误。前端是 Vite + React + TypeScript 单页应用，两个窗口（`main` / `capture`）共用同一份构建产物，靠窗口 label 分流渲染。前端所有 IPC 调用集中在 `src/lib/ipc.ts`，组件不直接 `invoke`。

**Tech Stack:** Tauri 2.0 / React 19 / TypeScript / Vite / TipTap / tauri-plugin-global-shortcut / tauri-plugin-single-instance / Vitest

---

## 关键设计取舍

三处为降低复杂度而做的决定，与 spec 不冲突但值得写下来：

**图片不走 asset 协议，走 blob URL。** Tauri 的 `asset:` 协议要配 scope、要处理路径转义、两平台行为还有差异。改为 `read_attachment(id) -> Vec<u8>` 命令返回字节，前端建 blob URL 并按 attachment id 缓存。个人笔记的图片量级下内存完全够用，换来的是零配置、零平台差异。

**剪贴板不装插件，用浏览器原生 paste 事件。** WebView 里用户主动触发的 `paste` 事件带完整的 `clipboardData`，图片、HTML、纯文本三种形态一次拿全。比 `tauri-plugin-clipboard-manager` 少一层依赖，且 HTML 读取在插件里本来就没有稳定支持。

**笔记正文里图片节点只存 attachment id。** TipTap 文档 JSON 里存 `{"type":"attachmentImage","attrs":{"attachmentId":7}}`，绝不存 blob URL —— blob URL 重启即失效，写进 `body_json` 等于埋一颗定时炸弹。

## 文件结构

```
package.json                              前端依赖与脚本
vite.config.ts                            Vite 配置（固定端口 1420）
tsconfig.json                             TypeScript 配置
index.html                                单一 HTML 入口，两个窗口共用
src/main.tsx                              按窗口 label 分流挂载
src/App.tsx                               主窗口：列表 + 编辑器 + 搜索
src/Capture.tsx                           快捕窗口
src/lib/ipc.ts                            唯一 invoke 出口与类型定义
src/lib/attachments.ts                    attachment id → blob URL 缓存
src/lib/clipboard.ts                      粘贴事件解析（纯函数，可测）
src/lib/highlight.ts                      命中词高亮切片（纯函数，可测）
src/editor/Editor.tsx                     TipTap 编辑器封装
src/editor/AttachmentImage.tsx            图片节点扩展与 NodeView
src/components/NoteList.tsx               笔记流
src/components/SearchPanel.tsx            Cmd+K 搜索面板
src/styles.css                            全部样式
src-tauri/Cargo.toml                      外壳 crate 清单
src-tauri/tauri.conf.json                 应用配置、窗口、打包
src-tauri/build.rs                        Tauri 构建脚本
src-tauri/src/main.rs                     入口：状态初始化、插件、托盘、热键
src-tauri/src/state.rs                    AppState 与数据目录解析
src-tauri/src/commands.rs                 IPC 命令与错误映射
src-tauri/capabilities/default.json       权限声明
src-tauri/icons/                          应用图标（生成物）
.github/workflows/ci.yml                  双平台 CI
docs/manual-verification.md               两平台手工验证清单
```

---

### Task 1: 前端脚手架与空窗口

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `index.html`, `src/main.tsx`, `src/styles.css`
- Create: `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/src/main.rs`
- Modify: `Cargo.toml`（工作区加入 src-tauri）
- Modify: `.gitignore`

不用 `create-tauri-app` 交互式脚手架 —— 它会新建目录并覆盖已有工作区。手写这几个文件更可控。

- [ ] **Step 1: 写前端清单与配置**

`package.json`：

```json
{
  "name": "meshmind",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "tauri": "tauri"
  },
  "dependencies": {
    "@tauri-apps/api": "^2",
    "react": "^19",
    "react-dom": "^19"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "@vitejs/plugin-react": "^4",
    "typescript": "^5",
    "vite": "^6",
    "vitest": "^2"
  }
}
```

`vite.config.ts`：

```ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Tauri 在开发模式下固定连 1420 端口，端口被占时必须报错而不是自动换端口，
// 否则外壳会连到一个空地址上，症状是白屏且没有任何提示。
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: 'es2021' },
})
```

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2021",
    "lib": ["ES2021", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noEmit": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

`index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>MeshMind</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`src/main.tsx`（先只渲染占位，确认外壳能起）：

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'

import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="placeholder">MeshMind</div>
  </React.StrictMode>,
)
```

`src/styles.css`：

```css
:root {
  --bg: #ffffff;
  --fg: #1a1a1a;
  --muted: #6b7280;
  --border: #e5e7eb;
  --accent: #2563eb;
  --panel: #f9fafb;
  font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #17181c;
    --fg: #e8e8ea;
    --muted: #9ca3af;
    --border: #2c2e35;
    --accent: #60a5fa;
    --panel: #1f2026;
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
}

.placeholder { padding: 24px; }
```

- [ ] **Step 2: 安装前端依赖**

```bash
cd /Users/chenhao/codes/myself/MeshMind
pnpm install
```

- [ ] **Step 3: 写 Tauri 外壳 crate**

`src-tauri/Cargo.toml`：

```toml
[package]
name = "meshmind"
version = "0.1.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
meshmind-core = { path = "../crates/core" }
tauri = { version = "2", features = ["tray-icon"] }
tauri-plugin-global-shortcut = "2"
tauri-plugin-single-instance = "2"
rusqlite = { version = "0.32", features = ["bundled"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[features]
default = ["custom-protocol"]
custom-protocol = ["tauri/custom-protocol"]
```

rusqlite 版本必须与 `crates/core` 里 `cargo add` 装到的版本一致，否则 `Connection` 是两个不同的类型，编译会报难懂的 trait 不匹配。装完先跑一次 `cargo tree -p meshmind -i rusqlite` 确认只有一个版本。

`src-tauri/build.rs`：

```rust
fn main() {
    tauri_build::build()
}
```

`src-tauri/src/main.rs`（先只开窗）：

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("启动 MeshMind 失败");
}
```

`src-tauri/capabilities/default.json`：

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "主窗口与快捕窗口的默认权限",
  "windows": ["main", "capture"],
  "permissions": ["core:default", "global-shortcut:default"]
}
```

`src-tauri/tauri.conf.json`：

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "MeshMind",
  "version": "0.1.0",
  "identifier": "com.meshmind.desktop",
  "build": {
    "beforeDevCommand": "pnpm dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "pnpm build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "MeshMind",
        "width": 1120,
        "height": 720,
        "minWidth": 720,
        "minHeight": 480
      },
      {
        "label": "capture",
        "title": "快速捕捉",
        "width": 640,
        "height": 220,
        "decorations": false,
        "alwaysOnTop": true,
        "skipTaskbar": true,
        "resizable": false,
        "visible": false,
        "center": true
      }
    ],
    "security": { "csp": null }
  },
  "bundle": {
    "active": true,
    "targets": ["dmg", "msi"],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
}
```

- [ ] **Step 4: 生成图标**

Tauri 打包必须有图标，缺了会在 bundle 阶段才报错。先造一个 1024×1024 的源图再交给 tauri CLI 派生全套：

```bash
cd /Users/chenhao/codes/myself/MeshMind
python3 - <<'PY'
import struct, zlib

size = 1024
# 深蓝底 + 居中浅色方块，先要一个能过构建的可辨识图标，视觉细化不在 MVP 范围。
bg, fg = (23, 32, 58), (96, 165, 250)
rows = []
for y in range(size):
    row = bytearray([0])
    for x in range(size):
        inside = size * 0.28 < x < size * 0.72 and size * 0.28 < y < size * 0.72
        row += bytes(fg if inside else bg)
    rows.append(bytes(row))
raw = b"".join(rows)

def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

png = (b"\x89PNG\r\n\x1a\n"
       + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
       + chunk(b"IDAT", zlib.compress(raw, 9))
       + chunk(b"IEND", b""))
open("app-icon.png", "wb").write(png)
print("wrote app-icon.png")
PY

pnpm tauri icon app-icon.png
```

Expected: `src-tauri/icons/` 下生成 `32x32.png`、`128x128.png`、`icon.icns`、`icon.ico` 等文件。

- [ ] **Step 5: 工作区纳入外壳 crate**

`Cargo.toml` 改为：

```toml
[workspace]
resolver = "2"
members = ["crates/core", "src-tauri"]
```

`.gitignore` 追加：

```
dist/
src-tauri/gen/
app-icon.png
```

- [ ] **Step 6: 构建验证**

```bash
cd /Users/chenhao/codes/myself/MeshMind
pnpm build
cargo build -p meshmind
cargo tree -p meshmind -i rusqlite | head -5
```

Expected: 前端产出 `dist/`；外壳编译通过；`cargo tree` 只列出一个 rusqlite 版本。首次编译 Tauri 依赖较久（5-10 分钟）。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat(shell): Tauri 外壳与前端脚手架"
```

---

### Task 2: 应用状态与数据库初始化

**Files:**
- Create: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: 写失败的测试**

`src-tauri/src/state.rs`：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_db_and_attachment_paths_from_data_dir() {
        let layout = Layout::new(std::path::Path::new("/tmp/meshmind"));
        assert_eq!(layout.db_path, std::path::PathBuf::from("/tmp/meshmind/meshmind.db"));
        assert_eq!(
            layout.attachments_root,
            std::path::PathBuf::from("/tmp/meshmind/attachments")
        );
    }

    #[test]
    fn initializes_a_migrated_database() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::initialize(dir.path()).unwrap();
        let conn = state.conn.lock().unwrap();
        let version: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert!(version >= 1, "数据库未迁移");
    }
}
```

- [ ] **Step 2: 添加 dev 依赖并确认测试失败**

```bash
cargo add -p meshmind --dev tempfile
cargo test -p meshmind
```

Expected: 编译失败，`cannot find type Layout`。

- [ ] **Step 3: 实现状态**

在 `src-tauri/src/state.rs` 顶部写：

```rust
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use meshmind_core::{db, Result};
use rusqlite::Connection;

/// 数据目录下的固定布局。单独抽出来是为了能脱离 Tauri 测试路径推导。
pub struct Layout {
    pub db_path: PathBuf,
    pub attachments_root: PathBuf,
}

impl Layout {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            db_path: data_dir.join("meshmind.db"),
            attachments_root: data_dir.join("attachments"),
        }
    }
}

/// Tauri 管理的全局状态。rusqlite 的 Connection 不是 Sync，用 Mutex 包起来。
/// 个人笔记的并发量下单连接足够，不引入连接池。
pub struct AppState {
    pub conn: Mutex<Connection>,
    pub attachments_root: PathBuf,
}

impl AppState {
    /// 打开并迁移数据库，创建附件目录。
    pub fn initialize(data_dir: &Path) -> Result<Self> {
        let layout = Layout::new(data_dir);
        std::fs::create_dir_all(&layout.attachments_root)?;
        let conn = db::open(&layout.db_path)?;
        db::migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            attachments_root: layout.attachments_root,
        })
    }
}
```

`src-tauri/src/main.rs` 改为：

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod state;

use state::AppState;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            // 迁移失败绝不静默降级：直接崩掉，比带着半迁移的库继续跑安全得多。
            let state = AppState::initialize(&data_dir)
                .unwrap_or_else(|e| panic!("初始化数据库失败（{}）: {e}", data_dir.display()));
            app.manage(state);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动 MeshMind 失败");
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test -p meshmind`
Expected: `test result: ok. 2 passed`

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(shell): 应用状态与数据库初始化"
```

---

### Task 3: 笔记与搜索 IPC 命令

**Files:**
- Create: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: 写失败的测试**

`src-tauri/src/commands.rs`：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_core_error_as_message_string() {
        let err: CommandError = meshmind_core::CoreError::NoteNotFound(7).into();
        assert_eq!(serde_json::to_string(&err).unwrap(), "\"笔记不存在: 7\"");
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test -p meshmind`
Expected: 编译失败，`cannot find type CommandError`。

- [ ] **Step 3: 实现命令层**

在 `src-tauri/src/commands.rs` 顶部写：

```rust
use meshmind_core::attachments::{self, Attachment};
use meshmind_core::notes::{self, NewNote, Note, NoteSummary};
use meshmind_core::search::{self, SearchHit};
use meshmind_core::{now_ms, CoreError};
use serde::Serialize;
use tauri::State;

use crate::state::AppState;

/// 前端只需要一句人话，不需要 Rust 的错误结构，故序列化成字符串。
#[derive(Debug)]
pub struct CommandError(String);

impl Serialize for CommandError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl From<CoreError> for CommandError {
    fn from(value: CoreError) -> Self {
        Self(value.to_string())
    }
}

type CmdResult<T> = std::result::Result<T, CommandError>;

/// Mutex 中毒说明别的线程已经 panic 过，此时继续用这个连接是不安全的。
macro_rules! conn {
    ($state:expr) => {
        $state.conn.lock().expect("数据库连接锁已中毒")
    };
}

#[tauri::command]
pub fn create_note(
    state: State<'_, AppState>,
    body_json: String,
    attachment_ids: Vec<i64>,
) -> CmdResult<Note> {
    let mut conn = conn!(state);
    let new = NewNote { body_json, attachment_ids };
    Ok(notes::create(&mut conn, &new, now_ms())?)
}

#[tauri::command]
pub fn update_note(
    state: State<'_, AppState>,
    id: i64,
    body_json: String,
    attachment_ids: Vec<i64>,
) -> CmdResult<Note> {
    let mut conn = conn!(state);
    Ok(notes::update(&mut conn, id, &body_json, &attachment_ids, now_ms())?)
}

#[tauri::command]
pub fn get_note(state: State<'_, AppState>, id: i64) -> CmdResult<Note> {
    let conn = conn!(state);
    Ok(notes::get(&conn, id)?)
}

#[tauri::command]
pub fn list_notes(state: State<'_, AppState>, limit: u32, offset: u32) -> CmdResult<Vec<NoteSummary>> {
    let conn = conn!(state);
    Ok(notes::list(&conn, limit, offset)?)
}

#[tauri::command]
pub fn delete_note(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    let mut conn = conn!(state);
    Ok(notes::soft_delete(&mut conn, id, now_ms())?)
}

#[tauri::command]
pub fn restore_note(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    let mut conn = conn!(state);
    Ok(notes::restore(&mut conn, id, now_ms())?)
}

#[tauri::command]
pub fn list_deleted_notes(
    state: State<'_, AppState>,
    limit: u32,
    offset: u32,
) -> CmdResult<Vec<NoteSummary>> {
    let conn = conn!(state);
    Ok(notes::list_deleted(&conn, limit, offset)?)
}

#[tauri::command]
pub fn search_notes(state: State<'_, AppState>, query: String, limit: u32) -> CmdResult<Vec<SearchHit>> {
    let conn = conn!(state);
    Ok(search::search(&conn, &query, limit)?)
}

#[tauri::command]
pub fn rebuild_index(state: State<'_, AppState>) -> CmdResult<usize> {
    let mut conn = conn!(state);
    Ok(notes::rebuild_index(&mut conn)?)
}

/// 保存附件。前端把粘贴到的图片字节原样传过来。
#[tauri::command]
pub fn store_attachment(
    state: State<'_, AppState>,
    bytes: Vec<u8>,
    ext: String,
) -> CmdResult<Attachment> {
    let conn = conn!(state);
    Ok(attachments::store(&conn, &state.attachments_root, &bytes, &ext, now_ms())?)
}

/// 读附件字节，前端据此建 blob URL 显示。
#[tauri::command]
pub fn read_attachment(state: State<'_, AppState>, id: i64) -> CmdResult<Vec<u8>> {
    let conn = conn!(state);
    let attachment = attachments::get(&conn, id)?.ok_or(CoreError::AttachmentNotFound(id))?;
    let path = state
        .attachments_root
        .join(attachments::relative_path(&attachment.sha256, &attachment.ext));
    Ok(std::fs::read(path).map_err(CoreError::Io)?)
}

#[tauri::command]
pub fn collect_garbage(state: State<'_, AppState>) -> CmdResult<usize> {
    let conn = conn!(state);
    Ok(attachments::collect_garbage(&conn, &state.attachments_root)?)
}
```

`src-tauri/src/main.rs` 中注册命令，`Builder::default()` 之后追加：

```rust
mod commands;
```

并在 builder 链上加：

```rust
        .invoke_handler(tauri::generate_handler![
            commands::create_note,
            commands::update_note,
            commands::get_note,
            commands::list_notes,
            commands::delete_note,
            commands::restore_note,
            commands::list_deleted_notes,
            commands::search_notes,
            commands::rebuild_index,
            commands::store_attachment,
            commands::read_attachment,
            commands::collect_garbage,
        ])
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test -p meshmind && cargo build -p meshmind`
Expected: 测试通过，编译通过。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(shell): 笔记、搜索与附件 IPC 命令"
```

---

### Task 4: 前端 IPC 封装与纯函数模块

**Files:**
- Create: `src/lib/ipc.ts`, `src/lib/clipboard.ts`, `src/lib/highlight.ts`, `src/lib/attachments.ts`
- Create: `src/lib/clipboard.test.ts`, `src/lib/highlight.test.ts`
- Modify: `package.json`（已含 vitest 脚本）

- [ ] **Step 1: 写失败的测试**

`src/lib/highlight.test.ts`：

```ts
import { describe, expect, it } from 'vitest'

import { splitByTerms } from './highlight'

describe('splitByTerms', () => {
  it('标出命中的词', () => {
    expect(splitByTerms('知识图谱构建', ['图谱'])).toEqual([
      { text: '知识', hit: false },
      { text: '图谱', hit: true },
      { text: '构建', hit: false },
    ])
  })

  it('没有命中词时原样返回', () => {
    expect(splitByTerms('知识图谱', [])).toEqual([{ text: '知识图谱', hit: false }])
  })

  it('忽略大小写', () => {
    expect(splitByTerms('Hello Tauri', ['tauri'])).toEqual([
      { text: 'Hello ', hit: false },
      { text: 'Tauri', hit: true },
    ])
  })

  it('正则元字符按字面处理', () => {
    expect(splitByTerms('a+b', ['+'])).toEqual([
      { text: 'a', hit: false },
      { text: '+', hit: true },
      { text: 'b', hit: false },
    ])
  })
})
```

`src/lib/clipboard.test.ts`：

```ts
import { describe, expect, it } from 'vitest'

import { extensionForMime } from './clipboard'

describe('extensionForMime', () => {
  it('识别常见图片类型', () => {
    expect(extensionForMime('image/png')).toBe('png')
    expect(extensionForMime('image/jpeg')).toBe('jpg')
    expect(extensionForMime('image/gif')).toBe('gif')
    expect(extensionForMime('image/webp')).toBe('webp')
  })

  it('未知类型退回 bin', () => {
    expect(extensionForMime('application/x-weird')).toBe('bin')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test`
Expected: 失败，`Failed to resolve import "./highlight"`。

- [ ] **Step 3: 实现前端模块**

`src/lib/ipc.ts`：

```ts
import { invoke } from '@tauri-apps/api/core'

// 这些类型与 crates/core 的 Rust 结构一一对应。改 Rust 那边就要同步改这里。
export interface Note {
  id: number
  uuid: string
  title: string
  bodyJson: string
  bodyText: string
  createdAt: number
  updatedAt: number
  tags: string[]
  attachmentIds: number[]
}

export interface NoteSummary {
  id: number
  uuid: string
  title: string
  excerpt: string
  updatedAt: number
  tags: string[]
}

export type HitSource = 'Literal' | 'PinyinFull' | 'PinyinHead'

export interface SearchHit {
  noteId: number
  uuid: string
  title: string
  excerpt: string
  matchedTerms: string[]
  source: HitSource
}

export interface Attachment {
  id: number
  sha256: string
  ext: string
  byteSize: number
  width: number | null
  height: number | null
}

// Rust 侧字段是 snake_case，序列化后原样过来，这里统一转成 camelCase，
// 让组件只见到一种命名风格。
function toCamel<T>(value: unknown): T {
  if (Array.isArray(value)) return value.map((v) => toCamel(v)) as T
  if (value === null || typeof value !== 'object') return value as T
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = toCamel(val)
  }
  return out as T
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return toCamel<T>(await invoke(command, args))
}

export const ipc = {
  createNote: (bodyJson: string, attachmentIds: number[] = []) =>
    call<Note>('create_note', { bodyJson, attachmentIds }),
  updateNote: (id: number, bodyJson: string, attachmentIds: number[] = []) =>
    call<Note>('update_note', { id, bodyJson, attachmentIds }),
  getNote: (id: number) => call<Note>('get_note', { id }),
  listNotes: (limit = 100, offset = 0) => call<NoteSummary[]>('list_notes', { limit, offset }),
  deleteNote: (id: number) => call<void>('delete_note', { id }),
  restoreNote: (id: number) => call<void>('restore_note', { id }),
  listDeletedNotes: (limit = 100, offset = 0) =>
    call<NoteSummary[]>('list_deleted_notes', { limit, offset }),
  searchNotes: (query: string, limit = 30) => call<SearchHit[]>('search_notes', { query, limit }),
  rebuildIndex: () => call<number>('rebuild_index'),
  storeAttachment: (bytes: number[], ext: string) =>
    call<Attachment>('store_attachment', { bytes, ext }),
  readAttachment: (id: number) => call<number[]>('read_attachment', { id }),
  collectGarbage: () => call<number>('collect_garbage'),
}
```

`src/lib/highlight.ts`：

```ts
export interface Slice {
  text: string
  hit: boolean
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/// 把文本按命中词切片，供搜索结果高亮。命中词来自 Rust 侧的 matchedTerms。
export function splitByTerms(text: string, terms: string[]): Slice[] {
  const usable = terms.filter((t) => t.trim().length > 0)
  if (usable.length === 0) return [{ text, hit: false }]

  const pattern = new RegExp(`(${usable.map(escapeRegExp).join('|')})`, 'gi')
  return text
    .split(pattern)
    .filter((part) => part.length > 0)
    .map((part) => ({
      text: part,
      hit: usable.some((term) => term.toLowerCase() === part.toLowerCase()),
    }))
}
```

`src/lib/clipboard.ts`：

```ts
const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
}

export function extensionForMime(mime: string): string {
  return MIME_EXTENSIONS[mime] ?? 'bin'
}

export interface PastedImage {
  bytes: number[]
  ext: string
}

/// 从粘贴事件里取出图片。没有图片返回 null，此时交回浏览器默认的文本粘贴行为。
export async function extractPastedImage(
  clipboardData: DataTransfer | null,
): Promise<PastedImage | null> {
  if (!clipboardData) return null
  const file = Array.from(clipboardData.items)
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .find((f): f is File => f !== null)
  if (!file) return null

  const buffer = await file.arrayBuffer()
  return { bytes: Array.from(new Uint8Array(buffer)), ext: extensionForMime(file.type) }
}
```

`src/lib/attachments.ts`：

```ts
import { ipc } from './ipc'

// 同一张图在列表和编辑器里会被反复请求，缓存 blob URL 避免重复 IPC 与重复分配。
const cache = new Map<number, string>()

export async function attachmentUrl(id: number): Promise<string> {
  const cached = cache.get(id)
  if (cached) return cached

  const bytes = await ipc.readAttachment(id)
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]))
  cache.set(id, url)
  return url
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test`
Expected: 6 个测试全部通过。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(web): IPC 封装、剪贴板解析与高亮切片"
```

---

### Task 5: TipTap 编辑器与附件图片节点

**Files:**
- Create: `src/editor/AttachmentImage.tsx`, `src/editor/Editor.tsx`
- Modify: `package.json`

- [ ] **Step 1: 安装编辑器依赖**

```bash
cd /Users/chenhao/codes/myself/MeshMind
pnpm add @tiptap/react @tiptap/starter-kit @tiptap/core @tiptap/pm
```

- [ ] **Step 2: 实现附件图片节点**

`src/editor/AttachmentImage.tsx`：

```tsx
import { Node, mergeAttributes } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import { useEffect, useState } from 'react'

import { attachmentUrl } from '../lib/attachments'

function AttachmentImageView({ node }: NodeViewProps) {
  const id = node.attrs.attachmentId as number
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    attachmentUrl(id)
      .then((u) => alive && setUrl(u))
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [id])

  return (
    <NodeViewWrapper className="attachment-image">
      {failed ? <span className="attachment-missing">图片已丢失（#{id}）</span> : null}
      {url ? <img src={url} alt="" /> : null}
    </NodeViewWrapper>
  )
}

/// 文档 JSON 里只存 attachmentId。绝不存 blob URL —— 它重启即失效。
export const AttachmentImage = Node.create({
  name: 'attachmentImage',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return { attachmentId: { default: null } }
  },

  parseHTML() {
    return [{ tag: 'img[data-attachment-id]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes({ 'data-attachment-id': HTMLAttributes.attachmentId })]
  },

  addNodeView() {
    return ReactNodeViewRenderer(AttachmentImageView)
  },
})
```

- [ ] **Step 3: 实现编辑器封装**

`src/editor/Editor.tsx`：

```tsx
import StarterKit from '@tiptap/starter-kit'
import { EditorContent, useEditor } from '@tiptap/react'
import { useEffect } from 'react'

import { extractPastedImage } from '../lib/clipboard'
import { ipc } from '../lib/ipc'
import { AttachmentImage } from './AttachmentImage'

interface Props {
  /// 初始文档 JSON 字符串；切换笔记时传入新值。
  bodyJson: string
  /// 内容变化时回调，参数是最新的文档 JSON 字符串。
  onChange: (bodyJson: string) => void
  placeholder?: string
  autoFocus?: boolean
}

export function Editor({ bodyJson, onChange, autoFocus = false }: Props) {
  const editor = useEditor({
    extensions: [StarterKit, AttachmentImage],
    content: bodyJson ? JSON.parse(bodyJson) : undefined,
    autofocus: autoFocus,
    onUpdate: ({ editor }) => onChange(JSON.stringify(editor.getJSON())),
    editorProps: {
      handlePaste: (view, event) => {
        // 图片走附件落盘，其余交回默认行为（纯文本与 HTML 由 TipTap 自己处理）。
        const data = event.clipboardData
        void extractPastedImage(data).then(async (image) => {
          if (!image) return
          const stored = await ipc.storeAttachment(image.bytes, image.ext)
          view.dispatch(
            view.state.tr.replaceSelectionWith(
              view.state.schema.nodes.attachmentImage.create({ attachmentId: stored.id }),
            ),
          )
        })
        const hasImage = Array.from(data?.items ?? []).some(
          (item) => item.kind === 'file' && item.type.startsWith('image/'),
        )
        return hasImage
      },
    },
  })

  // 切换笔记时把编辑器内容换掉。false 表示不再触发 onUpdate，避免刚载入就误判成用户编辑。
  useEffect(() => {
    if (!editor) return
    const incoming = bodyJson ? JSON.parse(bodyJson) : { type: 'doc', content: [] }
    if (JSON.stringify(editor.getJSON()) !== JSON.stringify(incoming)) {
      editor.commands.setContent(incoming, false)
    }
  }, [bodyJson, editor])

  return <EditorContent editor={editor} className="editor" />
}

/// 空文档的标准形态，新建笔记时用。
export const EMPTY_DOC = JSON.stringify({
  type: 'doc',
  content: [{ type: 'paragraph' }],
})
```

- [ ] **Step 4: 类型检查**

Run: `pnpm build`
Expected: `tsc --noEmit` 通过，vite 构建成功。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(web): TipTap 编辑器与附件图片节点"
```

---

### Task 6: 主窗口（笔记流 + 编辑器 + 自动保存）

**Files:**
- Create: `src/components/NoteList.tsx`, `src/App.tsx`
- Modify: `src/main.tsx`, `src/styles.css`

- [ ] **Step 1: 实现笔记流**

`src/components/NoteList.tsx`：

```tsx
import type { NoteSummary } from '../lib/ipc'

interface Props {
  notes: NoteSummary[]
  selectedId: number | null
  onSelect: (id: number) => void
  onDelete: (id: number) => void
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function NoteList({ notes, selectedId, onSelect, onDelete }: Props) {
  if (notes.length === 0) {
    return <div className="note-list-empty">还没有笔记。按 ⌥Space 随手记一条。</div>
  }

  return (
    <ul className="note-list">
      {notes.map((note) => (
        <li
          key={note.id}
          className={note.id === selectedId ? 'note-item selected' : 'note-item'}
          onClick={() => onSelect(note.id)}
        >
          <div className="note-item-head">
            <span className="note-item-title">{note.title || '无标题'}</span>
            <button
              className="note-item-delete"
              title="删除"
              onClick={(e) => {
                e.stopPropagation()
                onDelete(note.id)
              }}
            >
              ×
            </button>
          </div>
          <div className="note-item-excerpt">{note.excerpt}</div>
          <div className="note-item-meta">
            <span>{formatTime(note.updatedAt)}</span>
            {note.tags.map((tag) => (
              <span key={tag} className="tag">
                #{tag}
              </span>
            ))}
          </div>
        </li>
      ))}
    </ul>
  )
}
```

- [ ] **Step 2: 实现主窗口**

`src/App.tsx`：

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'

import { NoteList } from './components/NoteList'
import { SearchPanel } from './components/SearchPanel'
import { EMPTY_DOC, Editor } from './editor/Editor'
import { ipc } from './lib/ipc'
import type { Note, NoteSummary } from './lib/ipc'

const AUTOSAVE_DELAY_MS = 800

export function App() {
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [current, setCurrent] = useState<Note | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const saveTimer = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    setNotes(await ipc.listNotes())
  }, [])

  useEffect(() => {
    refresh().catch((e) => setError(String(e)))
  }, [refresh])

  // 快捕窗口存完会广播这个事件，主窗口据此刷新列表。
  useEffect(() => {
    const onCaptured = () => void refresh()
    window.addEventListener('meshmind:note-saved', onCaptured)
    return () => window.removeEventListener('meshmind:note-saved', onCaptured)
  }, [refresh])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
      if (e.key === 'Escape') setSearchOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const open = useCallback(async (id: number) => {
    setCurrent(await ipc.getNote(id))
  }, [])

  const createBlank = useCallback(async () => {
    const note = await ipc.createNote(EMPTY_DOC)
    setCurrent(note)
    await refresh()
  }, [refresh])

  const remove = useCallback(
    async (id: number) => {
      await ipc.deleteNote(id)
      if (current?.id === id) setCurrent(null)
      await refresh()
    },
    [current, refresh],
  )

  // 编辑后延时落盘。每次改动都重置计时器，停手 800ms 才写一次。
  const onEdit = useCallback(
    (bodyJson: string) => {
      if (!current) return
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => {
        ipc
          .updateNote(current.id, bodyJson, current.attachmentIds)
          .then(() => refresh())
          .catch((e) => setError(String(e)))
      }, AUTOSAVE_DELAY_MS)
    },
    [current, refresh],
  )

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="sidebar-head">
          <button onClick={() => void createBlank()}>新建</button>
          <button onClick={() => setSearchOpen(true)}>搜索 ⌘K</button>
        </header>
        <NoteList
          notes={notes}
          selectedId={current?.id ?? null}
          onSelect={(id) => void open(id)}
          onDelete={(id) => void remove(id)}
        />
      </aside>

      <main className="main">
        {current ? (
          <Editor key={current.id} bodyJson={current.bodyJson} onChange={onEdit} autoFocus />
        ) : (
          <div className="empty-state">选一条笔记，或按 ⌘K 搜索</div>
        )}
      </main>

      {searchOpen ? (
        <SearchPanel
          onClose={() => setSearchOpen(false)}
          onPick={(id) => {
            setSearchOpen(false)
            void open(id)
          }}
        />
      ) : null}

      {error ? (
        <div className="error-bar" onClick={() => setError(null)}>
          {error}（点击关闭）
        </div>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 3: 按窗口分流挂载**

`src/main.tsx` 全文替换为：

```tsx
import { getCurrentWindow } from '@tauri-apps/api/window'
import React from 'react'
import ReactDOM from 'react-dom/client'

import { App } from './App'
import { Capture } from './Capture'
import './styles.css'

// 两个窗口共用同一份前端产物，靠 label 决定挂谁。
const isCapture = getCurrentWindow().label === 'capture'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{isCapture ? <Capture /> : <App />}</React.StrictMode>,
)
```

- [ ] **Step 4: 补样式**

`src/styles.css` 末尾追加：

```css
.app { display: grid; grid-template-columns: 320px 1fr; height: 100vh; }
.sidebar { border-right: 1px solid var(--border); display: flex; flex-direction: column; background: var(--panel); }
.sidebar-head { display: flex; gap: 8px; padding: 12px; border-bottom: 1px solid var(--border); }
.sidebar-head button { flex: 1; padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--fg); cursor: pointer; }
.note-list { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1; }
.note-list-empty, .empty-state { padding: 32px 16px; color: var(--muted); text-align: center; }
.note-item { padding: 12px; border-bottom: 1px solid var(--border); cursor: pointer; }
.note-item.selected { background: var(--bg); border-left: 3px solid var(--accent); }
.note-item-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.note-item-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.note-item-delete { border: none; background: none; color: var(--muted); cursor: pointer; font-size: 16px; }
.note-item-excerpt { color: var(--muted); font-size: 13px; margin-top: 4px; max-height: 34px; overflow: hidden; }
.note-item-meta { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; font-size: 12px; color: var(--muted); }
.tag { color: var(--accent); }
.main { overflow-y: auto; }
.editor { padding: 24px 32px; }
.editor .ProseMirror { outline: none; min-height: 60vh; line-height: 1.7; }
.editor .ProseMirror img { max-width: 100%; border-radius: 6px; }
.attachment-missing { color: var(--muted); font-size: 13px; }
.error-bar { position: fixed; bottom: 0; left: 0; right: 0; padding: 8px 12px; background: #b91c1c; color: #fff; font-size: 13px; cursor: pointer; }
```

- [ ] **Step 5: 类型检查**

Run: `pnpm build`
Expected: 报错 `Cannot find module './components/SearchPanel'` 与 `'./Capture'` —— 这两个在下面两个 Task 里补齐，先记着，不要在这里凑合实现。

- [ ] **Step 6: 提交（允许暂时不通过构建）**

```bash
git add -A
git commit -m "feat(web): 主窗口笔记流、编辑器与自动保存"
```

---

### Task 7: 搜索面板

**Files:**
- Create: `src/components/SearchPanel.tsx`
- Modify: `src/styles.css`

- [ ] **Step 1: 实现搜索面板**

`src/components/SearchPanel.tsx`：

```tsx
import { useEffect, useState } from 'react'

import { splitByTerms } from '../lib/highlight'
import { ipc } from '../lib/ipc'
import type { SearchHit } from '../lib/ipc'

const DEBOUNCE_MS = 120

const SOURCE_LABELS: Record<SearchHit['source'], string> = {
  Literal: '字面',
  PinyinFull: '全拼',
  PinyinHead: '首字母',
}

interface Props {
  onClose: () => void
  onPick: (noteId: number) => void
}

function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {splitByTerms(text, terms).map((slice, i) =>
        slice.hit ? <mark key={i}>{slice.text}</mark> : <span key={i}>{slice.text}</span>,
      )}
    </>
  )
}

export function SearchPanel({ onClose, onPick }: Props) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [active, setActive] = useState(0)

  // 输入即搜，停手 120ms 才发请求。
  useEffect(() => {
    if (query.trim() === '') {
      setHits([])
      return
    }
    const timer = window.setTimeout(() => {
      ipc
        .searchNotes(query)
        .then((result) => {
          setHits(result)
          setActive(0)
        })
        .catch(() => setHits([]))
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, hits.length - 1))
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    }
    if (e.key === 'Enter' && hits[active]) onPick(hits[active].noteId)
    if (e.key === 'Escape') onClose()
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="search-panel" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="search-input"
          placeholder="搜索笔记 —— 支持中文、拼音（zhishitupu）与首字母（zstp）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <ul className="search-results">
          {hits.map((hit, i) => (
            <li
              key={hit.noteId}
              className={i === active ? 'search-hit active' : 'search-hit'}
              onClick={() => onPick(hit.noteId)}
            >
              <div className="search-hit-title">
                <Highlighted text={hit.title || '无标题'} terms={hit.matchedTerms} />
                <span className="search-hit-source">{SOURCE_LABELS[hit.source]}</span>
              </div>
              <div className="search-hit-excerpt">
                <Highlighted text={hit.excerpt} terms={hit.matchedTerms} />
              </div>
            </li>
          ))}
          {query.trim() !== '' && hits.length === 0 ? (
            <li className="search-empty">没有命中</li>
          ) : null}
        </ul>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 补样式**

`src/styles.css` 末尾追加：

```css
.overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); display: flex; justify-content: center; padding-top: 12vh; }
.search-panel { width: min(680px, 92vw); max-height: 70vh; display: flex; flex-direction: column; background: var(--bg); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3); }
.search-input { border: none; border-bottom: 1px solid var(--border); padding: 14px 16px; font-size: 15px; background: transparent; color: var(--fg); outline: none; }
.search-results { list-style: none; margin: 0; padding: 0; overflow-y: auto; }
.search-hit { padding: 10px 16px; cursor: pointer; border-bottom: 1px solid var(--border); }
.search-hit.active { background: var(--panel); }
.search-hit-title { display: flex; justify-content: space-between; gap: 8px; font-weight: 600; }
.search-hit-source { color: var(--muted); font-size: 12px; font-weight: 400; }
.search-hit-excerpt { color: var(--muted); font-size: 13px; margin-top: 3px; }
.search-empty { padding: 16px; color: var(--muted); }
mark { background: rgba(250, 204, 21, 0.35); color: inherit; border-radius: 2px; }
```

- [ ] **Step 3: 提交**

```bash
git add -A
git commit -m "feat(web): Cmd+K 搜索面板与命中高亮"
```

---

### Task 8: 快捕窗口与全局热键

**Files:**
- Create: `src/Capture.tsx`
- Modify: `src-tauri/src/main.rs`, `src/styles.css`

- [ ] **Step 1: 实现快捕窗口前端**

`src/Capture.tsx`：

```tsx
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useCallback, useEffect, useState } from 'react'

import { EMPTY_DOC, Editor } from './editor/Editor'
import { ipc } from './lib/ipc'

function isEmptyDoc(bodyJson: string): boolean {
  const doc = JSON.parse(bodyJson)
  const blocks = doc.content ?? []
  return blocks.every((block: { content?: unknown[] }) => (block.content ?? []).length === 0)
}

export function Capture() {
  const [bodyJson, setBodyJson] = useState(EMPTY_DOC)
  const [saving, setSaving] = useState(false)

  const reset = useCallback(async () => {
    setBodyJson(EMPTY_DOC)
    await getCurrentWindow().hide()
  }, [])

  const save = useCallback(async () => {
    if (isEmptyDoc(bodyJson) || saving) return
    setSaving(true)
    try {
      await ipc.createNote(bodyJson)
      window.dispatchEvent(new Event('meshmind:note-saved'))
      await reset()
    } finally {
      setSaving(false)
    }
  }, [bodyJson, reset, saving])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        void save()
      }
      if (e.key === 'Escape') {
        // 有内容时先确认，避免误触把刚敲的东西丢了。
        if (!isEmptyDoc(bodyJson) && !window.confirm('放弃这条笔记？')) return
        void reset()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [bodyJson, reset, save])

  return (
    <div className="capture">
      <Editor bodyJson={bodyJson} onChange={setBodyJson} autoFocus />
      <footer className="capture-hint">
        <span>⌘/Ctrl + Enter 保存 · Esc 取消 · 可直接粘贴截图</span>
      </footer>
    </div>
  )
}
```

- [ ] **Step 2: 注册全局热键**

`src-tauri/src/main.rs` 中 `setup` 内追加（`app.manage(state)` 之后）：

```rust
            register_capture_shortcut(app.handle())?;
```

文件末尾追加：

```rust
use tauri::{AppHandle, Manager as _};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// macOS 用 Option+Space；Windows 的 Alt+Space 被系统窗口菜单占用，改用 Alt+Shift+Space。
fn capture_shortcut() -> Shortcut {
    #[cfg(target_os = "macos")]
    {
        Shortcut::new(Some(Modifiers::ALT), Code::Space)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), Code::Space)
    }
}

/// 切换快捕窗口的显示状态。注册失败不静默吞掉 —— 热键被别的应用占了必须让用户知道。
fn register_capture_shortcut(app: &AppHandle) -> tauri::Result<()> {
    let shortcut = capture_shortcut();
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, triggered, event| {
                if *triggered != shortcut || event.state() != ShortcutState::Pressed {
                    return;
                }
                if let Some(window) = app.get_webview_window("capture") {
                    let visible = window.is_visible().unwrap_or(false);
                    let _ = if visible {
                        window.hide()
                    } else {
                        window.show().and_then(|_| window.set_focus())
                    };
                }
            })
            .build(),
    )?;
    app.global_shortcut().register(shortcut)?;
    Ok(())
}
```

- [ ] **Step 3: 补样式**

`src/styles.css` 末尾追加：

```css
.capture { display: flex; flex-direction: column; height: 100vh; background: var(--bg); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.capture .editor { flex: 1; padding: 16px; overflow-y: auto; }
.capture-hint { padding: 8px 16px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; }
```

- [ ] **Step 4: 构建验证**

```bash
pnpm build
cargo build -p meshmind
```

Expected: 两者均通过。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat: 快捕窗口与全局热键"
```

---

### Task 9: 托盘与单实例

**Files:**
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: 实现托盘与单实例**

`src-tauri/src/main.rs` 的 builder 链最前面加单实例插件（必须第一个注册，否则第二个进程已经把窗口开出来了）：

```rust
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 第二次启动唤起已有窗口，绝不开新进程 —— 两个进程写同一个 SQLite 会出事。
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
```

`setup` 内追加：

```rust
            build_tray(app.handle())?;
```

文件末尾追加：

```rust
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let capture = MenuItem::with_id(app, "capture", "快速捕捉", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &capture, &quit])?;

    TrayIconBuilder::new()
        .icon(app.default_window_icon().expect("缺少应用图标").clone())
        .tooltip("MeshMind")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "capture" => {
                if let Some(window) = app.get_webview_window("capture") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}
```

- [ ] **Step 2: 关窗不退出**

builder 链追加，让关主窗口只是隐藏 —— 这是常驻托盘应用该有的行为：

```rust
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
```

- [ ] **Step 3: 构建验证**

Run: `cargo build -p meshmind`
Expected: 通过。

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "feat(shell): 托盘菜单、单实例与关窗隐藏"
```

---

### Task 10: 端到端冒烟验证

**Files:**
- Create: `docs/manual-verification.md`

- [ ] **Step 1: 启动开发模式**

```bash
cd /Users/chenhao/codes/myself/MeshMind
pnpm tauri dev
```

Expected: 主窗口打开，显示空列表与「按 ⌥Space 随手记一条」提示，控制台无红色报错。

- [ ] **Step 2: 走一遍主链路**

依次确认：

1. 点「新建」→ 编辑器出现 → 输入「知识图谱 #测试」→ 停手 1 秒 → 左侧列表出现该条，标签显示 `#测试`
2. 按 ⌘K → 输入「知识图」→ 命中该条，来源标「字面」
3. ⌘K → 输入「zhishitupu」→ 命中，来源标「全拼」
4. ⌘K → 输入「zstp」→ 命中，来源标「首字母」
5. 系统截图（⌘⇧4）后在编辑器里 ⌘V → 图片显示出来
6. 重启应用 → 笔记与图片仍在
7. 按 ⌥Space → 快捕窗口弹出 → 输入文字 → ⌘Enter → 窗口消失，主窗口列表多一条
8. 关闭主窗口 → 应用仍在托盘 → 托盘菜单「显示主窗口」能唤回

- [ ] **Step 3: 记录手工验证清单**

`docs/manual-verification.md`：

```markdown
# 手工验证清单

每个平台各跑一遍。自动化测试覆盖不到窗口、热键、托盘与真实剪贴板，这些只能手工确认。

## 通用

- [ ] 新建笔记，输入文字，停手 1 秒后列表出现该条
- [ ] 正文写 `#标签`，保存后列表显示该标签
- [ ] ⌘/Ctrl+K 搜索：中文前缀（知识图 → 知识图谱）
- [ ] ⌘/Ctrl+K 搜索：全拼连写（zhishitupu）
- [ ] ⌘/Ctrl+K 搜索：首字母（zstp）
- [ ] 搜索结果高亮命中词，来源标签正确
- [ ] 系统截图后粘贴，图片显示
- [ ] 粘贴网页富文本，保留标题与列表结构
- [ ] 删除笔记后列表与搜索均不再出现
- [ ] 重启应用后笔记、标签、图片都还在
- [ ] 全局热键唤起快捕窗口，再按一次收起
- [ ] 快捕窗口 ⌘/Ctrl+Enter 保存，主窗口列表随即更新
- [ ] 快捕窗口有内容时按 Esc 会二次确认
- [ ] 关闭主窗口后应用留在托盘，托盘菜单可唤回
- [ ] 重复启动应用不会开出第二个进程

## macOS 专属

- [ ] 热键为 ⌥Space，与系统及常用应用无冲突
- [ ] 数据落在 `~/Library/Application Support/com.meshmind.desktop/`
- [ ] 菜单栏出现托盘图标
- [ ] .dmg 安装后能正常启动（首次需右键打开绕过 Gatekeeper，应用未签名）

## Windows 专属

- [ ] 热键为 Alt+Shift+Space（Alt+Space 被系统窗口菜单占用）
- [ ] 数据落在 `%APPDATA%\com.meshmind.desktop\`
- [ ] 系统托盘出现图标
- [ ] .msi 安装后能正常启动
- [ ] 缺少 WebView2 的机器上有安装引导
```

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "docs: 双平台手工验证清单"
```

---

### Task 11: 打包

**Files:**
- Modify: `src-tauri/tauri.conf.json`（按需）

- [ ] **Step 1: 构建 macOS 安装包**

```bash
cd /Users/chenhao/codes/myself/MeshMind
pnpm tauri build --bundles dmg
```

Expected: 产物在 `src-tauri/target/release/bundle/dmg/MeshMind_0.1.0_*.dmg`。首次 release 构建 10-20 分钟。

- [ ] **Step 2: 验证安装包**

```bash
ls -lh src-tauri/target/release/bundle/dmg/
hdiutil attach src-tauri/target/release/bundle/dmg/MeshMind_0.1.0_*.dmg
ls /Volumes/MeshMind*/
hdiutil detach /Volumes/MeshMind*/
```

Expected: dmg 能挂载，内含 `MeshMind.app`。

应用未做代码签名，首次打开需在「系统设置 → 隐私与安全性」里放行，或右键点「打开」。个人自用可接受，签名需要 Apple 开发者账号，不在 MVP 范围。

- [ ] **Step 3: 提交**

```bash
git add -A
git commit -m "build: macOS dmg 打包配置"
```

Windows 的 .msi 无法在 macOS 上交叉构建，交给 Task 12 的 CI 或本机 Windows 上执行 `pnpm tauri build --bundles msi`。

---

### Task 12: 双平台 CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: 写 CI 配置**

`.github/workflows/ci.yml`：

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
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
        with:
          components: clippy, rustfmt

      - uses: Swatinem/rust-cache@v2

      - name: 安装 Linux 构建依赖
        if: runner.os == 'Linux'
        run: echo "本项目只面向 macOS 与 Windows"

      - run: pnpm install --frozen-lockfile
      - run: pnpm test
      - run: pnpm build

      - run: cargo test --workspace
      - run: cargo clippy --workspace --all-targets -- -D warnings
      - run: cargo fmt --all -- --check

      - name: 构建安装包
        run: pnpm tauri build
```

- [ ] **Step 2: 本地复跑 CI 的检查项**

```bash
cd /Users/chenhao/codes/myself/MeshMind
pnpm install --frozen-lockfile
pnpm test
pnpm build
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
```

Expected: 全部通过。这一步的意义是别把本地能过、CI 才炸的问题留到明天。

- [ ] **Step 3: 提交**

```bash
git add -A
git commit -m "ci: 双平台测试与打包工作流"
```

CI 需要仓库有 GitHub remote 才会实际运行。当前仓库还没有 remote，工作流文件先就位，推上去即生效。

---

## 完成标准

- `cargo test --workspace` 与 `pnpm test` 全绿
- `cargo clippy --workspace --all-targets -- -D warnings` 无警告
- macOS 上 `pnpm tauri dev` 能跑通 Task 10 的八步冒烟链路
- `src-tauri/target/release/bundle/dmg/` 下有可挂载的 .dmg
- `docs/manual-verification.md` 与 `.github/workflows/ci.yml` 就位

## 明确不在本计划内

无限白板、AI/RAG、知识图谱、双向链接、OCR、云同步、代码签名与公证、自动更新。
