import { describe, expect, it } from 'vitest'

import type { TagCount } from './ipc'
import { resolveActiveTag, sortTags } from './tags'

const tag = (name: string, count: number): TagCount => ({ name, count })

describe('sortTags', () => {
  it('按条数降序', () => {
    expect(sortTags([tag('a', 1), tag('b', 5)]).map((t) => t.name)).toEqual(['b', 'a'])
  })

  it('同条数按名称升序', () => {
    expect(sortTags([tag('c', 2), tag('a', 2), tag('b', 2)]).map((t) => t.name)).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  it('不改动入参数组', () => {
    const input = [tag('a', 1), tag('b', 2)]
    sortTags(input)
    expect(input.map((t) => t.name)).toEqual(['a', 'b'])
  })

  it('空数组安全', () => {
    expect(sortTags([])).toEqual([])
  })
})

describe('resolveActiveTag', () => {
  it('没选就是全部', () => {
    expect(resolveActiveTag(null, [tag('工作', 1)])).toBeNull()
  })

  it('标签还在就保持选中', () => {
    expect(resolveActiveTag('工作', [tag('工作', 1), tag('想法', 2)])).toBe('工作')
  })

  it('标签消失后降级回全部', () => {
    expect(resolveActiveTag('工作', [tag('想法', 2)])).toBeNull()
  })

  it('标签列表还没加载出来时也降级（不会卡在空列表上）', () => {
    expect(resolveActiveTag('工作', [])).toBeNull()
  })
})
