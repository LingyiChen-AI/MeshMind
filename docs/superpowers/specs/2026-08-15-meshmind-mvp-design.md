# MeshMind MVP 设计文档

日期：2026-08-15
状态：已确认，待编写实施计划

## 1. 背景与目标

MeshMind 是一款本地优先（local-first）的跨平台桌面笔记客户端，目标平台 macOS 与 Windows。完整产品愿景见 `solution_proposal.pdf`：随手捕捉、结构化写作、无限白板、本地极速检索、可插拔 AI、动态知识图谱。

本文档只覆盖 **MVP**：捕捉 + 写 + 搜。这是整个产品中唯一不可替代的价值闭环，也是最快能日常自用的一版。

### MVP 范围

包含：

- 全局热键唤起快捕窗口，粘贴图片/富文本/纯文本并落盘
- 块式富文本编辑（TipTap），图片作为块嵌入
- SQLite FTS5 全局搜索，支持中文分词、全拼、首字母
- 扁平笔记流 + 标签
- 双平台打包（.dmg / .msi）

**明确不做**：无限白板、AI/RAG/embedding、知识图谱与力导图渲染、双向链接、OCR、云同步、移动端。这些在 MVP 之后按子项目独立走 spec → plan → 实现。

### 已确认的关键决策

| 决策 | 结论 | 理由 |
|---|---|---|
| OCR | 不做 | 省掉三套平台适配（PaddleOCR / Vision Framework / Windows.Media.Ocr）。代价：图片内容不可搜，只能靠上下文文字命中 |
| 存储形态 | 单一 SQLite 库 | 事务一致、实现最简、搜索最快。代价：笔记不能被外部工具直接打开，云盘同步单个大文件易冲突 |
| 截图 | 只做粘贴，不做应用内选区截屏 | 零系统权限、零平台差异；用系统截图工具截完粘贴，体验损失小 |
| 平台 | macOS 与 Windows 同等对待，均真机验证 | 用户两台机器都有 |
| 组织方式 | 扁平 + 标签，无文件夹 | 捕捉时不应停下来想存哪里；数据模型最简，与未来的双向链接/图谱天然兼容 |
| 搜索 | jieba 中文分词 + 拼音（全拼 + 首字母） | 用户明确要求 |
| 外壳框架 | Tauri 2.0 + React + TypeScript + Vite | 安装包 ~10MB、内存 <100MB；jieba-rs / pinyin / 未来的 sqlite-vec 都在 Rust 侧最省事 |
| 逻辑归属 | Rust 侧为主，前端零 SQL | 分词与拼音必须在 Rust 跑，DB 逻辑跟着走才不会撕裂；且搜索能脱离 GUI 单测 |

### 环境前置

- Node 24 / pnpm 10：已具备
- Xcode Command Line Tools：已具备
- **Rust 工具链：未安装**，需先 `rustup` 安装（约 1~1.5GB）

## 2. 模块边界

铁律：**前端不写一行 SQL**。所有数据操作走 `invoke()` 调 Rust 命令，`src/lib/ipc.ts` 是唯一跟 Rust 通话的地方，类型定义从该处单点导出。

```
src-tauri/src/
  db/           连接管理、schema 迁移（PRAGMA user_version 递增）
  notes/        笔记 CRUD，唯一能写 notes 表的地方
  search/       分词、拼音、查询构建、排序 —— 以纯函数为主
  attachments/  内容寻址落盘、引用计数、孤儿 GC
  commands/     #[tauri::command] 薄适配层，只做参数转换与错误映射
  app/          窗口、托盘、全局热键、单实例装配
src/
  features/capture/     快捕窗口
  features/editor/      TipTap 封装
  features/notes-list/  笔记流
  features/search/      搜索面板
  lib/ipc.ts            唯一 invoke 出口
```

`commands/` 刻意做薄，使 `notes/`、`search/`、`attachments/` 不依赖 Tauri —— 它们能在 `cargo test` 里用内存 SQLite 直接跑，无需启动 GUI。

各模块的对外契约：

- `notes`：给定 TipTap JSON 与标签，写入或更新一篇笔记；返回笔记列表与单篇详情；软删除与恢复。依赖 `db`、`search`（生成索引列）、`attachments`（引用登记）。
- `search`：给定查询字符串，返回排序后的笔记 id 与命中词列表。依赖 `db` 只读。分词与拼音生成是纯函数，不碰数据库。
- `attachments`：给定字节流与扩展名，落盘并返回 attachment id；解析 id 到文件路径；回收零引用文件。依赖 `db`、文件系统。

## 3. 数据模型

```sql
notes(
  id         INTEGER PRIMARY KEY,   -- 与 FTS5 的 rowid 对齐
  uuid       TEXT NOT NULL UNIQUE,  -- 对外稳定标识，为未来的双向链接/导出/同步预留
  title      TEXT NOT NULL,         -- 正文首行推导，可为空串
  body_json  TEXT NOT NULL,         -- TipTap JSON，唯一真相
  body_text  TEXT NOT NULL,         -- 从 JSON 抽取的纯文本，供分词与摘要
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER                -- 软删除；FTS 中同步剔除
)

tags(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)
note_tags(note_id INTEGER, tag_id INTEGER, PRIMARY KEY(note_id, tag_id))

attachments(
  id         INTEGER PRIMARY KEY,
  sha256     TEXT NOT NULL UNIQUE,
  ext        TEXT NOT NULL,
  byte_size  INTEGER NOT NULL,
  width      INTEGER, height INTEGER,
  created_at INTEGER NOT NULL
)
note_attachments(note_id INTEGER, attachment_id INTEGER,
                 PRIMARY KEY(note_id, attachment_id))

notes_fts USING fts5(title_seg, body_seg, tokenize='unicode61')
notes_py  USING fts5(py_full, py_head,   tokenize='trigram')
```

要点：

- **`body_json` 是真相，`body_text` 与 FTS 各列都是派生**。任何时候能从 `body_json` 重算，索引损坏可全量重建而不丢数据。
- **附件内容寻址**：文件落在 `<appdata>/attachments/<sha256 前 2 位>/<sha256>.<ext>`，同一张图截多次只存一份。`note_attachments` 承担引用计数，删笔记不立即删文件，由 GC 清理零引用文件。
- **`uuid` 当前无消费方**。加它是因为未来的双向链接与图谱需要不随索引重建变化的节点身份；此刻不加，那天就得写数据迁移。这是唯一主动保留的前瞻字段，其余一律 YAGNI。

## 4. 搜索机制

两张索引表存的都不是原文，而是写入时由 Rust 生成的加工列：

| 表 | 列 | 分词器 | 内容 | 例（原文「知识图谱构建」） |
|---|---|---|---|---|
| `notes_fts` | `title_seg` | unicode61 | 标题分词后空格分隔 | 同 `body_seg` 规则，仅作用于标题 |
| `notes_fts` | `body_seg` | unicode61 | jieba 切词后空格分隔 | `知识 图谱 构建` |
| `notes_py` | `py_full` | trigram | 全拼，无空格拼接 | `zhishitupugoujian` |
| `notes_py` | `py_head` | trigram | 首字母，无空格拼接 | `zstpgj` |

**不注册 FTS5 自定义分词器。** 做法是入库时用 jieba-rs 把正文切成空格分隔的词序列存入影子列，查询时用同一分词器切一遍。效果与自定义分词器等价，但省掉 rusqlite 里注册 `fts5_api` 的 unsafe 胶水，也不会在 SQLite 版本升级时失效。

**拼音单独一张表且用 trigram，是因为真实用户输入的是连写。** 若按词空格分隔存成 `zhishi tupu`，用户敲的 `zhishitupu` 一个 token 都匹配不上。trigram 支持任意子串匹配，连写、分写、局部片段（`tupu`）全部可命中。代价是跨词边界会产生无意义子串，这点噪音换连写可用，值得。

查询分两条路：

- **含中文**：用 jieba 切分查询，拼成**短语查询且末词带前缀**（如 `"知识 图" *`）。使「知识图」能命中「知识图谱」，同时不会误中分别提到「知识」和「图」的无关笔记。
- **纯 ASCII**：归一化（转小写、去掉非字母数字）后同时匹配字面列与两个拼音列。三字符及以上走 trigram，短于三字符退回 `LIKE` 扫描（trigram 的最小匹配长度是 3）。

排序用 `bm25()` 加列权重（标题高于正文），再叠一层来源加权：**字面命中 > 全拼 > 首字母**。首字母噪音天然最大，压至最后。

高亮不使用 FTS5 的 `snippet()` —— 它返回的是带空格的分词结果，显示效果是坏的。改为 Rust 一并返回命中词列表，前端在原文 `body_text` 上自行标注。

## 5. 交互流程

### 主窗口

左侧笔记流（时间倒序，标题 + 摘要 + 时间），右侧 TipTap 编辑器，顶栏标签筛选。`Cmd/Ctrl+K` 唤出搜索面板，输入即搜（debounce 120ms），Enter 打开选中项。

### 快捕窗口

无边框、置顶、不进任务栏，只有一个输入框。

```
全局热键 (Opt+Space / Alt+Space)
  └→ 窗口已显示? 隐藏 : 显示并抢焦点
       └→ 打字 / Cmd+V 粘贴
            ├─ 剪贴板是图片 → bytes 传 Rust → 算 sha256 → 落盘 → 返回 attachment id → 作为图片块插入
            ├─ 剪贴板是 HTML → 转 TipTap JSON（保留标题/列表/加粗，丢弃样式）
            └─ 剪贴板是纯文本 → 直接插入
                 ├→ Cmd/Ctrl+Enter 保存 → Rust 事务写入 + 分词 + 拼音 + FTS → 窗口隐藏并清空
                 └→ Esc 取消（有内容时二次确认，避免误触丢失）
```

正文中书写 `#标签`，保存时解析入 `tags` / `note_tags`。不做独立的标签输入控件 —— 捕捉时任何多余控件都是摩擦。

## 6. 平台差异

| | macOS | Windows |
|---|---|---|
| 热键 | `Opt+Space` | `Alt+Space`（系统窗口菜单占用，需实测；冲突则降级为 `Alt+Shift+Space`） |
| 数据目录 | `~/Library/Application Support/MeshMind/` | `%APPDATA%\MeshMind\` |
| 托盘 | 菜单栏图标，支持隐藏 Dock 图标 | 系统托盘，支持开机自启 |
| WebView | WKWebView | WebView2（需检测未安装情形并引导） |
| 打包 | `.dmg` | `.msi` |

路径一律经 Tauri 的 `app_data_dir()` 获取，代码中不出现硬编码路径分隔符。

## 7. 错误处理

立场：宁可失败，也不静默降级。

- **迁移失败** → 启动即报错并退出，绝不带着半迁移的库继续运行
- **保存笔记** → 先写附件文件，再在**单个事务**内写 notes + FTS + tags。事务失败则笔记不存在，已落盘文件成为孤儿由 GC 回收。反序（先提交 DB 后写文件）会产生指向不存在文件的笔记，那是不可修复的
- **热键被占用** → 注册失败不静默吞掉，托盘提示并允许改键
- **剪贴板无可识别内容** → 提示，不生成空笔记
- **FTS 与 notes 不一致** → 提供「重建索引」入口，从 `body_json` 全量重算
- **单实例** → 第二次启动唤起已有窗口，不开新进程（否则两个进程写同一个 SQLite）

## 8. 测试策略

实现走 TDD，先写测试。

- **Rust 单测 / 集成测**（内存 SQLite，不起 GUI）
  - `notes`：CRUD、软删除与恢复、标签解析
  - `attachments`：内容去重、引用计数、孤儿 GC
  - `search`：一张用例表 —— 中文分词命中、前缀命中（知识图 → 知识图谱）、全拼、首字母、中英混排、空查询、纯符号查询、排序优先级
- **前端 Vitest**：剪贴板解析（图片 / HTML / 纯文本三分支）、TipTap JSON ↔ 纯文本转换、`ipc.ts` 类型契约
- **CI**：GitHub Actions 双平台跑 `cargo test` + `pnpm test` + 出包，保证 Windows 侧始终可编译
- **手工验证清单**（每平台各跑一遍）：热键唤起 / 收起、粘贴三种内容、重启后数据仍在、搜索命中、托盘行为、打包安装

## 9. 后续子项目（不在本 spec 内）

按依赖顺序：无限白板（Excalidraw）→ 双向链接与反链 → 可插拔 AI 与 Hybrid RAG（sqlite-vec + RRF 重排）→ 知识图谱渲染与实体抽取。每个独立走 spec → plan → 实现。
