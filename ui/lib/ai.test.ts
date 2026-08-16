import { describe, expect, it } from 'vitest'

import { formatBytes, initialAsk, reduceAsk, splitCitedText } from './ai'
import type { AskEvent, RawCitation } from './ipc'

/** Channel 投递过来的引用是 snake_case 的，fixture 必须照这个来。 */
const rawCitation = (index: number, noteId: number): RawCitation => ({
  index,
  note_id: noteId,
  uuid: `u${noteId}`,
  title: `笔记${noteId}`,
  heading: '小标题',
  excerpt: '片段',
})

function play(events: AskEvent[]) {
  return events.reduce(reduceAsk, initialAsk())
}

describe('reduceAsk', () => {
  it('把多个 Delta 拼成完整回答', () => {
    const state = play([
      { Retrieved: { citations: [rawCitation(1, 7)] } },
      { Delta: { text: '知识' } },
      { Delta: { text: '图谱' } },
      { Done: { message_id: 42 } },
    ])
    expect(state.answer).toBe('知识图谱')
    expect(state.phase).toBe('done')
    expect(state.messageId).toBe(42)
  })

  // 引用要在模型开口之前就亮出来——这是「可核验」这条主张的实现方式。
  it('Retrieved 一到就有引用，此时还没有任何回答文字', () => {
    const state = play([{ Retrieved: { citations: [rawCitation(1, 7)] } }])
    expect(state.citations).toHaveLength(1)
    expect(state.answer).toBe('')
    expect(state.phase).toBe('streaming')
  })

  // 这条路径不经过 toCamel，归一化只能在这里做。漏了的话界面上
  // 「点引用跳转」会跳到 id 为 undefined 的笔记上，而且一声不吭。
  it('Retrieved 的 note_id 被归一化成 noteId', () => {
    const state = play([{ Retrieved: { citations: [rawCitation(1, 7), rawCitation(2, 9)] } }])
    expect(state.citations.map((c) => c.noteId)).toEqual([7, 9])
    // 归一化后不该再留着原来的 snake_case 键，否则两套字段名会一起漂下去。
    expect(state.citations[0]).not.toHaveProperty('note_id')
    expect(state.citations[0]).toEqual({
      index: 1,
      noteId: 7,
      uuid: 'u7',
      title: '笔记7',
      heading: '小标题',
      excerpt: '片段',
    })
  })

  it('Failed 记下错误并结束', () => {
    const state = play([{ Delta: { text: '半截' } }, { Failed: { message: '网络断了' } }])
    expect(state.phase).toBe('failed')
    expect(state.error).toBe('网络断了')
  })

  // 检索阶段就失败（embedding 请求打不通）时，一个 Retrieved 都还没来过，
  // phase 还是 idle。「终止态直接返回」的守卫要是写成「只在 streaming 时处理事件」，
  // 这类失败就会被守卫自己吃掉，用户对着一个永远转圈的界面。
  it('还没检索就 Failed 也要收得住', () => {
    const state = play([{ Failed: { message: 'AI 服务返回 401：密钥无效' } }])
    expect(state.phase).toBe('failed')
    expect(state.error).toBe('AI 服务返回 401：密钥无效')
  })

  // 取消不是错误：不能弹错误横幅，但必须收起「正在思考」。
  it('Cancelled 结束但不产生错误', () => {
    const state = play([{ Delta: { text: '半截' } }, 'Cancelled'])
    expect(state.phase).toBe('cancelled')
    expect(state.error).toBeNull()
    // 已经流出来的字留在屏幕上——用户按停止是不想再等，不是想把看过的东西抹掉。
    expect(state.answer).toBe('半截')
  })

  // Done 之后再来的事件必须被忽略，否则一次迟到的 Delta 会把
  // 已经落库的回答又改一遍，界面与数据库从此对不上。
  it('终止之后的事件被忽略', () => {
    const state = play([
      { Done: { message_id: 1 } },
      { Delta: { text: '迟到的' } },
      { Failed: { message: '迟到的错误' } },
    ])
    expect(state.answer).toBe('')
    expect(state.phase).toBe('done')
    expect(state.error).toBeNull()
  })

  it('reduceAsk 不改动传进来的 state', () => {
    const before = initialAsk()
    reduceAsk(before, { Delta: { text: '甲' } })
    expect(before.answer).toBe('')
    expect(before.phase).toBe('idle')
  })
})

describe('splitCitedText', () => {
  it('把 [n] 标注切出来，编号能对上引用', () => {
    const parts = splitCitedText('这是结论[1]，另一条[2]。')
    expect(parts.filter((p) => p.kind === 'cite').map((p) => p.index)).toEqual([1, 2])
    expect(parts.map((p) => (p.kind === 'text' ? p.text : '')).join('')).toBe('这是结论，另一条。')
  })

  it('没有标注时原样返回一段文本', () => {
    expect(splitCitedText('纯文本')).toEqual([{ kind: 'text', text: '纯文本' }])
  })

  // 模型偶尔会写 [1][2] 连着，或者写出根本不存在的 [9]。
  // 前者要拆成两个，后者不能崩——渲染成普通文本即可。
  it('处理连续标注与越界编号', () => {
    const parts = splitCitedText('结论[1][2]，还有[9]')
    expect(parts.filter((p) => p.kind === 'cite').map((p) => p.index)).toEqual([1, 2, 9])
    // 连着的标注之间不留空文本段：那会渲染成一堆空 span。
    expect(parts.filter((p) => p.kind === 'text').map((p) => p.text)).toEqual(['结论', '，还有'])
  })

  it('方括号里不是数字时当普通文本', () => {
    expect(splitCitedText('数组[i]取值')).toEqual([{ kind: 'text', text: '数组[i]取值' }])
    expect(splitCitedText('见[1a]')).toEqual([{ kind: 'text', text: '见[1a]' }])
  })

  it('空字符串返回空数组', () => {
    expect(splitCitedText('')).toEqual([])
  })
})

describe('formatBytes', () => {
  it('给出人能读的内存占用', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(120 * 1024 * 1024)).toBe('120.0 MB')
  })

  // 不满 1 KB 的时候写「0.5 KB」既难读又不准，字节数直接报数字。
  it('不满一档时用下一档的整数', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('保留一位小数而不是取整', () => {
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB')
  })
})
