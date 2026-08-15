use pinyin::ToPinyin;

/// 由分词结果生成两列拼音索引：全拼与首字母，均为无空格拼接。
///
/// 拼接而非空格分隔，是为了让用户连写的查询（zhishitupu）能被 trigram 子串命中。
/// 代价是跨词边界会产生无意义子串（zhishi + tupu 之间的 "shitu"），
/// 这点噪音换来的是连写查询可用，值得。
///
/// 含非汉字的词整词跳过 —— 英文已由字面列覆盖，混进拼音列只会制造假阳性。
pub fn pinyin_index(tokens: &[String]) -> (String, String) {
    let mut full = String::new();
    let mut head = String::new();
    for token in tokens {
        if let Some((token_full, token_head)) = token_pinyin(token) {
            full.push_str(&token_full);
            head.push_str(&token_head);
        }
    }
    (full, head)
}

fn token_pinyin(token: &str) -> Option<(String, String)> {
    let mut full = String::new();
    let mut head = String::new();
    let mut has_han = false;
    for maybe in token.to_pinyin() {
        let plain = maybe?.plain();
        full.push_str(plain);
        head.push(plain.chars().next()?);
        has_han = true;
    }
    has_han.then_some((full, head))
}

/// 归一化 ASCII 查询：转小写并丢弃所有非字母数字字符，
/// 使 "zhi shi tu pu"、"Zhi-Shi_Tu_Pu"、"zhishitupu" 归到同一形式。
pub fn normalize_ascii_query(query: &str) -> String {
    query
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .flat_map(char::to_lowercase)
        .collect()
}

/// 查询是否应该走拼音通道：不含任何非 ASCII 字符，且归一化后非空。
pub fn is_ascii_query(query: &str) -> bool {
    query.is_ascii() && !normalize_ascii_query(query).is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn builds_concatenated_full_and_head_pinyin() {
        let (full, head) = pinyin_index(&tokens(&["知识", "图谱"]));
        assert_eq!(full, "zhishitupu");
        assert_eq!(head, "zstp");
    }

    #[test]
    fn skips_tokens_containing_non_chinese() {
        let (full, head) = pinyin_index(&tokens(&["Tauri", "构建"]));
        assert_eq!(full, "goujian");
        assert_eq!(head, "gj");
    }

    #[test]
    fn empty_tokens_yield_empty_columns() {
        assert_eq!(pinyin_index(&[]), (String::new(), String::new()));
    }

    #[test]
    fn normalizes_ascii_query_by_stripping_separators() {
        assert_eq!(normalize_ascii_query("Zhi Shi-Tu_Pu"), "zhishitupu");
    }

    #[test]
    fn query_with_chinese_is_not_ascii() {
        assert!(!is_ascii_query("知识"));
        assert!(is_ascii_query("zstp"));
    }
}
