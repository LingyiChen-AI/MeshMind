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
