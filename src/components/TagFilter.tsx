// 笔记列表上方的标签筛选条。纯展示组件：标签集合和选中项都由 App 注入。
//
// 标签来自 `ipc.listAllTags()`——**全库**的标签与计数，筛选也由后端的
// `list_notes_by_tag` 执行。早先的版本是从已加载的那一页笔记里聚合（collectTags），
// 于是「标签」实际是「最近 100 条里出现过的标签」，筛选也只在那一页内过滤：
// 更早的笔记带同一个标签也筛不出来，chip 上的计数还比真实值小。那个函数已删除。

import type { TagCount } from '../lib/ipc'

export type { TagCount }

/**
 * 点一个 chip 之后的新选中项。再点一次已选中的标签就取消筛选——
 * 比强迫用户去够「全部」顺手。抽成纯函数是因为它是这个组件里唯一有分支的逻辑。
 */
export function toggleTag(clicked: string, selected: string | null): string | null {
  return clicked === selected ? null : clicked
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
            onClick={() => onSelect(toggleTag(tag.name, selected))}
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
