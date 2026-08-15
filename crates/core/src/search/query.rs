use crate::search::segment;

/// 把用户查询转成 FTS5 字面列的 MATCH 表达式。
///
/// 形式是「短语 + 末词前缀」：`"北京 天安门" *`。用短语而非 AND 连接，
/// 是为了让「知识图」只命中相邻出现的「知识 图谱」，
/// 而不是命中一篇分别提到「知识」和「图」的无关笔记。
///
/// token 的取舍走 `segment::searchable_tokens`——两边各写一份过滤条件是上一版的
/// bug：表达式里剔掉了标点，`matched_terms` 却把 `"，"` 泄漏给了前端。
///
/// 唯一一处刻意的分叉：`matched_terms` 在这份 token 集上又滤掉了单字中文虚词
/// （`segment::highlight_terms`）。表达式这边**不能**跟着滤——短语必须保留完整
/// 词序列，把「知识 的 图谱」缩成「知识 图谱」会改掉邻接语义，让一篇写着
/// 「知识图谱」的笔记被「知识的图谱」命中。降噪只发生在返回给前端的那一侧。
///
/// 查询里没有任何可检索字符时返回 None —— 调用方据此跳过这一路查询，
/// 而不是发一个空前缀出去（空前缀会匹配全部记录）。
pub(crate) fn literal_match(query: &str) -> Option<String> {
    let tokens: Vec<String> = segment::searchable_tokens(query)
        .iter()
        .map(|token| escape_phrase_token(token))
        .collect();
    if tokens.is_empty() {
        return None;
    }
    Some(format!("\"{}\" *", tokens.join(" ")))
}

/// 把 token 里的裸双引号加倍，使它能安全地待在 FTS5 短语的引号内。
///
/// 当前 jieba 不会产出「引号和字母数字同处一个 token」的切分，所以这一步在实践中
/// 是空转（`searchable_tokens` 早把纯引号 token 滤掉了）。保留它是因为 jieba 的
/// 字符类历史上变过：一旦哪天变了，缺这一步的后果是用户每输入一个含引号的查询就
/// 撞上 SQLITE_ERROR 硬失败，而不是少几条结果。这是 fail-hard 边界，保留成本为零。
fn escape_phrase_token(token: &str) -> String {
    token.replace('"', "\"\"")
}

/// 拼音列的 trigram MATCH 表达式，限定在单个列上以便区分命中来源。
///
/// 两个参数都不做转义：column 只接受本模块的常量，query 必须已经过
/// `pinyin::normalize_ascii_query` 归一化（结果只含 ASCII 字母数字）。
/// 这个前提无法在函数内校验，所以它不对外公开。
pub(crate) fn pinyin_match(column: &str, query: &str) -> String {
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
    fn drops_punctuation_tokens_from_the_expression() {
        // jieba 把标点切成独立 token（["say", "\"", "hi", "\""]），
        // 它们不含字母数字，在过滤这步就被丢掉了。
        assert_eq!(
            literal_match(r#"say "hi""#).as_deref(),
            Some(r#""say hi" *"#)
        );
        assert_eq!(
            literal_match("北京，天安门").as_deref(),
            Some(r#""北京 天安门" *"#)
        );
    }

    #[test]
    fn escapes_embedded_double_quotes_by_doubling_them() {
        // 直接单测转义本身。上面那条走的是「token 被丢弃」的路径，
        // 把转义整行删掉它也照样通过，覆盖不到这里。
        assert_eq!(escape_phrase_token(r#"a"b"#), r#"a""b"#);
        assert_eq!(escape_phrase_token(r#"""#), r#""""#);
        assert_eq!(escape_phrase_token("北京"), "北京");
    }

    #[test]
    fn never_emits_a_bare_double_quote_inside_the_phrase() {
        // 短语体（去掉首尾定界引号和末尾的 ` *`）里的引号必须成对出现，
        // 否则整个 MATCH 表达式会被 FTS5 判为语法错误。
        let token = r#"a"b"#;
        let phrase = format!("\"{}\" *", escape_phrase_token(token));
        let body = phrase
            .trim_end_matches(" *")
            .trim_start_matches('"')
            .trim_end_matches('"');
        assert_eq!(body.matches('"').count() % 2, 0, "短语体里有裸引号: {body}");
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
    fn returns_none_for_the_sentinel_alone() {
        // 哨兵是索引内部标记，不允许被当成查询词发出去，
        // 否则它会命中所有多段落笔记。
        assert_eq!(literal_match(segment::LINE_SENTINEL), None);
    }

    #[test]
    fn builds_column_filtered_trigram_match() {
        assert_eq!(
            pinyin_match("py_full", "zhishitupu"),
            r#"{py_full} : "zhishitupu""#
        );
    }
}
