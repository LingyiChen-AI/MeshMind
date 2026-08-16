// AI 问答的纯逻辑：流式事件的归并、回答里 [n] 标注的切分、字节数的人话化。
//
// 抽出来是因为这三件事都属于「错了不会报错、只会安静地显示错东西」的那一类：
//
// - 流式事件是从网络那头来的，顺序与迟到都不由前端说了算，状态机必须自己扛住；
// - Channel 那条路径不经过 `toCamel`，字段名归一化没人替我们做；
// - `[n]` 是模型现写的，它会写连着的、写越界的、写根本不是数字的。
//
// 组件只管渲染，不许在 JSX 里重新实现这里的任何一条规则。

import type { AskEvent, Citation, RawCitation, SemanticHit } from './ipc'

/**
 * 一次提问的进度。
 *
 * - `idle`：还没开始，或者发出去了但一个事件都没回来。
 * - `streaming`：`Retrieved` 或第一个 `Delta` 已经到了，界面该显示「正在思考」与停止按钮。
 * - `done` / `failed` / `cancelled`：三个终止态，后端保证只会到达其中之一。
 *
 * 界面在用户点「发送」的当下就要显示「正在思考」，而那时一个事件都还没来，
 * 所以提交时请自己置成 `{ ...initialAsk(), phase: 'streaming' }`，
 * 别等 `Retrieved`——第一次检索要发一次 embedding 请求，可能等上一两秒。
 */
export type AskPhase = 'idle' | 'streaming' | 'done' | 'failed' | 'cancelled'

export interface AskState {
  phase: AskPhase
  /** 已经流出来的回答文字，可能只是半截 */
  answer: string
  /** 已归一化成 camelCase，和 `aiGetMessages` 返回的历史消息是同一种形状 */
  citations: Citation[]
  /** `Done` 之后才有：后端落库的那条助手消息的 id */
  messageId: number | null
  /** 只有 `failed` 才非空。取消不是错误，这里保持 null */
  error: string | null
}

export function initialAsk(): AskState {
  return { phase: 'idle', answer: '', citations: [], messageId: null, error: null }
}

/**
 * 把一个 `AskEvent` 归并进状态。纯函数，不改动传进来的 state。
 *
 * 两条规则是这个函数存在的全部理由：
 *
 * 1. **终止态下原样返回。** 网络包的到达顺序不保证，一次迟到的 `Delta` 会把
 *    已经落库的回答又改一遍，界面与数据库从此对不上，而且没有任何报错。
 *    注意守卫判的是「已经终止」而不是「必须在 streaming」——检索阶段就失败时
 *    第一个事件就是 `Failed`，那时 phase 还是 `idle`，写成后者会把它吃掉。
 * 2. **先判 `typeof event === 'string'`。** 无字段的 `Cancelled` 在 serde 的
 *    外部标签下就是裸字符串，对字符串用 `'Delta' in event` 会直接抛 TypeError。
 */
export function reduceAsk(state: AskState, event: AskEvent): AskState {
  if (state.phase === 'done' || state.phase === 'failed' || state.phase === 'cancelled') {
    return state
  }

  if (typeof event === 'string') {
    // 目前只有 Cancelled 一个无字段变体。将来 Rust 那边再加，这里会漏——
    // 但漏的表现是「被当成取消」，比抛异常炸掉整个面板温和。
    return { ...state, phase: 'cancelled' }
  }

  if ('Retrieved' in event) {
    return {
      ...state,
      phase: 'streaming',
      citations: event.Retrieved.citations.map(normalizeCitation),
    }
  }

  if ('Delta' in event) {
    return { ...state, phase: 'streaming', answer: state.answer + event.Delta.text }
  }

  if ('Done' in event) {
    return { ...state, phase: 'done', messageId: event.Done.message_id }
  }

  return { ...state, phase: 'failed', error: event.Failed.message }
}

/** snake_case → camelCase，只此一处。逐字段列出而不是跑 `toCamel`，好让 TS 帮忙检查漏项。 */
function normalizeCitation(raw: RawCitation): Citation {
  return {
    index: raw.index,
    noteId: raw.note_id,
    uuid: raw.uuid,
    title: raw.title,
    heading: raw.heading,
    excerpt: raw.excerpt,
  }
}

/** 回答正文切开之后的一段：要么是普通文字，要么是一个可点的引用编号。 */
export type CitedPart = { kind: 'text'; text: string } | { kind: 'cite'; index: number }

/**
 * 只认方括号里是**纯数字**的写法。放宽到 `\[(.+?)\]` 会把「数组[i]取值」
 * 这种正常文字也吃掉，用户的笔记里代码片段不少。
 */
const CITE_PATTERN = /\[(\d+)\]/g

/**
 * 把回答正文切成可渲染的片段。
 *
 * `index` 不保证在引用列表里存在——模型会写出越界的 `[9]`。渲染方自己决定
 * 找不到时怎么办（建议照普通文字画，别报错，更别崩）。
 * 连着的 `[1][2]` 之间不产生空文本段。
 */
export function splitCitedText(text: string): CitedPart[] {
  const parts: CitedPart[] = []
  let cursor = 0

  for (const match of text.matchAll(CITE_PATTERN)) {
    const at = match.index ?? 0
    if (at > cursor) parts.push({ kind: 'text', text: text.slice(cursor, at) })
    parts.push({ kind: 'cite', index: Number(match[1]) })
    cursor = at + match[0].length
  }

  if (cursor < text.length) parts.push({ kind: 'text', text: text.slice(cursor) })
  return parts
}

/**
 * 语义结果里去掉已经在关键词组里出现过的笔记。
 *
 * 两组是同一次搜索的两种召回方式，重合是常态（一篇既字面命中又语义相关的笔记
 * 恰恰是最该排在前面的那种）。同一个标题在一屏里出现两次，用户第一反应是
 * 「点哪个？」而不是「这篇很相关」。
 */
export function dropSeenNotes(hits: SemanticHit[], seenNoteIds: number[]): SemanticHit[] {
  const seen = new Set(seenNoteIds)
  return hits.filter((hit) => !seen.has(hit.noteId))
}

/**
 * 「只认最后一次」的请求闸门：每次调用都真的发请求，但**只有最后发出的那一次
 * 的结果会被 commit**，先发后到的一律丢掉。
 *
 * 为什么非要有它：语义检索每敲一个键都要先过一次 embedding 请求，比字面检索
 * 慢一个数量级，而慢请求的返回顺序不由我们说了算。少了这道闸门，「知识图」的
 * 结果会在「知识图谱」的结果之后落地，把已经对的那一屏改成旧的——不报错，
 * 只是显示的东西和输入框里的字对不上，而且很难复现。
 *
 * 闸门只管「新旧」，不管组件死活：卸载后不该再 setState 是调用方在 `commit`
 * 里自己判断的事（两件事的判据不同，混在一起会让其中一个失效而没人发现）。
 */
export type LatestOnly<T> = (input: string, commit: (value: T) => void) => Promise<void>

export function createLatestOnly<T>(run: (input: string) => Promise<T>): LatestOnly<T> {
  let latest = 0
  return async (input, commit) => {
    latest += 1
    const seq = latest
    const value = await run(input)
    // 期间又发过新的，这一份已经过期：丢掉，什么都不做。
    if (seq !== latest) return
    commit(value)
  }
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/**
 * 内存占用的人话形式。设置面板拿它显示向量索引占了多少内存——
 * 「125829120」这个数字对用户没有任何意义，「120.0 MB」才有。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'

  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }

  // 字节这一档不带小数：「512.0 B」既不好读，那位小数也没有多出任何信息。
  if (unit === 0) return `${Math.round(value)} B`
  return `${value.toFixed(1)} ${BYTE_UNITS[unit]}`
}
