/// 注入到浏览器上下文的初始状态。必须是可结构化克隆的纯数据——
/// Playwright 的 addInitScript 只传一个序列化后的参数，闭包变量不会跟过去。
///
/// 字段一律 snake_case：这份数据会被 mock 原样当作「后端返回的结构体」吐给前端，
/// 而真实 Rust 侧用 serde 默认序列化，出来的就是 snake_case。写成 camelCase
/// 等于替前端把 `toCamel` 的活儿先干了，`toCamel` 的 bug 就永远测不出来。
export interface MockNote {
  id: number
  uuid: string
  title: string
  body_json: string
  body_text: string
  created_at: number
  updated_at: number
  /// 软删除时间戳。非 null = 在回收站里。
  deleted_at: number | null
  tags: string[]
  attachment_ids: number[]
}

export interface MockInit {
  /// 当前窗口 label，决定 main.tsx 渲染主窗口还是快捕窗口
  windowLabel: 'main' | 'capture'
  notes: MockNote[]
  /// 键是设置项名（`hotkey.capture` 这类含点号的串），不是结构体字段名
  settings: Record<string, string>
  /// 命令名 → 错误消息。设了的命令每次调用都失败（reject 裸字符串）。
  failCommands: Record<string, string>
  /// 命令名 → 额外延迟毫秒，用来构造「保存很慢」这类竞态
  delays: Record<string, number>
  /// 覆盖 search_notes 的返回。设了之后 mock 不再自己算命中，
  /// 直接吐这份数据——用来精确构造 matched_terms / source 的组合。
  searchHits: MockSearchHit[] | null
}

/// 一条检索结果，字段名照抄 Rust 的 `SearchHit`。
export interface MockSearchHit {
  note_id: number
  uuid: string
  title: string
  excerpt: string
  matched_terms: string[]
  source: 'Literal' | 'PinyinFull' | 'PinyinHead'
}

export function initialState(overrides: Partial<MockInit> = {}): MockInit {
  return {
    windowLabel: 'main',
    notes: [],
    settings: {},
    failCommands: {},
    delays: {},
    searchHits: null,
    ...overrides,
  }
}

/// 造一条笔记。`text` 同时充当标题与正文首行（真实后端的标题就是正文首个非空行）。
export function note(id: number, text: string, patch: Partial<MockNote> = {}): MockNote {
  const body_json = JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  })
  return {
    id,
    uuid: `uuid-${id}`,
    title: text,
    body_json,
    body_text: text,
    created_at: 1_000 + id,
    updated_at: 1_000 + id,
    deleted_at: null,
    tags: [],
    attachment_ids: [],
    ...patch,
  }
}

/// 造 n 条笔记，标题形如「笔记 1」。分页测试用。
export function notes(count: number, prefix = '笔记'): MockNote[] {
  return Array.from({ length: count }, (_, index) => note(index + 1, `${prefix} ${index + 1}`))
}
