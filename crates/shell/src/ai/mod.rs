//! 外壳侧的 AI：HTTP、后台向量化、问答编排。

// 发请求的入口要等后台 worker 与问答编排接上才会有调用者，在那之前
// dead_code 会把 `-D warnings` 的构建整个染红。两者落地后删掉这行。
#[allow(dead_code)]
pub mod http;
