pub mod db;
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
