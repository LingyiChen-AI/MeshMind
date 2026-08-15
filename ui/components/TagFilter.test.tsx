// 放在 .tsx 里既为了挨着组件，也顺带证明 vitest 的 include 真的收得到 .tsx
// （曾经有纯函数住在 .tsx 里而悄悄零覆盖）。测的仍是纯函数，不需要 DOM，
// 所以 environment 留在 node。
//
// 标签的聚合与排序已经搬到 ui/lib/tags.ts（见 tags.test.ts）；
// 这里只剩组件自己拥有的那点交互逻辑。

import { describe, expect, it } from 'vitest'

import { toggleTag } from './TagFilter'

describe('toggleTag', () => {
  it('点未选中的标签就选中它', () => {
    expect(toggleTag('工作', null)).toBe('工作')
    expect(toggleTag('工作', '想法')).toBe('工作')
  })

  it('再点一次已选中的标签取消筛选', () => {
    expect(toggleTag('工作', '工作')).toBeNull()
  })

  it('区分大小写与空白，不做归一化（标签名由后端给定）', () => {
    expect(toggleTag('Work', 'work')).toBe('Work')
    expect(toggleTag(' 工作', '工作')).toBe(' 工作')
  })
})
