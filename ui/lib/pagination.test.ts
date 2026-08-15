import { describe, expect, it } from 'vitest'

import {
  appendPage,
  emptyPage,
  listPhase,
  mergeHead,
  nextOffset,
  refreshLimit,
  removeItem,
  replacePage,
} from './pagination'

interface Row {
  id: number
}

const rows = (...ids: number[]): Row[] => ids.map((id) => ({ id }))
const page = (ids: number[], hasMore: boolean) => ({ items: rows(...ids), hasMore })

describe('emptyPage / nextOffset', () => {
  it('空页没有更多也没有偏移', () => {
    const p = emptyPage<Row>()
    expect(p.items).toEqual([])
    expect(p.hasMore).toBe(false)
    expect(nextOffset(p)).toBe(0)
  })

  it('下一页 offset 等于已加载条数', () => {
    expect(nextOffset(page([1, 2, 3], true))).toBe(3)
  })
})

describe('replacePage', () => {
  it('装满一页时认为还有更多', () => {
    expect(replacePage(rows(1, 2), 2)).toEqual({ items: rows(1, 2), hasMore: true })
  })

  it('没装满就是到底了', () => {
    expect(replacePage(rows(1), 2)).toEqual({ items: rows(1), hasMore: false })
  })

  it('空结果是到底了', () => {
    expect(replacePage([], 50)).toEqual({ items: [], hasMore: false })
  })

  it('后端多给了几条也算还有更多', () => {
    expect(replacePage(rows(1, 2, 3), 2).hasMore).toBe(true)
  })
})

describe('appendPage', () => {
  it('接在尾部并保持顺序', () => {
    expect(appendPage(page([1, 2], true), rows(3, 4), 2)).toEqual({
      items: rows(1, 2, 3, 4),
      hasMore: true,
    })
  })

  it('丢掉已经在列表里的 id', () => {
    expect(appendPage(page([1, 2], true), rows(2, 3), 2).items).toEqual(rows(1, 2, 3))
  })

  it('去重之后为空也不代表到底了', () => {
    // 后端确实给满了一页，只是全都是我们已有的——还得让用户能再点一次
    expect(appendPage(page([1, 2], true), rows(1, 2), 2)).toEqual({
      items: rows(1, 2),
      hasMore: true,
    })
  })

  it('空批次落到终止态', () => {
    expect(appendPage(page([1, 2], true), [], 2)).toEqual({ items: rows(1, 2), hasMore: false })
  })

  it('没装满一页则到底', () => {
    expect(appendPage(page([1, 2], true), rows(3), 2).hasMore).toBe(false)
  })
})

describe('refreshLimit', () => {
  it('不足一页也至少拉一页', () => {
    expect(refreshLimit(0, 50)).toBe(50)
    expect(refreshLimit(7, 50)).toBe(50)
    expect(refreshLimit(50, 50)).toBe(50)
  })

  it('已加载多页时向上取整到整页', () => {
    expect(refreshLimit(51, 50)).toBe(100)
    expect(refreshLimit(100, 50)).toBe(100)
    expect(refreshLimit(101, 50)).toBe(150)
  })

  it('页大小非法时返回 0，调用方据此跳过请求', () => {
    expect(refreshLimit(10, 0)).toBe(0)
  })
})

describe('mergeHead', () => {
  it('被编辑的笔记从深处跳到最前，且不留下重复', () => {
    // 已加载 4 条（页大小 2），第 4 条被编辑后跳到首位
    const merged = mergeHead(page([1, 2, 3, 4], true), rows(4, 1), 2)
    expect(merged.items).toEqual(rows(4, 1, 2, 3))
    expect(merged.hasMore).toBe(true)
  })

  it('被挤出第一页的那条落回紧随其后的位置', () => {
    const merged = mergeHead(page([1, 2, 3, 4], false), rows(9, 1), 2)
    expect(merged.items).toEqual(rows(9, 1, 2, 3, 4))
  })

  it('新第一页没装满时丢掉老尾巴（库里总共就这么多）', () => {
    expect(mergeHead(page([1, 2, 3], true), rows(2, 1), 50)).toEqual({
      items: rows(2, 1),
      hasMore: false,
    })
  })

  it('第一页内部换序不会影响后面的页', () => {
    const merged = mergeHead(page([1, 2, 3, 4], true), rows(2, 1), 2)
    expect(merged.items).toEqual(rows(2, 1, 3, 4))
  })
})

describe('removeItem', () => {
  it('摘掉指定 id', () => {
    expect(removeItem(page([1, 2, 3], true), 2).items).toEqual(rows(1, 3))
  })

  it('id 不存在时原样返回同一个对象', () => {
    const p = page([1, 2], true)
    expect(removeItem(p, 9)).toBe(p)
  })

  it('不改变 hasMore', () => {
    expect(removeItem(page([1], true), 1)).toEqual({ items: [], hasMore: true })
  })
})

describe('listPhase', () => {
  it('有内容就渲染列表，哪怕还在加载下一页', () => {
    expect(listPhase(true, 3)).toBe('list')
    expect(listPhase(false, 3)).toBe('list')
  })

  it('首屏加载中不闪空态', () => {
    expect(listPhase(true, 0)).toBe('loading')
  })

  it('加载完确实没有才是空态', () => {
    expect(listPhase(false, 0)).toBe('empty')
  })
})
