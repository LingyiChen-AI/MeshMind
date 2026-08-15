// 标签筛选的纯逻辑。标签数据本身来自后端（`ipc.listAllTags`，全库统计），
// 这里只管排序和「选中的标签还算不算数」。
//
// 之前这两件事分别是 TagFilter 里的 collectTags（从已加载的那一页笔记聚合）和 App 里
// 的一行三目表达式。前者已经删掉——它统计的是「最近 100 条里出现过的标签」，
// 和 chip 上写的计数根本不是一个东西，是个会骗人的实现。

import type { TagCount } from './ipc'

/**
 * 条数降序、同条数按名称升序（中文按拼音）。
 * 后端的排序不在契约里明说，前端自己排一遍才能保证 chip 的顺序稳定——
 * 顺序一抖，用户就得每次重新找同一个标签在哪。
 */
export function sortTags(tags: TagCount[]): TagCount[] {
  return [...tags].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'))
}

/**
 * 选中的标签可能因为笔记被删、被改而在库里彻底消失（计数归零后 list_all_tags 就不再
 * 返回它）。这时降级回「全部」，否则界面会停在一个空列表 + 一个已经不存在的筛选条件上，
 * 用户无从解释也无从取消。
 */
export function resolveActiveTag(selected: string | null, tags: TagCount[]): string | null {
  if (selected === null) return null
  return tags.some((tag) => tag.name === selected) ? selected : null
}
