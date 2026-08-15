import { describe, expect, it } from 'vitest'

import { toCamel } from './ipc'

describe('toCamel', () => {
  it('转换单层 snake_case 键', () => {
    expect(toCamel({ body_json: 'x', updated_at: 1 })).toEqual({ bodyJson: 'x', updatedAt: 1 })
  })

  it('转换嵌套对象', () => {
    expect(toCamel({ outer_key: { inner_key: { deep_key: 1 } } })).toEqual({
      outerKey: { innerKey: { deepKey: 1 } },
    })
  })

  it('转换对象数组', () => {
    expect(toCamel([{ note_id: 1 }, { note_id: 2 }])).toEqual([{ noteId: 1 }, { noteId: 2 }])
  })

  it('转换对象里的数组字段', () => {
    expect(toCamel({ attachment_ids: [1, 2], matched_terms: ['a'] })).toEqual({
      attachmentIds: [1, 2],
      matchedTerms: ['a'],
    })
  })

  it('null 不被当成对象', () => {
    expect(toCamel(null)).toBeNull()
    expect(toCamel({ width: null, byte_size: 3 })).toEqual({ width: null, byteSize: 3 })
    expect(toCamel([null, { a_b: 1 }])).toEqual([null, { aB: 1 }])
  })

  it('已经是 camelCase 的键不被破坏', () => {
    expect(toCamel({ bodyJson: 1, id: 2, uuid: 'u' })).toEqual({ bodyJson: 1, id: 2, uuid: 'u' })
  })

  it('原样返回标量', () => {
    expect(toCamel(1)).toBe(1)
    expect(toCamel('a_b')).toBe('a_b')
    expect(toCamel(undefined)).toBeUndefined()
    expect(toCamel(true)).toBe(true)
  })

  it('多下划线与尾部下划线处理稳定', () => {
    expect(toCamel({ a_b_c: 1 })).toEqual({ aBC: 1 })
    expect(toCamel({ _leading: 1 })).toEqual({ _leading: 1 })
  })

  it('转换 SearchHit 形状的真实载荷', () => {
    const hit = toCamel({
      note_id: 7,
      uuid: 'u',
      title: 't',
      excerpt: 'e',
      matched_terms: ['x'],
      source: 'PinyinHead',
    })
    expect(hit).toEqual({
      noteId: 7,
      uuid: 'u',
      title: 't',
      excerpt: 'e',
      matchedTerms: ['x'],
      source: 'PinyinHead',
    })
  })
})
