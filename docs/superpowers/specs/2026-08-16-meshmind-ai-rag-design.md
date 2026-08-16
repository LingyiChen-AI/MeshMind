# MeshMind 可插拔 AI 与 Hybrid RAG 知识问答 设计

**日期**：2026-08-16
**状态**：已确认，待实现
**前置**：`2026-08-15-meshmind-mvp-design.md`（MVP）、`2026-08-16-meshmind-phase2-engineering-design.md`（工程债）

---

## 1. 目标

给 MeshMind 接上方案书 Phase 2 的能力：**配置任意模型服务 → 后台把笔记向量化 → 混合检索 → 侧边栏基于自己的笔记问答**。

核心约束来自方案书第二节「零依赖启动与可插拔 AI」：**不配置 AI 时，应用的行为与今天完全一致**——不联网、不占额外内存、不多起线程、不多建索引。AI 是一层可以整体摘掉的增强。

### 做

- AI 服务配置（OpenAI 兼容 / Ollama）与连通性自检
- 笔记切块、后台增量向量化、失败重试与进度可见
- Hybrid RAG 检索：块级 FTS5 粗筛 + 向量精筛 + RRF 重排
- 侧边栏问答：流式回答、强制附出处、点击引用跳转笔记
- 对话持久化，可回看历史会话
- 搜索面板增加「语义相关」分组

### 不做（留给后续子项目）

无限白板、双向链接与反链、知识图谱与实体抽取、AI 伴写（续写/润色）、图文理解（多模态）、OCR、云同步。

**为什么不做图文理解**：当前没有 OCR，图片内容根本进不了检索索引。先把文字链路跑通，多模态在有 OCR 之后才有支点。

---

## 2. 关键决策与理由

| 决策 | 选择 | 理由 |
|---|---|---|
| 服务商 | OpenAI 兼容 + Ollama 两个适配器 | 一套 OpenAI-compatible 协议覆盖 OpenAI / DeepSeek / Kimi / 智谱 / 通义 / SiliconFlow / LM Studio；Ollama 覆盖纯本地。Ollama 的 `/v1` 兼容层官方标注为实验性，因此走它的原生 `/api/embed` 与 `/api/chat` |
| 向量检索 | Rust 内存暴力点积 | 零新增构建风险（sqlite-vec 要把 C 扩展静态链进 bundled SQLite，Windows 交叉构建有真实风险，而 CI 两个平台都必须绿）。个人规模下 O(n) 点积完全够用。表结构预留好，日后换 sqlite-vec 不需要迁移数据 |
| HTTP 由谁发 | Rust（reqwest） | 密钥不进 webview；CSP 的 `connect-src` 不必为任意主机开口；重试与队列只有一处 |
| 服务商协议实现位置 | core 构造请求/解析响应（纯函数），shell 只负责发送 | 协议细节能用普通单测钉住，不需要起 mock HTTP server；也维持了「core 不碰网络」的既有分层 |
| 密钥存储 | SQLite `settings` 表明文 | 用户选择。见 §9 的取舍说明与缓解措施 |
| 回答边界 | 严格只答笔记，必附出处 | 知识库问答的价值全在可核验。检索不到就直说没有 |
| 对话 | 持久化到 SQLite | 问过的东西本身就是知识 |

---

## 3. 架构

### 3.1 分层

沿用既有纪律：`crates/core` 纯逻辑（只碰 SQLite，不碰网络、不碰时钟）；`crates/shell` 管副作用；`ui` 只经 `ipc.ts` 与后端对话。

AI 需要网络，因此把服务商适配拆成两半：

- **core** 负责「给我配置和输入，还我一个 `HttpRequest { method, url, headers, body }`」以及「给我一段响应文本，还我向量 / 增量 token」——全是纯函数。
- **shell** 负责把这个 `HttpRequest` 真的发出去，处理超时、网络错误、密钥脱敏。

### 3.2 模块

```
crates/core/src/ai/
  mod.rs        AiConfig / 公共类型 / 模块级文档
  provider.rs   OpenAI 与 Ollama 适配器：请求构建、响应解析、流式分帧（纯函数）
  chunk.rs      body_json → Vec<Chunk>（纯切分）
  index.rs      chunks / chunk_embeddings / embed_queue 的读写与队列操作
  vector.rs     归一化、点积、Top-K；内存向量索引结构
  retrieve.rs   块级 FTS5 粗筛 + 向量精筛 + RRF 融合
  prompt.rs     命中块 → system/user 消息（纯拼装）
  chat.rs       conversations / messages 持久化

crates/shell/src/ai/
  mod.rs        AiRuntime：内存索引 + 取消标志 + worker 句柄
  http.rs       执行 core 构造的请求；超时、错误映射、密钥脱敏
  worker.rs     后台向量化线程
  ask.rs        一次问答的编排：检索 → 组 prompt → 流式转发

ui/
  lib/ai.ts             纯逻辑：流式增量拼装、状态机、引用解析
  components/AiPanel.tsx      右侧问答栏
  components/AiSettings.tsx   设置面板里的 AI 一节
```

---

## 4. 数据模型（迁移 003）

```sql
-- 一篇笔记切成若干块。
CREATE TABLE chunks (
  id      INTEGER PRIMARY KEY,
  note_id INTEGER NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
  ord     INTEGER NOT NULL,   -- 块在笔记内的序号，从 0 起
  heading TEXT NOT NULL,      -- 该块所属的最近标题；没有则为空串
  text    TEXT NOT NULL,
  UNIQUE (note_id, ord)
);
CREATE INDEX idx_chunks_note ON chunks (note_id);

-- 向量与块一一对应。
CREATE TABLE chunk_embeddings (
  chunk_id INTEGER PRIMARY KEY REFERENCES chunks (id) ON DELETE CASCADE,
  model    TEXT NOT NULL,
  dim      INTEGER NOT NULL,
  vec      BLOB NOT NULL      -- 已归一化的 f32 小端序，长度 = dim * 4
);
CREATE INDEX idx_chunk_embeddings_model ON chunk_embeddings (model);

-- 待向量化队列。
CREATE TABLE embed_queue (
  note_id     INTEGER PRIMARY KEY REFERENCES notes (id) ON DELETE CASCADE,
  enqueued_at INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_try_at INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT
);

-- 块级字面索引。rowid 与 chunks.id 对齐，写法沿用 notes_fts。
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

CREATE TABLE messages (
  id              INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  role            TEXT NOT NULL,               -- 'user' | 'assistant'
  content         TEXT NOT NULL,
  citations       TEXT NOT NULL DEFAULT '[]',  -- JSON 数组，见 §6.3
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_messages_conversation ON messages (conversation_id, id);
```

### 4.1 设计说明

**块级 FTS 而不是复用 `notes_fts`。** 方案书要的粗筛粒度是「Top 20 块」。笔记级粗筛会把一整篇长笔记原样倒进上下文，既浪费 token 又稀释相关度。

**`heading` 单独一列，不混进 `text`。** 喂给 embedding 的输入是 `{笔记标题}\n{heading}\n{text}`——把块放回它的语境里能显著提升召回质量；但引用面板展示的是干净的 `text`，用户看到的就是自己写下的原文。

**向量归一化后再存。** 检索时点积即余弦，省掉每次除模长；也让内存索引可以是一块扁平的 `Vec<f32>`。

**换模型 = 整表作废。** `model` 列记录产生该向量的模型名。模型或维度变了，`ai_reindex_all` 清空 `chunk_embeddings` 并把所有笔记重新入队。**不做跨模型混用**——不同模型的向量空间不可比，混着算出来的相似度没有意义。

**`next_try_at` 而不是纯 `attempts`。** 退避需要一个绝对时间点，否则每次 tick 都会把失败项重试一遍。

**AI 关闭时这些表全为空。** 切块与建索引只在 AI 启用后发生；关闭 AI 不删数据（重新打开不必重跑），但 worker 不再工作。

---

## 5. 索引管线

### 5.1 切块

输入是 TipTap 的 `body_json`，复用 `notes::tiptap` 的遍历能力，但需要**按块保留边界**（现有 `extract_text` 会拍平成一整段文本）。因此 `chunk.rs` 自己走一遍文档树，产出 `Vec<Block { heading: String, text: String }>`，其中 `heading` 是遍历过程中记住的最近一个 `heading` 节点的文本。

合并规则：

| 常量 | 值 | 含义 |
|---|---|---|
| `TARGET_CHARS` | 500 | 贪心合并相邻块直到再加一块就会超过它 |
| `MAX_CHARS` | 1000 | 单块超过它就按句末（`。！？；\n` 与 `.!?;`）二次切分 |
| `OVERLAP_CHARS` | 100 | 每块前置上一块末尾的这么多字符 |
| `MIN_CHARS` | 20 | 短于它的尾块并回前一块，不单独成块 |

- 只有 `heading` 相同的相邻块才合并；跨标题必须断开（否则一个块会横跨两个主题）。
- 块永不跨笔记。
- 空白块丢弃。
- 字符计数按 `chars().count()`，不能按字节——会劈开汉字。

### 5.2 入队

`notes::create` / `notes::update` 成功后，在**同一事务内**写 `embed_queue`。放进事务是为了避免「笔记写成功但没入队」——那会留下一篇永远不被索引的笔记，而且无人察觉。

`notes::soft_delete` 不出队（笔记可能被恢复），检索时按 `deleted_at IS NULL` 过滤。`notes::purge` 靠外键级联清掉 chunks / embeddings / queue 行。

### 5.3 后台 worker

一个独立线程（不是 tokio 任务——shell 目前没有 async runtime，为此引入一个太重了；worker 用阻塞 reqwest + `std::sync::mpsc` 即可）。

唤醒条件：应用启动、有新笔记入队（通过 channel 通知）、每 30 秒 tick 一次。

每轮：

1. 读 `ai.enabled`；关闭则直接回去睡。
2. 从 `embed_queue` 取 `next_try_at <= now` 的前 `QUEUE_BATCH_NOTES = 4` 条。
3. 对每篇笔记：删旧 chunks（embeddings 随级联消失）→ 切块 → 写 `chunks` + `chunks_fts`。
4. 把这批笔记的所有块按 `EMBED_BATCH = 16` 分组调 embedding API。
5. 写 `chunk_embeddings`，同步 upsert 进内存索引。
6. 出队，发 `ai://index-progress` 事件。

失败处理：`attempts += 1`，记 `last_error`，`next_try_at = now + min(2^attempts, 300) * 1000`。`attempts >= 5` 后不再自动重试（`next_try_at = i64::MAX`），但保留在队列里带着错误信息，供设置面板展示与手动「重试全部」。

**首次启用 AI 时不静默开跑**：这件事拆成两个命令。确认框上的篇数来自 `ai_preview_index`——它是**只读**的，不写设置、不入队、不起线程；用户点了「继续」，前端才调 `ai_enable(true)` 真正置位 `ai.enabled`、全量入队并启动 worker。

分成两个命令不是为了对称：把篇数放进 `ai_enable` 的回执，用户看见确认框的那一刻 worker 已经在发 embedding 请求了，点「取消」也追不回那之前漏出去的钱。用户的 API 调用是要花钱的，不能偷偷烧。

### 5.4 内存向量索引

```rust
pub struct VectorIndex {
    model: String,
    dim: usize,
    ids: Vec<i64>,      // chunk_id
    data: Vec<f32>,     // 行主序，第 i 行是 data[i*dim .. (i+1)*dim]
}
```

- `load(conn, model)`：一次全量读入。
- `upsert(chunk_id, vec)` / `remove(chunk_id)`：`remove` 用 swap_remove（顺序无意义）。
- `top_k(query, k)`：逐行点积 + `BinaryHeap`，返回 `Vec<(chunk_id, f32)>`。
- `memory_bytes()`：`ids.len() * dim * 4`，直接暴露给设置面板。

维度不一致的行在 `load` 时跳过并计数（模型换了但没重建索引的残留），计数一并报给设置面板。

`shell` 把它放在 `AiRuntime` 的 `Mutex` 后面，**懒加载**：AI 没启用就永远不加载，内存占用为零。

**内存量级**：`块数 × 维度 × 4 字节`。3000 篇笔记约 2 万块，1536 维约 120MB。这个数字必须在设置面板里明示，不藏着。

---

## 6. 检索与问答

### 6.1 Hybrid 检索

`retrieve::hybrid(conn, index, query, query_vec, k) -> Vec<Retrieved>`：

1. **粗筛**：jieba 切查询词（复用 `search::query::literal_match`），在 `chunks_fts` 上按 `bm25(chunks_fts)` 升序取前 `FTS_TOP = 20`。
2. **精筛**：`index.top_k(query_vec, VEC_TOP = 20)`。
3. **融合**：RRF，`score(c) = Σ 1/(RRF_K + rank_i(c))`，`RRF_K = 60`（原论文取值）。两路都没命中的块不参与。
4. **过滤**：JOIN `notes` 去掉 `deleted_at IS NOT NULL` 的块。
5. 按 `score` 降序取前 `k`（默认 6，可由 `ai.top_k` 调）。

**退化路径**：`query_vec` 为 `None`（AI 未启用 / 没有向量）时跳过第 2 步，只走 FTS。这条路不报错，也让整个检索逻辑能在完全不联网的情况下测试。

返回 `Retrieved { chunk_id, note_id, uuid, title, heading, text, score, from_fts, from_vec }`。

### 6.2 Prompt 组装

`prompt::build(question, retrieved, history) -> Vec<Message>`：

- **system**：明确只依据给定片段作答；不足以回答时直说「笔记里没有找到相关内容」；不得用模型自身知识补充；引用时用 `[n]` 标注片段编号。
- **user**：编号片段列表（`[1] 《标题》 > 小标题\n正文`）+ 空行 + 问题原文。
- **history**：最近 `HISTORY_TURNS = 3` 轮对话（各取 user + assistant 的 content，不带 citations），放在 system 与当前 user 之间。超出的老消息不带——上下文预算优先给检索到的笔记。

### 6.3 一次问答

命令 `ai_ask(conversation_id, question, on_event: Channel<AskEvent>)`。

**命令本身立刻返回**，真正的工作跑在一个新起的 `std::thread` 上，通过 Channel 回推事件。不依赖 Tauri 对同步/异步命令的线程调度细节，行为在两个平台上都是确定的。

```rust
enum AskEvent {
    Retrieved { citations: Vec<Citation> },
    Delta { text: String },
    Done { message_id: i64 },
    Failed { message: String },
    Cancelled,
}

struct Citation {
    index: u32,        // 对应 prompt 里的 [n]
    note_id: i64,
    uuid: String,
    title: String,
    heading: String,
    excerpt: String,   // chunk.text 截断到 200 字符
}
```

`Retrieved` 先于任何 `Delta` 发出——用户在模型开口之前就能看见它读了哪些笔记。

流程：写入 user 消息 → 检索 → 发 `Retrieved` → 流式请求 → 每帧发 `Delta` → 结束时把完整回答 + citations 写入 assistant 消息 → 发 `Done`。

中途失败或取消：**不写 assistant 消息**（半截回答留在库里没有价值，还会污染后续 history）。已写入的 user 消息保留——界面上呈现为一条没有回答的提问，用户可以重问。

**并发**：同一时刻只允许一个提问在飞。`AiRuntime` 持有 `Mutex<Option<Arc<AtomicBool>>>`，新提问先把旧标志置 true。命令 `ai_cancel()` 做同样的事。取消发 `Cancelled` 而不是 `Failed`——用户自己按的，不该弹错误横幅，但前端仍需要一个明确的终止信号来收起「正在思考」状态。

### 6.4 流式分帧

两家协议不同，都在 `provider.rs` 里做纯函数解析：

- **OpenAI**：SSE。`data: {...}` 逐行，`data: [DONE]` 结束。
- **Ollama**：换行分隔的 JSON（NDJSON），每行一个对象，`"done": true` 结束。

解析器接口是「喂进一段字节，吐出零个或多个增量 + 是否结束」，内部维护未消费的缓冲区。**必须覆盖一个 JSON 被切在两个网络包中间的情况**——这是流式解析最常见也最容易漏的 bug。

### 6.5 语义搜索

命令 `ai_semantic_search(query, limit)`：跑一次 `retrieve::hybrid`，把块按 `note_id` 归并（同一篇取最高分的块作为摘要片段），返回 `Vec<SemanticHit { note_id, uuid, title, excerpt, score }>`。

搜索面板把它渲染成独立的「语义相关」分组。**不动现有的 `search_notes`**——那条路径已经测透，把改动的爆炸半径压到最小。AI 未启用时该命令返回空数组，面板不渲染这一组。

---

## 7. 配置

### 7.1 设置项

加入 `crates/shell/src/settings.rs` 的 `ALLOWED_KEYS` 白名单：

| 键 | 取值 | 默认 |
|---|---|---|
| `ai.enabled` | `"true"` / `"false"` | `false` |
| `ai.provider` | `"openai"` / `"ollama"` | `"openai"` |
| `ai.base_url` | 形如 `https://api.deepseek.com/v1` 或 `http://localhost:11434` | 空 |
| `ai.api_key` | 明文；provider 为 ollama 时可空 | 空 |
| `ai.chat_model` | 如 `deepseek-chat` / `qwen3` | 空 |
| `ai.embed_model` | 如 `text-embedding-3-small` / `nomic-embed-text` | 空 |
| `ai.top_k` | 喂给模型的块数 | `"6"` |

**`ai.api_key` 只写不读**：`get_settings` 命令把这个键从返回的 map 里剔除，改为注入 `ai.api_key_set`（`"true"` / `"false"`）。密钥因此不会顺着 IPC 进入 webview，也不会出现在任何前端日志或错误上报里。

设置面板对应地把密钥做成一个「更新密钥」输入框：留空即不改动，另配一个「清除密钥」按钮显式写空串。

### 7.2 连通性自检

命令 `ai_test_connection()`：用当前配置真跑一次极小的 embedding 调用与一次极小的非流式 chat 调用，返回

```rust
struct ConnectionReport {
    embed_ok: bool,
    embed_dim: Option<usize>,
    chat_ok: bool,
    error: Option<String>,   // 已脱敏
}
```

没有这个按钮，用户 Base URL 填错一个字符就只能靠猜。

### 7.3 模型变更

设置面板保存时，若 `ai.embed_model` 变了，提示「更换 embedding 模型需要重建全部索引（N 篇笔记）」，确认后调 `ai_reindex_all()`。

---

## 8. 命令清单

新增的 Tauri 命令（全部要加进 `main.rs` 的 `generate_handler!`，`e2e/contract.spec.ts` 会自动守住这一点）：

| 命令 | 作用 |
|---|---|
| `ai_status` | `{ enabled, configured, pendingNotes, indexedChunks, memoryBytes, lastError }`。`configured` 的定义：`ai.base_url`、`ai.chat_model`、`ai.embed_model` 三项均非空，且 provider 为 `openai` 时 `ai.api_key` 也非空 |
| `ai_preview_index` | 只读：返回 `{ pendingNotes }` = 「现在启用的话要索引多少篇笔记」。不写设置、不入队、不起线程。启用前的确认框专用（§5.3） |
| `ai_enable(enabled)` | 开关 AI，返回 `{ pendingNotes }`。置真时全量入队并启动 worker（**用户在确认框上点过「继续」之后才调**），置假时停止 worker 并释放内存索引 |
| `ai_test_connection` | §7.2 |
| `ai_reindex_all` | 清空 embeddings 并全量入队 |
| `ai_retry_failed` | 把退避到底的队列项重置 `attempts` 与 `next_try_at` |
| `ai_ask(conversationId, question, onEvent)` | §6.3 |
| `ai_cancel` | 取消在飞的提问 |
| `ai_semantic_search(query, limit)` | §6.5 |
| `ai_list_conversations(limit, offset)` | 会话列表 |
| `ai_create_conversation` | 新建会话 |
| `ai_get_messages(conversationId)` | 某会话的全部消息 |
| `ai_delete_conversation(id)` | 删会话（级联删消息） |
| `ai_rename_conversation(id, title)` | 重命名 |

会话标题默认取首个提问的前 30 字符。

---

## 9. 错误处理与安全

### 9.1 错误

`CoreError` 新增：

```rust
AiNotConfigured,                                  // 缺 base_url / model / key
AiProtocol(String),                               // 响应结构对不上
EmbeddingDimMismatch { expected: usize, got: usize },
ConversationNotFound(i64),
```

shell 侧把 reqwest 的超时、连接失败、非 2xx 状态映射成可读中文，格式为「AI 服务调用失败（<原因>）」。

**脱敏是硬要求**：任何错误信息、任何 `eprintln!`、任何事件载荷都不得包含 `Authorization` 头或 `ai.api_key` 的值。`http.rs` 里统一有一个 `redact()`，错误路径必须经过它。这条要有测试钉住。

超时：embedding 60 秒，非流式 chat 60 秒，流式 chat 用「两帧之间最长 60 秒」而不是总时长——长回答本来就慢，卡死总时长会砍掉正常的长答案。

### 9.2 密钥存明文的取舍

用户选择把密钥存进 SQLite。这意味着：**拷贝或同步 `meshmind.db` 文件的人同时拿到了可计费的凭证**。

缓解措施：
- 密钥不出 Rust 进程边界（§7.1）。
- 设置面板明示「密钥保存在本地数据库中，请勿分享该文件」。
- `docs/manual-verification.md` 增加一条：确认导出/备份数据库时用户知晓其中含密钥。

不做的：系统钥匙串。已评估，用户明确选择不引入。

### 9.3 隐私

- AI 默认关闭，任何网络请求都需要用户显式启用。
- 只有被检索命中的块会离开本机，不是整库。
- 设置面板明示「启用后，提问时命中的笔记片段会发送给你配置的模型服务」。

---

## 10. 依赖

`crates/shell` 新增：

```toml
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "json", "blocking"] }
```

**必须关掉 default-features 并用 rustls**：默认特性会拉 native-tls，在 Windows 上引入 OpenSSL 构建依赖，CI 会红。

用 `blocking` 而不是异步流：shell 里没有 async runtime，为 AI 单独引入一个太重。`reqwest::blocking::Response` 实现了 `std::io::Read`，边读边喂给 §6.4 的分帧器就是流式，不需要 `stream` 特性。

`crates/core` 不新增依赖——它只做纯计算与 SQLite，`serde_json` 已经在了。

---

## 11. 测试策略

本项目有过「测试假绿」的教训（删掉被测逻辑测试仍全绿）。以下每一条的验收标准都是：**把对应实现删掉或改坏，这条测试必须变红**。

### core

| 模块 | 测试点 |
|---|---|
| `chunk` | 相邻块合并到目标长度；跨 heading 不合并；超长块按句末拆分；重叠字符确实出现在下一块开头；尾块过短时并回前一块；空文档产出空 Vec；中文字符计数不劈字 |
| `vector` | 归一化后模长为 1；`top_k` 与朴素全排序逐位一致；`remove` 后该 id 不再出现且其余向量未错位；维度不符的行被跳过并计数；`memory_bytes` 随插入线性增长 |
| `retrieve` | RRF 常数生效（改 `RRF_K` 排序应变）；两路都命中的块排在只命中一路的前面；软删除的笔记的块被过滤；`query_vec` 为 None 时退化成纯 FTS 且不 panic；`k` 截断真的截断 |
| `provider` | OpenAI 与 Ollama 的 embedding 请求 JSON 形状（URL、Authorization 头、body 字段名）；两家的响应解析；chat 流式请求体带 `stream: true`；**SSE 与 NDJSON 的跨包分帧**（把一个 JSON 从中间劈成两段分两次喂进去）；`[DONE]` 与 `"done": true` 的终止识别；畸形响应返回 `AiProtocol` 而不是 panic |
| `prompt` | 片段编号从 1 起且与 citations 对齐；history 只取最近 N 轮；system 里含「找不到就直说」的约束 |
| `index` | 入队幂等（同一笔记两次入队只有一行）；退避时间随 attempts 增长；purge 笔记后 chunks/embeddings/queue 行都消失（级联） |
| `chat` | 消息按 id 顺序返回；删会话级联删消息；citations 的 JSON 往返无损 |

### shell

- `redact()` 覆盖 Authorization 头与裸密钥串。
- `get_settings` 的返回里**不包含** `ai.api_key`、且包含 `ai.api_key_set`。
- 新命令全部注册（`e2e/contract.spec.ts` 自动守）。

### e2e（Playwright + mock IPC）

- AI 未配置时面板显示引导，不发任何 `ai_ask`。
- 提问 → `Retrieved` 先到 → 多个 `Delta` 拼成完整回答 → `Done`。
- 点击引用条调用 `get_note` 并切换到那篇笔记。
- `Failed` 事件渲染成错误横幅且不留下半截助手消息。
- 取消按钮发出 `ai_cancel`；收到 `Cancelled` 后「正在思考」收起，且**不**弹错误横幅。
- 会话切换加载对应 `ai_get_messages`。

mock 侧要新增 `Channel` 的假实现——`ipc.ts` 里对 `Channel` 的用法必须与 `@tauri-apps/api` 2.11.x 的真实形状对齐（`onmessage` 回调 + `__TAURI_INTERNALS__.transformCallback`），否则测试全绿而应用是坏的。

### 迁移

- 停在 002 的老库升级后只跑 003，已有笔记与设置毫发无损。
- 003 是追加，001/002 内容未被改动。

---

## 12. 实现拆分

两份 plan，按序执行：

**Plan A — 索引与检索管线**（core + shell，无界面）
迁移 003 → `chunk` → `index` → `vector` → `provider` → `retrieve` → `prompt` → `chat` → shell 的 `http` / `worker` / `ask` → 命令注册。
交付物：全部 core 测试绿，`cargo test` 通过，命令可用但没有 UI。

**Plan B — 问答界面与设置**（ui + e2e）
`ipc.ts` 类型与 Channel 封装 → `lib/ai.ts` → `AiSettings` → `AiPanel` → 搜索面板的语义分组 → e2e 用例 → 手工验证清单更新。

拆分理由：A 的产物能被 Rust 单测完整验证，不依赖任何界面；B 全是前端，能用 mock IPC 独立测。两边的接口就是 §8 的命令清单。

---

## 13. 验收

1. 全新安装、不配置 AI：行为与今天完全一致，无网络请求，无额外线程，`chunks` 表为空。
2. 配置 DeepSeek（OpenAI 兼容）后启用：提示待索引笔记数，确认后进度条走完，设置面板显示已索引块数与内存占用。
3. 提问一个只有自己笔记里才有答案的问题：先看到引用，再看到流式回答，回答内容能在引用的笔记里找到，点击引用跳转正确。
4. 提问一个笔记里根本没有的问题：回答是「笔记里没有找到相关内容」，不是编造。
5. 拔网线提问：错误横幅可读，不留半截消息，重连后能继续。
6. 换 embedding 模型：提示重建，重建后检索仍正确。
7. 关闭 AI：面板回到引导态，搜索面板不再有语义分组，worker 停止。
8. macOS 与 Windows 的 CI 全绿，打包产物能起来。
