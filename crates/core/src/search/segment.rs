use std::sync::OnceLock;

use jieba_rs::Jieba;

/// 行间哨兵 token。写索引时插在相邻两行之间，占掉一个 token 位置，
/// 让上一行的末词与下一行的首词不再相邻，短语查询因此无法跨行命中。
///
/// 为什么是 `ʬ`（U+02AC LATIN LETTER BILABIAL PERCUSSIVE）：
/// - unicode61 只把 Unicode 字母/数字当作 token 字符，纯标点会被它直接丢弃、
///   不占位置，起不到隔断作用；这个码位是 Ll 类字母，unicode61 会把它切成
///   独立的一个 token（`sentinel_is_a_single_unicode61_token` 守着这条前提）。
/// - IPA 双唇打击音，真实中文/英文笔记与查询里出现的概率可以忽略。
/// - 非汉字，`pinyin::pinyin_index` 对含非汉字的词整词跳过，因此不会污染拼音列。
/// - `is_searchable_token` 显式拒绝它，既不会进 MATCH 表达式，也不会漏进
///   `matched_terms` 交给前端高亮。
///
/// 已知代价：用户若真的把这个字符当查询词输入，`is_searchable_token` 会把它滤掉，
/// 该查询于是退化为「无可检索字符」而返回空结果；若它作为子串混在别的词里被 jieba
/// 切成同一个 token，那个 token 也不会命中索引里的哨兵（索引里它永远独占一个 token）。
/// 换言之搜不到，而不是搜出全部多段落笔记——这是这里刻意选的失败方向。
pub const LINE_SENTINEL: &str = "ʬ";

/// jieba 加载词典有成本，全进程只初始化一次。
fn jieba() -> &'static Jieba {
    static INSTANCE: OnceLock<Jieba> = OnceLock::new();
    INSTANCE.get_or_init(Jieba::new)
}

/// 切词。hmm=true 让未登录词也能被切出来（新技术名词很多不在词典里）。
///
/// 注意：jieba 会把换行连同两侧空白 trim 掉，所以这个函数对多行文本给出的是
/// 一条没有行边界的连续序列。写索引请走 `index_tokens`，它按行切并插哨兵。
pub fn segment_tokens(text: &str) -> Vec<String> {
    jieba()
        .cut(text, true)
        .into_iter()
        .map(|token| token.word.trim())
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
}

/// 逐行切词，每行一组 token；切不出任何 token 的行（空行、纯空白行）直接丢弃，
/// 不留空组。
///
/// 行边界是两张索引表共同的隔断依据：字面列靠它插哨兵，拼音列靠它插分隔符
/// （见 `pinyin::LINE_SEPARATOR`）。两边共用这一次切词，jieba 只跑一趟。
///
/// 丢弃空组是下游的前提：留下空组会让拼音列凭空多出一个分隔符，
/// 甚至在串首串尾挂上悬空分隔符。
pub fn line_tokens(text: &str) -> Vec<Vec<String>> {
    text.lines()
        .map(segment_tokens)
        .filter(|line| !line.is_empty())
        .collect()
}

/// 把逐行 token 拼成一条序列，行与行之间插一个 `LINE_SENTINEL`。
pub fn join_with_sentinel(lines: &[Vec<String>]) -> Vec<String> {
    let mut tokens = Vec::new();
    for line in lines {
        if !tokens.is_empty() {
            tokens.push(LINE_SENTINEL.to_string());
        }
        tokens.extend(line.iter().cloned());
    }
    tokens
}

/// 供写入 FTS5 影子列的 token 序列：逐行切词，行与行之间插一个 `LINE_SENTINEL`。
///
/// 不这么做的话，`tiptap::extract_text` 用 `\n` 拼起来的各个块会被 jieba 拉平成
/// 一条连续序列，上一段的末词和下一段的首词变成相邻 token，短语查询的邻接保证
/// 在多段落笔记上就失效了（「第一段讲知识」+「图谱是第二段」会被「知识图谱」命中）。
pub fn index_tokens(text: &str) -> Vec<String> {
    join_with_sentinel(&line_tokens(text))
}

/// token 是否可检索。查询侧唯一的判定入口：构造 MATCH 表达式和挑 `matched_terms`
/// 都从它出发，两边规则不会漂移（`matched_terms` 只在它之上再叠一层高亮降噪，
/// 见 `highlight_terms`）。
///
/// 不含字母数字的 token（标点、符号）既进不了 unicode61 索引，也不该出现在
/// `matched_terms` 里——前端拿到一个 `"，"` 会把全文每个逗号刷成高亮。
/// 哨兵是索引内部的实现细节，同样不对外暴露。
pub fn is_searchable_token(token: &str) -> bool {
    token != LINE_SENTINEL && token.chars().any(char::is_alphanumeric)
}

/// 切词并只保留可检索的 token。
pub fn searchable_tokens(text: &str) -> Vec<String> {
    segment_tokens(text)
        .into_iter()
        .filter(|token| is_searchable_token(token))
        .collect()
}

/// 单字中文虚词表。
///
/// **这是高亮降噪，不是检索规则。** 表里的词照常参与 MATCH 表达式的构造
/// （`query::literal_match` 走的是 `searchable_tokens`，不经过这里）——短语查询
/// 必须保留完整词序列，否则「知识的图谱」会退化成「知识图谱」，邻接语义就变了。
/// 这张表只作用于返回给前端做高亮的 `matched_terms`：查「知识的图谱」时把「的」
/// 交出去，前端会把摘要里每一个「的」都刷成高亮，视觉上一片脏。
///
/// 只收单字中文。单字英文（`a`、`I`）不进表：中文笔记里它们没有同样的噪音密度，
/// 而且纯英文的单字查询本就罕见，滤掉的损失大于收益。
/// 多字词一律不进表——「的确」「在于」是实词，误伤它们比放过一个「的」糟得多。
const HIGHLIGHT_STOP_WORDS: &[&str] = &[
    "的", "地", "得", "了", "着", "过", "是", "在", "有", "和", "与", "及", "等", "就", "都", "也",
    "很", "之", "其", "而", "或", "但", "又", "还", "更", "被", "把", "从", "对", "为", "以", "于",
    "由", "向", "个", "些", "吗", "呢", "吧", "啊", "呀",
];

/// 供 `matched_terms` 使用的高亮词：可检索 token 再滤掉单字中文虚词。
///
/// 与 `searchable_tokens` 的差异是刻意的，且只朝一个方向偏——高亮词是它的子集，
/// 因此「每一项都必须是原文里真实存在的子串」这条契约不会被破坏。
/// 全是虚词的查询（用户就搜了个「的」）返回空 Vec：前端拿到空数组会整段不高亮，
/// 这个行为已有定义，比刷亮全文诚实。
pub fn highlight_terms(query: &str) -> Vec<String> {
    searchable_tokens(query)
        .into_iter()
        .filter(|token| !HIGHLIGHT_STOP_WORDS.contains(&token.as_str()))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

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
        assert!(
            tokens.contains(&"Tauri".to_string()),
            "实际切分: {tokens:?}"
        );
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

    #[test]
    fn segment_tokens_loses_line_boundaries() {
        // 这正是 index_tokens 存在的理由：jieba 把换行 trim 掉，
        // 「知识」和「图谱」分属两行却成了相邻 token。
        assert_eq!(
            segment_tokens("第一段讲知识\n图谱是第二段"),
            vec!["第一段", "讲", "知识", "图谱", "是", "第二段"]
        );
    }

    #[test]
    fn line_tokens_groups_by_line() {
        assert_eq!(
            line_tokens("第一段讲知识\n图谱是第二段"),
            vec![vec!["第一段", "讲", "知识"], vec!["图谱", "是", "第二段"]]
        );
    }

    #[test]
    fn line_tokens_drops_lines_that_yield_nothing() {
        // 空行、纯空白行不产生空组——下游据此决定要不要插分隔符，
        // 留下空组会让拼音列凭空多出一个分隔符。
        assert_eq!(line_tokens("甲\n\n   \n乙"), vec![vec!["甲"], vec!["乙"]]);
        assert!(line_tokens("").is_empty());
        assert!(line_tokens("\n\n").is_empty());
    }

    #[test]
    fn line_tokens_of_single_line_is_one_group() {
        assert_eq!(line_tokens("知识图谱"), vec![vec!["知识", "图谱"]]);
    }

    #[test]
    fn index_tokens_inserts_sentinel_between_lines() {
        assert_eq!(
            index_tokens("第一段讲知识\n图谱是第二段"),
            vec![
                "第一段",
                "讲",
                "知识",
                LINE_SENTINEL,
                "图谱",
                "是",
                "第二段"
            ]
        );
    }

    #[test]
    fn index_tokens_does_not_pad_single_line_text() {
        assert_eq!(index_tokens("知识图谱"), vec!["知识", "图谱"]);
    }

    #[test]
    fn index_tokens_skips_blank_lines_without_stacking_sentinels() {
        let tokens = index_tokens("甲\n\n   \n乙");
        assert_eq!(tokens, vec!["甲", LINE_SENTINEL, "乙"]);
    }

    #[test]
    fn index_tokens_of_empty_text_is_empty() {
        assert!(index_tokens("").is_empty());
        assert!(index_tokens("\n\n").is_empty());
    }

    #[test]
    fn punctuation_is_not_searchable() {
        assert!(!is_searchable_token("，"));
        assert!(!is_searchable_token("!"));
        assert!(!is_searchable_token("……"));
        assert!(is_searchable_token("北京"));
        assert!(is_searchable_token("c9"));
    }

    #[test]
    fn sentinel_is_not_searchable() {
        // 哨兵是字母，`chars().any(is_alphanumeric)` 单独判定会放行，
        // 必须靠显式排除挡住，否则它会漏进 matched_terms。
        assert!(LINE_SENTINEL.chars().any(char::is_alphanumeric));
        assert!(!is_searchable_token(LINE_SENTINEL));
    }

    #[test]
    fn searchable_tokens_drops_punctuation() {
        assert_eq!(searchable_tokens("北京，天安门"), vec!["北京", "天安门"]);
    }

    #[test]
    fn highlight_terms_drop_single_char_function_words() {
        assert_eq!(highlight_terms("知识的图谱"), vec!["知识", "图谱"]);
        assert_eq!(highlight_terms("在北京"), vec!["北京"]);
    }

    #[test]
    fn highlight_terms_keep_multi_char_words_that_start_with_a_stop_word() {
        // 只滤单字，「的确」「是否」这类实词不能被误伤。
        assert_eq!(highlight_terms("的确"), vec!["的确"]);
        assert_eq!(highlight_terms("在于"), vec!["在于"]);
    }

    #[test]
    fn highlight_terms_keep_single_latin_characters() {
        // 单字英文没有同样的噪音问题，不在过滤范围内。
        assert_eq!(highlight_terms("a b c"), vec!["a", "b", "c"]);
        assert_eq!(highlight_terms("维生素 c"), vec!["维生素", "c"]);
    }

    #[test]
    fn highlight_terms_can_be_empty_when_the_query_is_all_function_words() {
        assert!(highlight_terms("的").is_empty());
        assert!(highlight_terms("的了").is_empty());
    }

    #[test]
    fn highlight_terms_still_drop_punctuation_and_the_sentinel() {
        // 降噪叠在 searchable_tokens 之上，原有的两条契约一条都不能松。
        assert_eq!(highlight_terms("北京，天安门"), vec!["北京", "天安门"]);
        assert!(highlight_terms(LINE_SENTINEL).is_empty());
    }

    #[test]
    fn the_stop_word_table_holds_only_single_chinese_characters() {
        // 表里一旦混进多字词或 ASCII，过滤范围就会悄悄扩大到实词与英文。
        for word in HIGHLIGHT_STOP_WORDS {
            let mut chars = word.chars();
            let first = chars.next().expect("虚词表里有空串");
            assert!(chars.next().is_none(), "虚词表里有多字词: {word}");
            assert!(!first.is_ascii(), "虚词表里有 ASCII 字符: {word}");
        }
    }

    #[test]
    fn the_stop_word_table_has_no_duplicates() {
        let unique: HashSet<&&str> = HIGHLIGHT_STOP_WORDS.iter().collect();
        assert_eq!(unique.len(), HIGHLIGHT_STOP_WORDS.len(), "虚词表有重复项");
    }

    /// 哨兵能隔断短语，前提是 unicode61 把它当成一个真 token 收进索引。
    /// 换掉哨兵字符时这个测试会立刻告诉你新字符是否还满足这条前提。
    #[test]
    fn sentinel_is_a_single_unicode61_token() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE VIRTUAL TABLE t USING fts5(x, tokenize = 'unicode61 remove_diacritics 2');",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO t (x) VALUES (?1)",
            [format!("知识 {LINE_SENTINEL} 图谱")],
        )
        .unwrap();

        let matches = |expr: &str| -> i64 {
            conn.query_row("SELECT count(*) FROM t WHERE t MATCH ?1", [expr], |r| {
                r.get(0)
            })
            .unwrap()
        };

        // 哨兵自成一个 token：单独查得到它。
        assert_eq!(matches(LINE_SENTINEL), 1, "哨兵没有被 unicode61 收成 token");
        // 它占了一个位置，因此两侧的词不再相邻。
        assert_eq!(matches(r#""知识 图谱""#), 0, "哨兵没有隔断相邻关系");
        assert_eq!(
            matches(&format!(r#""知识 {LINE_SENTINEL} 图谱""#)),
            1,
            "哨兵占据的位置恰好是一个"
        );
    }
}
