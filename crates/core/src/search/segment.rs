use std::sync::OnceLock;

use jieba_rs::Jieba;

/// jieba 加载词典有成本，全进程只初始化一次。
fn jieba() -> &'static Jieba {
    static INSTANCE: OnceLock<Jieba> = OnceLock::new();
    INSTANCE.get_or_init(Jieba::new)
}

/// 切词。hmm=true 让未登录词也能被切出来（新技术名词很多不在词典里）。
pub fn segment_tokens(text: &str) -> Vec<String> {
    jieba()
        .cut(text, true)
        .into_iter()
        .map(|token| token.word.trim())
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
}

/// 切词并以单空格拼接，用于写入 FTS5 影子列。
pub fn segment(text: &str) -> String {
    segment_tokens(text).join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_chinese_into_words() {
        assert_eq!(
            segment_tokens("我爱北京天安门"),
            vec!["我", "爱", "北京", "天安门"]
        );
    }

    #[test]
    fn keeps_multi_char_terms_intact() {
        let tokens = segment_tokens("知识图谱构建");
        assert!(tokens.contains(&"图谱".to_string()), "实际切分: {tokens:?}");
    }

    #[test]
    fn keeps_latin_words_as_tokens() {
        let tokens = segment_tokens("使用 Tauri 构建应用");
        assert!(tokens.contains(&"Tauri".to_string()), "实际切分: {tokens:?}");
    }

    #[test]
    fn drops_whitespace_only_tokens() {
        let tokens = segment_tokens("北京   天安门");
        assert!(
            tokens.iter().all(|t| !t.trim().is_empty()),
            "实际切分: {tokens:?}"
        );
    }

    #[test]
    fn empty_input_yields_no_tokens() {
        assert!(segment_tokens("").is_empty());
    }
}
