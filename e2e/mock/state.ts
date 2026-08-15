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

/// 假的「服务器上有一个新版本」。null = 没有更新（`plugin:updater|check` 返回 null）。
export interface MockUpdate {
  version: string
  /// 更新说明，对应 latest.json 的 notes / Update.body
  notes: string
  /// 更新包总字节数。null = 服务端没给 Content-Length——
  /// 界面必须退化成「已下载 x MB」而不是一个永远 0% 的假进度条。
  contentLength: number | null
  /// 每个分块的字节数，按顺序投递给下载回调
  chunks: number[]
  /// 分块之间的间隔。给测试留出观察进度的窗口：
  /// 一口气投完的话，界面从 0% 直接跳到重启，进度到底显没显示就断言不到了。
  chunkDelayMs: number
}

export interface MockInit {
  /// 当前窗口 label，决定 main.tsx 渲染主窗口还是快捕窗口
  windowLabel: 'main' | 'capture'
  /// 外壳报的应用版本（`plugin:app|version`）。设置面板显示的「当前版本」就是它。
  appVersion: string
  /// 更新源上的新版本。默认 null——绝大多数测试跑的是「没有更新」这条路。
  update: MockUpdate | null
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
    appVersion: '0.1.0',
    update: null,
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

/// 造一个待发布的新版本。默认 4 个 256 KB 的分块，总共 1 MB。
export function availableUpdate(version: string, patch: Partial<MockUpdate> = {}): MockUpdate {
  const chunk = 256 * 1024
  return {
    version,
    notes: `${version} 的更新说明`,
    contentLength: chunk * 4,
    chunks: [chunk, chunk, chunk, chunk],
    chunkDelayMs: 60,
    ...patch,
  }
}

/// 造 n 条笔记，标题形如「笔记 1」。分页测试用。
export function notes(count: number, prefix = '笔记'): MockNote[] {
  return Array.from({ length: count }, (_, index) => note(index + 1, `${prefix} ${index + 1}`))
}
