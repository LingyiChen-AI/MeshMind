//! 服务商适配：构造请求、解析响应、流式分帧。**本模块不发网络请求。**

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

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
        Self {
            role: "system".into(),
            content: content.into(),
        }
    }
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: "user".into(),
            content: content.into(),
        }
    }
    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: "assistant".into(),
            content: content.into(),
        }
    }
}

fn join(base: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
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
        Self {
            provider,
            buffer: Vec::new(),
            done: false,
        }
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
        req.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
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
        assert!(
            header(&req, "Authorization").is_none(),
            "Ollama 不需要鉴权头"
        );
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
            (
                Provider::Ollama,
                r#"{"data":[{"index":0,"embedding":[1.0]}]}"#,
            ),
            (Provider::OpenAi, "这不是 JSON"),
            (
                Provider::OpenAi,
                r#"{"data":[{"index":0,"embedding":"不是数组"}]}"#,
            ),
        ] {
            assert!(
                matches!(
                    parse_embed_response(provider, body),
                    Err(CoreError::AiProtocol(_))
                ),
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
        // 字面量里有汉字，只能写普通字符串再取字节：`b"…"` 不接受非 ASCII。
        let text = drain(
            &mut d,
            "data: {\"choices\":[{\"delta\":{\"content\":\"甲\"}}]}\n\
             data: {\"choices\":[{\"delta\":{\"content\":\"乙\"}}]}\n\
             data: [DONE]\n"
                .as_bytes(),
        );
        assert_eq!(text, "甲乙");
        assert!(d.is_done());
    }

    #[test]
    fn ollama_stream_decodes_deltas_and_stops_at_done_flag() {
        let mut d = StreamDecoder::new(Provider::Ollama);
        let text = drain(
            &mut d,
            "{\"message\":{\"content\":\"甲\"},\"done\":false}\n\
             {\"message\":{\"content\":\"乙\"},\"done\":true}\n"
                .as_bytes(),
        );
        assert_eq!(text, "甲乙");
        assert!(d.is_done());
    }

    /// **最容易漏的 bug**：一个 JSON 被 TCP 切在两个包中间。
    /// 解析器必须缓冲住残缺的一半，等下一段到了再一起处理。
    #[test]
    fn a_json_split_across_two_packets_is_reassembled() {
        let whole = "data: {\"choices\":[{\"delta\":{\"content\":\"完整\"}}]}\n".as_bytes();
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
            "\n: keep-alive\n\
             data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\
             data: {\"choices\":[{\"delta\":{\"content\":\"甲\"}}]}\n"
                .as_bytes(),
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
