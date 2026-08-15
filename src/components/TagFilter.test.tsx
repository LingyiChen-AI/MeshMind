// 放在 .tsx 里既为了挨着组件，也顺带证明 vitest 的 include 真的收得到 .tsx。
// collectTags 是纯函数，不需要 DOM，所以 environment 仍是 node。

import { describe, expect, it } from 'vitest'

import { collectTags } from './TagFilter'
import type { NoteSummary } from '../lib/ipc'

function note(id: number, tags: string[]): NoteSummary {
  return { id, uuid: `u${id}`, title: `笔记 ${id}`, excerpt: '', updatedAt: id, tags }
}

describe('collectTags', () => {
  it('没有笔记时返回空数组', () => {
    expect(collectTags([])).toEqual([])
  })

  it('聚合并统计条数', () => {
    const tags = collectTags([note(1, ['工作']), note(2, ['工作', '想法']), note(3, [])])
    expect(tags).toEqual([
      { name: '工作', count: 2 },
      { name: '想法', count: 1 },
    ])
  })

  it('同条笔记里的重名标签只算一次', () => {
    expect(collectTags([note(1, ['读书', '读书'])])).toEqual([{ name: '读书', count: 1 }])
  })

  it('忽略空白标签', () => {
    expect(collectTags([note(1, ['', '   ', '有效'])])).toEqual([{ name: '有效', count: 1 }])
  })

  it('两侧空白视作同一个标签', () => {
    expect(collectTags([note(1, [' 工作']), note(2, ['工作 '])])).toEqual([
      { name: '工作', count: 2 },
    ])
  })

  it('按条数降序、同条数按名称排序', () => {
    const tags = collectTags([note(1, ['b', 'a', 'c']), note(2, ['c'])])
    expect(tags.map((t) => t.name)).toEqual(['c', 'a', 'b'])
  })
})
