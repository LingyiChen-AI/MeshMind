# Plan A：AI 索引与检索管线 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `crates/core` 与 `crates/shell` 里建成完整的「切块 → 向量化 → 混合检索 → 流式问答」链路，全部可由 Rust 单测验证，暂不涉及任何界面。

**Architecture:** core 只做纯计算与 SQLite；服务商协议在 core 里表现为「构造请求 / 解析响应」的纯函数，shell 用 `reqwest::blocking` 把请求发出去。后台向量化跑在独立线程上，内存向量索引挂在 `AiRuntime` 里懒加载。

**Tech Stack:** Rust 2024 (core) / 2021 (shell)、rusqlite 0.40 (bundled, FTS5)、serde_json、reqwest 0.12 (rustls, blocking)、Tauri 2 `ipc::Channel`。

**依据：** `docs/superpowers/specs/2026-08-16-meshmind-ai-rag-design.md`

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `crates/core/src/db/migrations/003_ai.sql` | 新表：chunks / chunk_embeddings / embed_queue / chunks_fts / conversations / messages |
| `crates/core/src/ai/mod.rs` | `AiConfig`、`Provider`、模块导出 |
| `crates/core/src/ai/chunk.rs` | `body_json` → `Vec<Chunk>`（纯切分） |
| `crates/core/src/ai/index.rs` | chunks / chunk_embeddings / embed_queue 的读写 |
| `crates/core/src/ai/vector.rs` | 归一化、点积、blob 编解码、`VectorIndex` |
| `crates/core/src/ai/provider.rs` | 两家服务商的请求构建、响应解析、流式分帧 |
| `crates/core/src/ai/retrieve.rs` | 块级 FTS 粗筛 + RRF 融合 |
| `crates/core/src/ai/prompt.rs` | 命中块 → 消息序列 |
| `crates/core/src/ai/chat.rs` | conversations / messages 持久化 |
| `crates/shell/src/ai/mod.rs` | `AiRuntime` |
| `crates/shell/src/ai/http.rs` | 发请求、脱敏、错误映射 |
| `crates/shell/src/ai/worker.rs` | 后台向量化线程 |
| `crates/shell/src/ai/ask.rs` | 一次问答的编排 |
| `crates/shell/src/commands.rs` | 新增 `ai_*` 命令（修改） |

---

## 通用约定

- **所有注释与错误信息用中文**，风格对齐现有代码：解释「为什么这么做」而不是「做了什么」。
- **每写一个模块先写测试**，TDD。测试的验收标准是：把被测实现删掉或改坏，这条测试必须变红。写完一个模块后，随手挑 2 条测试做一次真实的「改坏实现」验证，确认它们确实会红。
- 每个 Task 结束时提交一次，commit message **不带任何 `Co-Authored-By` 后缀**（用户全局规则）。
- 跑测试：`cargo test -p meshmind-core` / `cargo test -p meshmind`。Rust 不在默认 PATH，先 `. "$HOME/.cargo/env"`。

---

### Task 1: 迁移 003 与 schema 守卫

**Files:**
- Create: `crates/core/src/db/migrations/003_ai.sql`
- Modify: `crates/core/src/db.rs`（`MIGRATIONS` 数组、`migrate_creates_all_tables` 测试）

- [ ] **Step 1: 写迁移脚本**

`crates/core/src/db/migrations/003_ai.sql`：

```sql
-- 笔记切块。AI 未启用时这些表全为空。
CREATE TABLE chunks (
  id      INTEGER PRIMARY KEY,
  note_id INTEGER NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
  ord     INTEGER NOT NULL,
  heading TEXT NOT NULL,
  text    TEXT NOT NULL,
  UNIQUE (note_id, ord)
);

CREATE INDEX idx_chunks_note ON chunks (note_id);

-- 向量与块一一对应。vec 是归一化后的 f32 小端序，长度恒为 dim * 4。
CREATE TABLE chunk_embeddings (
  chunk_id INTEGER PRIMARY KEY REFERENCES chunks (id) ON DELETE CASCADE,
  model    TEXT NOT NULL,
  dim      INTEGER NOT NULL,
  vec      BLOB NOT NULL
);

CREATE INDEX idx_chunk_embeddings_model ON chunk_embeddings (model);

-- 待向量化队列。next_try_at 是绝对时间点，退避靠它而不是靠 attempts 重算。
CREATE TABLE embed_queue (
  note_id     INTEGER PRIMARY KEY REFERENCES notes (id) ON DELETE CASCADE,
  enqueued_at INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_try_at INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT
);

-- 块级字面索引。rowid 与 chunks.id 对齐，写法沿用 notes_fts。
-- 列里存的是「heading 与 text 两行」切词后的序列，行间插哨兵：
-- 小标题的词也该能命中它下面的块，但不能和正文首词连成一个短语。
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text_seg,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE conversations (
  id         INTEGER PRIMARY KEY,
  title      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_conversations_updated ON conversations (updated_at DESC);

CREATE TABLE messages (
  id              INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  citations       TEXT NOT NULL DEFAULT '[]',
  created_at      INTEGER NOT NULL
);

CREATE INDEX idx_messages_conversation ON messages (conversation_id, id);
```

- [ ] **Step 2: 挂进 MIGRATIONS**

`crates/core/src/db.rs` 的 `MIGRATIONS` 数组末尾追加：

```rust
    include_str!("db/migrations/003_ai.sql"),
```

- [ ] **Step 3: 写测试**

在 `crates/core/src/db.rs` 的 `mod tests` 里，把 `migrate_creates_all_tables` 的表名列表补上新表：

```rust
            "chunks",
            "chunk_embeddings",
            "embed_queue",
            "chunks_fts",
            "conversations",
            "messages",
```

再新增三条：

```rust
    /// 停在 002 的老库升级后只跑 003，已有笔记与设置毫发无损。
    #[test]
    fn migrate_upgrades_a_database_that_stopped_at_002() {
        let conn = open_in_memory().unwrap();
        conn.execute_batch(MIGRATIONS[0]).unwrap();
        conn.execute_batch(MIGRATIONS[1]).unwrap();
        conn.pragma_update(None, "user_version", 2).unwrap();
        conn.execute(
            "INSERT INTO notes (uuid, title, body_json, body_text, created_at, updated_at)
             VALUES ('u', 't', '{}', 't', 1, 1)",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO settings (key, value) VALUES ('theme', 'dark')", [])
            .unwrap();

        migrate(&conn).unwrap();

        let notes: i64 = conn
            .query_row("SELECT count(*) FROM notes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(notes, 1, "增量迁移不该动已有数据");
        let theme: String = conn
            .query_row("SELECT value FROM settings WHERE key = 'theme'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(theme, "dark");
        let chunks: i64 = conn
            .query_row("SELECT count(*) FROM sqlite_master WHERE name = 'chunks'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(chunks, 1, "003 没有被应用");
    }

    /// 003 只能是追加，不能改动 001/002。
    #[test]
    fn migration_003_is_append_only() {
        assert_eq!(MIGRATIONS.len(), 3);
        assert!(MIGRATIONS[0].contains("CREATE TABLE notes"));
        assert!(MIGRATIONS[1].contains("CREATE TABLE settings"));
        assert!(!MIGRATIONS[0].contains("chunks"));
        assert!(!MIGRATIONS[1].contains("chunks"));
        assert!(MIGRATIONS[2].contains("CREATE TABLE chunks"));
    }

    /// 硬删除笔记时，块、向量、队列行必须靠外键级联一起消失。
    /// 少了任何一条级联，purge 之后会留下指向不存在笔记的孤儿块，
    /// 而检索的 JOIN 会把它们静默丢掉——表在无声地变大，没人会发现。
    #[test]
    fn ai_tables_cascade_from_notes() {
        let conn = open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO notes (id, uuid, title, body_json, body_text, created_at, updated_at)
             VALUES (1, 'u', 't', '{}', 't', 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chunks (id, note_id, ord, heading, text) VALUES (1, 1, 0, '', 'x')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chunk_embeddings (chunk_id, model, dim, vec)
             VALUES (1, 'm', 1, X'00000000')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO embed_queue (note_id, enqueued_at) VALUES (1, 1)",
            [],
        )
        .unwrap();

        conn.execute("DELETE FROM notes WHERE id = 1", []).unwrap();

        for table in ["chunks", "chunk_embeddings", "embed_queue"] {
            let count: i64 = conn
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(count, 0, "{table} 没有随 notes 级联删除");
        }
    }

    /// 删会话必须级联删掉它的消息。
    #[test]
    fn messages_cascade_from_conversations() {
        let conn = open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (1, 'c', 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (conversation_id, role, content, created_at)
             VALUES (1, 'user', 'q', 1)",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM conversations WHERE id = 1", []).unwrap();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
```

- [ ] **Step 4: 跑测试**

Run: `. "$HOME/.cargo/env" && cargo test -p meshmind-core db::`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add crates/core/src/db.rs crates/core/src/db/migrations/003_ai.sql
git commit -m "feat(core): AI 相关表的迁移 003"
```

---

### Task 2: `ai::mod` 与错误变体

**Files:**
- Create: `crates/core/src/ai/mod.rs`
- Modify: `crates/core/src/lib.rs`、`crates/core/src/error.rs`

- [ ] **Step 1: 加错误变体**

`crates/core/src/error.rs` 的 `CoreError` 里追加：

```rust
    /// AI 配置不完整。带上缺了哪一项——「AI 未配置」这四个字对用户毫无帮助，
    /// 他需要知道到底是 Base URL 没填还是模型名没填。
    #[error("AI 未配置完整，缺少: {0}")]
    AiNotConfigured(String),

    /// 服务返回的结构对不上预期。这不是用户的错，多半是 Base URL 指错了地方
    /// （比如把 Ollama 的地址填进了 OpenAI 模式），所以消息要能提示这一点。
    #[error("AI 服务返回的内容无法解析（请检查 Base URL 与服务商类型是否匹配）: {0}")]
    AiProtocol(String),

    #[error("向量维度不一致: 期望 {expected}，实际 {got}")]
    EmbeddingDimMismatch { expected: usize, got: usize },

    #[error("会话不存在: {0}")]
    ConversationNotFound(i64),
```

- [ ] **Step 2: 写 `ai/mod.rs`**

```rust
//! 可插拔 AI 与 Hybrid RAG。
//!
//! **这一层不发网络请求。** `provider` 只负责把配置和输入变成一个 `HttpRequest`
//! 描述，再把响应文本解析成结构化结果；真正的 socket 由 `crates/shell` 持有。
//! 这样服务商协议的每一个字段名、每一种分帧方式都能用普通单测钉住，
//! 不必为了测一个 JSON 的形状去起一台 mock HTTP server。

pub mod chat;
pub mod chunk;
pub mod index;
pub mod prompt;
pub mod provider;
pub mod retrieve;
pub mod vector;

pub use provider::{AiConfig, Provider};
```

在 `crates/core/src/lib.rs` 的模块列表首位加 `pub mod ai;`（保持字母序）。

- [ ] **Step 3: 错误消息测试**

`error.rs` 的 `mod tests` 追加：

```rust
    #[test]
    fn ai_not_configured_names_the_missing_field() {
        // 光说「未配置」用户不知道该填哪一格。
        let e = CoreError::AiNotConfigured("Base URL".into());
        assert!(e.to_string().contains("Base URL"));
    }

    #[test]
    fn ai_protocol_error_hints_at_base_url() {
        let e = CoreError::AiProtocol("missing field `data`".into());
        let message = e.to_string();
        assert!(message.contains("Base URL"), "解析失败最常见的原因是地址填错，消息要指出来");
        assert!(message.contains("missing field `data`"));
    }

    #[test]
    fn dim_mismatch_reports_both_numbers() {
        let e = CoreError::EmbeddingDimMismatch { expected: 1536, got: 768 };
        let message = e.to_string();
        assert!(message.contains("1536") && message.contains("768"));
    }
```

- [ ] **Step 4: 跑测试**

Run: `. "$HOME/.cargo/env" && cargo test -p meshmind-core error::`
Expected: PASS。此时 `ai/mod.rs` 里引用的子模块还不存在，先建空文件占位（每个文件写一行 `//! 占位`），保证 `cargo test` 能编过。

- [ ] **Step 5: 提交**

```bash
git add crates/core/src/ai crates/core/src/lib.rs crates/core/src/error.rs
git commit -m "feat(core): AI 模块骨架与错误变体"
```

---

### Task 3: `ai::chunk` 切块

**Files:**
- Create: `crates/core/src/ai/chunk.rs`

- [ ] **Step 1: 写失败的测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn doc(nodes: Vec<serde_json::Value>) -> String {
        json!({ "type": "doc", "content": nodes }).to_string()
    }

    fn para(text: &str) -> serde_json::Value {
        json!({ "type": "paragraph", "content": [{ "type": "text", "text": text }] })
    }

    fn heading(text: &str) -> serde_json::Value {
        json!({
            "type": "heading",
            "attrs": { "level": 2 },
            "content": [{ "type": "text", "text": text }]
        })
    }

    /// 短的相邻段落合并成一块，不该一段一块——一段话单独喂给 embedding
    /// 往往短到没有语义，检索质量会明显变差。
    #[test]
    fn merges_adjacent_short_blocks() {
        let chunks = split(&doc(vec![para("第一段"), para("第二段"), para("第三段")])).unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].text, "第一段\n第二段\n第三段");
        assert_eq!(chunks[0].heading, "");
    }

    /// 跨标题绝不合并：一个块横跨两个主题，检索命中后给模型的上下文就是混的。
    #[test]
    fn never_merges_across_headings() {
        let chunks = split(&doc(vec![
            heading("甲"),
            para("甲的内容"),
            heading("乙"),
            para("乙的内容"),
        ]))
        .unwrap();
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].heading, "甲");
        assert_eq!(chunks[0].text, "甲的内容");
        assert_eq!(chunks[1].heading, "乙");
        assert_eq!(chunks[1].text, "乙的内容");
    }

    /// 合并到接近 TARGET_CHARS 就断开，不能无限长下去。
    #[test]
    fn stops_merging_at_target_chars() {
        let block = "甲".repeat(200);
        let chunks = split(&doc(vec![para(&block), para(&block), para(&block)])).unwrap();
        assert!(chunks.len() >= 2, "三个 200 字的段落不该挤进一块 500 字的 chunk");
        for c in &chunks {
            assert!(
                c.text.chars().count() <= MAX_CHARS,
                "块长 {} 超过上限", c.text.chars().count()
            );
        }
    }

    /// 单个超长段落按句末二次切分，且切点必须在句号之后而不是硬切。
    #[test]
    fn splits_an_oversized_block_at_sentence_ends() {
        let sentence = "这是一句话。";
        let long = sentence.repeat(300); // 1800 字符，远超 MAX_CHARS
        let chunks = split(&doc(vec![para(&long)])).unwrap();
        assert!(chunks.len() > 1);
        for c in &chunks {
            assert!(c.text.chars().count() <= MAX_CHARS + OVERLAP_CHARS);
        }
        // 重新拼起来（去掉重叠）应当还是由完整句子组成，不该出现半句。
        assert!(chunks[0].text.ends_with('。'), "切点没有落在句末: {}", chunks[0].text);
    }

    /// 没有句末标点的超长块也必须能被切开，不能因为找不到切点就原样返回。
    #[test]
    fn splits_an_oversized_block_without_any_punctuation() {
        let long = "甲".repeat(2500);
        let chunks = split(&doc(vec![para(&long)])).unwrap();
        assert!(chunks.len() > 1, "找不到句末标点时必须硬切，否则超长块会整个喂给 API");
        for c in &chunks {
            assert!(c.text.chars().count() <= MAX_CHARS + OVERLAP_CHARS);
        }
    }

    /// 重叠：后一块开头必须带上前一块结尾的字符，否则跨块的答案会被切断。
    #[test]
    fn later_chunks_carry_overlap_from_the_previous_one() {
        let block = "甲".repeat(400);
        let chunks = split(&doc(vec![para(&block), para(&block)])).unwrap();
        assert!(chunks.len() >= 2);
        let tail: String = chunks[0]
            .text
            .chars()
            .rev()
            .take(OVERLAP_CHARS)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        assert!(
            chunks[1].text.starts_with(&tail),
            "第二块没有带上第一块结尾的 {OVERLAP_CHARS} 个字符"
        );
    }

    /// 重叠只在同一标题内发生：跨标题带过去就是把甲的内容塞进乙的块里。
    #[test]
    fn overlap_does_not_cross_headings() {
        let long = "甲".repeat(600);
        let chunks = split(&doc(vec![heading("A"), para(&long), heading("B"), para("乙")])).unwrap();
        let first_of_b = chunks.iter().find(|c| c.heading == "B").unwrap();
        assert_eq!(first_of_b.text, "乙", "B 的第一块不该带上 A 的尾巴");
    }

    /// 过短的尾块并回前一块，不单独成块——20 个字的碎片单独向量化毫无意义。
    #[test]
    fn merges_a_too_short_tail_back() {
        let block = "甲".repeat(480);
        let chunks = split(&doc(vec![para(&block), para("短")])).unwrap();
        assert_eq!(chunks.len(), 1, "5 个字的尾巴该并回去");
        assert!(chunks[0].text.ends_with("短"));
    }

    #[test]
    fn empty_document_yields_no_chunks() {
        assert!(split(&doc(vec![])).unwrap().is_empty());
        assert!(split(&doc(vec![para("")])).unwrap().is_empty());
        assert!(split(&doc(vec![para("   ")])).unwrap().is_empty());
    }

    /// 长度按字符算，不能按字节：按字节切会把汉字劈成乱码。
    #[test]
    fn counts_characters_not_bytes() {
        // 300 个汉字是 900 字节。若按字节算，早在 MAX_CHARS 处就被切开了。
        let chunks = split(&doc(vec![para(&"甲".repeat(300))])).unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].text.chars().count(), 300);
        assert!(chunks[0].text.chars().all(|c| c == '甲'), "出现了被劈开的字符");
    }

    #[test]
    fn invalid_json_is_an_invalid_content_error() {
        assert!(matches!(split("不是 JSON"), Err(CoreError::InvalidContent(_))));
    }

    /// 列表项与代码块也算块级节点，不能因为类型没列全就被整段吞掉。
    #[test]
    fn handles_list_items_and_code_blocks() {
        let nodes = vec![
            json!({ "type": "bulletList", "content": [
                { "type": "listItem", "content": [para("条目一")] },
                { "type": "listItem", "content": [para("条目二")] }
            ]}),
            json!({ "type": "codeBlock", "content": [{ "type": "text", "text": "let x = 1;" }] }),
        ];
        let chunks = split(&doc(nodes)).unwrap();
        let all: String = chunks.iter().map(|c| c.text.as_str()).collect();
        assert!(all.contains("条目一") && all.contains("条目二") && all.contains("let x = 1;"));
    }
}
```

- [ ] **Step 2: 跑测试确认全红**

Run: `. "$HOME/.cargo/env" && cargo test -p meshmind-core ai::chunk`
Expected: 编译失败（`split` 不存在）。

- [ ] **Step 3: 实现**

```rust
//! 把一篇笔记的 TipTap 文档切成适合向量化的块。
//!
//! 为什么不复用 `notes::tiptap::extract_text`：它把整篇文档拍平成一段文本，
//! 块边界和标题层级在那一步就丢了。而这两样恰恰是切块最需要的信息——
//! 边界决定在哪里断开，标题决定哪些内容属于同一个主题。

use serde_json::Value;

use crate::error::{CoreError, Result};

/// 贪心合并相邻块，直到再加一块就会超过它。
pub const TARGET_CHARS: usize = 500;
/// 单块超过它就按句末二次切分。
pub const MAX_CHARS: usize = 1000;
/// 每块前置上一块结尾的这么多字符，避免答案正好卡在块边界上被切断。
pub const OVERLAP_CHARS: usize = 100;
/// 短于它的尾块并回前一块，不单独成块。
pub const MIN_CHARS: usize = 20;

/// 句末标点。中英文都要认——笔记里两种混着写是常态。
const SENTENCE_ENDS: &[char] = &['。', '！', '？', '；', '.', '!', '?', ';'];

/// 这些节点在纯文本里各占一行。与 `notes::tiptap::BLOCK_TYPES` 保持一致，
/// 但这里是**切块边界**而不是换行符位置，语义不同，因此不共用常量。
const BLOCK_TYPES: &[&str] = &[
    "paragraph",
    "heading",
    "listItem",
    "taskItem",
    "blockquote",
    "codeBlock",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    /// 该块所属的最近标题；没有标题则为空串。
    pub heading: String,
    /// 块的正文，不含标题——标题另存一列，展示引用时给用户看干净的原文。
    pub text: String,
}

/// 文档树遍历产出的中间结果：一个块级节点的文本 + 它当时所处的标题。
struct Block {
    heading: String,
    text: String,
}

pub fn split(body_json: &str) -> Result<Vec<Chunk>> {
    let doc: Value = serde_json::from_str(body_json)
        .map_err(|e| CoreError::InvalidContent(e.to_string()))?;
    let blocks = collect_blocks(&doc);
    Ok(assemble(blocks))
}

/// 深度优先走一遍文档树，每碰到一个块级节点就产出一条 `Block`。
/// 遇到 heading 节点时更新「当前标题」，它本身不产出块——标题文本会进
/// `heading` 列并参与 FTS 索引，不必在正文里再出现一次。
fn collect_blocks(doc: &Value) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut heading = String::new();
    walk(doc, &mut heading, &mut blocks);
    blocks
}

fn walk(node: &Value, heading: &mut String, blocks: &mut Vec<Block>) {
    let node_type = node.get("type").and_then(Value::as_str).unwrap_or("");

    if node_type == "heading" {
        *heading = inline_text(node).trim().to_string();
        return;
    }

    // listItem 内部还嵌着 paragraph，若先递归子节点会把同一段文字产出两次。
    // 因此块级节点在这里就把自己的全部行内文本收走，不再往下走。
    if BLOCK_TYPES.contains(&node_type) {
        let text = inline_text(node).trim().to_string();
        if !text.is_empty() {
            blocks.push(Block {
                heading: heading.clone(),
                text,
            });
        }
        return;
    }

    if let Some(children) = node.get("content").and_then(Value::as_array) {
        for child in children {
            walk(child, heading, blocks);
        }
    }
}

/// 收集一个节点下的全部文本（含所有后代）。
fn inline_text(node: &Value) -> String {
    let mut buffer = String::new();
    fn go(node: &Value, buffer: &mut String) {
        if let Some(text) = node.get("text").and_then(Value::as_str) {
            buffer.push_str(text);
        }
        if let Some(children) = node.get("content").and_then(Value::as_array) {
            for child in children {
                go(child, buffer);
            }
        }
    }
    go(node, &mut buffer);
    buffer
}

fn assemble(blocks: Vec<Block>) -> Vec<Chunk> {
    let mut chunks: Vec<Chunk> = Vec::new();

    for block in blocks {
        for piece in split_oversized(&block.text) {
            let can_merge = chunks.last().is_some_and(|last| {
                last.heading == block.heading
                    && count(&last.text) + 1 + count(&piece) <= TARGET_CHARS
            });
            if can_merge {
                let last = chunks.last_mut().expect("can_merge 已确认非空");
                last.text.push('\n');
                last.text.push_str(&piece);
            } else {
                chunks.push(Chunk {
                    heading: block.heading.clone(),
                    text: piece,
                });
            }
        }
    }

    merge_short_tails(&mut chunks);
    apply_overlap(&mut chunks);
    chunks
}

/// 超长块按句末切分。找不到句末标点就在 MAX_CHARS 处硬切——
/// 宁可切在半句上，也不能把一个 5000 字的块整个塞进 embedding 请求。
fn split_oversized(text: &str) -> Vec<String> {
    if count(text) <= MAX_CHARS {
        return vec![text.to_string()];
    }

    let chars: Vec<char> = text.chars().collect();
    let mut pieces = Vec::new();
    let mut start = 0;

    while start < chars.len() {
        let hard_end = (start + MAX_CHARS).min(chars.len());
        if hard_end == chars.len() {
            pieces.push(chars[start..].iter().collect());
            break;
        }
        // 从硬上限往回找最近的句末，但不能退过半——退太多会切出一堆碎块。
        let floor = start + MAX_CHARS / 2;
        let cut = (floor..hard_end)
            .rev()
            .find(|&i| SENTENCE_ENDS.contains(&chars[i]))
            .map(|i| i + 1)
            .unwrap_or(hard_end);
        pieces.push(chars[start..cut].iter().collect());
        start = cut;
    }

    pieces
}

/// 过短的尾块并回前一块。只在同标题内进行；跨标题的短块只能自己待着。
fn merge_short_tails(chunks: &mut Vec<Chunk>) {
    let mut i = 1;
    while i < chunks.len() {
        let too_short = count(&chunks[i].text) < MIN_CHARS;
        let same_heading = chunks[i].heading == chunks[i - 1].heading;
        if too_short && same_heading {
            let tail = chunks.remove(i);
            let prev = &mut chunks[i - 1];
            prev.text.push('\n');
            prev.text.push_str(&tail.text);
        } else {
            i += 1;
        }
    }
}

/// 给每一块前置上一块结尾的 `OVERLAP_CHARS` 个字符。
///
/// 必须先把原始文本快照下来再改：边遍历边改的话，第 n 块拿到的是第 n-1 块
/// **已经带了重叠**的文本，重叠会一路滚雪球。
fn apply_overlap(chunks: &mut [Chunk]) {
    let originals: Vec<String> = chunks.iter().map(|c| c.text.clone()).collect();
    for i in 1..chunks.len() {
        if chunks[i].heading != chunks[i - 1].heading {
            continue;
        }
        let prev = &originals[i - 1];
        let tail: String = {
            let chars: Vec<char> = prev.chars().collect();
            let from = chars.len().saturating_sub(OVERLAP_CHARS);
            chars[from..].iter().collect()
        };
        chunks[i].text = format!("{tail}{}", chunks[i].text);
    }
}

fn count(text: &str) -> usize {
    text.chars().count()
}
```

- [ ] **Step 4: 跑测试**

Run: `. "$HOME/.cargo/env" && cargo test -p meshmind-core ai::chunk`
Expected: 全部 PASS。

- [ ] **Step 5: 反证两条测试**

把 `apply_overlap` 的函数体改成空（直接 `return`），跑测试，确认 `later_chunks_carry_overlap_from_the_previous_one` 变红；改回来。
把 `walk` 里 `node_type == "heading"` 那一支删掉，确认 `never_merges_across_headings` 变红；改回来。
两条都验证过再继续。

- [ ] **Step 6: 提交**

```bash
git add crates/core/src/ai/chunk.rs
git commit -m "feat(core): 笔记切块"
```

---

### Task 4: `ai::vector` 向量运算与内存索引

**Files:**
- Create: `crates/core/src/ai/vector.rs`

- [ ] **Step 1: 写失败的测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f32, b: f32) {
        assert!((a - b).abs() < 1e-5, "{a} != {b}");
    }

    #[test]
    fn normalize_makes_unit_length() {
        let mut v = vec![3.0, 4.0];
        normalize(&mut v);
        approx(v.iter().map(|x| x * x).sum::<f32>().sqrt(), 1.0);
        approx(v[0], 0.6);
        approx(v[1], 0.8);
    }

    /// 零向量不能除出 NaN——某些服务在输入为空字符串时真的会返回全零，
    /// 一个 NaN 混进索引会污染之后每一次排序。
    #[test]
    fn normalize_leaves_a_zero_vector_alone() {
        let mut v = vec![0.0, 0.0, 0.0];
        normalize(&mut v);
        assert!(v.iter().all(|x| *x == 0.0));
        assert!(v.iter().all(|x| !x.is_nan()));
    }

    #[test]
    fn blob_round_trip_preserves_values() {
        let v = vec![0.5_f32, -0.25, 1.0, -1.0];
        assert_eq!(from_blob(&to_blob(&v)), v);
    }

    /// 长度不是 4 的倍数的 blob 是坏数据，不能 panic 也不能读出垃圾。
    #[test]
    fn from_blob_rejects_a_truncated_buffer() {
        assert!(from_blob(&[0u8, 1, 2]).is_empty());
    }

    fn index_of(rows: &[(i64, Vec<f32>)]) -> VectorIndex {
        let mut index = VectorIndex::new("m".into(), rows[0].1.len());
        for (id, v) in rows {
            index.upsert(*id, v.clone());
        }
        index
    }

    /// top_k 必须与「全量算分再排序」逐位一致。这条是整个检索的正确性地基，
    /// 任何为了快而做的近似都会先在这里露馅。
    #[test]
    fn top_k_matches_a_naive_full_sort() {
        let rows: Vec<(i64, Vec<f32>)> = (1..=50)
            .map(|i| {
                let mut v = vec![i as f32, (50 - i) as f32, 1.0];
                normalize(&mut v);
                (i, v)
            })
            .collect();
        let index = index_of(&rows);
        let mut query = vec![1.0, 0.0, 0.0];
        normalize(&mut query);

        let mut naive: Vec<(i64, f32)> =
            rows.iter().map(|(id, v)| (*id, dot(v, &query))).collect();
        naive.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap().then(a.0.cmp(&b.0)));
        naive.truncate(5);

        let got = index.top_k(&query, 5);
        assert_eq!(
            got.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
            naive.iter().map(|(id, _)| *id).collect::<Vec<_>>()
        );
    }

    /// remove 之后该 id 消失，**且其余向量没有错位**。
    /// 用 swap_remove 时 ids 与 data 必须同步交换，漏一边就会让所有向量张冠李戴——
    /// 这种错误不会崩，只会让检索结果变得莫名其妙。
    #[test]
    fn remove_keeps_the_remaining_vectors_aligned() {
        let rows: Vec<(i64, Vec<f32>)> = vec![
            (1, vec![1.0, 0.0]),
            (2, vec![0.0, 1.0]),
            (3, vec![-1.0, 0.0]),
        ];
        let mut index = index_of(&rows);
        index.remove(1);

        assert_eq!(index.len(), 2);
        let top = index.top_k(&[0.0, 1.0], 1);
        assert_eq!(top[0].0, 2, "删掉 1 之后，2 的向量应当还是 [0,1]");
        let bottom = index.top_k(&[-1.0, 0.0], 1);
        assert_eq!(bottom[0].0, 3);
    }

    #[test]
    fn upsert_replaces_an_existing_id() {
        let mut index = index_of(&[(1, vec![1.0, 0.0])]);
        index.upsert(1, vec![0.0, 1.0]);
        assert_eq!(index.len(), 1);
        approx(index.top_k(&[0.0, 1.0], 1)[0].1, 1.0);
    }

    /// 维度对不上的向量必须被拒绝并计数，而不是塞进去把 data 的行距搞乱。
    #[test]
    fn upsert_rejects_and_counts_dimension_mismatches() {
        let mut index = index_of(&[(1, vec![1.0, 0.0])]);
        index.upsert(2, vec![1.0, 0.0, 0.0]);
        assert_eq!(index.len(), 1);
        assert_eq!(index.dim_mismatches(), 1);
    }

    #[test]
    fn query_with_wrong_dimension_returns_nothing_instead_of_panicking() {
        let index = index_of(&[(1, vec![1.0, 0.0])]);
        assert!(index.top_k(&[1.0, 0.0, 0.0], 5).is_empty());
    }

    #[test]
    fn memory_bytes_grows_with_the_row_count() {
        let mut index = VectorIndex::new("m".into(), 4);
        assert_eq!(index.memory_bytes(), 0);
        index.upsert(1, vec![0.0; 4]);
        assert_eq!(index.memory_bytes(), 16);
        index.upsert(2, vec![0.0; 4]);
        assert_eq!(index.memory_bytes(), 32);
    }

    #[test]
    fn top_k_truncates_to_k() {
        let rows: Vec<(i64, Vec<f32>)> =
            (1..=10).map(|i| (i, vec![1.0, i as f32])).collect();
        assert_eq!(index_of(&rows).top_k(&[1.0, 1.0], 3).len(), 3);
    }
}
```

- [ ] **Step 2: 跑测试确认全红**

Run: `. "$HOME/.cargo/env" && cargo test -p meshmind-core ai::vector`
Expected: 编译失败。

- [ ] **Step 3: 实现**

```rust
//! 向量运算与内存索引。
//!
//! **向量在存进库之前就已经归一化**，所以这里的相似度就是点积，
//! 检索时不必再算模长。代价是入库路径必须保证这条不变量成立——
//! `index::write_embedding` 是唯一的写入口，归一化在那里做。
//!
//! 索引是一块扁平的 `Vec<f32>`（行主序）而不是 `Vec<Vec<f32>>`：
//! 后者每一行都是一次独立分配，几万行下来指针追逐的开销比点积本身还大。

use std::cmp::Ordering;

/// 就地归一化。零向量原样返回——除以 0 会产生 NaN，
/// 而一个 NaN 混进索引会让之后每一次排序的结果都不可预测。
pub fn normalize(v: &mut [f32]) {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
}

pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// f32 小端序。选定端序是为了让数据库文件跨机器可搬——
/// 用本机端序的话，同一个库在大端机上读出来全是垃圾。
pub fn to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

/// 长度不是 4 的倍数说明 blob 被截断了，返回空而不是读出半个浮点数。
pub fn from_blob(bytes: &[u8]) -> Vec<f32> {
    if bytes.len() % 4 != 0 {
        return Vec::new();
    }
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// 内存向量索引。只在 AI 启用后由外壳懒加载；未启用时根本不构造，占用为零。
pub struct VectorIndex {
    model: String,
    dim: usize,
    ids: Vec<i64>,
    /// 行主序：第 i 行是 `data[i * dim .. (i + 1) * dim]`。
    data: Vec<f32>,
    dim_mismatches: usize,
}

impl VectorIndex {
    pub fn new(model: String, dim: usize) -> Self {
        Self {
            model,
            dim,
            ids: Vec::new(),
            data: Vec::new(),
            dim_mismatches: 0,
        }
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    pub fn dim(&self) -> usize {
        self.dim
    }

    pub fn len(&self) -> usize {
        self.ids.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }

    /// 加载时遇到的维度不符行数。模型换了但没重建索引会留下这类残留，
    /// 数字要能报到设置面板上，否则用户只会看到「搜不准」而不知道为什么。
    pub fn dim_mismatches(&self) -> usize {
        self.dim_mismatches
    }

    pub fn memory_bytes(&self) -> usize {
        self.data.len() * std::mem::size_of::<f32>()
    }

    /// 写入或替换一行。维度不符直接拒绝并计数——塞进去会让整块 data 的行距错乱，
    /// 之后每一行都读到别人的数据。
    pub fn upsert(&mut self, chunk_id: i64, vec: Vec<f32>) {
        if vec.len() != self.dim {
            self.dim_mismatches += 1;
            return;
        }
        match self.ids.iter().position(|id| *id == chunk_id) {
            Some(row) => {
                self.data[row * self.dim..(row + 1) * self.dim].copy_from_slice(&vec);
            }
            None => {
                self.ids.push(chunk_id);
                self.data.extend_from_slice(&vec);
            }
        }
    }

    /// 删除一行。用 swap_remove：顺序对点积没有任何意义，
    /// 但 ids 与 data 必须**一起**交换，漏一边所有向量就会张冠李戴。
    pub fn remove(&mut self, chunk_id: i64) {
        let Some(row) = self.ids.iter().position(|id| *id == chunk_id) else {
            return;
        };
        let last = self.ids.len() - 1;
        self.ids.swap(row, last);
        for i in 0..self.dim {
            self.data.swap(row * self.dim + i, last * self.dim + i);
        }
        self.ids.pop();
        self.data.truncate(last * self.dim);
    }

    /// 相似度最高的 k 行。
    ///
    /// 不做近似：几万行的全量点积在 Rust 里是毫秒级，而近似算法带来的
    /// 召回损失在个人笔记这个规模上完全不值得。排序在同分时按 id 升序兜底，
    /// 保证同一次查询在多次执行间结果稳定（否则测试会随机红）。
    pub fn top_k(&self, query: &[f32], k: usize) -> Vec<(i64, f32)> {
        if self.dim == 0 || query.len() != self.dim {
            return Vec::new();
        }
        let mut scored: Vec<(i64, f32)> = self
            .ids
            .iter()
            .enumerate()
            .map(|(row, id)| {
                let start = row * self.dim;
                (*id, dot(&self.data[start..start + self.dim], query))
            })
            .collect();
        scored.sort_by(|a, b| {
            b.1.partial_cmp(&a.1)
                .unwrap_or(Ordering::Equal)
                .then(a.0.cmp(&b.0))
        });
        scored.truncate(k);
        scored
    }
}
```

- [ ] **Step 4: 跑测试**

Run: `. "$HOME/.cargo/env" && cargo test -p meshmind-core ai::vector`
Expected: 全部 PASS。

- [ ] **Step 5: 反证**

把 `remove` 里的 `for i in 0..self.dim { self.data.swap(..) }` 整段删掉（只留 ids 的 swap 与 pop/truncate），确认 `remove_keeps_the_remaining_vectors_aligned` 变红；改回来。

- [ ] **Step 6: 提交**

```bash
git add crates/core/src/ai/vector.rs
git commit -m "feat(core): 向量运算与内存索引"
```

---

### Task 5: `ai::index` 块与向量的持久化

**Files:**
- Create: `crates/core/src/ai/index.rs`

**背景（写给实现者）：** `chunks_fts` 的 rowid 与 `chunks.id` 对齐，写法与 `notes::write_index` 相同。索引内容是 `heading` 与 `text` 两行切词后的序列，**行间插 `segment::LINE_SENTINEL` 哨兵**——小标题的词应当能命中它下面的块，但不能和正文首词连成一个短语。

- [ ] **Step 1: 写失败的测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::notes::{self, NewNote};

    fn conn() -> rusqlite::Connection {
        let conn = db::open_in_memory().unwrap();
        db::migrate(&conn).unwrap();
        conn
    }

    fn note(conn: &mut rusqlite::Connection, text: &str) -> i64 {
        let body = serde_json::json!({
            "type": "doc",
            "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": text }] }]
        })
        .to_string();
        notes::create(
            conn,
            &NewNote { body_json: body, attachment_ids: vec![] },
            1_000,
        )
        .unwrap()
        .id
    }

    #[test]
    fn replace_chunks_writes_rows_and_fts() {
        let mut conn = conn();
        let id = note(&mut conn, "知识图谱构建方法");
        let chunks = vec![Chunk { heading: "方法".into(), text: "知识图谱构建方法".into() }];
        replace_chunks(&mut conn, id, &chunks).unwrap();

        let count: i64 = conn
            .query_row("SELECT count(*) FROM chunks WHERE note_id = ?1", [id], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);

        // FTS 能命中正文里的词。
        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM chunks_fts WHERE chunks_fts MATCH '知识'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1);
    }

    /// 小标题里的词也要能命中它下面的块——否则「在『部署』那一节里说了什么」
    /// 这种再自然不过的问法一条都召回不到。
    #[test]
    fn fts_matches_words_from_the_heading() {
        let mut conn = conn();
        let id = note(&mut conn, "占位");
        replace_chunks(
            &mut conn,
            id,
            &[Chunk { heading: "部署流程".into(), text: "先构建镜像".into() }],
        )
        .unwrap();
        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM chunks_fts WHERE chunks_fts MATCH '部署'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1);
    }

    /// 标题末词与正文首词之间必须有哨兵隔开，否则「流程先」这种
    /// 根本不存在的短语会命中。
    #[test]
    fn heading_and_body_do_not_form_a_phrase() {
        let mut conn = conn();
        let id = note(&mut conn, "占位");
        replace_chunks(
            &mut conn,
            id,
            &[Chunk { heading: "部署流程".into(), text: "先构建镜像".into() }],
        )
        .unwrap();
        let hits: i64 = conn
            .query_row(
                r#"SELECT count(*) FROM chunks_fts WHERE chunks_fts MATCH '"流程 先"'"#,
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 0, "标题与正文之间缺少行边界哨兵");
    }

    /// 重切块必须先清干净：旧块留着的话，一篇笔记会同时命中新旧两份内容。
    #[test]
    fn replace_chunks_removes_the_previous_rows_and_fts() {
        let mut conn = conn();
        let id = note(&mut conn, "占位");
        replace_chunks(&mut conn, id, &[Chunk { heading: "".into(), text: "旧内容".into() }])
            .unwrap();
        replace_chunks(&mut conn, id, &[Chunk { heading: "".into(), text: "新内容".into() }])
            .unwrap();

        let count: i64 = conn
            .query_row("SELECT count(*) FROM chunks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
        let stale: i64 = conn
            .query_row(
                "SELECT count(*) FROM chunks_fts WHERE chunks_fts MATCH '旧内容'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stale, 0, "旧的 FTS 行没有被删掉");
    }

    /// 向量写入前必须归一化。跳过这一步的话，检索时的点积就不再是余弦，
    /// 长文本块会仅仅因为模长大而排到前面。
    #[test]
    fn write_embedding_normalizes_before_storing() {
        let mut conn = conn();
        let id = note(&mut conn, "占位");
        replace_chunks(&mut conn, id, &[Chunk { heading: "".into(), text: "x".into() }]).unwrap();
        let chunk_id: i64 = conn
            .query_row("SELECT id FROM chunks LIMIT 1", [], |r| r.get(0))
            .unwrap();

        write_embedding(&conn, chunk_id, "m", &[3.0, 4.0]).unwrap();

        let blob: Vec<u8> = conn
            .query_row("SELECT vec FROM chunk_embeddings WHERE chunk_id = ?1", [chunk_id], |r| r.get(0))
            .unwrap();
        let v = crate::ai::vector::from_blob(&blob);
        assert!((v.iter().map(|x| x * x).sum::<f32>().sqrt() - 1.0).abs() < 1e-5);
    }

    #[test]
    fn load_index_skips_rows_from_another_model() {
        let mut conn = conn();
        let id = note(&mut conn, "占位");
        replace_chunks(
            &mut conn,
            id,
            &[
                Chunk { heading: "".into(), text: "a".into() },
                Chunk { heading: "".into(), text: "b".into() },
            ],
        )
        .unwrap();
        let ids: Vec<i64> = {
            let mut stmt = conn.prepare("SELECT id FROM chunks ORDER BY id").unwrap();
            let rows = stmt.query_map([], |r| r.get(0)).unwrap();
            rows.map(|r| r.unwrap()).collect()
        };
        write_embedding(&conn, ids[0], "m1", &[1.0, 0.0]).unwrap();
        write_embedding(&conn, ids[1], "m2", &[0.0, 1.0]).unwrap();

        let index = load_index(&conn, "m1", 2).unwrap();
        assert_eq!(index.len(), 1);
    }

    /// 入队幂等：同一篇笔记连续保存十次，队列里只该有一行。
    #[test]
    fn enqueue_is_idempotent() {
        let mut conn = conn();
        let id = note(&mut conn, "占位");
        for i in 0..10 {
            enqueue(&conn, id, 1_000 + i).unwrap();
        }
        let count: i64 = conn
            .query_row("SELECT count(*) FROM embed_queue", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    /// 重新入队要把失败计数清零，否则一篇笔记失败 5 次之后，
    /// 用户就算把内容改对了也永远不会被重试。
    #[test]
    fn enqueue_resets_a_previously_failed_entry() {
        let mut conn = conn();
        let id = note(&mut conn, "占位");
        enqueue(&conn, id, 1_000).unwrap();
        record_failure(&conn, id, "boom", 2_000).unwrap();
        enqueue(&conn, id, 3_000).unwrap();

        let (attempts, next, err): (i64, i64, Option<String>) = conn
            .query_row(
                "SELECT attempts, next_try_at, last_error FROM embed_queue WHERE note_id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(attempts, 0);
        assert_eq!(next, 0);
        assert!(err.is_none());
    }

    /// 退避时间随失败次数增长，且有上限。
    #[test]
    fn backoff_grows_and_is_capped() {
        let mut conn = conn();
        let id = note(&mut conn, "占位");
        enqueue(&conn, id, 0).unwrap();

        let mut previous = 0;
        for round in 0..MAX_ATTEMPTS {
            record_failure(&conn, id, "boom", 0).unwrap();
            let next: i64 = conn
                .query_row("SELECT next_try_at FROM embed_queue WHERE note_id = ?1", [id], |r| r.get(0))
                .unwrap();
            if round + 1 < MAX_ATTEMPTS {
                assert!(next > previous, "第 {round} 轮退避没有变长");
                assert!(next <= BACKOFF_CAP_MS, "退避超过了上限");
                previous = next;
            }
        }
        // 用尽次数后停止自动重试。
        let next: i64 = conn
            .query_row("SELECT next_try_at FROM embed_queue WHERE note_id = ?1", [id], |r| r.get(0))
            .unwrap();
        assert_eq!(next, i64::MAX, "失败 {MAX_ATTEMPTS} 次后应停止自动重试");
    }

    /// 还没到重试时间的项不该被取出来。
    #[test]
    fn take_due_respects_next_try_at() {
        let mut conn = conn();
        let id = note(&mut conn, "占位");
        enqueue(&conn, id, 0).unwrap();
        record_failure(&conn, id, "boom", 10_000).unwrap();

        assert!(take_due(&conn, 10_500, 4).unwrap().is_empty(), "退避期内不该取出");
        assert_eq!(take_due(&conn, 999_999, 4).unwrap(), vec![id]);
    }

    #[test]
    fn retry_failed_resets_every_exhausted_entry() {
        let mut conn = conn();
        let id = note(&mut conn, "占位");
        enqueue(&conn, id, 0).unwrap();
        for _ in 0..MAX_ATTEMPTS {
            record_failure(&conn, id, "boom", 0).unwrap();
        }
        assert!(take_due(&conn, i64::MAX - 1, 4).unwrap().is_empty());

        retry_failed(&conn).unwrap();
        assert_eq!(take_due(&conn, 1, 4).unwrap(), vec![id]);
    }

    #[test]
    fn enqueue_all_notes_skips_the_deleted_ones() {
        let mut conn = conn();
        let alive = note(&mut conn, "活着");
        let dead = note(&mut conn, "删了");
        notes::soft_delete(&mut conn, dead, 2_000).unwrap();

        let n = enqueue_all(&conn, 3_000).unwrap();
        assert_eq!(n, 1);
        assert_eq!(take_due(&conn, 4_000, 10).unwrap(), vec![alive]);
    }

    #[test]
    fn clear_embeddings_empties_the_table_but_keeps_chunks() {
        let mut conn = conn();
        let id = note(&mut conn, "占位");
        replace_chunks(&mut conn, id, &[Chunk { heading: "".into(), text: "x".into() }]).unwrap();
        let chunk_id: i64 = conn.query_row("SELECT id FROM chunks LIMIT 1", [], |r| r.get(0)).unwrap();
        write_embedding(&conn, chunk_id, "m", &[1.0]).unwrap();

        clear_embeddings(&conn).unwrap();

        let embeddings: i64 = conn
            .query_row("SELECT count(*) FROM chunk_embeddings", [], |r| r.get(0))
            .unwrap();
        assert_eq!(embeddings, 0);
        let chunks: i64 = conn.query_row("SELECT count(*) FROM chunks", [], |r| r.get(0)).unwrap();
        assert_eq!(chunks, 1, "只清向量，块要留着");
    }
}
```

- [ ] **Step 2: 跑测试确认全红**

Run: `. "$HOME/.cargo/env" && cargo test -p meshmind-core ai::index`
Expected: 编译失败。

- [ ] **Step 3: 实现**

```rust
//! 块与向量的持久化，以及待向量化队列。

use rusqlite::{params, Connection, Transaction};

use crate::ai::chunk::Chunk;
use crate::ai::vector::{self, VectorIndex};
use crate::error::Result;
use crate::search::segment;

/// 连续失败到这个次数就停止自动重试，等用户在设置面板里手动点「重试」。
/// 无限重试会在服务商返回 401 时把队列变成一台永动机。
pub const MAX_ATTEMPTS: i64 = 5;
/// 退避上限，5 分钟。
pub const BACKOFF_CAP_MS: i64 = 300_000;

/// 一篇笔记的块与它的 FTS 行整体替换。
///
/// 先删后插而不是 diff：块的边界会随正文的任何一次改动整体漂移，
/// 算出「哪几块没变」的成本高于直接重建，而且极易算错。
pub fn replace_chunks(conn: &mut Connection, note_id: i64, chunks: &[Chunk]) -> Result<()> {
    let tx = conn.transaction()?;
    delete_chunks_in(&tx, note_id)?;
    for (ord, chunk) in chunks.iter().enumerate() {
        tx.execute(
            "INSERT INTO chunks (note_id, ord, heading, text) VALUES (?1, ?2, ?3, ?4)",
            params![note_id, ord as i64, chunk.heading, chunk.text],
        )?;
        let id = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO chunks_fts (rowid, text_seg) VALUES (?1, ?2)",
            params![id, fts_text(chunk)],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// 索引内容 = 标题一行 + 正文一行，行间插哨兵。
///
/// 标题的词必须能命中它下面的块（「部署那一节说了什么」是最自然的问法之一），
/// 但标题末词与正文首词不能连成一个短语——否则「流程先」这种原文里
/// 根本不存在的组合会命中。哨兵的作用与 `notes::write_index` 里完全一致。
fn fts_text(chunk: &Chunk) -> String {
    let lines = if chunk.heading.is_empty() {
        segment::line_tokens(&chunk.text)
    } else {
        segment::line_tokens(&format!("{}\n{}", chunk.heading, chunk.text))
    };
    segment::join_with_sentinel(&lines).join(" ")
}

/// FTS5 表不支持按普通列删除，只能按 rowid 逐行删。
fn delete_chunks_in(tx: &Transaction, note_id: i64) -> Result<()> {
    let ids: Vec<i64> = {
        let mut stmt = tx.prepare("SELECT id FROM chunks WHERE note_id = ?1")?;
        let rows = stmt.query_map(params![note_id], |r| r.get(0))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };
    for id in &ids {
        tx.execute("DELETE FROM chunks_fts WHERE rowid = ?1", params![id])?;
    }
    // chunk_embeddings 靠外键级联跟着走。
    tx.execute("DELETE FROM chunks WHERE note_id = ?1", params![note_id])?;
    Ok(())
}

/// 某篇笔记的全部块，按 ord 排序。
pub fn chunks_of(conn: &Connection, note_id: i64) -> Result<Vec<(i64, Chunk)>> {
    let mut stmt = conn
        .prepare("SELECT id, heading, text FROM chunks WHERE note_id = ?1 ORDER BY ord")?;
    let rows = stmt
        .query_map(params![note_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                Chunk {
                    heading: r.get(1)?,
                    text: r.get(2)?,
                },
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 写入一个块的向量。**归一化在这里做**，这是全库唯一的写入口，
/// `vector` 模块「存进来的都是单位向量」这条不变量由它保证。
pub fn write_embedding(conn: &Connection, chunk_id: i64, model: &str, raw: &[f32]) -> Result<()> {
    let mut v = raw.to_vec();
    vector::normalize(&mut v);
    conn.execute(
        "INSERT INTO chunk_embeddings (chunk_id, model, dim, vec) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (chunk_id) DO UPDATE SET
           model = excluded.model, dim = excluded.dim, vec = excluded.vec",
        params![chunk_id, model, v.len() as i64, vector::to_blob(&v)],
    )?;
    Ok(())
}

/// 全量装载指定模型的向量。别的模型产生的行直接跳过——
/// 不同模型的向量空间不可比，混在一起算出来的相似度没有意义。
pub fn load_index(conn: &Connection, model: &str, dim: usize) -> Result<VectorIndex> {
    let mut index = VectorIndex::new(model.to_string(), dim);
    let mut stmt = conn.prepare(
        "SELECT chunk_id, vec FROM chunk_embeddings WHERE model = ?1 ORDER BY chunk_id",
    )?;
    let rows = stmt.query_map(params![model], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))
    })?;
    for row in rows {
        let (chunk_id, blob) = row?;
        index.upsert(chunk_id, vector::from_blob(&blob));
    }
    Ok(index)
}

pub fn indexed_chunk_count(conn: &Connection, model: &str) -> Result<i64> {
    let count = conn.query_row(
        "SELECT count(*) FROM chunk_embeddings WHERE model = ?1",
        params![model],
        |r| r.get(0),
    )?;
    Ok(count)
}

pub fn clear_embeddings(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM chunk_embeddings", [])?;
    Ok(())
}

// ---------- 队列 ----------

/// 入队。已在队列里则重置失败状态——用户改了内容重新保存，
/// 说明上一次失败的前提可能已经不成立了，不该继续沿用退避。
pub fn enqueue(conn: &Connection, note_id: i64, now: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO embed_queue (note_id, enqueued_at, attempts, next_try_at, last_error)
         VALUES (?1, ?2, 0, 0, NULL)
         ON CONFLICT (note_id) DO UPDATE SET
           enqueued_at = excluded.enqueued_at, attempts = 0, next_try_at = 0, last_error = NULL",
        params![note_id, now],
    )?;
    Ok(())
}

/// 把所有未删除的笔记入队。返回入队条数。
pub fn enqueue_all(conn: &Connection, now: i64) -> Result<usize> {
    let n = conn.execute(
        "INSERT INTO embed_queue (note_id, enqueued_at, attempts, next_try_at, last_error)
         SELECT id, ?1, 0, 0, NULL FROM notes WHERE deleted_at IS NULL
         ON CONFLICT (note_id) DO UPDATE SET
           enqueued_at = excluded.enqueued_at, attempts = 0, next_try_at = 0, last_error = NULL",
        params![now],
    )?;
    Ok(n)
}

/// 取出到期的待处理笔记。
pub fn take_due(conn: &Connection, now: i64, limit: usize) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT note_id FROM embed_queue WHERE next_try_at <= ?1 ORDER BY enqueued_at LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![now, limit as i64], |r| r.get(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn dequeue(conn: &Connection, note_id: i64) -> Result<()> {
    conn.execute("DELETE FROM embed_queue WHERE note_id = ?1", params![note_id])?;
    Ok(())
}

/// 记一次失败并安排下次重试。用尽次数后把 `next_try_at` 顶到 `i64::MAX`：
/// 行留在队列里（错误信息要给用户看），但不再被 `take_due` 取到。
pub fn record_failure(conn: &Connection, note_id: i64, error: &str, now: i64) -> Result<()> {
    let attempts: i64 = conn.query_row(
        "SELECT attempts FROM embed_queue WHERE note_id = ?1",
        params![note_id],
        |r| r.get(0),
    )?;
    let attempts = attempts + 1;
    let next = if attempts >= MAX_ATTEMPTS {
        i64::MAX
    } else {
        now + (1_000_i64 << attempts).min(BACKOFF_CAP_MS)
    };
    conn.execute(
        "UPDATE embed_queue SET attempts = ?2, next_try_at = ?3, last_error = ?4 WHERE note_id = ?1",
        params![note_id, attempts, next, error],
    )?;
    Ok(())
}

/// 把退避到底的项全部复活。设置面板上的「重试全部」走这里。
pub fn retry_failed(conn: &Connection) -> Result<usize> {
    let n = conn.execute(
        "UPDATE embed_queue SET attempts = 0, next_try_at = 0 WHERE attempts >= ?1",
        params![MAX_ATTEMPTS],
    )?;
    Ok(n)
}

pub fn pending_count(conn: &Connection) -> Result<i64> {
    let count = conn.query_row("SELECT count(*) FROM embed_queue", [], |r| r.get(0))?;
    Ok(count)
}

/// 队列里最近一条错误，供设置面板展示。
pub fn last_error(conn: &Connection) -> Result<Option<String>> {
    let value = conn.query_row(
        "SELECT last_error FROM embed_queue
         WHERE last_error IS NOT NULL ORDER BY next_try_at DESC LIMIT 1",
        [],
        |r| r.get(0),
    );
    match value {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}
```

- [ ] **Step 4: 跑测试**

Run: `. "$HOME/.cargo/env" && cargo test -p meshmind-core ai::index`
Expected: 全部 PASS。

- [ ] **Step 5: 反证**

把 `fts_text` 改成只索引 `chunk.text`（丢掉 heading），确认 `fts_matches_words_from_the_heading` 变红；改回来。
把 `write_embedding` 里的 `vector::normalize(&mut v)` 删掉，确认 `write_embedding_normalizes_before_storing` 变红；改回来。

- [ ] **Step 6: 提交**

```bash
git add crates/core/src/ai/index.rs
git commit -m "feat(core): 块与向量的持久化及待处理队列"
```

---

### Task 6: `ai::provider` 服务商适配

**Files:**
- Create: `crates/core/src/ai/provider.rs`

**背景（写给实现者）：** 这个模块**不发任何网络请求**。它只做两件事：把配置和输入变成一个 `HttpRequest` 描述，把响应文本解析成结构化结果。真正的 socket 由 `crates/shell/src/ai/http.rs` 持有。

两家协议的差异必须准确实现：

| | OpenAI 兼容 | Ollama |
|---|---|---|
| embedding 路径 | `{base}/embeddings` | `{base}/api/embed` |
| embedding 请求体 | `{"model":…, "input": ["a","b"]}` | `{"model":…, "input": ["a","b"]}` |
| embedding 响应 | `{"data":[{"index":0,"embedding":[…]}, …]}`，**必须按 index 排序** | `{"embeddings":[[…],[…]]}`，本身有序 |
| chat 路径 | `{base}/chat/completions` | `{base}/api/chat` |
| chat 请求体 | `{"model":…,"messages":[…],"stream":bool}` | 同左 |
| 非流式响应 | `{"choices":[{"message":{"content":"…"}}]}` | `{"message":{"content":"…"}}` |
| 流式分帧 | SSE：`data: {…}` 逐行，`data: [DONE]` 结束 | NDJSON：每行一个对象，`"done":true` 结束 |
| 流式增量字段 | `choices[0].delta.content` | `message.content` |
| 鉴权 | `Authorization: Bearer {key}` | 无 |

- [ ] **Step 1: 写失败的测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn openai() -> AiConfig {
        AiConfig {
            provider: Provider::OpenAi,
            base_url: "https://api.deepseek.com/v1".into(),
            api_key: "sk-secret".into(),
            chat_model: "deepseek-chat".into(),
            embed_model: "text-embedding-3-small".into(),
            top_k: 6,
        }
    }

    fn ollama() -> AiConfig {
        AiConfig {
            provider: Provider::Ollama,
            base_url: "http://localhost:11434".into(),
            api_key: String::new(),
            chat_model: "qwen3".into(),
            embed_model: "nomic-embed-text".into(),
            top_k: 6,
        }
    }

    fn header<'a>(req: &'a HttpRequest, name: &str) -> Option<&'a str> {
        req.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    #[test]
    fn openai_embed_request_shape() {
        let req = embed_request(&openai(), &["甲".into(), "乙".into()]).unwrap();
        assert_eq!(req.url, "https://api.deepseek.com/v1/embeddings");
        assert_eq!(header(&req, "Authorization"), Some("Bearer sk-secret"));
        let body: serde_json::Value = serde_json::from_str(&req.body).unwrap();
        assert_eq!(body["model"], "text-embedding-3-small");
        assert_eq!(body["input"], serde_json::json!(["甲", "乙"]));
    }

    #[test]
    fn ollama_embed_request_uses_its_own_path_and_no_auth() {
        let req = embed_request(&ollama(), &["甲".into()]).unwrap();
        assert_eq!(req.url, "http://localhost:11434/api/embed");
        assert!(header(&req, "Authorization").is_none(), "Ollama 不需要鉴权头");
    }

    /// Base URL 末尾多一个斜杠是最常见的手误，不能因此拼出 `//embeddings`。
    #[test]
    fn trailing_slash_in_base_url_is_tolerated() {
        let mut cfg = openai();
        cfg.base_url = "https://api.deepseek.com/v1/".into();
        assert_eq!(
            embed_request(&cfg, &["x".into()]).unwrap().url,
            "https://api.deepseek.com/v1/embeddings"
        );
    }

    #[test]
    fn missing_configuration_is_reported_by_field_name() {
        let mut cfg = openai();
        cfg.base_url = String::new();
        let err = embed_request(&cfg, &["x".into()]).unwrap_err().to_string();
        assert!(err.contains("Base URL"), "{err}");

        let mut cfg = openai();
        cfg.embed_model = String::new();
        let err = embed_request(&cfg, &["x".into()]).unwrap_err().to_string();
        assert!(err.contains("Embedding 模型"), "{err}");

        // OpenAI 模式缺 key 要报错；Ollama 模式缺 key 是正常的。
        let mut cfg = openai();
        cfg.api_key = String::new();
        assert!(embed_request(&cfg, &["x".into()]).is_err());
        assert!(embed_request(&ollama(), &["x".into()]).is_ok());
    }

    /// OpenAI 不保证 data 数组按输入顺序返回，必须按 index 重排。
    /// 漏掉这一步的后果是向量和块**静默错配**——检索还能跑，只是答非所问。
    #[test]
    fn openai_embed_response_is_reordered_by_index() {
        let body = r#"{"data":[
            {"index":1,"embedding":[0.0,1.0]},
            {"index":0,"embedding":[1.0,0.0]}
        ]}"#;
        let got = parse_embed_response(Provider::OpenAi, body).unwrap();
        assert_eq!(got, vec![vec![1.0, 0.0], vec![0.0, 1.0]]);
    }

    #[test]
    fn ollama_embed_response_is_parsed() {
        let body = r#"{"embeddings":[[1.0,0.0],[0.0,1.0]]}"#;
        let got = parse_embed_response(Provider::Ollama, body).unwrap();
        assert_eq!(got, vec![vec![1.0, 0.0], vec![0.0, 1.0]]);
    }

    /// 把 Ollama 的地址填进 OpenAI 模式是最常见的配置错误，
    /// 此时响应里没有 `data` 字段——必须是可读的 AiProtocol 而不是 panic。
    #[test]
    fn a_malformed_embed_response_is_a_protocol_error_not_a_panic() {
        for (provider, body) in [
            (Provider::OpenAi, r#"{"embeddings":[[1.0]]}"#),
            (Provider::Ollama, r#"{"data":[{"index":0,"embedding":[1.0]}]}"#),
            (Provider::OpenAi, "这不是 JSON"),
            (Provider::OpenAi, r#"{"data":[{"index":0,"embedding":"不是数组"}]}"#),
        ] {
            assert!(
                matches!(parse_embed_response(provider, body), Err(CoreError::AiProtocol(_))),
                "{provider:?} / {body}"
            );
        }
    }

    #[test]
    fn chat_request_shape() {
        let messages = vec![Message::system("你是助手"), Message::user("问题")];
        let req = chat_request(&openai(), &messages, true).unwrap();
        assert_eq!(req.url, "https://api.deepseek.com/v1/chat/completions");
        let body: serde_json::Value = serde_json::from_str(&req.body).unwrap();
        assert_eq!(body["stream"], true);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["content"], "问题");

        let req = chat_request(&ollama(), &messages, false).unwrap();
        assert_eq!(req.url, "http://localhost:11434/api/chat");
        let body: serde_json::Value = serde_json::from_str(&req.body).unwrap();
        assert_eq!(body["stream"], false);
    }

    #[test]
    fn non_streaming_chat_responses_are_parsed() {
        assert_eq!(
            parse_chat_response(
                Provider::OpenAi,
                r#"{"choices":[{"message":{"content":"答案"}}]}"#
            )
            .unwrap(),
            "答案"
        );
        assert_eq!(
            parse_chat_response(Provider::Ollama, r#"{"message":{"content":"答案"}}"#).unwrap(),
            "答案"
        );
    }

    // ---------- 流式分帧 ----------

    fn drain(decoder: &mut StreamDecoder, input: &[u8]) -> String {
        decoder.push(input).unwrap().join("")
    }

    #[test]
    fn openai_stream_decodes_deltas_and_stops_at_done() {
        let mut d = StreamDecoder::new(Provider::OpenAi);
        let text = drain(
            &mut d,
            b"data: {\"choices\":[{\"delta\":{\"content\":\"甲\"}}]}\n\
              data: {\"choices\":[{\"delta\":{\"content\":\"乙\"}}]}\n\
              data: [DONE]\n",
        );
        assert_eq!(text, "甲乙");
        assert!(d.is_done());
    }

    #[test]
    fn ollama_stream_decodes_deltas_and_stops_at_done_flag() {
        let mut d = StreamDecoder::new(Provider::Ollama);
        let text = drain(
            &mut d,
            b"{\"message\":{\"content\":\"甲\"},\"done\":false}\n\
              {\"message\":{\"content\":\"乙\"},\"done\":true}\n",
        );
        assert_eq!(text, "甲乙");
        assert!(d.is_done());
    }

    /// **最容易漏的 bug**：一个 JSON 被 TCP 切在两个包中间。
    /// 解析器必须缓冲住残缺的一半，等下一段到了再一起处理。
    #[test]
    fn a_json_split_across_two_packets_is_reassembled() {
        let whole = b"data: {\"choices\":[{\"delta\":{\"content\":\"完整\"}}]}\n";
        for cut in 1..whole.len() {
            let mut d = StreamDecoder::new(Provider::OpenAi);
            let mut out = String::new();
            out.push_str(&drain(&mut d, &whole[..cut]));
            out.push_str(&drain(&mut d, &whole[cut..]));
            assert_eq!(out, "完整", "在第 {cut} 字节处切开时解析错误");
        }
    }

    /// 多字节字符被切开时也不能出乱码——这是「用 Vec<u8> 缓冲而不是 String」
    /// 的全部理由。
    #[test]
    fn a_multibyte_character_split_across_packets_is_not_corrupted() {
        let whole = "data: {\"choices\":[{\"delta\":{\"content\":\"图谱\"}}]}\n".as_bytes();
        // 「图」的第一个字节之后切开
        let cut = whole.iter().position(|b| *b == 0xE5).unwrap() + 1;
        let mut d = StreamDecoder::new(Provider::OpenAi);
        let mut out = String::new();
        out.push_str(&drain(&mut d, &whole[..cut]));
        out.push_str(&drain(&mut d, &whole[cut..]));
        assert_eq!(out, "图谱");
    }

    /// SSE 里的空行、注释行、以及不带 content 的心跳帧都要被安静地跳过。
    #[test]
    fn openai_stream_ignores_blank_lines_and_contentless_frames() {
        let mut d = StreamDecoder::new(Provider::OpenAi);
        let text = drain(
            &mut d,
            b"\n: keep-alive\n\
              data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\
              data: {\"choices\":[{\"delta\":{\"content\":\"甲\"}}]}\n",
        );
        assert_eq!(text, "甲");
        assert!(!d.is_done());
    }

    /// 流中途返回错误对象时不能当成正常增量吞掉。
    #[test]
    fn an_error_frame_in_the_stream_becomes_a_protocol_error() {
        let mut d = StreamDecoder::new(Provider::OpenAi);
        let err = d
            .push(b"data: {\"error\":{\"message\":\"rate limit\"}}\n")
            .unwrap_err();
        assert!(err.to_string().contains("rate limit"));
    }
}
```

- [ ] **Step 2: 跑测试确认全红**

Run: `. "$HOME/.cargo/env" && cargo test -p meshmind-core ai::provider`
Expected: 编译失败。

- [ ] **Step 3: 实现**

```rust
//! 服务商适配：构造请求、解析响应、流式分帧。**本模块不发网络请求。**

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{CoreError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Provider {
    OpenAi,
    Ollama,
}

impl Provider {
    /// 从 settings 里存的字符串解析。认不出来一律当 OpenAI 兼容——
    /// 那是覆盖面最广的协议，用它兜底比报错更可能让用户直接可用。
    pub fn parse(value: &str) -> Self {
        match value {
            "ollama" => Self::Ollama,
            _ => Self::OpenAi,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::Ollama => "ollama",
        }
    }
}

#[derive(Debug, Clone)]
pub struct AiConfig {
    pub provider: Provider,
    pub base_url: String,
    pub api_key: String,
    pub chat_model: String,
    pub embed_model: String,
    pub top_k: usize,
}

/// 一个待发送的请求的完整描述。全部是 POST + JSON，因此不带 method 字段。
#[derive(Debug, Clone)]
pub struct HttpRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}

impl Message {
    pub fn system(content: impl Into<String>) -> Self {
        Self { role: "system".into(), content: content.into() }
    }
    pub fn user(content: impl Into<String>) -> Self {
        Self { role: "user".into(), content: content.into() }
    }
    pub fn assistant(content: impl Into<String>) -> Self {
        Self { role: "assistant".into(), content: content.into() }
    }
}

fn join(base: &str, path: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'))
}

/// 公共必填项校验。错误里点名具体缺哪一格——「未配置」三个字帮不了任何人。
fn require(cfg: &AiConfig, model: &str, model_label: &str) -> Result<()> {
    if cfg.base_url.trim().is_empty() {
        return Err(CoreError::AiNotConfigured("Base URL".into()));
    }
    if model.trim().is_empty() {
        return Err(CoreError::AiNotConfigured(model_label.into()));
    }
    if cfg.provider == Provider::OpenAi && cfg.api_key.trim().is_empty() {
        return Err(CoreError::AiNotConfigured("API Key".into()));
    }
    Ok(())
}

fn headers(cfg: &AiConfig) -> Vec<(String, String)> {
    let mut out = vec![("Content-Type".into(), "application/json".into())];
    if cfg.provider == Provider::OpenAi {
        out.push(("Authorization".into(), format!("Bearer {}", cfg.api_key)));
    }
    out
}

pub fn embed_request(cfg: &AiConfig, inputs: &[String]) -> Result<HttpRequest> {
    require(cfg, &cfg.embed_model, "Embedding 模型")?;
    let path = match cfg.provider {
        Provider::OpenAi => "embeddings",
        Provider::Ollama => "api/embed",
    };
    Ok(HttpRequest {
        url: join(&cfg.base_url, path),
        headers: headers(cfg),
        body: json!({ "model": cfg.embed_model, "input": inputs }).to_string(),
    })
}

pub fn parse_embed_response(provider: Provider, body: &str) -> Result<Vec<Vec<f32>>> {
    let value: Value = serde_json::from_str(body).map_err(protocol)?;
    match provider {
        Provider::OpenAi => {
            let data = value
                .get("data")
                .and_then(Value::as_array)
                .ok_or_else(|| CoreError::AiProtocol("响应里没有 data 数组".into()))?;
            // OpenAI 不保证顺序，必须按 index 重排。少了这一步，向量与块会
            // **静默错配**——检索照样能跑，只是答非所问，极难排查。
            let mut rows: Vec<(u64, Vec<f32>)> = data
                .iter()
                .map(|item| {
                    let index = item.get("index").and_then(Value::as_u64).unwrap_or(0);
                    let vec = floats(item.get("embedding"))?;
                    Ok((index, vec))
                })
                .collect::<Result<Vec<_>>>()?;
            rows.sort_by_key(|(index, _)| *index);
            Ok(rows.into_iter().map(|(_, v)| v).collect())
        }
        Provider::Ollama => {
            let rows = value
                .get("embeddings")
                .and_then(Value::as_array)
                .ok_or_else(|| CoreError::AiProtocol("响应里没有 embeddings 数组".into()))?;
            rows.iter().map(|row| floats(Some(row))).collect()
        }
    }
}

fn floats(value: Option<&Value>) -> Result<Vec<f32>> {
    let array = value
        .and_then(Value::as_array)
        .ok_or_else(|| CoreError::AiProtocol("embedding 不是数组".into()))?;
    array
        .iter()
        .map(|x| {
            x.as_f64()
                .map(|f| f as f32)
                .ok_or_else(|| CoreError::AiProtocol("embedding 里出现了非数字".into()))
        })
        .collect()
}

pub fn chat_request(cfg: &AiConfig, messages: &[Message], stream: bool) -> Result<HttpRequest> {
    require(cfg, &cfg.chat_model, "对话模型")?;
    let path = match cfg.provider {
        Provider::OpenAi => "chat/completions",
        Provider::Ollama => "api/chat",
    };
    Ok(HttpRequest {
        url: join(&cfg.base_url, path),
        headers: headers(cfg),
        body: json!({ "model": cfg.chat_model, "messages": messages, "stream": stream })
            .to_string(),
    })
}

pub fn parse_chat_response(provider: Provider, body: &str) -> Result<String> {
    let value: Value = serde_json::from_str(body).map_err(protocol)?;
    let content = match provider {
        Provider::OpenAi => value
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str),
        Provider::Ollama => value.pointer("/message/content").and_then(Value::as_str),
    };
    content
        .map(str::to_string)
        .ok_or_else(|| CoreError::AiProtocol("响应里没有回答内容".into()))
}

fn protocol(err: impl std::fmt::Display) -> CoreError {
    CoreError::AiProtocol(err.to_string())
}

// ---------- 流式分帧 ----------

/// 增量解码器。
///
/// **缓冲区是 `Vec<u8>` 而不是 `String`**：TCP 会把一个多字节字符切在两个包
/// 中间，先转字符串必然产生替换字符。按 `\n` 切分是安全的——UTF-8 的续字节
/// 永远不会等于 0x0A。
pub struct StreamDecoder {
    provider: Provider,
    buffer: Vec<u8>,
    done: bool,
}

impl StreamDecoder {
    pub fn new(provider: Provider) -> Self {
        Self { provider, buffer: Vec::new(), done: false }
    }

    pub fn is_done(&self) -> bool {
        self.done
    }

    /// 喂进一段字节，吐出其中完整的增量文本。残缺的一行留在缓冲区里等下一段。
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>> {
        self.buffer.extend_from_slice(bytes);
        let mut deltas = Vec::new();

        while let Some(position) = self.buffer.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buffer.drain(..=position).collect();
            let line = String::from_utf8_lossy(&line[..line.len() - 1]);
            if let Some(delta) = self.line(line.trim())? {
                deltas.push(delta);
            }
        }

        Ok(deltas)
    }

    fn line(&mut self, line: &str) -> Result<Option<String>> {
        if line.is_empty() || line.starts_with(':') {
            return Ok(None); // 空行与 SSE 注释（心跳）
        }

        let payload = match self.provider {
            Provider::OpenAi => match line.strip_prefix("data:") {
                Some(rest) => rest.trim(),
                None => return Ok(None), // event: / id: 这类 SSE 字段一律忽略
            },
            Provider::Ollama => line,
        };

        if payload == "[DONE]" {
            self.done = true;
            return Ok(None);
        }

        let value: Value = serde_json::from_str(payload).map_err(protocol)?;

        // 服务在流中途返回错误对象是真实存在的（限流、超额）。
        // 当成普通帧吞掉的话，用户看到的是一个莫名其妙截断的回答。
        if let Some(message) = value.pointer("/error/message").and_then(Value::as_str) {
            return Err(CoreError::AiProtocol(message.to_string()));
        }

        let content = match self.provider {
            Provider::OpenAi => value.pointer("/choices/0/delta/content"),
            Provider::Ollama => {
                if value.get("done").and_then(Value::as_bool) == Some(true) {
                    self.done = true;
                }
                value.pointer("/message/content")
            }
        };

        Ok(content
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string))
    }
}
```

- [ ] **Step 4: 跑测试**

Run: `. "$HOME/.cargo/env" && cargo test -p meshmind-core ai::provider`
Expected: 全部 PASS。

- [ ] **Step 5: 反证**

把 `parse_embed_response` 里的 `rows.sort_by_key(...)` 删掉，确认 `openai_embed_response_is_reordered_by_index` 变红；改回来。
把 `StreamDecoder::push` 改成不缓冲（每次只处理本次传入的字节、剩余部分丢弃），确认 `a_json_split_across_two_packets_is_reassembled` 变红；改回来。

- [ ] **Step 6: 提交**

```bash
git add crates/core/src/ai/provider.rs
git commit -m "feat(core): OpenAI 与 Ollama 适配器"
```

---

### Task 7: `ai::retrieve` 混合检索与 RRF

**Files:**
- Create: `crates/core/src/ai/retrieve.rs`

**背景（写给实现者）：这里不能复用 `search::query::literal_match`。** 它构造的是**短语**表达式（`"知识 图谱" *`），要求词相邻出现——那对搜索框是对的（用户敲的是关键词），但对 RAG 是灾难：一个问句「知识图谱是怎么构建的」会变成要求这七个词原样相邻，一条都召回不到。RAG 的粗筛要的是词袋 OR，靠 bm25 排序。所以本模块自己构造表达式。

- [ ] **Step 1: 写失败的测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::chunk::Chunk;
    use crate::ai::index;
    use crate::db;
    use crate::notes::{self, NewNote};

    fn setup() -> rusqlite::Connection {
        let conn = db::open_in_memory().unwrap();
        db::migrate(&conn).unwrap();
        conn
    }

    fn note_with(conn: &mut rusqlite::Connection, chunks: &[(&str, &str)]) -> i64 {
        let body = serde_json::json!({
            "type": "doc",
            "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "占位" }] }]
        })
        .to_string();
        let id = notes::create(
            conn,
            &NewNote { body_json: body, attachment_ids: vec![] },
            1_000,
        )
        .unwrap()
        .id;
        let chunks: Vec<Chunk> = chunks
            .iter()
            .map(|(h, t)| Chunk { heading: (*h).into(), text: (*t).into() })
            .collect();
        index::replace_chunks(conn, id, &chunks).unwrap();
        id
    }

    /// 问句形式的查询必须能召回——这正是「不能用短语表达式」的理由。
    #[test]
    fn a_question_shaped_query_still_recalls() {
        let mut conn = setup();
        note_with(&mut conn, &[("", "知识图谱的构建分为实体抽取与关系抽取两步")]);
        let hits = hybrid(&conn, None, "知识图谱是怎么构建的？", None, 6).unwrap();
        assert_eq!(hits.len(), 1, "问句形式的查询召回不到，说明用了短语表达式");
    }

    #[test]
    fn returns_nothing_for_a_query_without_searchable_characters() {
        let mut conn = setup();
        note_with(&mut conn, &[("", "内容")]);
        assert!(hybrid(&conn, None, "？？？", None, 6).unwrap().is_empty());
    }

    /// 没有向量时退化成纯 FTS，不报错也不 panic。
    #[test]
    fn degrades_to_fts_only_without_vectors() {
        let mut conn = setup();
        note_with(&mut conn, &[("", "向量检索")]);
        let hits = hybrid(&conn, None, "向量", None, 6).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].from_fts);
        assert!(!hits[0].from_vec);
    }

    /// 软删除的笔记的块必须被过滤掉。漏了这条，用户删掉的东西会从
    /// AI 的嘴里说回来——这是最糟糕的一类 bug。
    #[test]
    fn chunks_of_a_soft_deleted_note_are_filtered_out() {
        let mut conn = setup();
        let id = note_with(&mut conn, &[("", "秘密内容")]);
        assert_eq!(hybrid(&conn, None, "秘密", None, 6).unwrap().len(), 1);

        notes::soft_delete(&mut conn, id, 2_000).unwrap();
        assert!(
            hybrid(&conn, None, "秘密", None, 6).unwrap().is_empty(),
            "回收站里的笔记不该被 AI 检索到"
        );
    }

    #[test]
    fn k_truncates_the_result() {
        let mut conn = setup();
        note_with(
            &mut conn,
            &[("", "检索甲"), ("", "检索乙"), ("", "检索丙"), ("", "检索丁")],
        );
        assert_eq!(hybrid(&conn, None, "检索", None, 2).unwrap().len(), 2);
    }

    #[test]
    fn hits_carry_the_note_metadata_needed_for_citations() {
        let mut conn = setup();
        let id = note_with(&mut conn, &[("小标题", "正文内容")]);
        let hit = &hybrid(&conn, None, "正文", None, 6).unwrap()[0];
        assert_eq!(hit.note_id, id);
        assert_eq!(hit.heading, "小标题");
        assert_eq!(hit.text, "正文内容");
        assert!(!hit.uuid.is_empty());
        assert!(!hit.title.is_empty());
    }

    // ---------- RRF ----------

    /// 两路都命中的块必须排在只命中一路的前面。这是融合的全部意义。
    #[test]
    fn a_chunk_found_by_both_channels_outranks_one_found_by_only_one() {
        // fts 名次：[10, 20]；向量名次：[20, 30]
        let fused = fuse(&[10, 20], &[20, 30]);
        assert_eq!(fused[0].0, 20, "两路都命中的 20 应当排第一");
    }

    /// 名次靠前得分更高。
    #[test]
    fn earlier_ranks_score_higher() {
        let fused = fuse(&[1, 2, 3], &[]);
        assert_eq!(fused.iter().map(|(id, _)| *id).collect::<Vec<_>>(), vec![1, 2, 3]);
        assert!(fused[0].1 > fused[1].1);
    }

    /// RRF 常数真的参与了计算：把它换掉，同一组输入的得分必须变。
    /// 这条是防「fuse 写成了简单的名次相加」这类退化实现。
    #[test]
    fn the_rrf_constant_actually_affects_the_score() {
        let with_default = fuse(&[1], &[])[0].1;
        let expected = 1.0 / (RRF_K + 1.0);
        assert!((with_default - expected).abs() < 1e-12, "得分公式不是 1/(k+rank)");
        assert!(RRF_K > 1.0, "k 取 1 以下会让首位得分爆炸，融合失去意义");
    }

    /// 同一 id 在同一路里出现两次不该被计两遍。
    #[test]
    fn duplicate_ids_within_one_channel_are_counted_once() {
        let fused = fuse(&[7, 7], &[]);
        assert_eq!(fused.len(), 1);
        assert!((fused[0].1 - 1.0 / (RRF_K + 1.0)).abs() < 1e-12);
    }

    /// 同分时按 id 升序，保证结果稳定——否则测试会随机红，
    /// 用户也会看到列表无缘无故重排。
    #[test]
    fn ties_are_broken_deterministically_by_id() {
        assert_eq!(fuse(&[5], &[3])[0].0, 3);
        assert_eq!(fuse(&[3], &[5])[0].0, 3);
    }

    #[test]
    fn fuse_of_two_empty_channels_is_empty() {
        assert!(fuse(&[], &[]).is_empty());
    }
}
```

- [ ] **Step 2: 跑测试确认全红**

Run: `. "$HOME/.cargo/env" && cargo test -p meshmind-core ai::retrieve`
Expected: 编译失败。

- [ ] **Step 3: 实现**

```rust
//! Hybrid RAG 检索：块级 FTS5 粗筛 + 向量精筛 + RRF 融合。

use std::collections::{BTreeMap, HashSet};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::ai::vector::VectorIndex;
use crate::error::Result;
use crate::search::segment;

/// RRF 的平滑常数，取自原论文。它压平了首位与次位之间的差距，
/// 使得「在一路里排第 1」不至于碾压「在两路里都排第 3」。
pub const RRF_K: f64 = 60.0;
/// 每一路各取多少候选进入融合。
pub const FTS_TOP: usize = 20;
pub const VEC_TOP: usize = 20;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Retrieved {
    pub chunk_id: i64,
    pub note_id: i64,
    pub uuid: String,
    pub title: String,
    pub heading: String,
    pub text: String,
    pub score: f64,
    pub from_fts: bool,
    pub from_vec: bool,
}

/// 一次混合检索。
///
/// `query_vec` 为 `None` 时（AI 未启用、或还没有任何向量）自动退化成纯 FTS。
/// 这条退化路径不是兜底而是常态：首次开启 AI 后索引建完之前，用户就已经能搜了。
pub fn hybrid(
    conn: &Connection,
    index: Option<&VectorIndex>,
    query: &str,
    query_vec: Option<&[f32]>,
    k: usize,
) -> Result<Vec<Retrieved>> {
    let fts = fts_top(conn, query, FTS_TOP)?;
    let vec: Vec<i64> = match (index, query_vec) {
        (Some(index), Some(query_vec)) => index
            .top_k(query_vec, VEC_TOP)
            .into_iter()
            .map(|(id, _)| id)
            .collect(),
        _ => Vec::new(),
    };

    let fts_set: HashSet<i64> = fts.iter().copied().collect();
    let vec_set: HashSet<i64> = vec.iter().copied().collect();

    let mut out = Vec::new();
    for (chunk_id, score) in fuse(&fts, &vec) {
        // 命中的块可能属于一篇已被软删除的笔记：向量索引和 FTS 都不感知删除状态，
        // 过滤只能在这里做。漏掉它意味着用户删掉的内容会从 AI 嘴里说回来。
        let Some(mut hit) = hydrate(conn, chunk_id)? else {
            continue;
        };
        hit.score = score;
        hit.from_fts = fts_set.contains(&chunk_id);
        hit.from_vec = vec_set.contains(&chunk_id);
        out.push(hit);
        if out.len() == k {
            break;
        }
    }
    Ok(out)
}

/// 块级 bm25 粗筛。
fn fts_top(conn: &Connection, query: &str, limit: usize) -> Result<Vec<i64>> {
    let Some(expr) = fts_match(query) else {
        return Ok(Vec::new());
    };
    let mut stmt = conn.prepare(
        "SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?1
         ORDER BY bm25(chunks_fts), rowid LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![expr, limit as i64], |r| r.get(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 构造词袋 OR 表达式。
///
/// **刻意不用 `search::query::literal_match`。** 那个函数产出的是短语
/// （`"知识 图谱" *`），要求词相邻——搜索框里用户敲的是关键词，短语是对的；
/// 但这里的输入是一整个问句，要求「知识 图谱 是 怎么 构建 的」原样相邻，
/// 一条都召回不到。RAG 粗筛要的是尽量宽的召回，排序交给 bm25。
///
/// 先用滤掉单字虚词的 token 集（`的`、`了`、`是` 这类在每篇笔记里都有，
/// 参与 OR 只会把无关内容捞上来）；若全被滤光则退回完整 token 集，
/// 保证「的」这种极端查询至少还有确定的行为。
fn fts_match(query: &str) -> Option<String> {
    let mut tokens = segment::highlight_terms(query);
    if tokens.is_empty() {
        tokens = segment::searchable_tokens(query);
    }
    if tokens.is_empty() {
        return None;
    }
    let quoted: Vec<String> = tokens
        .iter()
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect();
    Some(quoted.join(" OR "))
}

/// Reciprocal Rank Fusion。得分 = Σ 1/(k + 名次)，名次从 1 起。
///
/// 同一路里重复出现的 id 只按第一次的名次计一遍——重复计分会让一个
/// 恰好被切成多块的长笔记霸占整个结果。
pub fn fuse(fts: &[i64], vec: &[i64]) -> Vec<(i64, f64)> {
    let mut scores: BTreeMap<i64, f64> = BTreeMap::new();
    for channel in [fts, vec] {
        let mut seen = HashSet::new();
        for (rank, id) in channel.iter().enumerate() {
            if !seen.insert(*id) {
                continue;
            }
            *scores.entry(*id).or_insert(0.0) += 1.0 / (RRF_K + rank as f64 + 1.0);
        }
    }
    let mut out: Vec<(i64, f64)> = scores.into_iter().collect();
    // 同分按 id 升序：BTreeMap 已经给了确定的迭代顺序，这里的 tiebreak
    // 只是把它显式写出来，免得日后换成 HashMap 时静默变成不稳定排序。
    out.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0.cmp(&b.0))
    });
    out
}

/// 取块的完整信息。笔记已被软删除时返回 `None`。
fn hydrate(conn: &Connection, chunk_id: i64) -> Result<Option<Retrieved>> {
    let row = conn.query_row(
        "SELECT c.id, c.note_id, n.uuid, n.title, c.heading, c.text
         FROM chunks c JOIN notes n ON n.id = c.note_id
         WHERE c.id = ?1 AND n.deleted_at IS NULL",
        params![chunk_id],
        |r| {
            Ok(Retrieved {
                chunk_id: r.get(0)?,
                note_id: r.get(1)?,
                uuid: r.get(2)?,
                title: r.get(3)?,
                heading: r.get(4)?,
                text: r.get(5)?,
                score: 0.0,
                from_fts: false,
                from_vec: false,
            })
        },
    );
    match row {
        Ok(hit) => Ok(Some(hit)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}
```

- [ ] **Step 4: 跑测试**

Run: `. "$HOME/.cargo/env" && cargo test -p meshmind-core ai::retrieve`
Expected: 全部 PASS。

- [ ] **Step 5: 反证**

把 `hydrate` 的 SQL 里 `AND n.deleted_at IS NULL` 删掉，确认 `chunks_of_a_soft_deleted_note_are_filtered_out` 变红；改回来。
把 `fts_match` 的 `quoted.join(" OR ")` 改成 `format!("\"{}\"", tokens.join(" "))`（短语形式），确认 `a_question_shaped_query_still_recalls` 变红；改回来。

- [ ] **Step 6: 提交**

```bash
git add crates/core/src/ai/retrieve.rs
git commit -m "feat(core): 混合检索与 RRF 融合"
```

---

### Task 8: `ai::prompt` 提示词组装

**Files:**
- Create: `crates/core/src/ai/prompt.rs`

- [ ] **Step 1: 写失败的测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn hit(chunk_id: i64, title: &str, heading: &str, text: &str) -> Retrieved {
        Retrieved {
            chunk_id,
            note_id: chunk_id,
            uuid: format!("u{chunk_id}"),
            title: title.into(),
            heading: heading.into(),
            text: text.into(),
            score: 1.0,
            from_fts: true,
            from_vec: false,
        }
    }

    /// system 里必须写死「找不到就直说」。少了这一句，模型会拿自己的知识
    /// 把答案补齐，而用户完全分不出哪句来自笔记——知识库问答的价值就没了。
    #[test]
    fn system_message_forbids_answering_beyond_the_notes() {
        let messages = build("问题", &[hit(1, "笔记", "", "内容")], &[]);
        let system = &messages[0];
        assert_eq!(system.role, "system");
        assert!(system.content.contains("没有找到相关内容"));
        assert!(system.content.contains("不要"), "必须显式禁止使用自身知识");
    }

    /// 片段编号从 1 起，且与 citations 的编号对齐——模型写 [2] 时，
    /// 前端要能定位到第 2 条引用。
    #[test]
    fn fragments_are_numbered_from_one() {
        let hits = [hit(11, "甲", "", "甲的内容"), hit(22, "乙", "小标题", "乙的内容")];
        let messages = build("问题", &hits, &[]);
        let user = messages.last().unwrap();
        assert!(user.content.contains("[1]"));
        assert!(user.content.contains("[2]"));
        assert!(user.content.contains("甲的内容"));
        assert!(user.content.contains("小标题"), "小标题要一起给模型，它是块的语境");
        assert!(user.content.ends_with("问题"), "问题要放在片段之后");
    }

    #[test]
    fn citations_line_up_with_the_fragment_numbers() {
        let hits = [hit(11, "甲", "", "甲的内容"), hit(22, "乙", "", "乙的内容")];
        let citations = citations(&hits);
        assert_eq!(citations[0].index, 1);
        assert_eq!(citations[0].note_id, 11);
        assert_eq!(citations[1].index, 2);
        assert_eq!(citations[1].note_id, 22);
    }

    #[test]
    fn citation_excerpts_are_truncated_by_characters() {
        let long = "甲".repeat(EXCERPT_MAX_CHARS + 50);
        let c = &citations(&[hit(1, "标题", "", &long)])[0];
        assert_eq!(c.excerpt.chars().count(), EXCERPT_MAX_CHARS);
        assert!(c.excerpt.chars().all(|ch| ch == '甲'), "按字节截断会劈开汉字");
    }

    /// 没有命中时也要产出可用的消息序列，让模型能说出「没找到」，
    /// 而不是由前端假装模型说了什么。
    #[test]
    fn builds_a_usable_prompt_even_with_no_hits() {
        let messages = build("问题", &[], &[]);
        assert_eq!(messages.len(), 2);
        assert!(messages.last().unwrap().content.contains("问题"));
    }

    /// history 只取最近 N 轮。上下文预算要优先留给检索到的笔记，
    /// 而不是让十轮前的闲聊把片段挤出去。
    #[test]
    fn history_is_limited_to_the_most_recent_turns() {
        let history: Vec<Message> = (0..20)
            .map(|i| {
                if i % 2 == 0 {
                    Message::user(format!("问{i}"))
                } else {
                    Message::assistant(format!("答{i}"))
                }
            })
            .collect();
        let messages = build("现在的问题", &[], &history);
        let carried = messages.len() - 2; // 去掉 system 与当前 user
        assert_eq!(carried, HISTORY_TURNS * 2);
        assert!(messages.iter().any(|m| m.content == "问14"));
        assert!(!messages.iter().any(|m| m.content == "问0"), "十轮前的对话不该带上");
    }

    #[test]
    fn history_sits_between_the_system_and_the_current_question() {
        let history = vec![Message::user("旧问"), Message::assistant("旧答")];
        let messages = build("新问", &[], &history);
        assert_eq!(messages[0].role, "system");
        assert_eq!(messages[1].content, "旧问");
        assert_eq!(messages[2].content, "旧答");
        assert!(messages[3].content.ends_with("新问"));
    }
}
```

- [ ] **Step 2: 跑测试确认全红**

Run: `. "$HOME/.cargo/env" && cargo test -p meshmind-core ai::prompt`
Expected: 编译失败。

- [ ] **Step 3: 实现**

```rust
//! 把检索到的块拼成喂给模型的消息序列。纯函数，不碰数据库也不碰网络。

use serde::{Deserialize, Serialize};

use crate::ai::provider::Message;
use crate::ai::retrieve::Retrieved;

/// 带进上下文的历史轮数。一轮 = 一问一答。
///
/// 取 3 是个取舍：多带能让「那它呢」这类指代成立，但每一轮都在挤占本该
/// 留给笔记片段的预算。指代问题在个人笔记问答里远没有「答得准」重要。
pub const HISTORY_TURNS: usize = 3;

/// 引用里回显的原文长度上限。
pub const EXCERPT_MAX_CHARS: usize = 200;

const SYSTEM: &str = "\
你是用户个人笔记库的问答助手。

规则：
1. 只依据下面提供的笔记片段回答，不要使用你自己的知识补充或推测。
2. 片段不足以回答时，直接说「笔记里没有找到相关内容」，不要编造。
3. 用到某个片段时，在相应句子末尾标注它的编号，形如 [1]、[2]。
4. 用简体中文回答，简洁直接。";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Citation {
    /// 与提示词里 `[n]` 的编号一致，从 1 起。
    pub index: u32,
    pub note_id: i64,
    pub uuid: String,
    pub title: String,
    pub heading: String,
    pub excerpt: String,
}

pub fn build(question: &str, hits: &[Retrieved], history: &[Message]) -> Vec<Message> {
    let mut messages = vec![Message::system(SYSTEM)];

    // 只带最近 HISTORY_TURNS 轮。history 是按时间升序的消息序列，
    // 从尾部倒着数 2N 条即可，不必真的去切分「轮」。
    let keep = HISTORY_TURNS * 2;
    let start = history.len().saturating_sub(keep);
    messages.extend_from_slice(&history[start..]);

    messages.push(Message::user(user_message(question, hits)));
    messages
}

fn user_message(question: &str, hits: &[Retrieved]) -> String {
    let mut buffer = String::new();
    if hits.is_empty() {
        buffer.push_str("（没有检索到相关的笔记片段）\n\n");
    } else {
        buffer.push_str("笔记片段：\n\n");
        for (i, hit) in hits.iter().enumerate() {
            buffer.push_str(&format!("[{}] 《{}》", i + 1, hit.title));
            if !hit.heading.is_empty() {
                // 小标题是这一块的语境。丢掉它，模型看到的就是一段悬空的文字。
                buffer.push_str(&format!(" > {}", hit.heading));
            }
            buffer.push('\n');
            buffer.push_str(&hit.text);
            buffer.push_str("\n\n");
        }
    }
    buffer.push_str("问题：");
    buffer.push_str(question);
    buffer
}

/// 与 `build` 里的编号严格对齐——模型写 `[2]` 时，前端要能定位到第 2 条。
/// 两处编号都从同一个 `enumerate` 的语义出发，不允许各写各的。
pub fn citations(hits: &[Retrieved]) -> Vec<Citation> {
    hits.iter()
        .enumerate()
        .map(|(i, hit)| Citation {
            index: i as u32 + 1,
            note_id: hit.note_id,
            uuid: hit.uuid.clone(),
            title: hit.title.clone(),
            heading: hit.heading.clone(),
            // 按字符截断。按字节切会劈开汉字，回显出来是乱码。
            excerpt: hit.text.chars().take(EXCERPT_MAX_CHARS).collect(),
        })
        .collect()
}
```

- [ ] **Step 4: 跑测试**

Run: `. "$HOME/.cargo/env" && cargo test -p meshmind-core ai::prompt`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add crates/core/src/ai/prompt.rs
git commit -m "feat(core): 提示词组装与引用编号"
```

---

### Task 9: `ai::chat` 会话持久化

**Files:**
- Create: `crates/core/src/ai/chat.rs`

- [ ] **Step 1: 写失败的测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::prompt::Citation;
    use crate::db;

    fn conn() -> rusqlite::Connection {
        let conn = db::open_in_memory().unwrap();
        db::migrate(&conn).unwrap();
        conn
    }

    fn citation() -> Citation {
        Citation {
            index: 1,
            note_id: 7,
            uuid: "u7".into(),
            title: "标题".into(),
            heading: "小标题".into(),
            excerpt: "片段".into(),
        }
    }

    #[test]
    fn creates_and_lists_conversations_newest_first() {
        let conn = conn();
        let a = create_conversation(&conn, 1_000).unwrap();
        let b = create_conversation(&conn, 2_000).unwrap();
        let list = list_conversations(&conn, 10, 0).unwrap();
        assert_eq!(list.iter().map(|c| c.id).collect::<Vec<_>>(), vec![b, a]);
    }

    /// 标题默认取首个提问的前 N 个字符，且按字符截断。
    #[test]
    fn the_title_defaults_to_the_first_question() {
        let conn = conn();
        let id = create_conversation(&conn, 1_000).unwrap();
        append_user(&conn, id, &"甲".repeat(100), 1_100).unwrap();
        let title = list_conversations(&conn, 10, 0).unwrap()[0].title.clone();
        assert_eq!(title.chars().count(), TITLE_MAX_CHARS);
        assert!(title.chars().all(|c| c == '甲'));
    }

    /// 只有第一条提问决定标题。第二条不该把它改掉，否则会话在列表里
    /// 会随着每次提问改名，用户再也找不到之前那个。
    #[test]
    fn a_later_question_does_not_rename_the_conversation() {
        let conn = conn();
        let id = create_conversation(&conn, 1_000).unwrap();
        append_user(&conn, id, "第一问", 1_100).unwrap();
        append_user(&conn, id, "第二问", 1_200).unwrap();
        assert_eq!(list_conversations(&conn, 10, 0).unwrap()[0].title, "第一问");
    }

    #[test]
    fn messages_come_back_in_insertion_order_with_citations_intact() {
        let conn = conn();
        let id = create_conversation(&conn, 1_000).unwrap();
        append_user(&conn, id, "问题", 1_100).unwrap();
        append_assistant(&conn, id, "回答", &[citation()], 1_200).unwrap();

        let messages = get_messages(&conn, id).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[1].role, "assistant");
        assert_eq!(messages[1].citations, vec![citation()], "citations 的 JSON 往返有损");
    }

    /// 追加消息要顺带把会话的 updated_at 顶上去，否则列表排序永远停在创建时刻。
    #[test]
    fn appending_a_message_bumps_the_conversation_timestamp() {
        let conn = conn();
        let old = create_conversation(&conn, 1_000).unwrap();
        let new = create_conversation(&conn, 2_000).unwrap();
        append_user(&conn, old, "问题", 3_000).unwrap();
        assert_eq!(
            list_conversations(&conn, 10, 0).unwrap().first().unwrap().id,
            old,
            "刚说过话的会话应该排到最前"
        );
        let _ = new;
    }

    /// 供 prompt 使用的历史里**不能带 citations**——那是给界面看的，
    /// 塞进模型上下文只是白白烧 token。
    #[test]
    fn history_for_the_model_carries_only_role_and_content() {
        let conn = conn();
        let id = create_conversation(&conn, 1_000).unwrap();
        append_user(&conn, id, "问题", 1_100).unwrap();
        append_assistant(&conn, id, "回答", &[citation()], 1_200).unwrap();

        let history = history_for_prompt(&conn, id).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].content, "问题");
        assert_eq!(history[1].content, "回答");
        assert!(!history[1].content.contains("片段"));
    }

    #[test]
    fn deleting_a_conversation_removes_its_messages() {
        let conn = conn();
        let id = create_conversation(&conn, 1_000).unwrap();
        append_user(&conn, id, "问题", 1_100).unwrap();
        delete_conversation(&conn, id).unwrap();
        assert!(matches!(get_messages(&conn, id), Err(CoreError::ConversationNotFound(_))));
        let left: i64 = conn
            .query_row("SELECT count(*) FROM messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn operations_on_a_missing_conversation_are_a_named_error() {
        let conn = conn();
        assert!(matches!(get_messages(&conn, 999), Err(CoreError::ConversationNotFound(999))));
        assert!(matches!(
            append_user(&conn, 999, "问题", 1),
            Err(CoreError::ConversationNotFound(999))
        ));
        assert!(matches!(
            rename_conversation(&conn, 999, "新名"),
            Err(CoreError::ConversationNotFound(999))
        ));
    }

    #[test]
    fn rename_sets_the_title() {
        let conn = conn();
        let id = create_conversation(&conn, 1_000).unwrap();
        rename_conversation(&conn, id, "新名字").unwrap();
        assert_eq!(list_conversations(&conn, 10, 0).unwrap()[0].title, "新名字");
    }
}
```

- [ ] **Step 2: 跑测试确认全红**

Run: `. "$HOME/.cargo/env" && cargo test -p meshmind-core ai::chat`
Expected: 编译失败。

- [ ] **Step 3: 实现**

```rust
//! 对话与消息的持久化。

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::ai::prompt::Citation;
use crate::ai::provider::Message;
use crate::error::{CoreError, Result};

/// 会话标题从首个提问截取的长度。
pub const TITLE_MAX_CHARS: usize = 30;

/// 新会话在拿到第一个提问之前的占位标题。
const UNTITLED: &str = "新对话";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Conversation {
    pub id: i64,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: i64,
    pub role: String,
    pub content: String,
    pub citations: Vec<Citation>,
    pub created_at: i64,
}

pub fn create_conversation(conn: &Connection, now: i64) -> Result<i64> {
    conn.execute(
        "INSERT INTO conversations (title, created_at, updated_at) VALUES (?1, ?2, ?2)",
        params![UNTITLED, now],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_conversations(conn: &Connection, limit: u32, offset: u32) -> Result<Vec<Conversation>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, created_at, updated_at FROM conversations
         ORDER BY updated_at DESC, id DESC LIMIT ?1 OFFSET ?2",
    )?;
    let rows = stmt
        .query_map(params![limit, offset], |r| {
            Ok(Conversation {
                id: r.get(0)?,
                title: r.get(1)?,
                created_at: r.get(2)?,
                updated_at: r.get(3)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn delete_conversation(conn: &Connection, id: i64) -> Result<()> {
    // messages 靠外键级联跟着走。
    let n = conn.execute("DELETE FROM conversations WHERE id = ?1", params![id])?;
    if n == 0 {
        return Err(CoreError::ConversationNotFound(id));
    }
    Ok(())
}

pub fn rename_conversation(conn: &Connection, id: i64, title: &str) -> Result<()> {
    let n = conn.execute(
        "UPDATE conversations SET title = ?2 WHERE id = ?1",
        params![id, title],
    )?;
    if n == 0 {
        return Err(CoreError::ConversationNotFound(id));
    }
    Ok(())
}

pub fn get_messages(conn: &Connection, conversation_id: i64) -> Result<Vec<ChatMessage>> {
    ensure_exists(conn, conversation_id)?;
    let mut stmt = conn.prepare(
        "SELECT id, role, content, citations, created_at FROM messages
         WHERE conversation_id = ?1 ORDER BY id",
    )?;
    let rows = stmt
        .query_map(params![conversation_id], |r| {
            let raw: String = r.get(3)?;
            Ok(ChatMessage {
                id: r.get(0)?,
                role: r.get(1)?,
                content: r.get(2)?,
                // 坏掉的 citations JSON 不该让整个会话打不开：退化成没有引用，
                // 消息本身还在。这是纯粹的展示信息，不值得为它丢掉正文。
                citations: serde_json::from_str(&raw).unwrap_or_default(),
                created_at: r.get(4)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 喂给模型的历史：只有 role 与 content。
/// citations 是给界面看的，塞进上下文只是白烧 token。
pub fn history_for_prompt(conn: &Connection, conversation_id: i64) -> Result<Vec<Message>> {
    Ok(get_messages(conn, conversation_id)?
        .into_iter()
        .map(|m| Message { role: m.role, content: m.content })
        .collect())
}

pub fn append_user(conn: &Connection, conversation_id: i64, content: &str, now: i64) -> Result<i64> {
    let id = insert(conn, conversation_id, "user", content, &[], now)?;
    // 首个提问决定标题。之后的提问不再改动——会话每问一次就改名的话，
    // 用户在列表里再也认不出之前那个。
    conn.execute(
        "UPDATE conversations SET title = ?2 WHERE id = ?1 AND title = ?3",
        params![
            conversation_id,
            content.chars().take(TITLE_MAX_CHARS).collect::<String>(),
            UNTITLED
        ],
    )?;
    Ok(id)
}

pub fn append_assistant(
    conn: &Connection,
    conversation_id: i64,
    content: &str,
    citations: &[Citation],
    now: i64,
) -> Result<i64> {
    insert(conn, conversation_id, "assistant", content, citations, now)
}

fn insert(
    conn: &Connection,
    conversation_id: i64,
    role: &str,
    content: &str,
    citations: &[Citation],
    now: i64,
) -> Result<i64> {
    ensure_exists(conn, conversation_id)?;
    let citations = serde_json::to_string(citations)
        .map_err(|e| CoreError::InvalidContent(e.to_string()))?;
    conn.execute(
        "INSERT INTO messages (conversation_id, role, content, citations, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![conversation_id, role, content, citations, now],
    )?;
    let id = conn.last_insert_rowid();
    // 顶起 updated_at，否则会话列表的排序永远停在创建时刻。
    conn.execute(
        "UPDATE conversations SET updated_at = ?2 WHERE id = ?1",
        params![conversation_id, now],
    )?;
    Ok(id)
}

fn ensure_exists(conn: &Connection, id: i64) -> Result<()> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM conversations WHERE id = ?1)",
        params![id],
        |r| r.get(0),
    )?;
    if exists {
        Ok(())
    } else {
        Err(CoreError::ConversationNotFound(id))
    }
}
```

- [ ] **Step 4: 跑测试**

Run: `. "$HOME/.cargo/env" && cargo test -p meshmind-core ai::chat`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add crates/core/src/ai/chat.rs
git commit -m "feat(core): 对话与消息持久化"
```

---

### Task 10: 笔记保存时入队

**Files:**
- Modify: `crates/core/src/notes/mod.rs`（`create`、`update`）
- Modify: `crates/core/tests/notes.rs`（新增测试）

**决策（写给实现者）：不论 AI 是否启用都入队。** 让 core 去读 `settings` 判断开关，等于把「AI 开没开」这件事散进笔记模块，而 `embed_queue` 一行只有几十字节。代价是关着 AI 时队列会累积——这恰恰是想要的：用户哪天打开 AI，历史笔记本来就都得索引一遍。

- [ ] **Step 1: 写失败的测试**

追加到 `crates/core/tests/notes.rs`：

```rust
/// 新建笔记必须入队，否则它永远不会被向量化，而且没有任何人会发现。
#[test]
fn creating_a_note_enqueues_it_for_embedding() {
    let mut conn = common::conn();
    let note = common::create(&mut conn, "内容");
    let queued: i64 = conn
        .query_row(
            "SELECT count(*) FROM embed_queue WHERE note_id = ?1",
            [note.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(queued, 1);
}

/// 更新同样要入队——正文变了，旧向量就过期了。
#[test]
fn updating_a_note_reenqueues_it() {
    let mut conn = common::conn();
    let note = common::create(&mut conn, "旧内容");
    conn.execute("DELETE FROM embed_queue", []).unwrap();

    meshmind_core::notes::update(&mut conn, note.id, &common::body("新内容"), &[], 2_000).unwrap();

    let queued: i64 = conn
        .query_row(
            "SELECT count(*) FROM embed_queue WHERE note_id = ?1",
            [note.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(queued, 1);
}

/// 入队与笔记写入必须在同一事务里。笔记写成功而入队失败的话，
/// 会留下一篇永远不被索引的笔记——而且是静默的。
#[test]
fn the_note_and_its_queue_entry_are_written_atomically() {
    let mut conn = common::conn();
    // 附件不存在会让 create 在事务中途失败并整体回滚。
    let failed = meshmind_core::notes::create(
        &mut conn,
        &meshmind_core::notes::NewNote {
            body_json: common::body("内容"),
            attachment_ids: vec![9999],
        },
        1_000,
    );
    assert!(failed.is_err());

    let notes: i64 = conn.query_row("SELECT count(*) FROM notes", [], |r| r.get(0)).unwrap();
    let queued: i64 = conn
        .query_row("SELECT count(*) FROM embed_queue", [], |r| r.get(0))
        .unwrap();
    assert_eq!(notes, 0);
    assert_eq!(queued, 0, "笔记回滚了，队列行却留下来了——两者不在同一事务里");
}
```

若 `crates/core/tests/common/mod.rs` 里还没有 `body(text)` 这个构造 TipTap JSON 的辅助函数，先加一个，并让已有的 `create` 复用它。

- [ ] **Step 2: 跑测试确认全红**

Run: `. "$HOME/.cargo/env" && cargo test -p meshmind-core --test notes`
Expected: 三条新测试 FAIL。

- [ ] **Step 3: 实现**

在 `notes::create` 的 `tx.commit()?` **之前**、`link_attachments` 之后插入：

```rust
    // 入队等待向量化。放在同一事务里：笔记写成功而入队失败的话，
    // 会留下一篇永远不被索引的笔记，且没有任何信号能暴露它。
    // 不判断 AI 开关——core 不该知道那件事，而一行队列记录只有几十字节。
    crate::ai::index::enqueue(&tx, id, now)?;
```

在 `notes::update` 的对应位置（重建索引之后、`tx.commit()?` 之前）插入同样的一行（`id` 换成该函数里的笔记 id 变量）。

`Transaction` 解引用到 `Connection`，`&tx` 可以直接传给 `enqueue`。

- [ ] **Step 4: 跑测试**

Run: `. "$HOME/.cargo/env" && cargo test -p meshmind-core`
Expected: 全部 PASS（包括原有测试）。

- [ ] **Step 5: 提交**

```bash
git add crates/core/src/notes/mod.rs crates/core/tests
git commit -m "feat(core): 笔记保存时入队等待向量化"
```

---

### Task 11: shell 的 HTTP 层与脱敏

**Files:**
- Create: `crates/shell/src/ai/mod.rs`、`crates/shell/src/ai/http.rs`
- Modify: `crates/shell/Cargo.toml`、`crates/shell/src/main.rs`（`mod ai;`）

- [ ] **Step 1: 加依赖**

`crates/shell/Cargo.toml` 的 `[dependencies]` 追加：

```toml
# 关掉默认特性并改用 rustls：默认的 native-tls 会在 Windows 上引入
# OpenSSL 构建依赖，CI 会直接红。
# 用 blocking 而不是异步流：外壳没有 async runtime，为 AI 单独引入一个太重；
# blocking::Response 实现了 Read，边读边分帧就是流式。
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "json", "blocking"] }
```

- [ ] **Step 2: 写失败的测试**

`crates/shell/src/ai/http.rs` 的 `mod tests`：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// 密钥绝不能出现在任何错误信息里。它会被写进日志、显示在错误横幅上、
    /// 被用户截图发出去——泄漏路径太多，只能在源头堵死。
    #[test]
    fn redact_removes_the_bare_key() {
        let text = "请求失败: Authorization: Bearer sk-abcdef123456";
        let clean = redact(text, "sk-abcdef123456");
        assert!(!clean.contains("sk-abcdef123456"));
        assert!(clean.contains("请求失败"), "脱敏不该把有用的信息也抹掉");
    }

    /// 就算不知道密钥原文（比如错误来自另一处配置），也要把
    /// `Bearer xxx` 这种形状盖掉——这是 reqwest 错误里最常见的泄漏形式。
    #[test]
    fn redact_masks_any_bearer_token_even_without_knowing_the_key() {
        let clean = redact("header Authorization: Bearer sk-live-999 end", "");
        assert!(!clean.contains("sk-live-999"), "{clean}");
        assert!(clean.contains("end"));
    }

    /// 空密钥不能把整段文本盖成星号——空串是任何字符串的子串。
    #[test]
    fn redact_with_an_empty_key_does_not_destroy_the_message() {
        assert_eq!(redact("普通错误", ""), "普通错误");
    }

    #[test]
    fn non_2xx_responses_name_the_status_and_include_the_body() {
        let message = status_error(401, "{\"error\":{\"message\":\"invalid key\"}}", "sk-x");
        assert!(message.contains("401"));
        assert!(message.contains("invalid key"));
    }

    /// 服务返回的错误体里可能原样回显密钥，这条路径同样要脱敏。
    #[test]
    fn the_error_body_is_redacted_too() {
        let message = status_error(400, "bad key sk-secret-1", "sk-secret-1");
        assert!(!message.contains("sk-secret-1"), "{message}");
    }

    /// 超长的错误体要截断——某些网关会返回整页 HTML，
    /// 原样塞进错误横幅会把界面撑爆。
    #[test]
    fn a_huge_error_body_is_truncated() {
        let message = status_error(500, &"x".repeat(10_000), "");
        assert!(message.chars().count() < 1_000);
    }
}
```

- [ ] **Step 3: 实现 `http.rs`**

```rust
//! 把 core 构造出来的请求真正发出去。**密钥脱敏在这里，也只在这里。**

use std::io::Read;
use std::time::Duration;

use meshmind_core::ai::provider::HttpRequest;

/// 非流式请求的总超时。embedding 一批 16 条在慢网络下确实可能接近一分钟。
pub const TIMEOUT: Duration = Duration::from_secs(60);
/// 流式请求两次读之间的最长间隔。
///
/// 不能用总超时：一个长回答本来就要写好几分钟，卡总时长会把正常的长答案砍掉。
/// 真正需要检测的是「连接卡死了」，而那表现为长时间读不出任何字节。
pub const STREAM_READ_TIMEOUT: Duration = Duration::from_secs(60);

/// 错误体最多回显多少字符。某些网关会返回整页 HTML。
const ERROR_BODY_MAX_CHARS: usize = 500;

/// 抹掉文本里的密钥。
///
/// 两条路径都要堵：已知密钥原文时直接替换；不知道时按 `Bearer xxx` 的形状盖掉
/// ——reqwest 的错误里最常见的泄漏形式就是它把请求头原样打印出来。
pub fn redact(text: &str, api_key: &str) -> String {
    let mut out = text.to_string();
    // 空串是任何字符串的子串，不加这层判断会把整段文本盖成星号。
    if !api_key.is_empty() {
        out = out.replace(api_key, "***");
    }
    // 逐词扫描，把紧跟在 Bearer 之后的那一段换掉。用手写扫描而不是正则，
    // 是为了不给 shell 引入 regex 依赖（core 有，shell 没有）。
    let mut result = String::with_capacity(out.len());
    let mut rest = out.as_str();
    while let Some(at) = rest.find("Bearer ") {
        let (head, tail) = rest.split_at(at + "Bearer ".len());
        result.push_str(head);
        let end = tail
            .find(|c: char| c.is_whitespace())
            .unwrap_or(tail.len());
        result.push_str("***");
        rest = &tail[end..];
    }
    result.push_str(rest);
    result
}

/// 非 2xx 响应转成一句能直接显示给用户的中文。
pub fn status_error(status: u16, body: &str, api_key: &str) -> String {
    let body: String = redact(body.trim(), api_key)
        .chars()
        .take(ERROR_BODY_MAX_CHARS)
        .collect();
    format!("AI 服务返回 {status}：{body}")
}

fn client(read_timeout: Option<Duration>) -> Result<reqwest::blocking::Client, String> {
    let mut builder = reqwest::blocking::Client::builder();
    match read_timeout {
        Some(d) => builder = builder.read_timeout(d),
        None => builder = builder.timeout(TIMEOUT),
    }
    builder
        .build()
        .map_err(|e| format!("AI 服务调用失败（无法创建 HTTP 客户端）：{e}"))
}

fn send(
    client: &reqwest::blocking::Client,
    request: &HttpRequest,
) -> Result<reqwest::blocking::Response, String> {
    let mut builder = client.post(&request.url).body(request.body.clone());
    for (name, value) in &request.headers {
        builder = builder.header(name, value);
    }
    builder
        .send()
        .map_err(|e| format!("AI 服务调用失败（{e}）"))
}

/// 发一个请求，把响应体整个读回来。
pub fn post(request: &HttpRequest, api_key: &str) -> Result<String, String> {
    let client = client(None)?;
    let response = send(&client, request).map_err(|e| redact(&e, api_key))?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .map_err(|e| redact(&format!("AI 服务调用失败（读取响应失败：{e}）"), api_key))?;
    if !(200..300).contains(&status) {
        return Err(status_error(status, &body, api_key));
    }
    Ok(body)
}

/// 发一个流式请求，每读到一段字节就交给 `on_bytes`。
///
/// `on_bytes` 返回 `false` 表示调用方要求中止（用户按了取消），此时立刻断开连接。
pub fn post_stream(
    request: &HttpRequest,
    api_key: &str,
    mut on_bytes: impl FnMut(&[u8]) -> Result<bool, String>,
) -> Result<(), String> {
    let client = client(Some(STREAM_READ_TIMEOUT))?;
    let mut response = send(&client, request).map_err(|e| redact(&e, api_key))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let body = response.text().unwrap_or_default();
        return Err(status_error(status, &body, api_key));
    }

    let mut buffer = [0u8; 8192];
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|e| redact(&format!("AI 服务调用失败（连接中断：{e}）"), api_key))?;
        if read == 0 {
            return Ok(());
        }
        if !on_bytes(&buffer[..read])? {
            return Ok(());
        }
    }
}
```

**若 `read_timeout` 在解析到的 reqwest 版本上不存在**（0.12.5 之前没有这个方法），改用 `builder.timeout(Duration::from_secs(600))` 并把 `STREAM_READ_TIMEOUT` 的注释改成说明这是总超时的退让。不要为此升级 reqwest 大版本。

- [ ] **Step 4: 写 `ai/mod.rs` 占位并挂上模块**

```rust
//! 外壳侧的 AI：HTTP、后台向量化、问答编排。

pub mod http;
```

`crates/shell/src/main.rs` 的模块声明区加 `mod ai;`。

- [ ] **Step 5: 跑测试**

Run: `. "$HOME/.cargo/env" && cargo test -p meshmind ai::http`
Expected: 全部 PASS。

- [ ] **Step 6: 反证**

把 `redact` 改成直接 `text.to_string()`，确认三条脱敏测试变红；改回来。

- [ ] **Step 7: 提交**

```bash
git add crates/shell/Cargo.toml crates/shell/src/ai crates/shell/src/main.rs Cargo.lock
git commit -m "feat(shell): AI 的 HTTP 层与密钥脱敏"
```

---

### Task 12: 设置项与 `AiRuntime`

**Files:**
- Create: `crates/shell/src/ai/config.rs`
- Modify: `crates/shell/src/ai/mod.rs`、`crates/shell/src/settings.rs`、`crates/shell/src/state.rs`

- [ ] **Step 1: 扩设置项白名单**

`crates/shell/src/settings.rs`：

```rust
/// AI 总开关，`"true"` / `"false"`。默认关——方案书的「零依赖启动」
/// 意味着不配置 AI 时应用不该有任何网络行为。
pub const KEY_AI_ENABLED: &str = "ai.enabled";
/// `"openai"`（OpenAI 兼容协议）或 `"ollama"`。
pub const KEY_AI_PROVIDER: &str = "ai.provider";
pub const KEY_AI_BASE_URL: &str = "ai.base_url";
/// **只写不读**：`get_settings` 会把这个键从返回值里剔除，换成
/// `ai.api_key_set`。密钥因此不会经 IPC 进入 webview，也不会出现在
/// 前端日志或错误上报里。
pub const KEY_AI_API_KEY: &str = "ai.api_key";
pub const KEY_AI_CHAT_MODEL: &str = "ai.chat_model";
pub const KEY_AI_EMBED_MODEL: &str = "ai.embed_model";
pub const KEY_AI_TOP_K: &str = "ai.top_k";

/// `get_settings` 返回值里代替 `ai.api_key` 的那个键，值为 `"true"` / `"false"`。
/// 它**不在** `ALLOWED_KEYS` 里——前端不能写它，它是读取时合成出来的。
pub const KEY_AI_API_KEY_SET: &str = "ai.api_key_set";

pub const ALLOWED_KEYS: [&str; 10] = [
    KEY_CAPTURE_HOTKEY,
    KEY_HIDE_DOCK_ICON,
    KEY_AUTOSTART,
    KEY_AI_ENABLED,
    KEY_AI_PROVIDER,
    KEY_AI_BASE_URL,
    KEY_AI_API_KEY,
    KEY_AI_CHAT_MODEL,
    KEY_AI_EMBED_MODEL,
    KEY_AI_TOP_K,
];
```

追加测试：

```rust
    /// 合成键不能进白名单——它是读取时算出来的，让前端写进去只会
    /// 在 settings 表里留下一个永远对不上的幽灵值。
    #[test]
    fn the_synthesised_key_is_not_writable() {
        assert!(ensure_allowed(KEY_AI_API_KEY_SET).is_err());
    }

    #[test]
    fn ai_keys_are_writable() {
        for key in [KEY_AI_ENABLED, KEY_AI_PROVIDER, KEY_AI_BASE_URL, KEY_AI_API_KEY] {
            assert!(ensure_allowed(key).is_ok(), "{key}");
        }
    }
```

- [ ] **Step 2: 写 `config.rs` 的失败测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use meshmind_core::{db, settings as core_settings};

    fn conn() -> rusqlite::Connection {
        let conn = db::open_in_memory().unwrap();
        db::migrate(&conn).unwrap();
        conn
    }

    fn configure(conn: &rusqlite::Connection) {
        for (k, v) in [
            (crate::settings::KEY_AI_PROVIDER, "openai"),
            (crate::settings::KEY_AI_BASE_URL, "https://api.deepseek.com/v1"),
            (crate::settings::KEY_AI_API_KEY, "sk-x"),
            (crate::settings::KEY_AI_CHAT_MODEL, "deepseek-chat"),
            (crate::settings::KEY_AI_EMBED_MODEL, "text-embedding-3-small"),
        ] {
            core_settings::set(conn, k, v).unwrap();
        }
    }

    #[test]
    fn defaults_are_safe_when_nothing_is_configured() {
        let conn = conn();
        let cfg = load(&conn);
        assert!(!is_enabled(&conn), "AI 默认必须是关的");
        assert_eq!(cfg.top_k, DEFAULT_TOP_K);
        assert!(missing(&cfg).is_some());
    }

    #[test]
    fn loads_every_field() {
        let conn = conn();
        configure(&conn);
        let cfg = load(&conn);
        assert_eq!(cfg.base_url, "https://api.deepseek.com/v1");
        assert_eq!(cfg.api_key, "sk-x");
        assert_eq!(cfg.chat_model, "deepseek-chat");
        assert!(missing(&cfg).is_none());
    }

    /// Ollama 模式不需要密钥，不能因为没填 key 就判定「未配置」。
    #[test]
    fn ollama_does_not_require_an_api_key() {
        let conn = conn();
        configure(&conn);
        core_settings::set(&conn, crate::settings::KEY_AI_PROVIDER, "ollama").unwrap();
        core_settings::set(&conn, crate::settings::KEY_AI_API_KEY, "").unwrap();
        assert!(missing(&load(&conn)).is_none());
    }

    /// top_k 填了垃圾不能让整个 AI 挂掉，回落到默认值即可。
    #[test]
    fn a_garbage_top_k_falls_back_to_the_default() {
        let conn = conn();
        core_settings::set(&conn, crate::settings::KEY_AI_TOP_K, "很多").unwrap();
        assert_eq!(load(&conn).top_k, DEFAULT_TOP_K);
    }

    /// top_k 为 0 会让检索返回空，等于 AI 永远答不出东西——必须兜住。
    #[test]
    fn a_zero_top_k_falls_back_to_the_default() {
        let conn = conn();
        core_settings::set(&conn, crate::settings::KEY_AI_TOP_K, "0").unwrap();
        assert_eq!(load(&conn).top_k, DEFAULT_TOP_K);
    }

    #[test]
    fn missing_names_the_first_empty_field() {
        let conn = conn();
        configure(&conn);
        core_settings::set(&conn, crate::settings::KEY_AI_CHAT_MODEL, "").unwrap();
        assert_eq!(missing(&load(&conn)), Some("对话模型"));
    }
}
```

- [ ] **Step 3: 实现 `config.rs`**

```rust
//! 从 settings 表读出 AI 配置。

use meshmind_core::ai::provider::{AiConfig, Provider};
use meshmind_core::settings as core_settings;
use rusqlite::Connection;

use crate::settings;

/// 喂给模型的片段数。6 条在 500 字/块的粒度下约 3000 字，
/// 对绝大多数模型的上下文都很宽裕，同时不至于把无关内容也塞进去。
pub const DEFAULT_TOP_K: usize = 6;

fn read(conn: &Connection, key: &str) -> String {
    core_settings::get(conn, key)
        .unwrap_or_default()
        .unwrap_or_default()
}

pub fn is_enabled(conn: &Connection) -> bool {
    settings::read_bool(conn, settings::KEY_AI_ENABLED)
}

pub fn load(conn: &Connection) -> AiConfig {
    AiConfig {
        provider: Provider::parse(&read(conn, settings::KEY_AI_PROVIDER)),
        base_url: read(conn, settings::KEY_AI_BASE_URL),
        api_key: read(conn, settings::KEY_AI_API_KEY),
        chat_model: read(conn, settings::KEY_AI_CHAT_MODEL),
        embed_model: read(conn, settings::KEY_AI_EMBED_MODEL),
        // 解析失败或填了 0 一律回落默认值：一个坏掉的数字不该让 AI 整体失灵，
        // 而 top_k = 0 会让检索永远返回空，表现为「模型什么都答不上来」。
        top_k: read(conn, settings::KEY_AI_TOP_K)
            .parse::<usize>()
            .ok()
            .filter(|k| *k > 0)
            .unwrap_or(DEFAULT_TOP_K),
    }
}

/// 配置是否完整；不完整时返回缺的那一项的中文名。
pub fn missing(cfg: &AiConfig) -> Option<&'static str> {
    if cfg.base_url.trim().is_empty() {
        return Some("Base URL");
    }
    if cfg.chat_model.trim().is_empty() {
        return Some("对话模型");
    }
    if cfg.embed_model.trim().is_empty() {
        return Some("Embedding 模型");
    }
    if cfg.provider == Provider::OpenAi && cfg.api_key.trim().is_empty() {
        return Some("API Key");
    }
    None
}
```

- [ ] **Step 4: 写 `AiRuntime` 并挂进 `AppState`**

`crates/shell/src/ai/mod.rs`：

```rust
//! 外壳侧的 AI：配置、HTTP、后台向量化、问答编排。

pub mod ask;
pub mod config;
pub mod http;
pub mod worker;

use std::sync::atomic::AtomicBool;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

use meshmind_core::ai::vector::VectorIndex;

/// AI 的运行期状态。
///
/// **三样东西都是 `None` 起步**，且只在用户真正启用 AI 之后才被填上：
/// 不配置 AI 的用户不会为此付出任何内存或线程的代价，这是方案书
/// 「零依赖启动」的字面要求。
#[derive(Default)]
pub struct AiRuntime {
    /// 内存向量索引。懒加载：首次检索时装载，关闭 AI 时置 None 释放。
    pub index: Mutex<Option<VectorIndex>>,
    /// 当前在飞的提问的取消标志。同一时刻只允许一个提问，
    /// 新提问会先把旧标志置 true。
    pub cancel: Mutex<Option<Arc<AtomicBool>>>,
    /// 唤醒后台 worker 的通道。worker 未启动时为 None。
    pub wake: Mutex<Option<Sender<()>>>,
}

impl AiRuntime {
    /// 取消在飞的提问（若有），并返回一个属于新提问的标志。
    pub fn begin_ask(&self) -> Arc<AtomicBool> {
        let mut slot = self.cancel.lock().expect("AI 取消标志锁已中毒");
        if let Some(previous) = slot.take() {
            previous.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        let flag = Arc::new(AtomicBool::new(false));
        *slot = Some(Arc::clone(&flag));
        flag
    }

    pub fn cancel_ask(&self) {
        let mut slot = self.cancel.lock().expect("AI 取消标志锁已中毒");
        if let Some(flag) = slot.take() {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    /// 戳一下 worker 让它立刻干活。worker 没起来时静默忽略——
    /// 那说明 AI 是关的，本来就不该有人在等它。
    pub fn wake_worker(&self) {
        if let Some(tx) = self.wake.lock().expect("AI 唤醒通道锁已中毒").as_ref() {
            let _ = tx.send(());
        }
    }
}
```

`crates/shell/src/state.rs` 的 `AppState` 加一个字段并在 `initialize` 里 `ai: AiRuntime::default()`：

```rust
    /// AI 的运行期状态。未启用 AI 时全是空的，不占内存也不起线程。
    pub ai: crate::ai::AiRuntime,
```

- [ ] **Step 5: 跑测试**

Run: `. "$HOME/.cargo/env" && cargo test -p meshmind`
Expected: 全部 PASS。`ask` 与 `worker` 模块此时还不存在，先建空占位文件（`//! 占位`）让它编过。

- [ ] **Step 6: 提交**

```bash
git add crates/shell/src
git commit -m "feat(shell): AI 设置项与运行期状态"
```

---

### Task 13: 后台向量化 worker

**Files:**
- Create: `crates/shell/src/ai/worker.rs`

**并发纪律（写给实现者，这是本任务最容易写错的地方）：**
**绝不能在持有数据库锁的时候发 HTTP 请求。** 一次 embedding 调用在慢网络下可能耗时数十秒，而 `AppState.conn` 是全应用共用的一把 `Mutex`——期间用户敲的每一个字、每一次搜索都会被卡死。正确的节奏是：**锁 → 读出要处理的数据 → 解锁 → 发请求 → 锁 → 写回 → 解锁**。每个代码块都要短到一眼能看出锁在哪里释放。

- [ ] **Step 1: 写失败的测试**

worker 的主循环依赖 `AppHandle`，不适合单测。把**可测的决策逻辑**抽成纯函数单独测：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// 分批必须覆盖到全部输入，不能因为整除关系漏掉尾巴。
    #[test]
    fn batches_cover_every_input() {
        for total in 0..40usize {
            let inputs: Vec<usize> = (0..total).collect();
            let flattened: Vec<usize> = inputs
                .chunks(EMBED_BATCH)
                .flat_map(|c| c.to_vec())
                .collect();
            assert_eq!(flattened, inputs, "total = {total}");
        }
    }

    /// embedding 的输入把标题与小标题拼在正文前面。这是检索质量的关键：
    /// 一个块脱离了它的语境，向量表达的就是一段悬空的文字。
    #[test]
    fn embed_input_carries_the_note_title_and_heading() {
        let input = embed_input("笔记标题", "小标题", "正文");
        assert!(input.starts_with("笔记标题"));
        assert!(input.contains("小标题"));
        assert!(input.ends_with("正文"));
    }

    #[test]
    fn embed_input_omits_an_empty_heading_without_leaving_a_blank_line() {
        assert_eq!(embed_input("标题", "", "正文"), "标题\n正文");
    }

    /// 返回的向量条数与请求的块数对不上时必须报错。
    /// 静默按位置配对会让向量与块错位——检索照样能跑，只是全都答非所问。
    #[test]
    fn a_count_mismatch_is_an_error_not_a_silent_zip() {
        assert!(check_count(3, 2).is_err());
        assert!(check_count(3, 3).is_ok());
    }
}
```

- [ ] **Step 2: 实现**

```rust
//! 后台向量化线程。
//!
//! **锁的纪律**：绝不在持有数据库锁时发 HTTP。一次 embedding 调用可能耗时
//! 数十秒，而 `AppState.conn` 是全应用共用的一把锁——期间用户敲的每个字、
//! 每一次搜索都会被卡住。节奏必须是：锁 → 读 → 解锁 → 请求 → 锁 → 写 → 解锁。

use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::time::Duration;

use meshmind_core::ai::provider::{self, AiConfig};
use meshmind_core::ai::{chunk, index};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::ai::{config, http};
use crate::state::AppState;

/// 没有新任务时的巡检间隔。
const TICK: Duration = Duration::from_secs(30);
/// 每轮处理多少篇笔记。
const QUEUE_BATCH_NOTES: usize = 4;
/// 一次 embedding 请求带多少个块。
pub const EMBED_BATCH: usize = 16;

/// 索引进度事件。前端据此更新设置面板上的进度。
pub const PROGRESS_EVENT: &str = "ai://index-progress";

#[derive(Clone, serde::Serialize)]
struct Progress {
    pending: i64,
    indexed: i64,
}

/// 起一个 worker 线程，返回用来唤醒它的发送端。
///
/// 只在 AI 被启用时调用。线程随发送端一起消亡：`AiRuntime.wake` 被置 None 后
/// 通道断开，`recv_timeout` 返回 `Disconnected`，循环退出。
pub fn spawn<R: Runtime>(app: AppHandle<R>) -> Sender<()> {
    let (tx, rx) = mpsc::channel::<()>();
    std::thread::spawn(move || loop {
        match rx.recv_timeout(TICK) {
            Ok(()) | Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        if let Err(err) = run_once(&app) {
            // 这里的失败已经被记进了队列的 last_error，用户在设置面板能看到。
            // 打一行日志只是为了本地排查，不该让线程倒下。
            eprintln!("[MeshMind] 向量化失败: {err}");
        }
    });
    tx
}

fn run_once<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app.state::<AppState>();

    // ---- 锁：读配置与待办 ----
    let (enabled, cfg, due) = {
        let conn = state.conn.lock().expect("数据库连接锁已中毒");
        let enabled = config::is_enabled(&conn);
        let cfg = config::load(&conn);
        let due = if enabled && config::missing(&cfg).is_none() {
            index::take_due(&conn, meshmind_core::now_ms(), QUEUE_BATCH_NOTES)
                .map_err(|e| e.to_string())?
        } else {
            Vec::new()
        };
        (enabled, cfg, due)
    };
    // ---- 解锁 ----

    if !enabled || due.is_empty() {
        return Ok(());
    }

    for note_id in due {
        if let Err(err) = process(app, &state, &cfg, note_id) {
            let conn = state.conn.lock().expect("数据库连接锁已中毒");
            let _ = index::record_failure(&conn, note_id, &err, meshmind_core::now_ms());
        }
    }

    emit_progress(app, &state, &cfg);
    Ok(())
}

fn process<R: Runtime>(
    app: &AppHandle<R>,
    state: &tauri::State<'_, AppState>,
    cfg: &AiConfig,
    note_id: i64,
) -> Result<(), String> {
    let _ = app;

    // ---- 锁：读笔记、切块、写块 ----
    let pending: Vec<(i64, String)> = {
        let mut conn = state.conn.lock().expect("数据库连接锁已中毒");
        let (title, body_json): (String, String) = conn
            .query_row(
                "SELECT title, body_json FROM notes WHERE id = ?1 AND deleted_at IS NULL",
                [note_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            // 笔记在排队期间被删了：不是错误，出队走人。
            .ok()
            .ok_or_else(|| String::new())
            .or_else(|_| {
                index::dequeue(&conn, note_id).map_err(|e| e.to_string())?;
                Err(String::new())
            })?;

        let chunks = chunk::split(&body_json).map_err(|e| e.to_string())?;
        index::replace_chunks(&mut conn, note_id, &chunks).map_err(|e| e.to_string())?;
        index::chunks_of(&conn, note_id)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|(id, c)| (id, embed_input(&title, &c.heading, &c.text)))
            .collect()
    };
    // ---- 解锁 ----

    for batch in pending.chunks(EMBED_BATCH) {
        let inputs: Vec<String> = batch.iter().map(|(_, text)| text.clone()).collect();
        let request = provider::embed_request(cfg, &inputs).map_err(|e| e.to_string())?;

        // ---- 无锁：发请求 ----
        let body = http::post(&request, &cfg.api_key)?;
        let vectors = provider::parse_embed_response(cfg.provider, &body)
            .map_err(|e| e.to_string())?;
        check_count(batch.len(), vectors.len())?;

        // ---- 锁：写回向量并同步内存索引 ----
        let conn = state.conn.lock().expect("数据库连接锁已中毒");
        for ((chunk_id, _), raw) in batch.iter().zip(&vectors) {
            index::write_embedding(&conn, *chunk_id, &cfg.embed_model, raw)
                .map_err(|e| e.to_string())?;
        }
        drop(conn);
        // ---- 解锁 ----

        let mut slot = state.ai.index.lock().expect("向量索引锁已中毒");
        if let Some(memory) = slot.as_mut() {
            for ((chunk_id, _), raw) in batch.iter().zip(&vectors) {
                let mut v = raw.clone();
                meshmind_core::ai::vector::normalize(&mut v);
                memory.upsert(*chunk_id, v);
            }
        }
    }

    let conn = state.conn.lock().expect("数据库连接锁已中毒");
    index::dequeue(&conn, note_id).map_err(|e| e.to_string())?;
    Ok(())
}

/// 喂给 embedding 的输入：标题与小标题拼在正文前面。
///
/// 一个块脱离了它的语境，向量表达的只是一段悬空的文字。补上这两行的成本是
/// 每块多几十个 token，换来的召回提升远超这个代价。
pub fn embed_input(title: &str, heading: &str, text: &str) -> String {
    if heading.is_empty() {
        format!("{title}\n{text}")
    } else {
        format!("{title}\n{heading}\n{text}")
    }
}

/// 返回条数与请求条数必须一致。按位置 zip 而不校验的话，
/// 少返回一条就会让**之后每一个块**的向量都错位——检索照样能跑，只是全都答非所问。
pub fn check_count(expected: usize, got: usize) -> Result<(), String> {
    if expected == got {
        Ok(())
    } else {
        Err(format!("AI 服务返回的向量条数不对：期望 {expected}，实际 {got}"))
    }
}

fn emit_progress<R: Runtime>(
    app: &AppHandle<R>,
    state: &tauri::State<'_, AppState>,
    cfg: &AiConfig,
) {
    let conn = state.conn.lock().expect("数据库连接锁已中毒");
    let pending = index::pending_count(&conn).unwrap_or(0);
    let indexed = index::indexed_chunk_count(&conn, &cfg.embed_model).unwrap_or(0);
    drop(conn);
    let _ = app.emit(PROGRESS_EVENT, Progress { pending, indexed });
}
```

**实现者注意**：上面 `process` 里「笔记已被删除」那一段的错误处理写得别扭（用空串 `String` 当哨兵）。请改写成清晰的形式——先单独查一次笔记是否存在，不存在就 `dequeue` 并 `return Ok(())`，再进入正常路径。保持锁的进出边界不变。

- [ ] **Step 3: 跑测试**

Run: `. "$HOME/.cargo/env" && cargo test -p meshmind ai::worker`
Expected: 全部 PASS。

- [ ] **Step 4: 人工核对锁的边界**

通读 `process`，逐个确认：每一处 `http::post` 调用的前后，数据库锁都不在作用域内。这一条没有自动化测试兜底，只能靠读。若发现某个 `conn` 的生命周期跨过了 HTTP 调用，用显式的作用域 `{}` 或 `drop(conn)` 切开。

- [ ] **Step 5: 提交**

```bash
git add crates/shell/src/ai/worker.rs
git commit -m "feat(shell): 后台向量化 worker"
```

---

### Task 14: 一次问答的编排

**Files:**
- Create: `crates/shell/src/ai/ask.rs`

**同样的锁纪律**：检索需要锁，发请求不需要。流式回答期间**绝不能持锁**——那会把整个应用卡住一整段回答的时长。

- [ ] **Step 1: 写失败的测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// 事件的序列化形状是前端契约的一部分。Rust 侧 serde 默认给外部标签
    /// （`{"Delta":{"text":"…"}}`），前端 `ipc.ts` 必须按同样的形状解析。
    /// 这条测试把它钉住——改了这里而不改前端，界面会安静地什么都不显示。
    #[test]
    fn ask_events_serialise_with_an_external_tag() {
        let json = serde_json::to_value(AskEvent::Delta { text: "甲".into() }).unwrap();
        assert_eq!(json["Delta"]["text"], "甲");

        let json = serde_json::to_value(AskEvent::Done { message_id: 7 }).unwrap();
        assert_eq!(json["Done"]["message_id"], 7);

        let json = serde_json::to_value(AskEvent::Cancelled).unwrap();
        assert_eq!(json, serde_json::json!("Cancelled"));
    }

    /// Retrieved 必须先于任何 Delta 发出——用户要在模型开口之前
    /// 就看见它读了哪些笔记。这是「可核验」这条产品主张的实现方式。
    #[test]
    fn retrieved_carries_the_citations() {
        let event = AskEvent::Retrieved { citations: vec![] };
        let json = serde_json::to_value(event).unwrap();
        assert!(json["Retrieved"]["citations"].is_array());
    }
}
```

- [ ] **Step 2: 实现**

```rust
//! 一次问答的完整编排：检索 → 组 prompt → 流式转发。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use meshmind_core::ai::prompt::{self, Citation};
use meshmind_core::ai::provider::{self, AiConfig, StreamDecoder};
use meshmind_core::ai::retrieve::{self, Retrieved};
use meshmind_core::ai::{chat, index};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime};

use crate::ai::{config, http};
use crate::state::AppState;

/// 推给前端的事件。
///
/// serde 的默认外部标签序列化成 `{"Delta":{"text":"…"}}`，
/// 前端 `ipc.ts` 按同样的形状解析。改这里必须同步改那边——
/// TS 编译器看不见 Rust，对不上只会表现为界面安静地什么都不显示。
#[derive(Debug, Clone, Serialize)]
pub enum AskEvent {
    Retrieved { citations: Vec<Citation> },
    Delta { text: String },
    Done { message_id: i64 },
    Failed { message: String },
    Cancelled,
}

/// 发起一次提问。**立刻返回**，实际工作在新线程上跑。
///
/// 不依赖 Tauri 对同步/异步命令的线程调度细节：自己起线程，
/// 行为在两个平台上都是确定的。
pub fn start<R: Runtime>(
    app: AppHandle<R>,
    conversation_id: i64,
    question: String,
    channel: Channel<AskEvent>,
) {
    let flag = {
        let state = app.state::<AppState>();
        state.ai.begin_ask()
    };
    std::thread::spawn(move || {
        let result = run(&app, conversation_id, &question, &channel, &flag);
        match result {
            Ok(()) => {}
            Err(message) if flag.load(Ordering::SeqCst) => {
                // 取消途中产生的错误（连接被主动断开）不是错误，别弹横幅。
                let _ = message;
                let _ = channel.send(AskEvent::Cancelled);
            }
            Err(message) => {
                let _ = channel.send(AskEvent::Failed { message });
            }
        }
    });
}

fn run<R: Runtime>(
    app: &AppHandle<R>,
    conversation_id: i64,
    question: &str,
    channel: &Channel<AskEvent>,
    flag: &Arc<AtomicBool>,
) -> Result<(), String> {
    let state = app.state::<AppState>();

    // ---- 锁：写下提问、读配置与历史 ----
    let (cfg, history) = {
        let conn = state.conn.lock().expect("数据库连接锁已中毒");
        let cfg = config::load(&conn);
        if let Some(field) = config::missing(&cfg) {
            return Err(format!("AI 未配置完整，缺少: {field}"));
        }
        // 提问先落库。就算之后失败或取消，界面上也该留下这条没被回答的提问，
        // 而不是让用户敲的字凭空消失。
        chat::append_user(&conn, conversation_id, question, meshmind_core::now_ms())
            .map_err(|e| e.to_string())?;
        let history = chat::history_for_prompt(&conn, conversation_id)
            .map_err(|e| e.to_string())?;
        // 去掉刚写进去的这一条：它就是当前问题，`prompt::build` 会单独放。
        let history = history[..history.len().saturating_sub(1)].to_vec();
        (cfg, history)
    };
    // ---- 解锁 ----

    let hits = retrieve_for(app, &cfg, question)?;
    if flag.load(Ordering::SeqCst) {
        let _ = channel.send(AskEvent::Cancelled);
        return Ok(());
    }

    let citations = prompt::citations(&hits);
    channel
        .send(AskEvent::Retrieved { citations: citations.clone() })
        .map_err(|e| e.to_string())?;

    let messages = prompt::build(question, &hits, &history);
    let request = provider::chat_request(&cfg, &messages, true).map_err(|e| e.to_string())?;

    let mut decoder = StreamDecoder::new(cfg.provider);
    let mut answer = String::new();

    // ---- 无锁：整段流式回答期间不持有任何锁 ----
    http::post_stream(&request, &cfg.api_key, |bytes| {
        if flag.load(Ordering::SeqCst) {
            return Ok(false); // 用户取消，断开连接
        }
        for delta in decoder.push(bytes).map_err(|e| e.to_string())? {
            answer.push_str(&delta);
            channel
                .send(AskEvent::Delta { text: delta })
                .map_err(|e| e.to_string())?;
        }
        Ok(!decoder.is_done())
    })?;

    if flag.load(Ordering::SeqCst) {
        let _ = channel.send(AskEvent::Cancelled);
        return Ok(());
    }

    // ---- 锁：落库 ----
    let message_id = {
        let conn = state.conn.lock().expect("数据库连接锁已中毒");
        chat::append_assistant(
            &conn,
            conversation_id,
            &answer,
            &citations,
            meshmind_core::now_ms(),
        )
        .map_err(|e| e.to_string())?
    };

    channel
        .send(AskEvent::Done { message_id })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 检索：把查询向量化，再跑一次混合检索。`ai_semantic_search` 也走这里。
pub fn retrieve_for<R: Runtime>(
    app: &AppHandle<R>,
    cfg: &AiConfig,
    query: &str,
) -> Result<Vec<Retrieved>, String> {
    let state = app.state::<AppState>();

    // ---- 无锁：把查询向量化 ----
    let request = provider::embed_request(cfg, &[query.to_string()])
        .map_err(|e| e.to_string())?;
    let body = http::post(&request, &cfg.api_key)?;
    let mut vectors =
        provider::parse_embed_response(cfg.provider, &body).map_err(|e| e.to_string())?;
    let query_vec = vectors.pop().unwrap_or_default();
    let mut query_vec = query_vec;
    meshmind_core::ai::vector::normalize(&mut query_vec);

    // ---- 锁：懒加载内存索引并检索 ----
    let conn = state.conn.lock().expect("数据库连接锁已中毒");
    let mut slot = state.ai.index.lock().expect("向量索引锁已中毒");
    // 懒加载：模型换了或还没装过就重新装。装载是一次全表扫描，
    // 但只在启用 AI 后的第一次检索发生。
    let stale = slot
        .as_ref()
        .is_none_or(|i| i.model() != cfg.embed_model || i.dim() != query_vec.len());
    if stale {
        *slot = Some(
            index::load_index(&conn, &cfg.embed_model, query_vec.len())
                .map_err(|e| e.to_string())?,
        );
    }
    let hits = retrieve::hybrid(
        &conn,
        slot.as_ref(),
        query,
        Some(&query_vec),
        cfg.top_k,
    )
    .map_err(|e| e.to_string())?;
    Ok(hits)
}
```

**实现者注意**：`is_none_or` 需要较新的 Rust（1.82+）。若工具链不支持，改写成 `slot.as_ref().map_or(true, |i| ...)`。另外 `let query_vec = vectors.pop()...; let mut query_vec = query_vec;` 这两行请合并成一行 `let mut query_vec = vectors.pop().unwrap_or_default();`。

- [ ] **Step 3: 跑测试**

Run: `. "$HOME/.cargo/env" && cargo test -p meshmind ai::ask`
Expected: 全部 PASS。

- [ ] **Step 4: 提交**

```bash
git add crates/shell/src/ai/ask.rs
git commit -m "feat(shell): 问答编排与流式转发"
```

---

### Task 15: 命令层与注册

**Files:**
- Modify: `crates/shell/src/commands.rs`、`crates/shell/src/main.rs`
- Modify: `e2e/contract.spec.ts`（若它维护着一份命令白名单）

- [ ] **Step 1: 写失败的测试**

在 `crates/shell/src/commands.rs` 的 `mod tests` 里追加：

```rust
    /// 密钥绝不能经 IPC 回到前端。它只该有一条单向的写入路径。
    #[test]
    fn get_settings_never_returns_the_api_key() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::initialize(dir.path()).unwrap();
        {
            let conn = state.conn.lock().unwrap();
            meshmind_core::settings::set(&conn, crate::settings::KEY_AI_API_KEY, "sk-secret")
                .unwrap();
        }

        let map = {
            let conn = state.conn.lock().unwrap();
            super::redact_settings(meshmind_core::settings::get_all(&conn).unwrap())
        };

        assert!(!map.contains_key(crate::settings::KEY_AI_API_KEY));
        assert!(
            !map.values().any(|v| v.contains("sk-secret")),
            "密钥出现在了别的键的值里"
        );
        assert_eq!(
            map.get(crate::settings::KEY_AI_API_KEY_SET).map(String::as_str),
            Some("true")
        );
    }

    /// 没设过密钥时合成键是 "false"，不能缺席——前端要靠它决定
    /// 密钥输入框显示「未设置」还是「已设置（留空则不修改）」。
    #[test]
    fn the_synthesised_key_is_false_when_unset() {
        let map = super::redact_settings(std::collections::BTreeMap::new());
        assert_eq!(
            map.get(crate::settings::KEY_AI_API_KEY_SET).map(String::as_str),
            Some("false")
        );
    }

    /// 设成空串等同于未设置。
    #[test]
    fn an_empty_api_key_counts_as_unset() {
        let mut input = std::collections::BTreeMap::new();
        input.insert(crate::settings::KEY_AI_API_KEY.to_string(), String::new());
        let map = super::redact_settings(input);
        assert_eq!(
            map.get(crate::settings::KEY_AI_API_KEY_SET).map(String::as_str),
            Some("false")
        );
    }
```

- [ ] **Step 2: 实现命令**

在 `commands.rs` 里加：

```rust
/// 把设置项里的密钥换成一个「设没设过」的布尔。
///
/// 抽成自由函数是为了能直接单测——`get_settings` 本身要 `State`，
/// 而这里真正想钉住的是「密钥不出去」这条规则本身。
pub(crate) fn redact_settings(mut map: BTreeMap<String, String>) -> BTreeMap<String, String> {
    let has_key = map
        .remove(settings::KEY_AI_API_KEY)
        .is_some_and(|v| !v.trim().is_empty());
    map.insert(
        settings::KEY_AI_API_KEY_SET.into(),
        settings::write_bool(has_key).into(),
    );
    map
}
```

把现有的 `get_settings` 改成 `Ok(redact_settings(settings_map))`。

新增以下命令（每个都要 `#[tauri::command]`）：

| 命令 | 签名要点 |
|---|---|
| `ai_status` | 返回 `AiStatus { enabled, configured, missing_field, pending_notes, indexed_chunks, memory_bytes, dim_mismatches, last_error }` |
| `ai_enable(enabled: bool)` | 写 `ai.enabled`；置真时 `index::enqueue_all` + `worker::spawn` 并把发送端存进 `state.ai.wake`；置假时把 `wake` 与 `index` 都置 `None`（线程随通道断开自行退出，内存索引被释放）。返回 `{ pending_notes }` |
| `ai_test_connection` | 用当前配置发一次 `embed_request(["ping"])` 与一次非流式 `chat_request` 单轮问候，返回 `ConnectionReport { embed_ok, embed_dim, chat_ok, error }`。**错误必须经 `http::redact`** |
| `ai_reindex_all` | `index::clear_embeddings` + `index::enqueue_all`，把 `state.ai.index` 置 `None`，`wake_worker()` |
| `ai_retry_failed` | `index::retry_failed` + `wake_worker()` |
| `ai_ask(conversation_id, question, on_event: Channel<AskEvent>)` | 直接调 `ask::start`，立刻返回 `()` |
| `ai_cancel` | `state.ai.cancel_ask()` |
| `ai_semantic_search(query, limit)` | AI 未启用或未配置时返回**空数组而不是错误**（搜索框每敲一个键都会调它，弹错误横幅不可接受）；否则 `ask::retrieve_for` 后按 `note_id` 归并，同一篇取最高分那块的文本作摘要 |

命令层要新定义两个返回结构，都放在 `commands.rs` 里（它们是 IPC 的形状，不属于 core）：

```rust
#[derive(Serialize)]
pub struct AiStatus {
    pub enabled: bool,
    pub configured: bool,
    /// 配置不完整时缺的那一项的中文名，完整时为 None。
    pub missing_field: Option<&'static str>,
    pub pending_notes: i64,
    pub indexed_chunks: i64,
    pub memory_bytes: usize,
    pub dim_mismatches: usize,
    pub last_error: Option<String>,
}

/// 语义检索的结果按笔记归并后的形状。同一篇笔记可能命中多个块，
/// 列表里只出现一次，摘要取分数最高的那一块。
#[derive(Serialize)]
pub struct SemanticHit {
    pub note_id: i64,
    pub uuid: String,
    pub title: String,
    pub excerpt: String,
    pub score: f64,
}
```

`ConnectionReport` 同样定义在这里，字段见 spec §7.2。
| `ai_list_conversations(limit, offset)` / `ai_create_conversation` / `ai_get_messages(conversation_id)` / `ai_delete_conversation(id)` / `ai_rename_conversation(id, title)` | 直接转发到 `chat::*` |

`ai_enable` 置真时的顺序很重要：**先写 `ai.enabled` 再 spawn**。反过来的话 worker 第一轮醒来读到的还是 `false`，会白白等一个 tick。

- [ ] **Step 3: 注册**

`crates/shell/src/main.rs` 的 `generate_handler!` 里追加全部 13 个 `ai_*` 命令。

**这一步历史上出过事**：MVP 阶段有四个命令写完了却没注册，直到 Playwright 跑起来才发现。`e2e/contract.spec.ts` 现在会守住这条，但那是 Plan B 才跑得起来的——这里请**逐个对照上表核对一遍**，别漏。

- [ ] **Step 4: 跑测试与检查**

```bash
. "$HOME/.cargo/env"
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```
Expected: 全绿。

- [ ] **Step 5: 反证**

把 `get_settings` 改回直接返回原始 map，确认 `get_settings_never_returns_the_api_key` 变红；改回来。

- [ ] **Step 6: 提交**

```bash
git add crates/shell/src
git commit -m "feat(shell): AI 命令层与注册"
```

---

## 完成后

Plan A 的验收：

1. `cargo test` 全绿，`cargo clippy --all-targets -- -D warnings` 无告警。
2. `cargo build --release` 在 macOS 上通过（Windows 由 CI 验证）。
3. 全新数据库、不配置 AI：`chunks`、`chunk_embeddings` 为空，无网络请求，无额外线程。
4. 手工用 `sqlite3` 打开库确认 003 的六张表都在。

接着执行 `docs/superpowers/plans/2026-08-16-ai-b-ui.md`。
