// 笔记列表上方的标签筛选条。纯展示组件：标签集合和选中项都由 App 注入。
//
// 重要局限：`list_notes` 不接受 tag 参数，筛选完全发生在前端，
// 聚合与过滤的输入只有**当前已加载的那一页笔记**（默认 limit=100）。
// 所以这里看到的是「最近 100 条里出现过的标签」，而不是库里的全部标签；
// 更早的笔记即使带同一个标签也不会被筛出来。要做成真正的全库筛选，
// 得让后端的 list_notes 支持按 tag 过滤。

import type { NoteSummary } from '../lib/ipc'

export interface TagCount {
  name: string
  /** 已加载笔记里带这个标签的条数 */
  count: number
}

/**
 * 从已加载的笔记里聚合标签，按条数降序、同条数按名称升序。
 * 同一条笔记里重复出现的同名标签只算一次，否则计数会虚高。
 */
export function collectTags(notes: NoteSummary[]): TagCount[] {
  const counts = new Map<string, number>()
  for (const note of notes) {
    const seen = new Set<string>()
    for (const raw of note.tags ?? []) {
      const name = raw.trim()
      if (!name || seen.has(name)) continue
      seen.add(name)
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'))
}

export interface TagFilterProps {
  tags: TagCount[]
  /** null = 不筛选 */
  selected: string | null
  onSelect: (tag: string | null) => void
}

export function TagFilter({ tags, selected, onSelect }: TagFilterProps) {
  // 一个标签都没有时整条不渲染，别在侧边栏顶上留一条空白。
  if (tags.length === 0) return null

  return (
    <div className="tag-filter" role="group" aria-label="标签筛选">
      <button
        type="button"
        className={`tag-chip${selected === null ? ' active' : ''}`}
        aria-pressed={selected === null}
        onClick={() => onSelect(null)}
      >
        全部
      </button>
      {tags.map((tag) => {
        const active = tag.name === selected
        return (
          <button
            key={tag.name}
            type="button"
            className={`tag-chip${active ? ' active' : ''}`}
            aria-pressed={active}
            title={`${tag.count} 条笔记`}
            // 再点一次已选中的标签就取消筛选——比强迫用户去点「全部」顺手。
            onClick={() => onSelect(active ? null : tag.name)}
          >
            #{tag.name}
            <span className="tag-chip-count">{tag.count}</span>
          </button>
        )
      })}
    </div>
  )
}

export default TagFilter
