use crate::search::segment;

/// 把用户查询转成 FTS5 字面列的 MATCH 表达式。
///
/// 形式是「短语 + 末词前缀」：`"北京 天安门" *`。用短语而非 AND 连接，
/// 是为了让「知识图」只命中相邻出现的「知识 图谱」，
/// 而不是命中一篇分别提到「知识」和「图」的无关笔记。
///
/// 查询里没有任何可检索字符时返回 None —— 调用方据此跳过这一路查询，
/// 而不是发一个空前缀出去（空前缀会匹配全部记录）。
pub fn literal_match(query: &str) -> Option<String> {
    let tokens: Vec<String> = segment::segment_tokens(query)
        .iter()
        .filter(|token| token.chars().any(char::is_alphanumeric))
        .map(|token| token.replace('"', "\"\""))
        .collect();
    if tokens.is_empty() {
        return None;
    }
    Some(format!("\"{}\" *", tokens.join(" ")))
}

/// 拼音列的 trigram MATCH 表达式，限定在单个列上以便区分命中来源。
/// 传入的 query 必须已经过 pinyin::normalize_ascii_query 归一化。
pub fn pinyin_match(column: &str, query: &str) -> String {
    format!("{{{column}}} : \"{query}\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_phrase_with_trailing_prefix_for_chinese() {
        // 末词带 * 前缀，使「知识图」能命中「知识图谱」。
        assert_eq!(
            literal_match("北京天安门").as_deref(),
            Some(r#""北京 天安门" *"#)
        );
    }

    #[test]
    fn builds_prefix_match_for_latin() {
        assert_eq!(literal_match("Tauri").as_deref(), Some(r#""Tauri" *"#));
    }

    #[test]
    fn neutralizes_embedded_double_quotes() {
        // jieba 把引号切成独立 token（["say", "\"", "hi", "\""]），
        // 不含字母数字，在过滤这步就被丢掉了，压根到不了转义那行。
        // 关键是结果里不能残留裸引号——否则整个 MATCH 表达式会被 FTS5 判为语法错误。
        assert_eq!(
            literal_match(r#"say "hi""#).as_deref(),
            Some(r#""say hi" *"#)
        );
    }

    #[test]
    fn returns_none_for_punctuation_only_query() {
        assert_eq!(literal_match("！！！"), None);
    }

    #[test]
    fn returns_none_for_empty_query() {
        assert_eq!(literal_match("   "), None);
    }

    #[test]
    fn builds_column_filtered_trigram_match() {
        assert_eq!(
            pinyin_match("py_full", "zhishitupu"),
            r#"{py_full} : "zhishitupu""#
        );
    }
}
