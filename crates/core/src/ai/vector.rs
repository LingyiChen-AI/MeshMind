//! 向量运算与内存索引。
//!
//! **向量在存进库之前就已经归一化**，所以这里的相似度就是点积，
//! 检索时不必再算模长。代价是入库路径必须保证这条不变量成立——
//! `index::write_embedding` 是唯一的写入口，归一化在那里做。
//!
//! 索引是一块扁平的 `Vec<f32>`（行主序）而不是 `Vec<Vec<f32>>`：
//! 后者每一行都是一次独立分配，几万行下来指针追逐的开销比点积本身还大。

use std::cmp::Ordering;

/// 就地归一化。零向量原样返回——除以 0 会产生 NaN，
/// 而一个 NaN 混进索引会让之后每一次排序的结果都不可预测。
pub fn normalize(v: &mut [f32]) {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
}

pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// f32 小端序。选定端序是为了让数据库文件跨机器可搬——
/// 用本机端序的话，同一个库在大端机上读出来全是垃圾。
pub fn to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

/// 长度不是 4 的倍数说明 blob 被截断了，返回空而不是读出半个浮点数。
pub fn from_blob(bytes: &[u8]) -> Vec<f32> {
    if !bytes.len().is_multiple_of(4) {
        return Vec::new();
    }
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// 内存向量索引。只在 AI 启用后由外壳懒加载；未启用时根本不构造，占用为零。
pub struct VectorIndex {
    model: String,
    dim: usize,
    ids: Vec<i64>,
    /// 行主序：第 i 行是 `data[i * dim .. (i + 1) * dim]`。
    data: Vec<f32>,
    dim_mismatches: usize,
}

impl VectorIndex {
    pub fn new(model: String, dim: usize) -> Self {
        Self {
            model,
            dim,
            ids: Vec::new(),
            data: Vec::new(),
            dim_mismatches: 0,
        }
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    pub fn dim(&self) -> usize {
        self.dim
    }

    pub fn len(&self) -> usize {
        self.ids.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }

    /// 加载时遇到的维度不符行数。模型换了但没重建索引会留下这类残留，
    /// 数字要能报到设置面板上，否则用户只会看到「搜不准」而不知道为什么。
    pub fn dim_mismatches(&self) -> usize {
        self.dim_mismatches
    }

    pub fn memory_bytes(&self) -> usize {
        self.data.len() * std::mem::size_of::<f32>()
    }

    /// 写入或替换一行。维度不符直接拒绝并计数——塞进去会让整块 data 的行距错乱，
    /// 之后每一行都读到别人的数据。
    pub fn upsert(&mut self, chunk_id: i64, vec: Vec<f32>) {
        if vec.len() != self.dim {
            self.dim_mismatches += 1;
            return;
        }
        match self.ids.iter().position(|id| *id == chunk_id) {
            Some(row) => {
                self.data[row * self.dim..(row + 1) * self.dim].copy_from_slice(&vec);
            }
            None => {
                self.ids.push(chunk_id);
                self.data.extend_from_slice(&vec);
            }
        }
    }

    /// 删除一行。用 swap_remove：顺序对点积没有任何意义，
    /// 但 ids 与 data 必须**一起**交换，漏一边所有向量就会张冠李戴。
    pub fn remove(&mut self, chunk_id: i64) {
        let Some(row) = self.ids.iter().position(|id| *id == chunk_id) else {
            return;
        };
        let last = self.ids.len() - 1;
        self.ids.swap(row, last);
        for i in 0..self.dim {
            self.data.swap(row * self.dim + i, last * self.dim + i);
        }
        self.ids.pop();
        self.data.truncate(last * self.dim);
    }

    /// 相似度最高的 k 行。
    ///
    /// 不做近似：几万行的全量点积在 Rust 里是毫秒级，而近似算法带来的
    /// 召回损失在个人笔记这个规模上完全不值得。排序在同分时按 id 升序兜底，
    /// 保证同一次查询在多次执行间结果稳定（否则测试会随机红）。
    pub fn top_k(&self, query: &[f32], k: usize) -> Vec<(i64, f32)> {
        if self.dim == 0 || query.len() != self.dim {
            return Vec::new();
        }
        let mut scored: Vec<(i64, f32)> = self
            .ids
            .iter()
            .enumerate()
            .map(|(row, id)| {
                let start = row * self.dim;
                (*id, dot(&self.data[start..start + self.dim], query))
            })
            .collect();
        scored.sort_by(|a, b| {
            b.1.partial_cmp(&a.1)
                .unwrap_or(Ordering::Equal)
                .then(a.0.cmp(&b.0))
        });
        scored.truncate(k);
        scored
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f32, b: f32) {
        assert!((a - b).abs() < 1e-5, "{a} != {b}");
    }

    #[test]
    fn normalize_makes_unit_length() {
        let mut v = vec![3.0, 4.0];
        normalize(&mut v);
        approx(v.iter().map(|x| x * x).sum::<f32>().sqrt(), 1.0);
        approx(v[0], 0.6);
        approx(v[1], 0.8);
    }

    /// 零向量不能除出 NaN——某些服务在输入为空字符串时真的会返回全零，
    /// 一个 NaN 混进索引会污染之后每一次排序。
    #[test]
    fn normalize_leaves_a_zero_vector_alone() {
        let mut v = vec![0.0, 0.0, 0.0];
        normalize(&mut v);
        assert!(v.iter().all(|x| *x == 0.0));
        assert!(v.iter().all(|x| !x.is_nan()));
    }

    #[test]
    fn blob_round_trip_preserves_values() {
        let v = vec![0.5_f32, -0.25, 1.0, -1.0];
        assert_eq!(from_blob(&to_blob(&v)), v);
    }

    /// 长度不是 4 的倍数的 blob 是坏数据，不能 panic 也不能读出垃圾。
    #[test]
    fn from_blob_rejects_a_truncated_buffer() {
        assert!(from_blob(&[0u8, 1, 2]).is_empty());
    }

    fn index_of(rows: &[(i64, Vec<f32>)]) -> VectorIndex {
        let mut index = VectorIndex::new("m".into(), rows[0].1.len());
        for (id, v) in rows {
            index.upsert(*id, v.clone());
        }
        index
    }

    /// top_k 必须与「全量算分再排序」逐位一致。这条是整个检索的正确性地基，
    /// 任何为了快而做的近似都会先在这里露馅。
    #[test]
    fn top_k_matches_a_naive_full_sort() {
        let rows: Vec<(i64, Vec<f32>)> = (1..=50)
            .map(|i| {
                let mut v = vec![i as f32, (50 - i) as f32, 1.0];
                normalize(&mut v);
                (i, v)
            })
            .collect();
        let index = index_of(&rows);
        let mut query = vec![1.0, 0.0, 0.0];
        normalize(&mut query);

        let mut naive: Vec<(i64, f32)> = rows.iter().map(|(id, v)| (*id, dot(v, &query))).collect();
        naive.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap().then(a.0.cmp(&b.0)));
        naive.truncate(5);

        let got = index.top_k(&query, 5);
        assert_eq!(
            got.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
            naive.iter().map(|(id, _)| *id).collect::<Vec<_>>()
        );
    }

    /// remove 之后该 id 消失，**且其余向量没有错位**。
    /// 用 swap_remove 时 ids 与 data 必须同步交换，漏一边就会让所有向量张冠李戴——
    /// 这种错误不会崩，只会让检索结果变得莫名其妙。
    #[test]
    fn remove_keeps_the_remaining_vectors_aligned() {
        let rows: Vec<(i64, Vec<f32>)> = vec![
            (1, vec![1.0, 0.0]),
            (2, vec![0.0, 1.0]),
            (3, vec![-1.0, 0.0]),
        ];
        let mut index = index_of(&rows);
        index.remove(1);

        assert_eq!(index.len(), 2);
        let top = index.top_k(&[0.0, 1.0], 1);
        assert_eq!(top[0].0, 2, "删掉 1 之后，2 的向量应当还是 [0,1]");
        let bottom = index.top_k(&[-1.0, 0.0], 1);
        assert_eq!(bottom[0].0, 3);
    }

    #[test]
    fn upsert_replaces_an_existing_id() {
        let mut index = index_of(&[(1, vec![1.0, 0.0])]);
        index.upsert(1, vec![0.0, 1.0]);
        assert_eq!(index.len(), 1);
        approx(index.top_k(&[0.0, 1.0], 1)[0].1, 1.0);
    }

    /// 维度对不上的向量必须被拒绝并计数，而不是塞进去把 data 的行距搞乱。
    #[test]
    fn upsert_rejects_and_counts_dimension_mismatches() {
        let mut index = index_of(&[(1, vec![1.0, 0.0])]);
        index.upsert(2, vec![1.0, 0.0, 0.0]);
        assert_eq!(index.len(), 1);
        assert_eq!(index.dim_mismatches(), 1);
    }

    #[test]
    fn query_with_wrong_dimension_returns_nothing_instead_of_panicking() {
        let index = index_of(&[(1, vec![1.0, 0.0])]);
        assert!(index.top_k(&[1.0, 0.0, 0.0], 5).is_empty());
    }

    #[test]
    fn memory_bytes_grows_with_the_row_count() {
        let mut index = VectorIndex::new("m".into(), 4);
        assert_eq!(index.memory_bytes(), 0);
        index.upsert(1, vec![0.0; 4]);
        assert_eq!(index.memory_bytes(), 16);
        index.upsert(2, vec![0.0; 4]);
        assert_eq!(index.memory_bytes(), 32);
    }

    #[test]
    fn top_k_truncates_to_k() {
        let rows: Vec<(i64, Vec<f32>)> = (1..=10).map(|i| (i, vec![1.0, i as f32])).collect();
        assert_eq!(index_of(&rows).top_k(&[1.0, 1.0], 3).len(), 3);
    }
}
