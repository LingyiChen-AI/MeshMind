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

/// 一条引用，字段名照抄 Rust 的 `Citation`。
///
/// **是 `note_id` 不是 `noteId`**。这个结构体走两条路回到前端：命令返回值那条
/// 被 `toCamel` 洗过，Channel 那条**没人洗**。假实现里图省事写成 camelCase，
/// 等于替 `lib/ai.ts` 的 `normalizeCitation` 把活先干了——它写错的时候
/// （点引用跳到一篇 id 为 undefined 的笔记上，已经真实发生过一次）测试照样全绿。
export interface MockCitation {
  /// 与回答正文里 `[n]` 的编号一致，从 1 起
  index: number
  note_id: number
  uuid: string
  title: string
  heading: string
  excerpt: string
}

/// 一条会话消息，字段名照抄 Rust 的 `ChatMessage`。
export interface MockChatMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  citations: MockCitation[]
  created_at: number
}

/// 一个会话，字段名照抄 Rust 的 `Conversation`。
export interface MockConversation {
  id: number
  title: string
  created_at: number
  updated_at: number
}

/// 一条语义检索结果，字段名照抄 Rust 的 `SemanticHit`。
export interface MockSemanticHit {
  note_id: number
  uuid: string
  title: string
  excerpt: string
  score: number
}

/// `ai_test_connection` 的回执，字段名照抄 Rust 的 `ConnectionReport`。
export interface MockConnectionReport {
  embed_ok: boolean
  /// embedding 的维度，不通时为 null
  embed_dim: number | null
  chat_ok: boolean
  error: string | null
}

/// `AskEvent` 的 JSON 形状。serde 的默认外部标签把有字段的变体序列化成单键对象，
/// **无字段的 `Cancelled` 则是裸字符串**——照抄 `crates/shell/src/ai/ask.rs`。
///
/// 写成 `{ Cancelled: {} }` 或者把 `message_id` 写成 `messageId`，前端的
/// `reduceAsk` 会一条都匹配不上，界面安静地什么都不显示、也不报错。
export type MockAskEvent =
  | { Retrieved: { citations: MockCitation[] } }
  | { Delta: { text: string } }
  | { Done: { message_id: number } }
  | { Failed: { message: string } }
  | 'Cancelled'

/// AI 那部分的假状态。
///
/// **开关与配置完整性不在这里**：它们和真实后端一样从 `settings` 派生
/// （`config::is_enabled` / `config::missing`），这样 `ai_enable` 写完库之后
/// 下一次 `ai_status` 才会跟着变。摆成一个独立的布尔的话，
/// 「开关写库了但状态没跟上」这类缺陷在测试里完全看不见。
///
/// 字段名的规矩和 `MockUpdate` 一致：这里的标量是**测试旋钮**，由假实现拼装成
/// `AiStatus` 之后才交给前端，所以用 camelCase；而 `connection`、`conversations`、
/// `messages`、`semanticHits` 里的东西是**原样吐给前端的后端结构体**，
/// 一律 snake_case。
export interface MockAi {
  /// 还有多少篇笔记等着建索引。`ai_enable(true)` / `ai_reindex_all` 会把它改写成当前笔记数
  pendingNotes: number
  /// 向量化失败、等着重试的篇数。`ai_retry_failed` 返回它并清零
  failedNotes: number
  indexedChunks: number
  memoryBytes: number
  /// 装载索引时跳过的维度不符行数，非 0 说明换过 embedding 模型但没重建
  dimMismatches: number
  lastError: string | null
  connection: MockConnectionReport
  conversations: MockConversation[]
  /// 会话 id（键是字符串，结构化克隆之后数字键本来就会变成字符串）→ 消息
  messages: Record<string, MockChatMessage[]>
  /// `ai_semantic_search` 的返回。AI 没开 / 没配全 / 查询为空时假实现照样返回 `[]`，
  /// 和真实后端一样——搜索框每敲一个键都会调它，它不该报错。
  semanticHits: MockSemanticHit[]
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
  ai: MockAi
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
    ai: aiState(),
    ...overrides,
  }
}

/// AI 的假状态。默认是「一片空白但连得通」：没有会话、没有索引、
/// 测试连接两条链路都通——绝大多数用例只需要覆盖其中一两项。
export function aiState(overrides: Partial<MockAi> = {}): MockAi {
  return {
    pendingNotes: 0,
    failedNotes: 0,
    indexedChunks: 0,
    memoryBytes: 0,
    dimMismatches: 0,
    lastError: null,
    connection: { embed_ok: true, embed_dim: 1536, chat_ok: true, error: null },
    conversations: [],
    messages: {},
    semanticHits: [],
    ...overrides,
  }
}

/// 一份填全了的 AI 配置（OpenAI 兼容 + 密钥）。
///
/// **`ai.enabled` 不在里面**：「配好了」和「还没开」是两个不同的界面状态
/// （引导页上一句是「先去设置里配置」，另一句是「AI 还没启用」），
/// 而启用确认框那条路只在「配好了但没开」时才走得到。
export function aiConfigured(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'ai.provider': 'openai',
    'ai.base_url': 'https://api.example.com/v1',
    'ai.api_key': 'sk-test',
    'ai.chat_model': 'chat-x',
    'ai.embed_model': 'embed-x',
    ...overrides,
  }
}

/// 配好了并且已经开着。
export function aiEnabled(overrides: Record<string, string> = {}): Record<string, string> {
  return aiConfigured({ 'ai.enabled': 'true', ...overrides })
}

/// 造一个会话。`updated_at` 跟着 id 走，好让「按 updated_at 降序」的列表顺序可预测。
export function conversation(
  id: number,
  title: string,
  patch: Partial<MockConversation> = {},
): MockConversation {
  return { id, title, created_at: 1_000 + id, updated_at: 1_000 + id, ...patch }
}

/// 造一条引用。`note_id` 默认等于 index 对应的那条笔记。
export function citation(index: number, noteId: number, patch: Partial<MockCitation> = {}): MockCitation {
  return {
    index,
    note_id: noteId,
    uuid: `uuid-${noteId}`,
    title: `笔记 ${noteId}`,
    heading: '',
    excerpt: `笔记 ${noteId} 里的一段`,
    ...patch,
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
