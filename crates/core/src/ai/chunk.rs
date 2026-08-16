//! 把一篇笔记的 TipTap 文档切成适合向量化的块。
//!
//! 为什么不复用 `notes::tiptap::extract_text`：它把整篇文档拍平成一段文本，
//! 块边界和标题层级在那一步就丢了。而这两样恰恰是切块最需要的信息——
//! 边界决定在哪里断开，标题决定哪些内容属于同一个主题。

use serde_json::Value;

use crate::error::{CoreError, Result};

/// 贪心合并相邻块，直到再加一块就会超过它。
pub const TARGET_CHARS: usize = 500;
/// 单块超过它就按句末二次切分。
pub const MAX_CHARS: usize = 1000;
/// 每块前置上一块结尾的这么多字符，避免答案正好卡在块边界上被切断。
pub const OVERLAP_CHARS: usize = 100;
/// 短于它的尾块并回前一块，不单独成块。
pub const MIN_CHARS: usize = 20;

/// 句末标点。中英文都要认——笔记里两种混着写是常态。
const SENTENCE_ENDS: &[char] = &['。', '！', '？', '；', '.', '!', '?', ';'];

/// 这些节点在纯文本里各占一行。与 `notes::tiptap::BLOCK_TYPES` 保持一致，
/// 但这里是**切块边界**而不是换行符位置，语义不同，因此不共用常量。
const BLOCK_TYPES: &[&str] = &[
    "paragraph",
    "heading",
    "listItem",
    "taskItem",
    "blockquote",
    "codeBlock",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    /// 该块所属的最近标题；没有标题则为空串。
    pub heading: String,
    /// 块的正文，不含标题——标题另存一列，展示引用时给用户看干净的原文。
    pub text: String,
}

/// 文档树遍历产出的中间结果：一个块级节点的文本 + 它当时所处的标题。
struct Block {
    heading: String,
    text: String,
}

pub fn split(body_json: &str) -> Result<Vec<Chunk>> {
    let doc: Value =
        serde_json::from_str(body_json).map_err(|e| CoreError::InvalidContent(e.to_string()))?;
    let blocks = collect_blocks(&doc);
    Ok(assemble(blocks))
}

/// 深度优先走一遍文档树，每碰到一个块级节点就产出一条 `Block`。
/// 遇到 heading 节点时更新「当前标题」，它本身不产出块——标题文本会进
/// `heading` 列并参与 FTS 索引，不必在正文里再出现一次。
fn collect_blocks(doc: &Value) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut heading = String::new();
    walk(doc, &mut heading, &mut blocks);
    blocks
}

fn walk(node: &Value, heading: &mut String, blocks: &mut Vec<Block>) {
    let node_type = node.get("type").and_then(Value::as_str).unwrap_or("");

    if node_type == "heading" {
        *heading = inline_text(node).trim().to_string();
        return;
    }

    // listItem 内部还嵌着 paragraph，若先递归子节点会把同一段文字产出两次。
    // 因此块级节点在这里就把自己的全部行内文本收走，不再往下走。
    if BLOCK_TYPES.contains(&node_type) {
        let text = inline_text(node).trim().to_string();
        if !text.is_empty() {
            blocks.push(Block {
                heading: heading.clone(),
                text,
            });
        }
        return;
    }

    if let Some(children) = node.get("content").and_then(Value::as_array) {
        for child in children {
            walk(child, heading, blocks);
        }
    }
}

/// 收集一个节点下的全部文本（含所有后代）。
fn inline_text(node: &Value) -> String {
    let mut buffer = String::new();
    fn go(node: &Value, buffer: &mut String) {
        if let Some(text) = node.get("text").and_then(Value::as_str) {
            buffer.push_str(text);
        }
        if let Some(children) = node.get("content").and_then(Value::as_array) {
            for child in children {
                go(child, buffer);
            }
        }
    }
    go(node, &mut buffer);
    buffer
}

fn assemble(blocks: Vec<Block>) -> Vec<Chunk> {
    let mut chunks: Vec<Chunk> = Vec::new();

    for block in blocks {
        for piece in split_oversized(&block.text) {
            let can_merge = chunks.last().is_some_and(|last| {
                last.heading == block.heading
                    && count(&last.text) + 1 + count(&piece) <= TARGET_CHARS
            });
            if can_merge {
                let last = chunks.last_mut().expect("can_merge 已确认非空");
                last.text.push('\n');
                last.text.push_str(&piece);
            } else {
                chunks.push(Chunk {
                    heading: block.heading.clone(),
                    text: piece,
                });
            }
        }
    }

    merge_short_tails(&mut chunks);
    apply_overlap(&mut chunks);
    chunks
}

/// 超长块按句末切分。找不到句末标点就在 MAX_CHARS 处硬切——
/// 宁可切在半句上，也不能把一个 5000 字的块整个塞进 embedding 请求。
fn split_oversized(text: &str) -> Vec<String> {
    if count(text) <= MAX_CHARS {
        return vec![text.to_string()];
    }

    let chars: Vec<char> = text.chars().collect();
    let mut pieces = Vec::new();
    let mut start = 0;

    while start < chars.len() {
        let hard_end = (start + MAX_CHARS).min(chars.len());
        if hard_end == chars.len() {
            pieces.push(chars[start..].iter().collect());
            break;
        }
        // 从硬上限往回找最近的句末，但不能退过半——退太多会切出一堆碎块。
        let floor = start + MAX_CHARS / 2;
        let cut = (floor..hard_end)
            .rev()
            .find(|&i| SENTENCE_ENDS.contains(&chars[i]))
            .map(|i| i + 1)
            .unwrap_or(hard_end);
        pieces.push(chars[start..cut].iter().collect());
        start = cut;
    }

    pieces
}

/// 过短的尾块并回前一块。只在同标题内进行；跨标题的短块只能自己待着。
fn merge_short_tails(chunks: &mut Vec<Chunk>) {
    let mut i = 1;
    while i < chunks.len() {
        let too_short = count(&chunks[i].text) < MIN_CHARS;
        let same_heading = chunks[i].heading == chunks[i - 1].heading;
        if too_short && same_heading {
            let tail = chunks.remove(i);
            let prev = &mut chunks[i - 1];
            prev.text.push('\n');
            prev.text.push_str(&tail.text);
        } else {
            i += 1;
        }
    }
}

/// 给每一块前置上一块结尾的 `OVERLAP_CHARS` 个字符。
///
/// 必须先把原始文本快照下来再改：边遍历边改的话，第 n 块拿到的是第 n-1 块
/// **已经带了重叠**的文本，重叠会一路滚雪球。
fn apply_overlap(chunks: &mut [Chunk]) {
    let originals: Vec<String> = chunks.iter().map(|c| c.text.clone()).collect();
    for i in 1..chunks.len() {
        if chunks[i].heading != chunks[i - 1].heading {
            continue;
        }
        let prev = &originals[i - 1];
        let tail: String = {
            let chars: Vec<char> = prev.chars().collect();
            let from = chars.len().saturating_sub(OVERLAP_CHARS);
            chars[from..].iter().collect()
        };
        chunks[i].text = format!("{tail}{}", chunks[i].text);
    }
}

fn count(text: &str) -> usize {
    text.chars().count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn doc(nodes: Vec<serde_json::Value>) -> String {
        json!({ "type": "doc", "content": nodes }).to_string()
    }

    fn para(text: &str) -> serde_json::Value {
        json!({ "type": "paragraph", "content": [{ "type": "text", "text": text }] })
    }

    fn heading(text: &str) -> serde_json::Value {
        json!({
            "type": "heading",
            "attrs": { "level": 2 },
            "content": [{ "type": "text", "text": text }]
        })
    }

    /// 短的相邻段落合并成一块，不该一段一块——一段话单独喂给 embedding
    /// 往往短到没有语义，检索质量会明显变差。
    #[test]
    fn merges_adjacent_short_blocks() {
        let chunks = split(&doc(vec![para("第一段"), para("第二段"), para("第三段")])).unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].text, "第一段\n第二段\n第三段");
        assert_eq!(chunks[0].heading, "");
    }

    /// 跨标题绝不合并：一个块横跨两个主题，检索命中后给模型的上下文就是混的。
    #[test]
    fn never_merges_across_headings() {
        let chunks = split(&doc(vec![
            heading("甲"),
            para("甲的内容"),
            heading("乙"),
            para("乙的内容"),
        ]))
        .unwrap();
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].heading, "甲");
        assert_eq!(chunks[0].text, "甲的内容");
        assert_eq!(chunks[1].heading, "乙");
        assert_eq!(chunks[1].text, "乙的内容");
    }

    /// 合并到接近 TARGET_CHARS 就断开，不能无限长下去。
    #[test]
    fn stops_merging_at_target_chars() {
        let block = "甲".repeat(200);
        let chunks = split(&doc(vec![para(&block), para(&block), para(&block)])).unwrap();
        assert!(
            chunks.len() >= 2,
            "三个 200 字的段落不该挤进一块 500 字的 chunk"
        );
        for c in &chunks {
            assert!(
                c.text.chars().count() <= MAX_CHARS,
                "块长 {} 超过上限",
                c.text.chars().count()
            );
        }
    }

    /// 单个超长段落按句末二次切分，且切点必须在句号之后而不是硬切。
    #[test]
    fn splits_an_oversized_block_at_sentence_ends() {
        let sentence = "这是一句话。";
        let long = sentence.repeat(300); // 1800 字符，远超 MAX_CHARS
        let chunks = split(&doc(vec![para(&long)])).unwrap();
        assert!(chunks.len() > 1);
        for c in &chunks {
            assert!(c.text.chars().count() <= MAX_CHARS + OVERLAP_CHARS);
        }
        // 重新拼起来（去掉重叠）应当还是由完整句子组成，不该出现半句。
        assert!(
            chunks[0].text.ends_with('。'),
            "切点没有落在句末: {}",
            chunks[0].text
        );
    }

    /// 没有句末标点的超长块也必须能被切开，不能因为找不到切点就原样返回。
    #[test]
    fn splits_an_oversized_block_without_any_punctuation() {
        let long = "甲".repeat(2500);
        let chunks = split(&doc(vec![para(&long)])).unwrap();
        assert!(
            chunks.len() > 1,
            "找不到句末标点时必须硬切，否则超长块会整个喂给 API"
        );
        for c in &chunks {
            assert!(c.text.chars().count() <= MAX_CHARS + OVERLAP_CHARS);
        }
    }

    /// 重叠：后一块开头必须带上前一块结尾的字符，否则跨块的答案会被切断。
    #[test]
    fn later_chunks_carry_overlap_from_the_previous_one() {
        // 两段必须用不同的字：同一个字重复 800 遍的话，无论有没有重叠，
        // 后一块都以「前一块的尾巴」开头，这条断言就永远为真、测不出东西。
        let chunks = split(&doc(vec![para(&"甲".repeat(400)), para(&"乙".repeat(400))])).unwrap();
        assert!(chunks.len() >= 2);
        let tail: String = chunks[0]
            .text
            .chars()
            .rev()
            .take(OVERLAP_CHARS)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        assert!(
            chunks[1].text.starts_with(&tail),
            "第二块没有带上第一块结尾的 {OVERLAP_CHARS} 个字符"
        );
    }

    /// 重叠只在同一标题内发生：跨标题带过去就是把甲的内容塞进乙的块里。
    #[test]
    fn overlap_does_not_cross_headings() {
        let long = "甲".repeat(600);
        let chunks = split(&doc(vec![
            heading("A"),
            para(&long),
            heading("B"),
            para("乙"),
        ]))
        .unwrap();
        let first_of_b = chunks.iter().find(|c| c.heading == "B").unwrap();
        assert_eq!(first_of_b.text, "乙", "B 的第一块不该带上 A 的尾巴");
    }

    /// 过短的尾块并回前一块，不单独成块——20 个字的碎片单独向量化毫无意义。
    #[test]
    fn merges_a_too_short_tail_back() {
        let block = "甲".repeat(480);
        let chunks = split(&doc(vec![para(&block), para("短")])).unwrap();
        assert_eq!(chunks.len(), 1, "5 个字的尾巴该并回去");
        assert!(chunks[0].text.ends_with("短"));
    }

    #[test]
    fn empty_document_yields_no_chunks() {
        assert!(split(&doc(vec![])).unwrap().is_empty());
        assert!(split(&doc(vec![para("")])).unwrap().is_empty());
        assert!(split(&doc(vec![para("   ")])).unwrap().is_empty());
    }

    /// 长度按字符算，不能按字节：按字节切会把汉字劈成乱码。
    #[test]
    fn counts_characters_not_bytes() {
        // 300 个汉字是 900 字节。若按字节算，早在 MAX_CHARS 处就被切开了。
        let chunks = split(&doc(vec![para(&"甲".repeat(300))])).unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].text.chars().count(), 300);
        assert!(
            chunks[0].text.chars().all(|c| c == '甲'),
            "出现了被劈开的字符"
        );
    }

    #[test]
    fn invalid_json_is_an_invalid_content_error() {
        assert!(matches!(
            split("不是 JSON"),
            Err(CoreError::InvalidContent(_))
        ));
    }

    /// 列表项与代码块也算块级节点，不能因为类型没列全就被整段吞掉。
    #[test]
    fn handles_list_items_and_code_blocks() {
        let nodes = vec![
            json!({ "type": "bulletList", "content": [
                { "type": "listItem", "content": [para("条目一")] },
                { "type": "listItem", "content": [para("条目二")] }
            ]}),
            json!({ "type": "codeBlock", "content": [{ "type": "text", "text": "let x = 1;" }] }),
        ];
        let chunks = split(&doc(nodes)).unwrap();
        let all: String = chunks.iter().map(|c| c.text.as_str()).collect();
        assert!(all.contains("条目一") && all.contains("条目二") && all.contains("let x = 1;"));
    }
}
