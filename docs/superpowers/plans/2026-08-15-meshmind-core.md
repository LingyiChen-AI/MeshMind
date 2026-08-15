# MeshMind Core 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 `meshmind-core` —— 一个不依赖 Tauri 的纯 Rust crate，提供 MeshMind MVP 的全部数据能力：SQLite 存储与迁移、笔记 CRUD、中文分词与拼音索引、FTS5 混合搜索、附件内容寻址与回收。

**Architecture:** 单个 library crate，模块按职责划分：`db`（连接与迁移）、`notes`（笔记与标签与 TipTap 解析）、`search`（分词、拼音、查询构建与执行）、`attachments`（内容寻址落盘与 GC）。所有公开函数接收 `&Connection` 或 `&mut Connection`，不持有全局状态，不读系统时钟（时间戳由调用方传入），因此全部可在内存 SQLite 上单元测试。Tauri 外壳（Plan 2）只是这个 crate 的调用方。

**Tech Stack:** Rust / rusqlite (bundled SQLite, FTS5) / jieba-rs / pinyin / sha2 / uuid v7 / serde_json / regex / imagesize / tempfile (dev)

---

## 与 spec 的一处偏离

spec 第 3、4 节把拼音做成 `notes_fts` 的两个普通列（`pinyin_full` / `pinyin_head`，unicode61 分词），按词空格分隔存储。该设计无法满足连写拼音查询：正文「知识图谱」存为 `zhishi tupu`，而用户输入的是 `zhishitupu`，token 级匹配必然落空。

本计划改为：拼音移入独立的 `notes_py` 表，使用 **FTS5 trigram 分词器**，存无空格拼接的全拼与首字母（`zhishitupu` / `zstp`）。trigram 支持任意子串匹配，连写、分写、局部片段（`tupu`）均可命中；短于 3 字符的查询 trigram 不支持，用 `LIKE` 兜底。中文字面检索仍在 `notes_fts` 用 jieba + 短语前缀，不变。

spec 文档已同步更新为该设计。

## 文件结构

```
Cargo.toml                              工作区定义
crates/core/Cargo.toml                  crate 清单与依赖
crates/core/src/lib.rs                  模块声明、公开 API 再导出、now_ms()
crates/core/src/error.rs                CoreError 与 Result 别名
crates/core/src/db.rs                   连接打开、PRAGMA 配置、迁移执行
crates/core/src/db/migrations/001_init.sql   初始 schema
crates/core/src/notes/mod.rs            笔记 CRUD、软删除、索引写入
crates/core/src/notes/tiptap.rs         TipTap JSON → 纯文本、标题推导
crates/core/src/notes/tags.rs           #标签 解析与关联表写入
crates/core/src/search/mod.rs           搜索执行与来源合并排序
crates/core/src/search/segment.rs       jieba 分词
crates/core/src/search/pinyin.rs        拼音索引生成与 ASCII 查询归一化
crates/core/src/search/query.rs         FTS5 MATCH 表达式构建
crates/core/src/attachments.rs          内容寻址落盘、去重、GC
crates/core/tests/common/mod.rs         测试夹具：建库并迁移
crates/core/tests/notes.rs              笔记 CRUD 集成测试
crates/core/tests/search.rs             搜索集成测试
crates/core/tests/attachments.rs        附件集成测试
```

纯函数（分词、拼音、TipTap 解析、标签解析、查询构建）用同文件内的 `#[cfg(test)] mod tests` 测；涉及数据库的走 `tests/` 集成测试，只能碰公开 API —— 这样模块边界是被测试强制的，不是靠自觉。

---

### Task 1: 工作区脚手架

**Files:**
- Create: `Cargo.toml`
- Create: `crates/core/Cargo.toml`
- Create: `crates/core/src/lib.rs`

- [ ] **Step 1: 安装 Rust 工具链**

本机尚未安装 Rust。执行：

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
rustc --version
```

Expected: 输出形如 `rustc 1.8x.x (...)`。后续所有 cargo 命令若提示 command not found，先跑一次 `source "$HOME/.cargo/env"`。

- [ ] **Step 2: 创建 crate**

```bash
cd /Users/chenhao/codes/myself/MeshMind
cargo new --lib crates/core --name meshmind-core
```

- [ ] **Step 3: 写工作区根清单**

`Cargo.toml`：

```toml
[workspace]
resolver = "2"
members = ["crates/core"]
```

- [ ] **Step 4: 添加依赖**

```bash
cd /Users/chenhao/codes/myself/MeshMind
cargo add -p meshmind-core rusqlite --features bundled
cargo add -p meshmind-core serde --features derive
cargo add -p meshmind-core serde_json thiserror jieba-rs pinyin sha2 regex imagesize
cargo add -p meshmind-core uuid --features v7
cargo add -p meshmind-core --dev tempfile
```

`rusqlite` 的 `bundled` 特性会编译内置 SQLite，首次构建约 1-2 分钟。

- [ ] **Step 5: 跑通测试回路**

```bash
cargo test -p meshmind-core
```

Expected: `test result: ok. 0 passed` 或默认生成的示例测试通过。若报错，先解决工具链问题再往下走。

- [ ] **Step 6: 提交**

```bash
git add Cargo.toml Cargo.lock crates/
git commit -m "chore: 初始化 meshmind-core crate 与工作区"
```

---

### Task 2: 错误类型

**Files:**
- Create: `crates/core/src/error.rs`
- Modify: `crates/core/src/lib.rs`

- [ ] **Step 1: 写失败的测试**

`crates/core/src/error.rs`：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_not_found_message_contains_id() {
        assert_eq!(CoreError::NoteNotFound(42).to_string(), "笔记不存在: 42");
    }

    #[test]
    fn invalid_content_message_contains_reason() {
        let e = CoreError::InvalidContent("expected value at line 1".into());
        assert_eq!(e.to_string(), "笔记内容无效: expected value at line 1");
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test -p meshmind-core`
Expected: 编译失败，`cannot find type CoreError in this scope`。

- [ ] **Step 3: 实现错误类型**

在 `crates/core/src/error.rs` 顶部（测试模块之前）写：

```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("数据库错误: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("文件系统错误: {0}")]
    Io(#[from] std::io::Error),

    #[error("数据库迁移在版本 {version} 失败: {source}")]
    Migration {
        version: i32,
        #[source]
        source: rusqlite::Error,
    },

    #[error("笔记不存在: {0}")]
    NoteNotFound(i64),

    #[error("附件不存在: {0}")]
    AttachmentNotFound(i64),

    #[error("笔记内容无效: {0}")]
    InvalidContent(String),
}

pub type Result<T> = std::result::Result<T, CoreError>;
```

`crates/core/src/lib.rs` 全文替换为：

```rust
pub mod error;

pub use error::{CoreError, Result};

/// 当前 Unix 毫秒时间戳。核心模块自身不读时钟，时间戳一律由调用方传入，
/// 这样所有涉及时间的行为都可在测试中固定。
pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("系统时间早于 UNIX 纪元")
        .as_millis() as i64
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test -p meshmind-core`
Expected: `test result: ok. 2 passed`

- [ ] **Step 5: 提交**

```bash
git add crates/core/src
git commit -m "feat(core): 定义 CoreError 错误类型"
```

---

### Task 3: 数据库连接与 FTS5 能力验证

这一步的核心目的是**尽早证伪**：如果 bundled SQLite 没编进 FTS5 或 trigram 分词器，整个搜索设计都要改，必须现在就撞上，而不是在 Task 13 才发现。

**Files:**
- Create: `crates/core/src/db.rs`
- Modify: `crates/core/src/lib.rs`

- [ ] **Step 1: 写失败的测试**

`crates/core/src/db.rs`：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_in_memory_database() {
        let conn = open_in_memory().unwrap();
        let one: i64 = conn.query_row("SELECT 1", [], |r| r.get(0)).unwrap();
        assert_eq!(one, 1);
    }

    #[test]
    fn sqlite_supports_fts5_with_unicode61() {
        let conn = open_in_memory().unwrap();
        conn.execute_batch("CREATE VIRTUAL TABLE t USING fts5(a, tokenize='unicode61');")
            .expect("bundled SQLite 未启用 FTS5");
    }

    #[test]
    fn sqlite_supports_trigram_tokenizer() {
        let conn = open_in_memory().unwrap();
        conn.execute_batch("CREATE VIRTUAL TABLE p USING fts5(b, tokenize='trigram');")
            .expect("SQLite 版本过低，trigram 分词器需要 3.34+");
    }

    #[test]
    fn foreign_keys_are_enforced() {
        let conn = open_in_memory().unwrap();
        let enabled: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(enabled, 1);
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test -p meshmind-core`
Expected: 编译失败，`cannot find function open_in_memory`。

- [ ] **Step 3: 实现连接打开**

在 `crates/core/src/db.rs` 顶部写：

```rust
use std::path::Path;

use rusqlite::Connection;

use crate::error::Result;

/// 打开磁盘数据库，父目录不存在则创建。
pub fn open(path: &Path) -> Result<Connection> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let conn = Connection::open(path)?;
    configure(&conn)?;
    Ok(conn)
}

/// 打开内存数据库，仅供测试使用。
pub fn open_in_memory() -> Result<Connection> {
    let conn = Connection::open_in_memory()?;
    configure(&conn)?;
    Ok(conn)
}

fn configure(conn: &Connection) -> Result<()> {
    // journal_mode 会返回一行结果，必须用 execute_batch 而非 pragma_update。
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;",
    )?;
    Ok(())
}
```

`crates/core/src/lib.rs` 的模块声明改为：

```rust
pub mod db;
pub mod error;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test -p meshmind-core`
Expected: `test result: ok. 6 passed`

若 `sqlite_supports_fts5_with_unicode61` 失败（报 `no such module: fts5`），在 `crates/core/Cargo.toml` 把 rusqlite 的特性改为 `features = ["bundled-full"]` 后重跑。

- [ ] **Step 5: 提交**

```bash
git add crates/core/src
git commit -m "feat(core): SQLite 连接配置与 FTS5 能力验证"
```

---

### Task 4: 迁移框架与初始 schema

**Files:**
- Create: `crates/core/src/db/migrations/001_init.sql`
- Modify: `crates/core/src/db.rs`

- [ ] **Step 1: 写失败的测试**

在 `crates/core/src/db.rs` 的 `mod tests` 内追加：

```rust
    #[test]
    fn migrate_sets_user_version() {
        let conn = open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let version: i32 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, MIGRATIONS.len() as i32);
    }

    #[test]
    fn migrate_is_idempotent() {
        let conn = open_in_memory().unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).expect("重复迁移不应报错");
    }

    #[test]
    fn migrate_creates_all_tables() {
        let conn = open_in_memory().unwrap();
        migrate(&conn).unwrap();
        for table in [
            "notes", "tags", "note_tags", "attachments", "note_attachments", "notes_fts",
            "notes_py",
        ] {
            let count: i64 = conn
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE name = ?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "缺少表 {table}");
        }
    }
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test -p meshmind-core`
Expected: 编译失败，`cannot find function migrate`。

- [ ] **Step 3: 写初始 schema**

`crates/core/src/db/migrations/001_init.sql`：

```sql
CREATE TABLE notes (
  id         INTEGER PRIMARY KEY,
  uuid       TEXT NOT NULL UNIQUE,
  title      TEXT NOT NULL,
  body_json  TEXT NOT NULL,
  body_text  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX idx_notes_active_updated ON notes (deleted_at, updated_at DESC);

CREATE TABLE tags (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE note_tags (
  note_id INTEGER NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  PRIMARY KEY (note_id, tag_id)
);

CREATE TABLE attachments (
  id         INTEGER PRIMARY KEY,
  sha256     TEXT NOT NULL UNIQUE,
  ext        TEXT NOT NULL,
  byte_size  INTEGER NOT NULL,
  width      INTEGER,
  height     INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE note_attachments (
  note_id       INTEGER NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
  attachment_id INTEGER NOT NULL REFERENCES attachments (id) ON DELETE CASCADE,
  PRIMARY KEY (note_id, attachment_id)
);

-- 字面检索：存 jieba 切分后空格分隔的词序列，rowid 与 notes.id 对齐。
CREATE VIRTUAL TABLE notes_fts USING fts5(
  title_seg,
  body_seg,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- 拼音检索：存无空格拼接的全拼与首字母，trigram 支持任意子串匹配。
CREATE VIRTUAL TABLE notes_py USING fts5(
  py_full,
  py_head,
  tokenize = 'trigram'
);
```

- [ ] **Step 4: 实现迁移执行**

在 `crates/core/src/db.rs` 的 `configure` 之后追加：

```rust
use crate::error::CoreError;

/// 迁移脚本按序号排列，下标 + 1 即为该脚本对应的 user_version。
/// 新增迁移只能往数组末尾追加，永不修改已发布的脚本。
const MIGRATIONS: &[&str] = &[include_str!("db/migrations/001_init.sql")];

/// 执行所有尚未应用的迁移。已是最新版本时为空操作。
pub fn migrate(conn: &Connection) -> Result<()> {
    let current: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (index, sql) in MIGRATIONS.iter().enumerate() {
        let version = index as i32 + 1;
        if version <= current {
            continue;
        }
        conn.execute_batch(sql)
            .map_err(|source| CoreError::Migration { version, source })?;
        conn.pragma_update(None, "user_version", version)?;
    }
    Ok(())
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cargo test -p meshmind-core`
Expected: `test result: ok. 9 passed`

- [ ] **Step 6: 提交**

```bash
git add crates/core/src
git commit -m "feat(core): 数据库迁移框架与初始 schema"
```

---

### Task 5: 中文分词

**Files:**
- Create: `crates/core/src/search/mod.rs`
- Create: `crates/core/src/search/segment.rs`
- Modify: `crates/core/src/lib.rs`

- [ ] **Step 1: 写失败的测试**

`crates/core/src/search/segment.rs`：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_chinese_into_words() {
        assert_eq!(segment_tokens("我爱北京天安门"), vec!["我", "爱", "北京", "天安门"]);
    }

    #[test]
    fn keeps_multi_char_terms_intact() {
        let tokens = segment_tokens("知识图谱构建");
        assert!(tokens.contains(&"图谱".to_string()), "实际切分: {tokens:?}");
    }

    #[test]
    fn keeps_latin_words_as_tokens() {
        let tokens = segment_tokens("使用 Tauri 构建应用");
        assert!(tokens.contains(&"Tauri".to_string()), "实际切分: {tokens:?}");
    }

    #[test]
    fn drops_whitespace_only_tokens() {
        let tokens = segment_tokens("北京   天安门");
        assert!(tokens.iter().all(|t| !t.trim().is_empty()), "实际切分: {tokens:?}");
    }

    #[test]
    fn empty_input_yields_no_tokens() {
        assert!(segment_tokens("").is_empty());
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test -p meshmind-core`
Expected: 编译失败，`cannot find function segment_tokens`。

- [ ] **Step 3: 实现分词**

在 `crates/core/src/search/segment.rs` 顶部写：

```rust
use std::sync::OnceLock;

use jieba_rs::Jieba;

/// jieba 加载词典有成本，全进程只初始化一次。
fn jieba() -> &'static Jieba {
    static INSTANCE: OnceLock<Jieba> = OnceLock::new();
    INSTANCE.get_or_init(Jieba::new)
}

/// 切词。hmm=true 让未登录词也能被切出来（新技术名词很多不在词典里）。
pub fn segment_tokens(text: &str) -> Vec<String> {
    jieba()
        .cut(text, true)
        .into_iter()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
}

/// 切词并以单空格拼接，用于写入 FTS5 影子列。
pub fn segment(text: &str) -> String {
    segment_tokens(text).join(" ")
}
```

`crates/core/src/search/mod.rs`：

```rust
pub mod segment;
```

`crates/core/src/lib.rs` 的模块声明改为：

```rust
pub mod db;
pub mod error;
pub mod search;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test -p meshmind-core`
Expected: `test result: ok. 14 passed`

若 `splits_chinese_into_words` 因 jieba 词典版本差异失败，按失败信息里打印的实际切分调整期望值 —— 需要守住的性质是「多字词不被拆散」，不是某个特定词典版本的输出。

- [ ] **Step 5: 提交**

```bash
git add crates/core/src
git commit -m "feat(core): jieba 中文分词"
```

---

### Task 6: 拼音索引

**Files:**
- Create: `crates/core/src/search/pinyin.rs`
- Modify: `crates/core/src/search/mod.rs`

- [ ] **Step 1: 写失败的测试**

`crates/core/src/search/pinyin.rs`：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn builds_concatenated_full_and_head_pinyin() {
        let (full, head) = pinyin_index(&tokens(&["知识", "图谱"]));
        assert_eq!(full, "zhishitupu");
        assert_eq!(head, "zstp");
    }

    #[test]
    fn skips_tokens_containing_non_chinese() {
        let (full, head) = pinyin_index(&tokens(&["Tauri", "构建"]));
        assert_eq!(full, "goujian");
        assert_eq!(head, "gj");
    }

    #[test]
    fn empty_tokens_yield_empty_columns() {
        assert_eq!(pinyin_index(&[]), (String::new(), String::new()));
    }

    #[test]
    fn normalizes_ascii_query_by_stripping_separators() {
        assert_eq!(normalize_ascii_query("Zhi Shi-Tu_Pu"), "zhishitupu");
    }

    #[test]
    fn query_with_chinese_is_not_ascii() {
        assert!(!is_ascii_query("知识"));
        assert!(is_ascii_query("zstp"));
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test -p meshmind-core`
Expected: 编译失败，`cannot find function pinyin_index`。

- [ ] **Step 3: 实现拼音生成**

在 `crates/core/src/search/pinyin.rs` 顶部写：

```rust
use pinyin::ToPinyin;

/// 由分词结果生成两列拼音索引：全拼与首字母，均为无空格拼接。
///
/// 拼接而非空格分隔，是为了让用户连写的查询（zhishitupu）能被 trigram 子串命中。
/// 代价是跨词边界会产生无意义子串（zhishi + tupu 之间的 "shitu"），
/// 这点噪音换来的是连写查询可用，值得。
///
/// 含非汉字的词整词跳过 —— 英文已由字面列覆盖，混进拼音列只会制造假阳性。
pub fn pinyin_index(tokens: &[String]) -> (String, String) {
    let mut full = String::new();
    let mut head = String::new();
    for token in tokens {
        if let Some((token_full, token_head)) = token_pinyin(token) {
            full.push_str(&token_full);
            head.push_str(&token_head);
        }
    }
    (full, head)
}

fn token_pinyin(token: &str) -> Option<(String, String)> {
    let mut full = String::new();
    let mut head = String::new();
    let mut has_han = false;
    for maybe in token.to_pinyin() {
        let plain = maybe?.plain();
        full.push_str(plain);
        head.push(plain.chars().next()?);
        has_han = true;
    }
    has_han.then_some((full, head))
}

/// 归一化 ASCII 查询：转小写并丢弃所有非字母数字字符，
/// 使 "zhi shi tu pu"、"Zhi-Shi_Tu_Pu"、"zhishitupu" 归到同一形式。
pub fn normalize_ascii_query(query: &str) -> String {
    query
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .flat_map(char::to_lowercase)
        .collect()
}

/// 查询是否应该走拼音通道：不含任何非 ASCII 字符，且归一化后非空。
pub fn is_ascii_query(query: &str) -> bool {
    query.is_ascii() && !normalize_ascii_query(query).is_empty()
}
```

`crates/core/src/search/mod.rs` 改为：

```rust
pub mod pinyin;
pub mod segment;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test -p meshmind-core`
Expected: `test result: ok. 19 passed`

- [ ] **Step 5: 提交**

```bash
git add crates/core/src
git commit -m "feat(core): 拼音索引生成与 ASCII 查询归一化"
```

---

### Task 7: TipTap JSON 解析

**Files:**
- Create: `crates/core/src/notes/mod.rs`
- Create: `crates/core/src/notes/tiptap.rs`
- Modify: `crates/core/src/lib.rs`

- [ ] **Step 1: 写失败的测试**

`crates/core/src/notes/tiptap.rs`：

```rust
#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn sample() -> serde_json::Value {
        json!({
            "type": "doc",
            "content": [
                {"type": "heading", "attrs": {"level": 1},
                 "content": [{"type": "text", "text": "知识图谱"}]},
                {"type": "paragraph",
                 "content": [{"type": "text", "text": "第一段"},
                             {"type": "text", "text": "续写"}]},
                {"type": "image", "attrs": {"attachmentId": 7}}
            ]
        })
    }

    #[test]
    fn extracts_text_with_one_line_per_block() {
        assert_eq!(extract_text(&sample()), "知识图谱\n第一段续写");
    }

    #[test]
    fn derives_title_from_first_non_empty_line() {
        assert_eq!(derive_title("知识图谱\n第一段"), "知识图谱");
    }

    #[test]
    fn derives_empty_title_from_empty_text() {
        assert_eq!(derive_title("   \n  "), "");
    }

    #[test]
    fn truncates_long_title_without_splitting_chars() {
        let long = "标".repeat(200);
        assert_eq!(derive_title(&long).chars().count(), 120);
    }

    #[test]
    fn excerpt_skips_the_title_line() {
        assert_eq!(excerpt("知识图谱\n第一段\n第二段"), "第一段 第二段");
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test -p meshmind-core`
Expected: 编译失败，`cannot find function extract_text`。

- [ ] **Step 3: 实现解析**

在 `crates/core/src/notes/tiptap.rs` 顶部写：

```rust
use serde_json::Value;

/// 这些节点类型在纯文本里各占一行。其余节点（text、图片等行内节点）不换行。
const BLOCK_TYPES: &[&str] = &[
    "paragraph",
    "heading",
    "listItem",
    "taskItem",
    "blockquote",
    "codeBlock",
    "horizontalRule",
];

const TITLE_MAX_CHARS: usize = 120;
const EXCERPT_MAX_CHARS: usize = 200;

/// 从 TipTap 文档 JSON 抽取纯文本：每个块级节点一行，空行折叠掉。
pub fn extract_text(doc: &Value) -> String {
    let mut buffer = String::new();
    walk(doc, &mut buffer);
    buffer
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn walk(node: &Value, buffer: &mut String) {
    if let Some(text) = node.get("text").and_then(Value::as_str) {
        buffer.push_str(text);
    }
    if let Some(children) = node.get("content").and_then(Value::as_array) {
        for child in children {
            walk(child, buffer);
        }
    }
    let is_block = node
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|t| BLOCK_TYPES.contains(&t));
    if is_block {
        buffer.push('\n');
    }
}

/// 标题取正文首个非空行，按字符截断（不能按字节切，会劈开汉字）。
pub fn derive_title(body_text: &str) -> String {
    body_text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(TITLE_MAX_CHARS).collect())
        .unwrap_or_default()
}

/// 摘要取标题之后的正文，换行压成空格。
pub fn excerpt(body_text: &str) -> String {
    body_text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .skip(1)
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(EXCERPT_MAX_CHARS)
        .collect()
}
```

`crates/core/src/notes/mod.rs`：

```rust
pub mod tiptap;
```

`crates/core/src/lib.rs` 的模块声明改为：

```rust
pub mod db;
pub mod error;
pub mod notes;
pub mod search;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test -p meshmind-core`
Expected: `test result: ok. 24 passed`

- [ ] **Step 5: 提交**

```bash
git add crates/core/src
git commit -m "feat(core): TipTap JSON 纯文本抽取与标题推导"
```

---

### Task 8: 标签解析

**Files:**
- Create: `crates/core/src/notes/tags.rs`
- Modify: `crates/core/src/notes/mod.rs`

- [ ] **Step 1: 写失败的测试**

`crates/core/src/notes/tags.rs`：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_chinese_and_latin_tags() {
        assert_eq!(
            parse_tags("今天读了 #论文 和 #machine-learning"),
            vec!["论文", "machine-learning"]
        );
    }

    #[test]
    fn deduplicates_preserving_first_occurrence_order() {
        assert_eq!(parse_tags("#b #a #b"), vec!["b", "a"]);
    }

    #[test]
    fn lowercases_tags() {
        assert_eq!(parse_tags("#Rust #RUST"), vec!["rust"]);
    }

    #[test]
    fn ignores_hash_inside_words() {
        assert!(parse_tags("见 https://x.com/a#frag 与 C#").is_empty());
    }

    #[test]
    fn matches_tag_at_line_start() {
        assert_eq!(parse_tags("第一行\n#标签"), vec!["标签"]);
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test -p meshmind-core`
Expected: 编译失败，`cannot find function parse_tags`。

- [ ] **Step 3: 实现标签解析**

在 `crates/core/src/notes/tags.rs` 顶部写：

```rust
use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;
use rusqlite::{params, Transaction};

use crate::error::Result;

/// `#` 必须位于行首或空白之后，否则 URL 片段（#frag）和 C# 都会被误判成标签。
/// Rust 正则不支持后顾断言，所以把前导边界写进匹配再用捕获组取标签名。
fn tag_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"(?m)(?:^|\s)#([\p{L}\p{N}_-]+)").unwrap())
}

/// 从正文纯文本解析标签，统一小写，保留首次出现顺序并去重。
pub fn parse_tags(body_text: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    tag_pattern()
        .captures_iter(body_text)
        .map(|caps| caps[1].to_lowercase())
        .filter(|tag| seen.insert(tag.clone()))
        .collect()
}

/// 把标签写入 tags 并与笔记关联。已存在的标签复用同一行。
pub fn attach(tx: &Transaction, note_id: i64, names: &[String]) -> Result<()> {
    for name in names {
        tx.execute("INSERT OR IGNORE INTO tags (name) VALUES (?1)", params![name])?;
        let tag_id: i64 = tx.query_row("SELECT id FROM tags WHERE name = ?1", params![name], |row| {
            row.get(0)
        })?;
        tx.execute(
            "INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?1, ?2)",
            params![note_id, tag_id],
        )?;
    }
    Ok(())
}

/// 读取一篇笔记的标签，按名称排序保证输出稳定。
pub fn of_note(conn: &rusqlite::Connection, note_id: i64) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT t.name FROM tags t
         JOIN note_tags nt ON nt.tag_id = t.id
         WHERE nt.note_id = ?1
         ORDER BY t.name",
    )?;
    let names = stmt
        .query_map(params![note_id], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(names)
}
```

`crates/core/src/notes/mod.rs` 改为：

```rust
pub mod tags;
pub mod tiptap;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test -p meshmind-core`
Expected: `test result: ok. 29 passed`

- [ ] **Step 5: 提交**

```bash
git add crates/core/src
git commit -m "feat(core): #标签 解析与关联表写入"
```

---

### Task 9: 附件内容寻址与去重

**Files:**
- Create: `crates/core/src/attachments.rs`
- Create: `crates/core/tests/common/mod.rs`
- Create: `crates/core/tests/attachments.rs`
- Modify: `crates/core/src/lib.rs`

- [ ] **Step 1: 写测试夹具**

`crates/core/tests/common/mod.rs`：

```rust
// 每个集成测试二进制都会各自编译本文件，某个测试用不到的夹具会触发 dead_code 警告。
#![allow(dead_code)]

use meshmind_core::db;
use rusqlite::Connection;

/// 建一个迁移完毕的内存库。集成测试只走公开 API。
pub fn test_conn() -> Connection {
    let conn = db::open_in_memory().expect("打开内存库");
    db::migrate(&conn).expect("执行迁移");
    conn
}

/// 1x1 透明 PNG，用于验证图片尺寸解析。
pub const TINY_PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
    0x42, 0x60, 0x82,
];
```

- [ ] **Step 2: 写失败的测试**

`crates/core/tests/attachments.rs`：

```rust
mod common;

use meshmind_core::attachments;

use common::{test_conn, TINY_PNG};

#[test]
fn stores_file_under_sharded_content_addressed_path() {
    let dir = tempfile::tempdir().unwrap();
    let conn = test_conn();

    let stored = attachments::store(&conn, dir.path(), TINY_PNG, "png", 1_000).unwrap();

    let path = dir.path().join(attachments::relative_path(&stored.sha256, "png"));
    assert!(path.exists(), "附件文件未落盘: {path:?}");
    assert_eq!(
        path.parent().unwrap().file_name().unwrap().to_str().unwrap(),
        &stored.sha256[0..2],
        "未按 hash 前两位分片"
    );
}

#[test]
fn deduplicates_identical_content() {
    let dir = tempfile::tempdir().unwrap();
    let conn = test_conn();

    let first = attachments::store(&conn, dir.path(), TINY_PNG, "png", 1_000).unwrap();
    let second = attachments::store(&conn, dir.path(), TINY_PNG, "png", 2_000).unwrap();

    assert_eq!(first.id, second.id, "相同内容应复用同一条附件记录");
    let rows: i64 = conn
        .query_row("SELECT count(*) FROM attachments", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 1);
}

#[test]
fn parses_image_dimensions() {
    let dir = tempfile::tempdir().unwrap();
    let conn = test_conn();

    let stored = attachments::store(&conn, dir.path(), TINY_PNG, "png", 1_000).unwrap();

    assert_eq!(stored.width, Some(1));
    assert_eq!(stored.height, Some(1));
}

#[test]
fn stores_non_image_without_dimensions() {
    let dir = tempfile::tempdir().unwrap();
    let conn = test_conn();

    let stored = attachments::store(&conn, dir.path(), b"just text", "txt", 1_000).unwrap();

    assert_eq!(stored.width, None);
    assert_eq!(stored.byte_size, 9);
}
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cargo test -p meshmind-core --test attachments`
Expected: 编译失败，`unresolved import meshmind_core::attachments`。

- [ ] **Step 4: 实现附件模块**

`crates/core/src/attachments.rs`：

```rust
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::Result;

/// 派生 Serialize 是为了 Plan 2 的 Tauri 命令能直接把它返回给前端。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attachment {
    pub id: i64,
    pub sha256: String,
    pub ext: String,
    pub byte_size: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
}

/// 附件在附件根目录下的相对路径：按 hash 前两位分片，避免单目录堆几万个文件。
pub fn relative_path(sha256: &str, ext: &str) -> PathBuf {
    PathBuf::from(&sha256[0..2]).join(format!("{sha256}.{ext}"))
}

/// 落盘并登记一个附件。内容相同则复用已有记录，不重复写盘。
pub fn store(
    conn: &Connection,
    root: &Path,
    bytes: &[u8],
    ext: &str,
    now: i64,
) -> Result<Attachment> {
    let sha256 = format!("{:x}", Sha256::digest(bytes));
    if let Some(existing) = find_by_sha(conn, &sha256)? {
        return Ok(existing);
    }

    let (width, height) = match imagesize::blob_size(bytes) {
        Ok(size) => (Some(size.width as i64), Some(size.height as i64)),
        Err(_) => (None, None),
    };

    let path = root.join(relative_path(&sha256, ext));
    std::fs::create_dir_all(path.parent().expect("分片路径必有父目录"))?;
    std::fs::write(&path, bytes)?;

    let byte_size = bytes.len() as i64;
    conn.execute(
        "INSERT INTO attachments (sha256, ext, byte_size, width, height, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![sha256, ext, byte_size, width, height, now],
    )?;

    Ok(Attachment {
        id: conn.last_insert_rowid(),
        sha256,
        ext: ext.to_string(),
        byte_size,
        width,
        height,
    })
}

fn find_by_sha(conn: &Connection, sha256: &str) -> Result<Option<Attachment>> {
    let found = conn
        .query_row(
            "SELECT id, sha256, ext, byte_size, width, height FROM attachments WHERE sha256 = ?1",
            params![sha256],
            row_to_attachment,
        )
        .optional()?;
    Ok(found)
}

/// 按 id 取附件，供外壳解析出文件路径用。
pub fn get(conn: &Connection, id: i64) -> Result<Option<Attachment>> {
    let found = conn
        .query_row(
            "SELECT id, sha256, ext, byte_size, width, height FROM attachments WHERE id = ?1",
            params![id],
            row_to_attachment,
        )
        .optional()?;
    Ok(found)
}

fn row_to_attachment(row: &rusqlite::Row) -> rusqlite::Result<Attachment> {
    Ok(Attachment {
        id: row.get(0)?,
        sha256: row.get(1)?,
        ext: row.get(2)?,
        byte_size: row.get(3)?,
        width: row.get(4)?,
        height: row.get(5)?,
    })
}
```

`crates/core/src/lib.rs` 的模块声明改为：

```rust
pub mod attachments;
pub mod db;
pub mod error;
pub mod notes;
pub mod search;
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cargo test -p meshmind-core`
Expected: 全部通过，其中 `attachments` 测试 4 个。

- [ ] **Step 6: 提交**

```bash
git add crates/core/src crates/core/tests
git commit -m "feat(core): 附件内容寻址落盘与去重"
```

---

### Task 10: 笔记创建与索引写入

**Files:**
- Modify: `crates/core/src/notes/mod.rs`
- Create: `crates/core/tests/notes.rs`

- [ ] **Step 1: 写失败的测试**

`crates/core/tests/notes.rs`：

```rust
mod common;

use meshmind_core::notes::{self, NewNote};

use common::{test_conn, TINY_PNG};

fn doc(text: &str) -> String {
    serde_json::json!({
        "type": "doc",
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}]
    })
    .to_string()
}

#[test]
fn creates_note_with_derived_title_and_text() {
    let mut conn = test_conn();

    let note = notes::create(&mut conn, &NewNote { body_json: doc("知识图谱构建"), attachment_ids: vec![] }, 1_000)
        .unwrap();

    assert_eq!(note.title, "知识图谱构建");
    assert_eq!(note.body_text, "知识图谱构建");
    assert_eq!(note.created_at, 1_000);
    assert!(!note.uuid.is_empty());
}

#[test]
fn creates_note_with_parsed_tags() {
    let mut conn = test_conn();

    let note = notes::create(&mut conn, &NewNote { body_json: doc("读了 #论文 #Rust"), attachment_ids: vec![] }, 1_000)
        .unwrap();

    assert_eq!(note.tags, vec!["rust".to_string(), "论文".to_string()]);
}

#[test]
fn writes_both_index_tables() {
    let mut conn = test_conn();

    let note = notes::create(&mut conn, &NewNote { body_json: doc("知识图谱"), attachment_ids: vec![] }, 1_000)
        .unwrap();

    let fts: i64 = conn
        .query_row("SELECT count(*) FROM notes_fts WHERE rowid = ?1", [note.id], |r| r.get(0))
        .unwrap();
    let py: String = conn
        .query_row("SELECT py_full FROM notes_py WHERE rowid = ?1", [note.id], |r| r.get(0))
        .unwrap();

    assert_eq!(fts, 1);
    assert_eq!(py, "zhishitupu");
}

#[test]
fn links_attachments_to_note() {
    let dir = tempfile::tempdir().unwrap();
    let mut conn = test_conn();
    let file = meshmind_core::attachments::store(&conn, dir.path(), TINY_PNG, "png", 500).unwrap();

    let note = notes::create(
        &mut conn,
        &NewNote { body_json: doc("带图的笔记"), attachment_ids: vec![file.id] },
        1_000,
    )
    .unwrap();

    assert_eq!(note.attachment_ids, vec![file.id]);
}

#[test]
fn rolls_back_entirely_when_attachment_is_missing() {
    let mut conn = test_conn();

    let result = notes::create(
        &mut conn,
        &NewNote { body_json: doc("引用了不存在的附件"), attachment_ids: vec![999] },
        1_000,
    );

    assert!(result.is_err());
    let rows: i64 = conn.query_row("SELECT count(*) FROM notes", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 0, "事务失败后不应残留笔记行");
    let index_rows: i64 = conn.query_row("SELECT count(*) FROM notes_fts", [], |r| r.get(0)).unwrap();
    assert_eq!(index_rows, 0, "事务失败后不应残留索引行");
}

#[test]
fn rejects_invalid_json() {
    let mut conn = test_conn();

    let result = notes::create(
        &mut conn,
        &NewNote { body_json: "not json".into(), attachment_ids: vec![] },
        1_000,
    );

    assert!(result.is_err());
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test -p meshmind-core --test notes`
Expected: 编译失败，`cannot find function create in module notes`。

- [ ] **Step 3: 实现创建**

在 `crates/core/src/notes/mod.rs` 顶部写（保留末尾已有的 `pub mod` 声明）：

```rust
pub mod tags;
pub mod tiptap;

use rusqlite::{params, Connection, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::error::{CoreError, Result};
use crate::search::{pinyin, segment};

/// 新建笔记的输入。标题、纯文本、标签都由 body_json 推导，不重复接收。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewNote {
    pub body_json: String,
    pub attachment_ids: Vec<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Note {
    pub id: i64,
    pub uuid: String,
    pub title: String,
    pub body_json: String,
    pub body_text: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub tags: Vec<String>,
    pub attachment_ids: Vec<i64>,
}

/// 创建笔记。notes、两张索引表、标签、附件关联在同一事务内写入，
/// 任一环节失败则整体回滚，绝不留下有笔记没索引的中间态。
pub fn create(conn: &mut Connection, new: &NewNote, now: i64) -> Result<Note> {
    let doc: Value = serde_json::from_str(&new.body_json)
        .map_err(|e| CoreError::InvalidContent(e.to_string()))?;
    let body_text = tiptap::extract_text(&doc);
    let title = tiptap::derive_title(&body_text);
    let tag_names = tags::parse_tags(&body_text);
    let uuid = Uuid::now_v7().to_string();

    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO notes (uuid, title, body_json, body_text, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![uuid, title, new.body_json, body_text, now],
    )?;
    let id = tx.last_insert_rowid();
    write_index(&tx, id, &title, &body_text)?;
    tags::attach(&tx, id, &tag_names)?;
    link_attachments(&tx, id, &new.attachment_ids)?;
    tx.commit()?;

    let mut sorted_tags = tag_names;
    sorted_tags.sort();
    Ok(Note {
        id,
        uuid,
        title,
        body_json: new.body_json.clone(),
        body_text,
        created_at: now,
        updated_at: now,
        tags: sorted_tags,
        attachment_ids: new.attachment_ids.clone(),
    })
}

/// 写入两张索引表。rowid 与 notes.id 对齐，这样搜索能直接 JOIN 回 notes。
fn write_index(tx: &Transaction, id: i64, title: &str, body_text: &str) -> Result<()> {
    let title_tokens = segment::segment_tokens(title);
    let body_tokens = segment::segment_tokens(body_text);
    let (py_full, py_head) = pinyin::pinyin_index(&body_tokens);

    tx.execute(
        "INSERT INTO notes_fts (rowid, title_seg, body_seg) VALUES (?1, ?2, ?3)",
        params![id, title_tokens.join(" "), body_tokens.join(" ")],
    )?;
    tx.execute(
        "INSERT INTO notes_py (rowid, py_full, py_head) VALUES (?1, ?2, ?3)",
        params![id, py_full, py_head],
    )?;
    Ok(())
}

/// 索引行按 rowid 删除。FTS5 外部内容表不支持 UPDATE，改写一律先删后插。
fn delete_index(tx: &Transaction, id: i64) -> Result<()> {
    tx.execute("DELETE FROM notes_fts WHERE rowid = ?1", params![id])?;
    tx.execute("DELETE FROM notes_py WHERE rowid = ?1", params![id])?;
    Ok(())
}

fn link_attachments(tx: &Transaction, note_id: i64, attachment_ids: &[i64]) -> Result<()> {
    for attachment_id in attachment_ids {
        tx.execute(
            "INSERT OR IGNORE INTO note_attachments (note_id, attachment_id) VALUES (?1, ?2)",
            params![note_id, attachment_id],
        )?;
    }
    Ok(())
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test -p meshmind-core`
Expected: 全部通过。若 `rolls_back_entirely_when_attachment_is_missing` 失败，检查 `db::configure` 里 `PRAGMA foreign_keys = ON` 是否生效 —— 外键不开，脏引用就写得进去。

- [ ] **Step 5: 提交**

```bash
git add crates/core/src crates/core/tests
git commit -m "feat(core): 笔记创建与事务化索引写入"
```

---

### Task 11: 笔记读取、列表与更新

**Files:**
- Modify: `crates/core/src/notes/mod.rs`
- Modify: `crates/core/tests/notes.rs`

- [ ] **Step 1: 写失败的测试**

在 `crates/core/tests/notes.rs` 末尾追加：

```rust
#[test]
fn reads_back_a_created_note() {
    let mut conn = test_conn();
    let created = notes::create(&mut conn, &NewNote { body_json: doc("原文"), attachment_ids: vec![] }, 1_000).unwrap();

    let loaded = notes::get(&conn, created.id).unwrap();

    assert_eq!(loaded, created);
}

#[test]
fn get_returns_error_for_missing_note() {
    let conn = test_conn();
    assert!(notes::get(&conn, 999).is_err());
}

#[test]
fn lists_notes_newest_first() {
    let mut conn = test_conn();
    notes::create(&mut conn, &NewNote { body_json: doc("旧"), attachment_ids: vec![] }, 1_000).unwrap();
    notes::create(&mut conn, &NewNote { body_json: doc("新"), attachment_ids: vec![] }, 2_000).unwrap();

    let list = notes::list(&conn, 10, 0).unwrap();

    assert_eq!(list.len(), 2);
    assert_eq!(list[0].title, "新");
    assert_eq!(list[1].title, "旧");
}

#[test]
fn list_respects_limit_and_offset() {
    let mut conn = test_conn();
    for i in 0..3 {
        notes::create(&mut conn, &NewNote { body_json: doc(&format!("第{i}条")), attachment_ids: vec![] }, 1_000 + i).unwrap();
    }

    let page = notes::list(&conn, 1, 1).unwrap();

    assert_eq!(page.len(), 1);
    assert_eq!(page[0].title, "第1条");
}

#[test]
fn update_replaces_content_tags_and_index() {
    let mut conn = test_conn();
    let created = notes::create(&mut conn, &NewNote { body_json: doc("旧内容 #旧标签"), attachment_ids: vec![] }, 1_000).unwrap();

    let updated = notes::update(&mut conn, created.id, &doc("新内容 #新标签"), &[], 2_000).unwrap();

    assert_eq!(updated.title, "新内容 #新标签");
    assert_eq!(updated.tags, vec!["新标签".to_string()]);
    assert_eq!(updated.created_at, 1_000, "创建时间不应被改写");
    assert_eq!(updated.updated_at, 2_000);
    let index_rows: i64 = conn
        .query_row("SELECT count(*) FROM notes_fts WHERE rowid = ?1", [created.id], |r| r.get(0))
        .unwrap();
    assert_eq!(index_rows, 1, "更新后索引行应恰好一条，不能重复插入");
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test -p meshmind-core --test notes`
Expected: 编译失败，`cannot find function get in module notes`。

- [ ] **Step 3: 实现读取与更新**

在 `crates/core/src/notes/mod.rs` 末尾追加：

```rust
/// 列表项，只带渲染笔记流所需的字段，不搬运整份 body_json。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteSummary {
    pub id: i64,
    pub uuid: String,
    pub title: String,
    pub excerpt: String,
    pub updated_at: i64,
    pub tags: Vec<String>,
}

pub fn get(conn: &Connection, id: i64) -> Result<Note> {
    let mut note = conn
        .query_row(
            "SELECT id, uuid, title, body_json, body_text, created_at, updated_at
             FROM notes WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
            |row| {
                Ok(Note {
                    id: row.get(0)?,
                    uuid: row.get(1)?,
                    title: row.get(2)?,
                    body_json: row.get(3)?,
                    body_text: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                    tags: Vec::new(),
                    attachment_ids: Vec::new(),
                })
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => CoreError::NoteNotFound(id),
            other => CoreError::Db(other),
        })?;

    note.tags = tags::of_note(conn, id)?;
    note.attachment_ids = attachment_ids_of(conn, id)?;
    Ok(note)
}

fn attachment_ids_of(conn: &Connection, note_id: i64) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT attachment_id FROM note_attachments WHERE note_id = ?1 ORDER BY attachment_id",
    )?;
    let ids = stmt
        .query_map(params![note_id], |row| row.get::<_, i64>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(ids)
}

/// 按更新时间倒序列出未删除的笔记。
pub fn list(conn: &Connection, limit: u32, offset: u32) -> Result<Vec<NoteSummary>> {
    let mut stmt = conn.prepare(
        "SELECT id, uuid, title, body_text, updated_at
         FROM notes WHERE deleted_at IS NULL
         ORDER BY updated_at DESC, id DESC
         LIMIT ?1 OFFSET ?2",
    )?;
    let rows = stmt
        .query_map(params![limit, offset], |row| {
            let body_text: String = row.get(3)?;
            Ok(NoteSummary {
                id: row.get(0)?,
                uuid: row.get(1)?,
                title: row.get(2)?,
                excerpt: tiptap::excerpt(&body_text),
                updated_at: row.get(4)?,
                tags: Vec::new(),
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let mut summaries = rows;
    for summary in &mut summaries {
        summary.tags = tags::of_note(conn, summary.id)?;
    }
    Ok(summaries)
}

/// 全量替换笔记内容。标题、纯文本、标签、索引全部按新内容重算。
pub fn update(
    conn: &mut Connection,
    id: i64,
    body_json: &str,
    attachment_ids: &[i64],
    now: i64,
) -> Result<Note> {
    let doc: Value =
        serde_json::from_str(body_json).map_err(|e| CoreError::InvalidContent(e.to_string()))?;
    let body_text = tiptap::extract_text(&doc);
    let title = tiptap::derive_title(&body_text);
    let tag_names = tags::parse_tags(&body_text);

    let tx = conn.transaction()?;
    let changed = tx.execute(
        "UPDATE notes SET title = ?2, body_json = ?3, body_text = ?4, updated_at = ?5
         WHERE id = ?1 AND deleted_at IS NULL",
        params![id, title, body_json, body_text, now],
    )?;
    if changed == 0 {
        return Err(CoreError::NoteNotFound(id));
    }

    delete_index(&tx, id)?;
    write_index(&tx, id, &title, &body_text)?;
    tx.execute("DELETE FROM note_tags WHERE note_id = ?1", params![id])?;
    tags::attach(&tx, id, &tag_names)?;
    tx.execute("DELETE FROM note_attachments WHERE note_id = ?1", params![id])?;
    link_attachments(&tx, id, attachment_ids)?;
    tx.commit()?;

    get(conn, id)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test -p meshmind-core`
Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
git add crates/core/src crates/core/tests
git commit -m "feat(core): 笔记读取、分页列表与更新"
```

---

### Task 12: 软删除与恢复

**Files:**
- Modify: `crates/core/src/notes/mod.rs`
- Modify: `crates/core/tests/notes.rs`

- [ ] **Step 1: 写失败的测试**

在 `crates/core/tests/notes.rs` 末尾追加：

```rust
#[test]
fn soft_deleted_note_disappears_from_list_and_index() {
    let mut conn = test_conn();
    let note = notes::create(&mut conn, &NewNote { body_json: doc("待删除"), attachment_ids: vec![] }, 1_000).unwrap();

    notes::soft_delete(&mut conn, note.id, 2_000).unwrap();

    assert!(notes::list(&conn, 10, 0).unwrap().is_empty());
    assert!(notes::get(&conn, note.id).is_err());
    let index_rows: i64 = conn
        .query_row("SELECT count(*) FROM notes_fts WHERE rowid = ?1", [note.id], |r| r.get(0))
        .unwrap();
    assert_eq!(index_rows, 0, "删除后索引行必须一并剔除");
}

#[test]
fn deleted_note_is_listed_in_trash() {
    let mut conn = test_conn();
    let note = notes::create(&mut conn, &NewNote { body_json: doc("待删除"), attachment_ids: vec![] }, 1_000).unwrap();
    notes::soft_delete(&mut conn, note.id, 2_000).unwrap();

    let trash = notes::list_deleted(&conn, 10, 0).unwrap();

    assert_eq!(trash.len(), 1);
    assert_eq!(trash[0].id, note.id);
}

#[test]
fn restore_brings_back_note_and_index() {
    let mut conn = test_conn();
    let note = notes::create(&mut conn, &NewNote { body_json: doc("知识图谱"), attachment_ids: vec![] }, 1_000).unwrap();
    notes::soft_delete(&mut conn, note.id, 2_000).unwrap();

    notes::restore(&mut conn, note.id, 3_000).unwrap();

    assert_eq!(notes::list(&conn, 10, 0).unwrap().len(), 1);
    let index_rows: i64 = conn
        .query_row("SELECT count(*) FROM notes_fts WHERE rowid = ?1", [note.id], |r| r.get(0))
        .unwrap();
    assert_eq!(index_rows, 1, "恢复后索引行必须重建");
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test -p meshmind-core --test notes`
Expected: 编译失败，`cannot find function soft_delete`。

- [ ] **Step 3: 实现软删除**

在 `crates/core/src/notes/mod.rs` 末尾追加：

```rust
/// 软删除：置 deleted_at 并剔除索引行。笔记行与附件关联保留，供回收站恢复。
pub fn soft_delete(conn: &mut Connection, id: i64, now: i64) -> Result<()> {
    let tx = conn.transaction()?;
    let changed = tx.execute(
        "UPDATE notes SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
        params![id, now],
    )?;
    if changed == 0 {
        return Err(CoreError::NoteNotFound(id));
    }
    delete_index(&tx, id)?;
    tx.commit()?;
    Ok(())
}

/// 从回收站恢复：清 deleted_at 并按当前内容重建索引。
pub fn restore(conn: &mut Connection, id: i64, now: i64) -> Result<()> {
    let tx = conn.transaction()?;
    let row = tx
        .query_row(
            "SELECT title, body_text FROM notes WHERE id = ?1 AND deleted_at IS NOT NULL",
            params![id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => CoreError::NoteNotFound(id),
            other => CoreError::Db(other),
        })?;

    tx.execute(
        "UPDATE notes SET deleted_at = NULL, updated_at = ?2 WHERE id = ?1",
        params![id, now],
    )?;
    delete_index(&tx, id)?;
    write_index(&tx, id, &row.0, &row.1)?;
    tx.commit()?;
    Ok(())
}

/// 回收站列表，按删除时间倒序。
pub fn list_deleted(conn: &Connection, limit: u32, offset: u32) -> Result<Vec<NoteSummary>> {
    let mut stmt = conn.prepare(
        "SELECT id, uuid, title, body_text, updated_at
         FROM notes WHERE deleted_at IS NOT NULL
         ORDER BY deleted_at DESC, id DESC
         LIMIT ?1 OFFSET ?2",
    )?;
    let summaries = stmt
        .query_map(params![limit, offset], |row| {
            let body_text: String = row.get(3)?;
            Ok(NoteSummary {
                id: row.get(0)?,
                uuid: row.get(1)?,
                title: row.get(2)?,
                excerpt: tiptap::excerpt(&body_text),
                updated_at: row.get(4)?,
                tags: Vec::new(),
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(summaries)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test -p meshmind-core`
Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
git add crates/core/src crates/core/tests
git commit -m "feat(core): 笔记软删除、回收站与恢复"
```

---

### Task 13: 查询表达式构建

**Files:**
- Create: `crates/core/src/search/query.rs`
- Modify: `crates/core/src/search/mod.rs`

- [ ] **Step 1: 写失败的测试**

`crates/core/src/search/query.rs`：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_phrase_with_trailing_prefix_for_chinese() {
        // 末词带 * 前缀，使「知识图」能命中「知识图谱」。
        assert_eq!(literal_match("北京天安门").as_deref(), Some(r#""北京 天安门" *"#));
    }

    #[test]
    fn builds_prefix_match_for_latin() {
        assert_eq!(literal_match("Tauri").as_deref(), Some(r#""Tauri" *"#));
    }

    #[test]
    fn escapes_embedded_double_quotes() {
        assert_eq!(literal_match(r#"say "hi""#).as_deref(), Some(r#""say ""hi""" *"#));
    }

    #[test]
    fn returns_none_for_punctuation_only_query() {
        assert_eq!(literal_match("！！！"), None);
    }

    #[test]
    fn returns_none_for_empty_query() {
        assert_eq!(literal_match("   "), None);
    }

    #[test]
    fn builds_column_filtered_trigram_match() {
        assert_eq!(pinyin_match("py_full", "zhishitupu"), r#"{py_full} : "zhishitupu""#);
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test -p meshmind-core`
Expected: 编译失败，`cannot find function literal_match`。

- [ ] **Step 3: 实现查询构建**

在 `crates/core/src/search/query.rs` 顶部写：

```rust
use crate::search::segment;

/// 把用户查询转成 FTS5 字面列的 MATCH 表达式。
///
/// 形式是「短语 + 末词前缀」：`"北京 天安门" *`。用短语而非 AND 连接，
/// 是为了让「知识图」只命中相邻出现的「知识 图谱」，
/// 而不是命中一篇分别提到「知识」和「图」的无关笔记。
///
/// 查询里没有任何可检索字符时返回 None —— 调用方据此跳过这一路查询，
/// 而不是发一个空前缀出去（空前缀会匹配全部记录）。
pub fn literal_match(query: &str) -> Option<String> {
    let tokens: Vec<String> = segment::segment_tokens(query)
        .iter()
        .filter(|token| token.chars().any(char::is_alphanumeric))
        .map(|token| token.replace('"', "\"\""))
        .collect();
    if tokens.is_empty() {
        return None;
    }
    Some(format!("\"{}\" *", tokens.join(" ")))
}

/// 拼音列的 trigram MATCH 表达式，限定在单个列上以便区分命中来源。
/// 传入的 query 必须已经过 pinyin::normalize_ascii_query 归一化。
pub fn pinyin_match(column: &str, query: &str) -> String {
    format!("{{{column}}} : \"{query}\"")
}
```

`crates/core/src/search/mod.rs` 改为：

```rust
pub mod pinyin;
pub mod query;
pub mod segment;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test -p meshmind-core`
Expected: 全部通过。

若 `builds_phrase_with_trailing_prefix_for_chinese` 因分词差异失败，按失败信息调整期望的词序列 —— 要守住的是输出格式 `"词1 词2" *`。

- [ ] **Step 5: 提交**

```bash
git add crates/core/src
git commit -m "feat(core): FTS5 查询表达式构建"
```

---

### Task 14: 搜索执行与来源排序

**Files:**
- Modify: `crates/core/src/search/mod.rs`
- Create: `crates/core/tests/search.rs`

- [ ] **Step 1: 写失败的测试**

`crates/core/tests/search.rs`：

```rust
mod common;

use meshmind_core::notes::{self, NewNote};
use meshmind_core::search::{self, HitSource};

use common::test_conn;

fn doc(text: &str) -> String {
    serde_json::json!({
        "type": "doc",
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}]
    })
    .to_string()
}

fn seed(conn: &mut rusqlite::Connection, text: &str, now: i64) -> i64 {
    notes::create(conn, &NewNote { body_json: doc(text), attachment_ids: vec![] }, now)
        .unwrap()
        .id
}

#[test]
fn finds_note_by_chinese_prefix() {
    let mut conn = test_conn();
    let id = seed(&mut conn, "知识图谱构建方法", 1_000);

    let hits = search::search(&conn, "知识图", 10).unwrap();

    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].note_id, id);
    assert_eq!(hits[0].source, HitSource::Literal);
}

#[test]
fn does_not_match_words_that_are_merely_co_occurring() {
    let mut conn = test_conn();
    seed(&mut conn, "知识管理与图书检索", 1_000);

    let hits = search::search(&conn, "知识图", 10).unwrap();

    assert!(hits.is_empty(), "短语查询不应命中分散出现的词: {hits:?}");
}

#[test]
fn finds_note_by_concatenated_full_pinyin() {
    let mut conn = test_conn();
    let id = seed(&mut conn, "知识图谱", 1_000);

    let hits = search::search(&conn, "zhishitupu", 10).unwrap();

    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].note_id, id);
    assert_eq!(hits[0].source, HitSource::PinyinFull);
}

#[test]
fn finds_note_by_partial_pinyin() {
    let mut conn = test_conn();
    let id = seed(&mut conn, "知识图谱", 1_000);

    let hits = search::search(&conn, "tupu", 10).unwrap();

    assert_eq!(hits[0].note_id, id);
}

#[test]
fn finds_note_by_pinyin_initials() {
    let mut conn = test_conn();
    let id = seed(&mut conn, "知识图谱", 1_000);

    let hits = search::search(&conn, "zstp", 10).unwrap();

    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].note_id, id);
    assert_eq!(hits[0].source, HitSource::PinyinHead);
}

#[test]
fn finds_note_by_short_initials_via_like_fallback() {
    let mut conn = test_conn();
    let id = seed(&mut conn, "知识", 1_000);

    // "zs" 只有两个字符，短于 trigram 的三字符下限，走 LIKE 兜底。
    let hits = search::search(&conn, "zs", 10).unwrap();

    assert_eq!(hits[0].note_id, id);
}

#[test]
fn literal_hits_outrank_pinyin_hits() {
    let mut conn = test_conn();
    let pinyin_only = seed(&mut conn, "图谱", 1_000);
    let literal = seed(&mut conn, "tupu 是拼音", 2_000);

    let hits = search::search(&conn, "tupu", 10).unwrap();

    assert_eq!(hits[0].note_id, literal, "字面命中必须排在拼音命中之前");
    assert_eq!(hits[1].note_id, pinyin_only);
}

#[test]
fn deduplicates_a_note_matched_through_multiple_channels() {
    let mut conn = test_conn();
    seed(&mut conn, "tupu 图谱", 1_000);

    let hits = search::search(&conn, "tupu", 10).unwrap();

    assert_eq!(hits.len(), 1, "同一篇笔记不能因多路命中重复出现");
}

#[test]
fn excludes_deleted_notes() {
    let mut conn = test_conn();
    let id = seed(&mut conn, "知识图谱", 1_000);
    notes::soft_delete(&mut conn, id, 2_000).unwrap();

    assert!(search::search(&conn, "知识图", 10).unwrap().is_empty());
}

#[test]
fn returns_matched_terms_for_highlighting() {
    let mut conn = test_conn();
    seed(&mut conn, "北京天安门", 1_000);

    let hits = search::search(&conn, "北京", 10).unwrap();

    assert_eq!(hits[0].matched_terms, vec!["北京".to_string()]);
}

#[test]
fn empty_query_returns_nothing() {
    let mut conn = test_conn();
    seed(&mut conn, "知识图谱", 1_000);

    assert!(search::search(&conn, "   ", 10).unwrap().is_empty());
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test -p meshmind-core --test search`
Expected: 编译失败，`cannot find function search in module search`。

- [ ] **Step 3: 实现搜索执行**

在 `crates/core/src/search/mod.rs` 末尾追加（保留开头的 `pub mod` 声明）：

```rust
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::notes::tiptap;

/// trigram 分词器的最小可匹配长度。短于此值的查询退回 LIKE 扫描。
const TRIGRAM_MIN_CHARS: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HitSource {
    /// 命中原文字面（中文分词或英文单词）
    Literal,
    /// 命中全拼
    PinyinFull,
    /// 命中拼音首字母
    PinyinHead,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchHit {
    pub note_id: i64,
    pub uuid: String,
    pub title: String,
    pub excerpt: String,
    /// 命中的词，供前端在原文上自行高亮。
    /// 不用 FTS5 的 snippet()，它返回的是带空格的分词结果，显示出来是坏的。
    pub matched_terms: Vec<String>,
    pub source: HitSource,
}

/// 混合检索。三条通道依次执行，先到先得：字面 > 全拼 > 首字母。
/// 同一篇笔记被多路命中时只保留优先级最高的那次。
pub fn search(conn: &Connection, query: &str, limit: u32) -> Result<Vec<SearchHit>> {
    let mut hits: Vec<SearchHit> = Vec::new();
    let mut seen: std::collections::HashSet<i64> = std::collections::HashSet::new();

    let literal_terms = segment::segment_tokens(query);
    if let Some(expression) = query::literal_match(query) {
        let rows = match_notes_fts(conn, &expression, limit)?;
        push_hits(&mut hits, &mut seen, rows, HitSource::Literal, &literal_terms);
    }

    if pinyin::is_ascii_query(query) {
        let normalized = pinyin::normalize_ascii_query(query);
        let terms = vec![normalized.clone()];
        for (column, source) in [
            ("py_full", HitSource::PinyinFull),
            ("py_head", HitSource::PinyinHead),
        ] {
            let rows = match_notes_py(conn, column, &normalized, limit)?;
            push_hits(&mut hits, &mut seen, rows, source, &terms);
        }
    }

    hits.truncate(limit as usize);
    Ok(hits)
}

/// 一行原始结果：id、uuid、title、body_text。
type Row = (i64, String, String, String);

fn push_hits(
    hits: &mut Vec<SearchHit>,
    seen: &mut std::collections::HashSet<i64>,
    rows: Vec<Row>,
    source: HitSource,
    matched_terms: &[String],
) {
    for (note_id, uuid, title, body_text) in rows {
        if !seen.insert(note_id) {
            continue;
        }
        hits.push(SearchHit {
            note_id,
            uuid,
            title,
            excerpt: tiptap::excerpt(&body_text),
            matched_terms: matched_terms.to_vec(),
            source,
        });
    }
}

fn match_notes_fts(conn: &Connection, expression: &str, limit: u32) -> Result<Vec<Row>> {
    // bm25 的权重个数必须与 FTS 表列数一致：title_seg 权重高于 body_seg。
    // bm25 返回值越小越相关，故升序排列。
    let mut stmt = conn.prepare(
        "SELECT n.id, n.uuid, n.title, n.body_text
         FROM notes_fts f JOIN notes n ON n.id = f.rowid
         WHERE notes_fts MATCH ?1 AND n.deleted_at IS NULL
         ORDER BY bm25(notes_fts, 10.0, 1.0)
         LIMIT ?2",
    )?;
    collect_rows(&mut stmt, params![expression, limit])
}

fn match_notes_py(conn: &Connection, column: &str, query: &str, limit: u32) -> Result<Vec<Row>> {
    if query.chars().count() >= TRIGRAM_MIN_CHARS {
        let expression = query::pinyin_match(column, query);
        let mut stmt = conn.prepare(
            "SELECT n.id, n.uuid, n.title, n.body_text
             FROM notes_py p JOIN notes n ON n.id = p.rowid
             WHERE notes_py MATCH ?1 AND n.deleted_at IS NULL
             ORDER BY rank
             LIMIT ?2",
        )?;
        return collect_rows(&mut stmt, params![expression, limit]);
    }

    // 短查询走 LIKE。列名不能参数化，但它只来自本模块的常量，不含用户输入。
    let sql = format!(
        "SELECT n.id, n.uuid, n.title, n.body_text
         FROM notes_py p JOIN notes n ON n.id = p.rowid
         WHERE p.{column} LIKE ?1 AND n.deleted_at IS NULL
         ORDER BY n.updated_at DESC
         LIMIT ?2"
    );
    let mut stmt = conn.prepare(&sql)?;
    collect_rows(&mut stmt, params![format!("%{query}%"), limit])
}

fn collect_rows(stmt: &mut rusqlite::Statement, params: &[&dyn rusqlite::ToSql]) -> Result<Vec<Row>> {
    let rows = stmt
        .query_map(params, |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test -p meshmind-core`
Expected: 全部通过。

排查提示：若 `finds_note_by_concatenated_full_pinyin` 失败，先直接查库确认索引内容 —— `SELECT py_full FROM notes_py` 应为 `zhishitupu`。若 `literal_hits_outrank_pinyin_hits` 失败，检查 `search` 里三条通道的执行顺序，字面通道必须最先跑。

- [ ] **Step 5: 提交**

```bash
git add crates/core/src crates/core/tests
git commit -m "feat(core): 混合检索执行与命中来源排序"
```

---

### Task 15: 附件垃圾回收

**Files:**
- Modify: `crates/core/src/attachments.rs`
- Modify: `crates/core/tests/attachments.rs`

- [ ] **Step 1: 写失败的测试**

在 `crates/core/tests/attachments.rs` 末尾追加：

```rust
use meshmind_core::notes::{self, NewNote};

fn doc(text: &str) -> String {
    serde_json::json!({
        "type": "doc",
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}]
    })
    .to_string()
}

#[test]
fn collects_unreferenced_attachments() {
    let dir = tempfile::tempdir().unwrap();
    let conn = test_conn();
    let orphan = attachments::store(&conn, dir.path(), b"orphan bytes", "txt", 1_000).unwrap();
    let path = dir.path().join(attachments::relative_path(&orphan.sha256, "txt"));

    let removed = attachments::collect_garbage(&conn, dir.path()).unwrap();

    assert_eq!(removed, 1);
    assert!(!path.exists(), "孤儿文件应被删除");
    let rows: i64 = conn.query_row("SELECT count(*) FROM attachments", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 0);
}

#[test]
fn keeps_attachments_referenced_by_a_note() {
    let dir = tempfile::tempdir().unwrap();
    let mut conn = test_conn();
    let kept = attachments::store(&conn, dir.path(), TINY_PNG, "png", 1_000).unwrap();
    notes::create(
        &mut conn,
        &NewNote { body_json: doc("带图"), attachment_ids: vec![kept.id] },
        1_000,
    )
    .unwrap();

    let removed = attachments::collect_garbage(&conn, dir.path()).unwrap();

    assert_eq!(removed, 0);
    let path = dir.path().join(attachments::relative_path(&kept.sha256, "png"));
    assert!(path.exists(), "被引用的附件不能被回收");
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test -p meshmind-core --test attachments`
Expected: 编译失败，`cannot find function collect_garbage`。

- [ ] **Step 3: 实现 GC**

在 `crates/core/src/attachments.rs` 末尾追加：

```rust
/// 回收零引用附件：先删文件再删记录。
///
/// 顺序是刻意的 —— 文件删了记录还在，下次 GC 会重试；
/// 反过来记录没了文件还在，那个文件就永远没人知道该删了。
pub fn collect_garbage(conn: &Connection, root: &Path) -> Result<usize> {
    let mut stmt = conn.prepare(
        "SELECT id, sha256, ext FROM attachments a
         WHERE NOT EXISTS (SELECT 1 FROM note_attachments na WHERE na.attachment_id = a.id)",
    )?;
    let orphans = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);

    let mut removed = 0;
    for (id, sha256, ext) in orphans {
        let path = root.join(relative_path(&sha256, &ext));
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            // 文件已不在，记录照样该清。
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        conn.execute("DELETE FROM attachments WHERE id = ?1", params![id])?;
        removed += 1;
    }
    Ok(removed)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test -p meshmind-core`
Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
git add crates/core/src crates/core/tests
git commit -m "feat(core): 零引用附件垃圾回收"
```

---

### Task 16: 索引重建

spec 第 7 节要求提供「重建索引」入口，用于索引与 notes 不一致时从 `body_json` 全量重算。

**Files:**
- Modify: `crates/core/src/search/mod.rs`
- Modify: `crates/core/src/notes/mod.rs`
- Modify: `crates/core/tests/search.rs`

- [ ] **Step 1: 写失败的测试**

在 `crates/core/tests/search.rs` 末尾追加：

```rust
#[test]
fn rebuild_restores_a_wiped_index() {
    let mut conn = test_conn();
    let id = seed(&mut conn, "知识图谱", 1_000);
    conn.execute("DELETE FROM notes_fts", []).unwrap();
    conn.execute("DELETE FROM notes_py", []).unwrap();
    assert!(search::search(&conn, "知识图", 10).unwrap().is_empty());

    let rebuilt = notes::rebuild_index(&mut conn).unwrap();

    assert_eq!(rebuilt, 1);
    assert_eq!(search::search(&conn, "知识图", 10).unwrap()[0].note_id, id);
    assert_eq!(search::search(&conn, "zhishitupu", 10).unwrap()[0].note_id, id);
}

#[test]
fn rebuild_skips_deleted_notes() {
    let mut conn = test_conn();
    let id = seed(&mut conn, "已删除的笔记", 1_000);
    notes::soft_delete(&mut conn, id, 2_000).unwrap();

    let rebuilt = notes::rebuild_index(&mut conn).unwrap();

    assert_eq!(rebuilt, 0);
    let index_rows: i64 = conn
        .query_row("SELECT count(*) FROM notes_fts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(index_rows, 0);
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test -p meshmind-core --test search`
Expected: 编译失败，`cannot find function rebuild_index`。

- [ ] **Step 3: 实现重建**

在 `crates/core/src/notes/mod.rs` 末尾追加：

```rust
/// 全量重建两张索引表，返回重建的笔记条数。
/// 索引全部由 notes 派生，因此清空重算永远是安全的。
pub fn rebuild_index(conn: &mut Connection) -> Result<usize> {
    let rows: Vec<(i64, String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT id, title, body_text FROM notes WHERE deleted_at IS NULL ORDER BY id",
        )?;
        stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?
    };

    let tx = conn.transaction()?;
    tx.execute("DELETE FROM notes_fts", [])?;
    tx.execute("DELETE FROM notes_py", [])?;
    for (id, title, body_text) in &rows {
        write_index(&tx, *id, title, body_text)?;
    }
    tx.commit()?;
    Ok(rows.len())
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test -p meshmind-core`
Expected: 全部通过。

- [ ] **Step 5: 全量检查并提交**

```bash
cargo test -p meshmind-core
cargo clippy -p meshmind-core --all-targets -- -D warnings
cargo fmt --all -- --check
```

Expected: 测试全绿；clippy 无警告；fmt 无差异。若 fmt 报差异，跑 `cargo fmt --all` 后重新提交。

```bash
git add crates/core/src crates/core/tests
git commit -m "feat(core): 索引全量重建入口"
```

---

## 完成标准

Plan 1 完成时，以下全部成立：

- `cargo test -p meshmind-core` 全绿，覆盖笔记 CRUD、软删除与恢复、标签、附件去重与 GC、中文前缀检索、全拼与首字母检索、排序优先级、索引重建
- `cargo clippy --all-targets -- -D warnings` 无警告
- crate 不依赖 tauri，可在无 GUI 环境构建与测试
- 所有涉及时间的函数接收 `now: i64` 参数，无隐式时钟读取

Plan 2（Tauri 外壳 + React 前端 + 热键/托盘/打包/CI）在此基础上编写，届时 IPC 契约直接照搬本 crate 的公开签名。
