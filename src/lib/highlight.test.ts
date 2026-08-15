import { describe, expect, it } from 'vitest'

import { splitByTerms } from './highlight'

describe('splitByTerms', () => {
  it('标出命中词', () => {
    expect(splitByTerms('hello world', ['world'])).toEqual([
      { text: 'hello ', hit: false },
      { text: 'world', hit: true },
    ])
  })

  it('命中词在开头和中间时切片顺序正确', () => {
    expect(splitByTerms('abcabd', ['ab'])).toEqual([
      { text: 'ab', hit: true },
      { text: 'c', hit: false },
      { text: 'ab', hit: true },
      { text: 'd', hit: false },
    ])
  })

  it('无命中词时原样返回单个切片', () => {
    expect(splitByTerms('hello', ['zzz'])).toEqual([{ text: 'hello', hit: false }])
  })

  it('terms 为空数组时原样返回', () => {
    expect(splitByTerms('hello', [])).toEqual([{ text: 'hello', hit: false }])
  })

  it('terms 全是空白时原样返回', () => {
    expect(splitByTerms('hello', ['', '   '])).toEqual([{ text: 'hello', hit: false }])
  })

  it('忽略大小写', () => {
    expect(splitByTerms('Hello World', ['hello'])).toEqual([
      { text: 'Hello', hit: true },
      { text: ' World', hit: false },
    ])
  })

  it('正则元字符按字面处理', () => {
    expect(splitByTerms('a+b', ['+'])).toEqual([
      { text: 'a', hit: false },
      { text: '+', hit: true },
      { text: 'b', hit: false },
    ])
    expect(splitByTerms('a.b', ['.'])).toEqual([
      { text: 'a', hit: false },
      { text: '.', hit: true },
      { text: 'b', hit: false },
    ])
    // '.' 若未转义会匹配任意字符，这里必须不命中
    expect(splitByTerms('axb', ['.'])).toEqual([{ text: 'axb', hit: false }])
  })

  it('空文本可处理', () => {
    expect(splitByTerms('', ['a'])).toEqual([{ text: '', hit: false }])
    expect(splitByTerms('', [])).toEqual([{ text: '', hit: false }])
  })

  it('支持多个命中词', () => {
    expect(splitByTerms('foo bar baz', ['foo', 'baz'])).toEqual([
      { text: 'foo', hit: true },
      { text: ' bar ', hit: false },
      { text: 'baz', hit: true },
    ])
  })

  it('支持中文命中词', () => {
    expect(splitByTerms('会议纪要草稿', ['纪要'])).toEqual([
      { text: '会议', hit: false },
      { text: '纪要', hit: true },
      { text: '草稿', hit: false },
    ])
  })
})
