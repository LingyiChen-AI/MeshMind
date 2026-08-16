//! 把 core 构造出来的请求真正发出去。**密钥脱敏在这里，也只在这里。**

use std::io::Read;
use std::time::Duration;

use meshmind_core::ai::provider::HttpRequest;

/// 非流式请求的总超时。embedding 一批 16 条在慢网络下确实可能接近一分钟。
pub const TIMEOUT: Duration = Duration::from_secs(60);
/// 流式请求的总超时。
///
/// 想要的其实是「两次读之间的最长间隔」：一个长回答本来就要写好几分钟，
/// 卡总时长会把正常的长答案砍掉，真正需要检测的是连接卡死——那表现为
/// 长时间读不出任何字节。但 `read_timeout` 只存在于异步的 ClientBuilder 上，
/// blocking 版没有这个旋钮，只能退而求其次用总超时，
/// 并把它放得足够宽，宽到正常的长回答撞不到。
pub const STREAM_TIMEOUT: Duration = Duration::from_secs(600);

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
        let end = tail.find(char::is_whitespace).unwrap_or(tail.len());
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

fn client(timeout: Duration) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(timeout)
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
    let client = client(TIMEOUT)?;
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
    let client = client(STREAM_TIMEOUT)?;
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
