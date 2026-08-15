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
