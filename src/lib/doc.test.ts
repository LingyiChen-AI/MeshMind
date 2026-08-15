import { describe, expect, it } from 'vitest'

import { collectAttachmentIds, isEmptyDoc } from './doc'

/** 造一个 TipTap 风格的文档字符串。 */
function doc(...content: unknown[]): string {
  return JSON.stringify({ type: 'doc', content })
}

function paragraph(text: string) {
  return { type: 'paragraph', content: [{ type: 'text', text }] }
}

function image(attachmentId: unknown) {
  return { type: 'attachmentImage', attrs: { attachmentId } }
}

describe('collectAttachmentIds', () => {
  it('顶层图片', () => {
    expect(collectAttachmentIds(doc(image(1), image(2)))).toEqual([1, 2])
  })

  it('列表项里的图片也要收上来', () => {
    const list = {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [paragraph('第一条'), image(7)] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [image(8)] }] },
      ],
    }
    expect(collectAttachmentIds(doc(paragraph('前言'), list))).toEqual([7, 8])
  })

  it('引用块里的图片也要收上来', () => {
    const quote = {
      type: 'blockquote',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '引用' }, image(3)] }],
    }
    expect(collectAttachmentIds(doc(quote))).toEqual([3])
  })

  it('多层嵌套（引用套列表套列表）不漏', () => {
    const deep = {
      type: 'blockquote',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'orderedList',
                  content: [{ type: 'listItem', content: [image(42)] }],
                },
              ],
            },
          ],
        },
      ],
    }
    expect(collectAttachmentIds(doc(deep))).toEqual([42])
  })

  it('按出现顺序去重', () => {
    const nested = { type: 'blockquote', content: [image(5)] }
    expect(collectAttachmentIds(doc(image(5), nested, image(1), image(5)))).toEqual([5, 1])
  })

  it('空文档返回空数组', () => {
    expect(collectAttachmentIds(doc({ type: 'paragraph' }))).toEqual([])
    expect(collectAttachmentIds(JSON.stringify({ type: 'doc' }))).toEqual([])
  })

  it('只有图片、没有任何文字时照样收得到', () => {
    expect(collectAttachmentIds(doc(image(9)))).toEqual([9])
  })

  it('非数字或非有限的 attachmentId 一律忽略', () => {
    // 这些若被当成合法 id 传给 update_note，后端会解绑真正的附件。
    const bad = doc(image('3'), image(null), image(undefined), image(Number.NaN), image(1.5))
    expect(collectAttachmentIds(bad)).toEqual([1.5])
  })

  it('畸形 JSON 不抛异常，退回空数组', () => {
    expect(collectAttachmentIds('')).toEqual([])
    expect(collectAttachmentIds('{ 这不是 json')).toEqual([])
    expect(collectAttachmentIds('null')).toEqual([])
    expect(collectAttachmentIds('42')).toEqual([])
    expect(collectAttachmentIds('"字符串"')).toEqual([])
  })

  it('content 不是数组时不炸', () => {
    expect(collectAttachmentIds(JSON.stringify({ type: 'doc', content: null }))).toEqual([])
  })
})

describe('isEmptyDoc', () => {
  it('只有空段落算空', () => {
    expect(isEmptyDoc(doc({ type: 'paragraph' }))).toBe(true)
    expect(isEmptyDoc(doc())).toBe(true)
  })

  it('只有空白字符也算空', () => {
    expect(isEmptyDoc(doc(paragraph('   \n\t ')))).toBe(true)
  })

  it('有文字就不空', () => {
    expect(isEmptyDoc(doc(paragraph('随手记一条')))).toBe(false)
  })

  it('嵌套深处的文字也算数', () => {
    const deep = {
      type: 'blockquote',
      content: [
        { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('藏得很深')] }] },
      ],
    }
    expect(isEmptyDoc(doc(deep))).toBe(false)
  })

  it('只有图片、没有文字不算空', () => {
    // 截图流是快捕的主要用法，判空时把它当空会直接丢掉用户刚粘的图。
    expect(isEmptyDoc(doc(image(1)))).toBe(false)
  })

  it('列表项里的图片同样不算空', () => {
    const list = {
      type: 'bulletList',
      content: [{ type: 'listItem', content: [image(2)] }],
    }
    expect(isEmptyDoc(doc(list))).toBe(false)
  })

  it('attachmentId 为 null / undefined 的节点不算内容', () => {
    expect(isEmptyDoc(doc(image(null)))).toBe(true)
    expect(isEmptyDoc(doc({ type: 'attachmentImage', attrs: {} }))).toBe(true)
  })

  it('畸形 JSON 当空文档处理', () => {
    expect(isEmptyDoc('')).toBe(true)
    expect(isEmptyDoc('{ 坏数据')).toBe(true)
    expect(isEmptyDoc('null')).toBe(true)
  })
})
