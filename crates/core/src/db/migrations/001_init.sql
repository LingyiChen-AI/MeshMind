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
