//! 把检索到的块拼成喂给模型的消息序列。纯函数，不碰数据库也不碰网络。

use serde::{Deserialize, Serialize};

use crate::ai::provider::Message;
use crate::ai::retrieve::Retrieved;

/// 带进上下文的历史轮数。一轮 = 一问一答。
///
/// 取 3 是个取舍：多带能让「那它呢」这类指代成立，但每一轮都在挤占本该
/// 留给笔记片段的预算。指代问题在个人笔记问答里远没有「答得准」重要。
pub const HISTORY_TURNS: usize = 3;

/// 引用里回显的原文长度上限。
pub const EXCERPT_MAX_CHARS: usize = 200;

const SYSTEM: &str = "\
你是用户个人笔记库的问答助手。

规则：
1. 只依据下面提供的笔记片段回答，不要使用你自己的知识补充或推测。
2. 片段不足以回答时，直接说「笔记里没有找到相关内容」，不要编造。
3. 用到某个片段时，在相应句子末尾标注它的编号，形如 [1]、[2]。
4. 用简体中文回答，简洁直接。";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Citation {
    /// 与提示词里 `[n]` 的编号一致，从 1 起。
    pub index: u32,
    pub note_id: i64,
    pub uuid: String,
    pub title: String,
    pub heading: String,
    pub excerpt: String,
}

pub fn build(question: &str, hits: &[Retrieved], history: &[Message]) -> Vec<Message> {
    let mut messages = vec![Message::system(SYSTEM)];

    // 只带最近 HISTORY_TURNS 轮。history 是按时间升序的消息序列，
    // 从尾部倒着数 2N 条即可，不必真的去切分「轮」。
    let keep = HISTORY_TURNS * 2;
    let start = history.len().saturating_sub(keep);
    messages.extend_from_slice(&history[start..]);

    messages.push(Message::user(user_message(question, hits)));
    messages
}

fn user_message(question: &str, hits: &[Retrieved]) -> String {
    let mut buffer = String::new();
    if hits.is_empty() {
        buffer.push_str("（没有检索到相关的笔记片段）\n\n");
    } else {
        buffer.push_str("笔记片段：\n\n");
        for (i, hit) in hits.iter().enumerate() {
            buffer.push_str(&format!("[{}] 《{}》", i + 1, hit.title));
            if !hit.heading.is_empty() {
                // 小标题是这一块的语境。丢掉它，模型看到的就是一段悬空的文字。
                buffer.push_str(&format!(" > {}", hit.heading));
            }
            buffer.push('\n');
            buffer.push_str(&hit.text);
            buffer.push_str("\n\n");
        }
    }
    buffer.push_str("问题：");
    buffer.push_str(question);
    buffer
}

/// 与 `build` 里的编号严格对齐——模型写 `[2]` 时，前端要能定位到第 2 条。
/// 两处编号都从同一个 `enumerate` 的语义出发，不允许各写各的。
pub fn citations(hits: &[Retrieved]) -> Vec<Citation> {
    hits.iter()
        .enumerate()
        .map(|(i, hit)| Citation {
            index: i as u32 + 1,
            note_id: hit.note_id,
            uuid: hit.uuid.clone(),
            title: hit.title.clone(),
            heading: hit.heading.clone(),
            // 按字符截断。按字节切会劈开汉字，回显出来是乱码。
            excerpt: hit.text.chars().take(EXCERPT_MAX_CHARS).collect(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(chunk_id: i64, title: &str, heading: &str, text: &str) -> Retrieved {
        Retrieved {
            chunk_id,
            note_id: chunk_id,
            uuid: format!("u{chunk_id}"),
            title: title.into(),
            heading: heading.into(),
            text: text.into(),
            score: 1.0,
            from_fts: true,
            from_vec: false,
        }
    }

    /// system 里必须写死「找不到就直说」。少了这一句，模型会拿自己的知识
    /// 把答案补齐，而用户完全分不出哪句来自笔记——知识库问答的价值就没了。
    #[test]
    fn system_message_forbids_answering_beyond_the_notes() {
        let messages = build("问题", &[hit(1, "笔记", "", "内容")], &[]);
        let system = &messages[0];
        assert_eq!(system.role, "system");
        assert!(system.content.contains("没有找到相关内容"));
        assert!(system.content.contains("不要"), "必须显式禁止使用自身知识");
    }

    /// 片段编号从 1 起，且与 citations 的编号对齐——模型写 [2] 时，
    /// 前端要能定位到第 2 条引用。
    #[test]
    fn fragments_are_numbered_from_one() {
        let hits = [
            hit(11, "甲", "", "甲的内容"),
            hit(22, "乙", "小标题", "乙的内容"),
        ];
        let messages = build("问题", &hits, &[]);
        let user = messages.last().unwrap();
        assert!(user.content.contains("[1]"));
        assert!(user.content.contains("[2]"));
        assert!(user.content.contains("甲的内容"));
        assert!(
            user.content.contains("小标题"),
            "小标题要一起给模型，它是块的语境"
        );
        assert!(user.content.ends_with("问题"), "问题要放在片段之后");
    }

    #[test]
    fn citations_line_up_with_the_fragment_numbers() {
        let hits = [hit(11, "甲", "", "甲的内容"), hit(22, "乙", "", "乙的内容")];
        let citations = citations(&hits);
        assert_eq!(citations[0].index, 1);
        assert_eq!(citations[0].note_id, 11);
        assert_eq!(citations[1].index, 2);
        assert_eq!(citations[1].note_id, 22);
    }

    #[test]
    fn citation_excerpts_are_truncated_by_characters() {
        let long = "甲".repeat(EXCERPT_MAX_CHARS + 50);
        let c = &citations(&[hit(1, "标题", "", &long)])[0];
        assert_eq!(c.excerpt.chars().count(), EXCERPT_MAX_CHARS);
        assert!(
            c.excerpt.chars().all(|ch| ch == '甲'),
            "按字节截断会劈开汉字"
        );
    }

    /// 没有命中时也要产出可用的消息序列，让模型能说出「没找到」，
    /// 而不是由前端假装模型说了什么。
    #[test]
    fn builds_a_usable_prompt_even_with_no_hits() {
        let messages = build("问题", &[], &[]);
        assert_eq!(messages.len(), 2);
        assert!(messages.last().unwrap().content.contains("问题"));
    }

    /// history 只取最近 N 轮。上下文预算要优先留给检索到的笔记，
    /// 而不是让十轮前的闲聊把片段挤出去。
    #[test]
    fn history_is_limited_to_the_most_recent_turns() {
        let history: Vec<Message> = (0..20)
            .map(|i| {
                if i % 2 == 0 {
                    Message::user(format!("问{i}"))
                } else {
                    Message::assistant(format!("答{i}"))
                }
            })
            .collect();
        let messages = build("现在的问题", &[], &history);
        let carried = messages.len() - 2; // 去掉 system 与当前 user
        assert_eq!(carried, HISTORY_TURNS * 2);
        assert!(messages.iter().any(|m| m.content == "问14"));
        assert!(
            !messages.iter().any(|m| m.content == "问0"),
            "十轮前的对话不该带上"
        );
    }

    #[test]
    fn history_sits_between_the_system_and_the_current_question() {
        let history = vec![Message::user("旧问"), Message::assistant("旧答")];
        let messages = build("新问", &[], &history);
        assert_eq!(messages[0].role, "system");
        assert_eq!(messages[1].content, "旧问");
        assert_eq!(messages[2].content, "旧答");
        assert!(messages[3].content.ends_with("新问"));
    }
}
