use pinyin::ToPinyin;

/// 拼音列的行间分隔符。写索引时插在相邻两行的拼音之间，
/// 让上一行末尾的音节与下一行开头的音节不再连成一个可查子串。
///
/// 为什么是 `/`（U+002F SOLIDUS）：
/// - **用户造不出它**。`normalize_ascii_query` 会剥掉查询里所有非字母数字字符，
///   归一化后的查询串只剩 `[a-z0-9]`，因此任何查询都不可能含有这个字符，
///   也就永远跨不过行边界。这是整套隔断成立的全部理由。
/// - **trigram 原样保留它**。trigram 索引的是任意连续三字符窗口，不做字符过滤，
///   所以它在索引里实打实占掉一个字符位置
///   （`the_separator_is_preserved_by_the_trigram_tokenizer` 守着这条前提）。
/// - 不是 `%` 或 `_`，因此短查询走的 LIKE 兜底路径也照样被它挡住，
///   而不会被当成通配符。
/// - 单字节 ASCII，三字符窗口里只占一格，对相邻行的可查子串损耗最小。
///
/// 它只插在**行边界**，绝不插在词边界：同一行内「知识」「图谱」仍拼成
/// `zhishitupu`，连写查询能命中——这是这套设计刻意支持的能力，不是副作用。
pub const LINE_SEPARATOR: &str = "/";

/// 由逐行分词结果生成两列拼音索引：全拼与首字母。
///
/// **行内**无空格拼接，是为了让用户连写的查询（zhishitupu）能被 trigram 子串命中。
/// 代价是跨词边界会产生无意义子串（zhishi + tupu 之间的 "shitu"），
/// 这点噪音换来的是连写查询可用，值得。
///
/// **行间**插 [`LINE_SEPARATOR`]。不插的话，`tiptap::extract_text` 用 `\n` 拼起来的
/// 各个块会在拼音列上连成一片：第一段以「知识」结尾、第二段以「图谱」开头，
/// 就会拼出连续的 `zhishitupu`，搜 `zhishitupu` 假阳性命中一篇根本没提过
/// 知识图谱的笔记。字面列用哨兵解决了同一个问题，拼音列这里对应。
///
/// 出不了拼音的行（纯英文、纯标点）不占分隔符位置，串首串尾也不会留下悬空分隔符。
///
/// 含非汉字的词整词跳过 —— 英文已由字面列覆盖，混进拼音列只会制造假阳性。
pub fn pinyin_index(lines: &[Vec<String>]) -> (String, String) {
    let mut full = String::new();
    let mut head = String::new();
    for line in lines {
        let mut line_full = String::new();
        let mut line_head = String::new();
        for token in line {
            if let Some((token_full, token_head)) = token_pinyin(token) {
                line_full.push_str(&token_full);
                line_head.push_str(&token_head);
            }
        }
        // 整行都没产出拼音就当这行不存在：既不占分隔符，也不会让串首挂上一个。
        if line_full.is_empty() {
            continue;
        }
        if !full.is_empty() {
            full.push_str(LINE_SEPARATOR);
            head.push_str(LINE_SEPARATOR);
        }
        full.push_str(&line_full);
        head.push_str(&line_head);
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

    fn lines(list: &[&[&str]]) -> Vec<Vec<String>> {
        list.iter()
            .map(|line| line.iter().map(|s| s.to_string()).collect())
            .collect()
    }

    #[test]
    fn builds_concatenated_full_and_head_pinyin() {
        let (full, head) = pinyin_index(&lines(&[&["知识", "图谱"]]));
        assert_eq!(full, "zhishitupu");
        assert_eq!(head, "zstp");
    }

    #[test]
    fn concatenates_across_word_boundaries_inside_one_line() {
        // 这套设计刻意支持的能力：同一行里连写查询要能命中，
        // 分隔符只管行边界，绝不能顺手把词边界也隔开。
        let (full, head) = pinyin_index(&lines(&[&["知识", "图谱", "构建"]]));
        assert_eq!(full, "zhishitupugoujian");
        assert_eq!(head, "zstpgj");
        assert!(full.contains("shitu"), "词边界不该被隔开");
    }

    #[test]
    fn inserts_separator_between_lines() {
        let (full, head) = pinyin_index(&lines(&[&["知识"], &["图谱"]]));
        assert_eq!(full, format!("zhishi{LINE_SEPARATOR}tupu"));
        assert_eq!(head, format!("zs{LINE_SEPARATOR}tp"));
    }

    #[test]
    fn single_line_gets_no_separator() {
        let (full, head) = pinyin_index(&lines(&[&["知识", "图谱"]]));
        assert!(!full.contains(LINE_SEPARATOR));
        assert!(!head.contains(LINE_SEPARATOR));
    }

    #[test]
    fn skips_tokens_containing_non_chinese() {
        let (full, head) = pinyin_index(&lines(&[&["Tauri", "构建"]]));
        assert_eq!(full, "goujian");
        assert_eq!(head, "gj");
    }

    #[test]
    fn skips_the_line_sentinel() {
        // 防御性：字面索引的行间哨兵万一流进来，也必须原样穿过而不留痕迹。
        use crate::search::segment::LINE_SENTINEL;
        let with = pinyin_index(&lines(&[&["知识", LINE_SENTINEL, "图谱"]]));
        let without = pinyin_index(&lines(&[&["知识", "图谱"]]));
        assert_eq!(with, without);
        assert_eq!(with.0, "zhishitupu");
    }

    #[test]
    fn empty_lines_do_not_stack_separators() {
        // 出不了拼音的行（纯英文、纯标点）不能白占一个分隔符位置，
        // 更不能在首尾留下悬空的分隔符。
        let (full, head) = pinyin_index(&lines(&[&["知识"], &["Tauri"], &[], &["图谱"]]));
        assert_eq!(full, format!("zhishi{LINE_SEPARATOR}tupu"));
        assert_eq!(head, format!("zs{LINE_SEPARATOR}tp"));
        assert!(!full.starts_with(LINE_SEPARATOR));
        assert!(!full.ends_with(LINE_SEPARATOR));
    }

    #[test]
    fn empty_tokens_yield_empty_columns() {
        assert_eq!(pinyin_index(&[]), (String::new(), String::new()));
        assert_eq!(
            pinyin_index(&lines(&[&[], &[]])),
            (String::new(), String::new())
        );
    }

    #[test]
    fn the_separator_cannot_survive_query_normalization() {
        // 这是分隔符能挡住跨行查询的全部理由：用户无论怎么输，
        // 归一化后都造不出一个含分隔符的查询串。
        assert!(!normalize_ascii_query(LINE_SEPARATOR).contains(LINE_SEPARATOR));
        assert!(normalize_ascii_query(LINE_SEPARATOR).is_empty());
        assert_eq!(
            normalize_ascii_query(&format!("zhishi{LINE_SEPARATOR}tupu")),
            "zhishitupu"
        );
    }

    /// 分隔符能隔断连写查询，前提是 trigram 把它原样收进三字符窗口。
    /// 换掉分隔符时这个测试会立刻告诉你新字符是否还满足这条前提。
    #[test]
    fn the_separator_is_preserved_by_the_trigram_tokenizer() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE VIRTUAL TABLE p USING fts5(py, tokenize = 'trigram');")
            .unwrap();
        let (full, _) = pinyin_index(&lines(&[&["知识"], &["图谱"]]));
        conn.execute("INSERT INTO p (py) VALUES (?1)", [&full])
            .unwrap();

        let matches = |needle: &str| -> i64 {
            conn.query_row(
                "SELECT count(*) FROM p WHERE p MATCH ?1",
                [format!("\"{needle}\"")],
                |r| r.get(0),
            )
            .unwrap()
        };

        // 分隔符原样留在索引里：带上它就能命中。
        assert_eq!(
            matches(&format!("zhishi{LINE_SEPARATOR}tupu")),
            1,
            "trigram 没有原样保留分隔符"
        );
        // 不带它就跨不过去——而用户永远造不出带它的查询。
        assert_eq!(matches("zhishitupu"), 0, "分隔符没有隔断连写子串");
        // 行内的部分照常可查。
        assert_eq!(matches("zhishi"), 1);
        assert_eq!(matches("tupu"), 1);
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
