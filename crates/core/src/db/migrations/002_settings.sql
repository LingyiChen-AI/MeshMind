-- 应用设置的键值存储。值一律是字符串，类型解释权在调用方。
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
