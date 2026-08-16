// 前端与 Rust 后端之间唯一的通道。
//
// 两条约定，改动前请先读：
//
// 1. 下面的类型与 `crates/core` 里的 Rust 结构体一一对应。Rust 侧用 serde 默认序列化，
//    字段名是 snake_case；这里统一暴露成 camelCase，转换由 `toCamel` 在运行时完成。
//    **改了 Rust 那边的结构体或命令签名，就必须同步改这里**——TS 编译器看不见 Rust，
//    对不上时不会报错，只会在运行时拿到 undefined。
// 2. 这是整个前端唯一允许调用 `invoke` 的地方。组件一律走 `ipc.*`，
//    这样命令名、参数名、类型转换只有一处需要维护，也方便日后统一加日志或重试。
//
// 参数名注意：Tauri 2 会把 JS 侧的 camelCase 参数名自动转成 Rust 的 snake_case，
// 所以这里传 `bodyJson`，Rust 收到的是 `body_json`。
//
// 错误：所有命令失败时 reject 一个字符串（中文错误消息，如「笔记不存在: 7」），
// 调用方 catch 到的就是 string，不是 Error 对象。

import { Channel, invoke } from '@tauri-apps/api/core'

// ---------- 类型（对应 crates/core 的 Rust 结构体） ----------

/** 对应 Rust `Note` */
export interface Note {
  id: number
  uuid: string
  title: string
  bodyJson: string
  bodyText: string
  createdAt: number
  updatedAt: number
  tags: string[]
  attachmentIds: number[]
}

/** 对应 Rust `NoteSummary`，列表页用，不含正文 */
export interface NoteSummary {
  id: number
  uuid: string
  title: string
  excerpt: string
  updatedAt: number
  tags: string[]
}

/** 对应 Rust `HitSource` 枚举，serde 序列化成字符串 */
export type HitSource = 'Literal' | 'PinyinFull' | 'PinyinHead'

/** 对应 Rust `SearchHit` */
export interface SearchHit {
  noteId: number
  uuid: string
  title: string
  excerpt: string
  matchedTerms: string[]
  source: HitSource
}

/** 对应 Rust `Attachment`。width/height 只有图片才有，其余为 null */
export interface Attachment {
  id: number
  sha256: string
  ext: string
  byteSize: number
  width: number | null
  height: number | null
}

/**
 * 对应 Rust `TagCount`，`list_all_tags` 返回。
 * 注意这是**全库**统计，不是「已加载的那一页里出现过的标签」。
 * 两个字段本来就没有下划线，`toCamel` 对它是恒等变换。
 */
export interface TagCount {
  name: string
  /** 全库带这个标签的未删除笔记条数 */
  count: number
}

// ---------- AI（对应 crates/shell 的 commands.rs 与 ai/ask.rs） ----------

/** 对应 Rust `AiStatus` */
export interface AiStatus {
  enabled: boolean
  configured: boolean
  /** 配置不完整时缺的那一项的中文名，完整时为 null */
  missingField: string | null
  pendingNotes: number
  indexedChunks: number
  memoryBytes: number
  /** 装载索引时跳过的维度不符行数，非 0 说明换过 embedding 模型但没重建 */
  dimMismatches: number
  lastError: string | null
}

/** 对应 Rust `EnableReport`，`ai_enable` 的回执 */
export interface EnableReport {
  pendingNotes: number
}

/**
 * 对应 Rust `ConnectionReport`。
 * 两条链路分开报：embedding 通了而对话没通（模型名写错）是常见的半通状态。
 */
export interface ConnectionReport {
  embedOk: boolean
  /** embedding 的维度，失败时为 null */
  embedDim: number | null
  chatOk: boolean
  /** 已脱敏，可以直接显示给用户 */
  error: string | null
}

/** 对应 Rust `Citation`。index 与回答正文里的 `[n]` 标注一一对应，从 1 起。 */
export interface Citation {
  index: number
  noteId: number
  uuid: string
  title: string
  heading: string
  excerpt: string
}

/**
 * 对应 Rust `ChatMessage`。
 * Rust 那边 `role` 的类型是 String，这里收窄成两个字面量——写入方只有编排层，
 * 只会写 `user` / `assistant`。收窄是为了让渲染分支能被穷尽检查。
 */
export interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  citations: Citation[]
  createdAt: number
}

/** 对应 Rust `Conversation` */
export interface Conversation {
  id: number
  title: string
  createdAt: number
  updatedAt: number
}

/** 对应 Rust `SemanticHit`，已按笔记去重、按 score 降序 */
export interface SemanticHit {
  noteId: number
  uuid: string
  title: string
  excerpt: string
  score: number
}

/**
 * Channel 投递过来的引用，字段名是 Rust 那边的 snake_case。
 *
 * 和 `Citation` 是同一个 Rust 结构体的两副面孔：走命令返回值时被 `toCamel`
 * 洗成了 `noteId`，走 Channel 时**没人洗**，就是 `note_id`。
 * 别把这里换成 `Citation`——TS 不会报错，运行时 `noteId` 是 undefined，
 * 点引用会跳到一篇 id 为 undefined 的笔记上。
 * 归一化由 `lib/ai.ts` 的 `reduceAsk` 负责，界面只见 `Citation` 一种形状。
 */
export interface RawCitation {
  index: number
  note_id: number
  uuid: string
  title: string
  heading: string
  excerpt: string
}

/**
 * 对应 Rust `AskEvent`。serde 的默认外部标签把有字段的变体序列化成单键对象
 * `{"Delta":{"text":"…"}}`，**无字段的 `Cancelled` 则是裸字符串** `"Cancelled"`。
 *
 * 两处容易栽跟头，都会表现为「界面安静地什么都不显示」而不是报错：
 *
 * 1. **这条路径不经过 `toCamel`**：Channel 的载荷由 Tauri 直接投递，
 *    所以字段名必须写成 Rust 那边的 snake_case（`message_id`、`note_id`）。
 * 2. 判别时**必须先处理 `typeof event === 'string'` 这一支**，
 *    否则取消事件会被当成对象去取键，静默地什么也匹配不上。
 */
export type AskEvent =
  | { Retrieved: { citations: RawCitation[] } }
  | { Delta: { text: string } }
  | { Done: { message_id: number } }
  | { Failed: { message: string } }
  | 'Cancelled'

/** 索引进度事件名。载荷 `{ pending, indexed }`，是普通 Tauri 事件而非 Channel。 */
export const AI_INDEX_PROGRESS_EVENT = 'ai://index-progress'

/** `ai://index-progress` 的载荷。两个键本来就没有下划线，不需要 `toCamel`。 */
export interface IndexProgress {
  pending: number
  indexed: number
}

// ---------- snake_case → camelCase ----------

function camelKey(key: string): string {
  let out = ''
  let pendingUpper = false
  let seenChar = false
  for (const ch of key) {
    if (ch === '_') {
      // 前导下划线原样保留，中间的下划线才是分隔符
      if (seenChar) pendingUpper = true
      else out += ch
      continue
    }
    out += pendingUpper ? ch.toUpperCase() : ch
    pendingUpper = false
    seenChar = true
  }
  // 尾部下划线没有后继字符可大写，还原回去
  if (pendingUpper) out += '_'
  return out
}

/**
 * 递归把 snake_case 键转成 camelCase。数组逐项递归，标量原样返回。
 * 导出仅为了单测——业务代码请走 `ipc.*`。
 *
 * 坑：`typeof null === 'object'`，所以 null 必须先于对象判断，
 * 否则 `Attachment.width` 这种可空字段会被 Object.entries 炸掉。
 */
export function toCamel<T>(value: unknown): T {
  if (value === null || typeof value !== 'object') return value as T
  if (Array.isArray(value)) return value.map((item) => toCamel(item)) as T

  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[camelKey(key)] = toCamel(val)
  }
  return out as T
}

// ---------- 命令封装 ----------

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return toCamel<T>(await invoke(command, args))
}

export const ipc = {
  createNote(bodyJson: string, attachmentIds: number[] = []): Promise<Note> {
    return call<Note>('create_note', { bodyJson, attachmentIds })
  },

  updateNote(id: number, bodyJson: string, attachmentIds: number[] = []): Promise<Note> {
    return call<Note>('update_note', { id, bodyJson, attachmentIds })
  },

  getNote(id: number): Promise<Note> {
    return call<Note>('get_note', { id })
  },

  listNotes(limit = 100, offset = 0): Promise<NoteSummary[]> {
    return call<NoteSummary[]>('list_notes', { limit, offset })
  },

  /**
   * 按标签列出笔记，排序与 listNotes 一致（updated_at DESC）。
   * 走后端而不是在前端过滤已加载的那一页——否则「筛选」只对最近 N 条生效。
   */
  listNotesByTag(tag: string, limit = 100, offset = 0): Promise<NoteSummary[]> {
    return call<NoteSummary[]>('list_notes_by_tag', { tag, limit, offset })
  },

  /** 全库标签与计数（未删除的笔记）。 */
  listAllTags(): Promise<TagCount[]> {
    return call<TagCount[]>('list_all_tags')
  },

  /** 软删除，可用 restoreNote 撤销 */
  deleteNote(id: number): Promise<void> {
    return call<void>('delete_note', { id })
  },

  restoreNote(id: number): Promise<void> {
    return call<void>('restore_note', { id })
  },

  listDeletedNotes(limit = 100, offset = 0): Promise<NoteSummary[]> {
    return call<NoteSummary[]>('list_deleted_notes', { limit, offset })
  },

  /**
   * 彻底删除一条**已软删除**的笔记，不可撤销。
   * 附件不会立刻消失：解除引用后要等下一轮 collectGarbage（有宽限期）才回收。
   */
  purgeNote(id: number): Promise<void> {
    return call<void>('purge_note', { id })
  },

  /** 清空回收站，返回彻底删除的条数。不可撤销。 */
  purgeAllDeleted(): Promise<number> {
    return call<number>('purge_all_deleted')
  },

  searchNotes(query: string, limit = 30): Promise<SearchHit[]> {
    return call<SearchHit[]>('search_notes', { query, limit })
  },

  /** 返回重建的笔记条数 */
  rebuildIndex(): Promise<number> {
    return call<number>('rebuild_index')
  },

  storeAttachment(bytes: number[], ext: string): Promise<Attachment> {
    return call<Attachment>('store_attachment', { bytes, ext })
  },

  /**
   * 读附件字节。**唯一一个绕开 `call`（也就是绕开 `toCamel`）的命令**：
   * Rust 侧走 Tauri 的 raw 通道直接返回二进制，JS 拿到的是 ArrayBuffer——
   * 而 `toCamel` 见到非 null 的 object 就会 `Object.entries` 遍历它，
   * ArrayBuffer 会被拆成一个空对象，字节全丢。
   *
   * （改成 raw 通道是为了避开 JSON 数组：一张 2MB 的图走 `number[]`
   * 序列化出来是 7MB 文本，两头各解析一遍。）
   */
  readAttachment(id: number): Promise<ArrayBuffer> {
    return invoke<ArrayBuffer>('read_attachment', { id })
  },

  /** 清理无人引用的附件，返回删除的文件数 */
  collectGarbage(): Promise<number> {
    return call<number>('collect_garbage')
  },

  /**
   * 让快捕窗口收起自己。
   *
   * 不能用 `getCurrentWindow().hide()`：那条路要 `core:window:allow-hide` 权限，
   * 而 capabilities 里给的 `core:window:default` 是纯只读集合、不含它，
   * invoke 会被 ACL 直接拒掉——症状是笔记存进去了，窗口却赖在屏幕上。
   * 走命令层则只依赖 Rust 侧的窗口句柄，与前端权限无关。
   */
  hideCaptureWindow(): Promise<void> {
    return call<void>('hide_capture_window')
  },

  /**
   * 「待保存的内容已经落盘，可以退了」——`app-quit-requested` 事件的回执。
   *
   * 必须在落盘之后调一次，**成功失败都要调**：不调也退得掉（外壳有 2 秒兜底），
   * 但那 2 秒里用户对着一个点了没反应的退出菜单。
   */
  confirmQuit(): Promise<void> {
    return call<void>('confirm_quit')
  },

  /**
   * 读全部设置。**第二个绕开 `call`（也就是绕开 `toCamel`）的命令**，理由和
   * readAttachment 不同但同样致命：
   *
   * 返回的是一张 BTreeMap，它的**键是设置项名**（`macos.hide_dock_icon`），
   * 不是 Rust 结构体的字段名。`toCamel` 见到对象就递归改键，会把它变成
   * `macos.hideDockIcon`——之后拿 SETTING_KEYS 里的常量去取值，全是 undefined，
   * 界面上表现为「所有设置都是默认值，改完刷新又变回去」。
   *
   * 值一律是字符串，语义解释在 lib/settings.ts。
   */
  getSettings(): Promise<Record<string, string>> {
    return invoke<Record<string, string>>('get_settings')
  },

  // 外壳还有一个通用的 `set_setting`，这里**刻意不封装**：三个设置项全都不能只写库。
  // 热键要真的注册上去、Dock 图标要真的切换、自启要真的写进 LaunchAgent/注册表，
  // 各自都有下面的专用命令（它们都是先动系统、成功了才落库，失败会回滚）。
  // 只走 set_setting 的结果是库里是新值、系统上还是旧行为，而且没有任何报错。
  // 将来真有「纯记录型」的设置项时再加回来。

  /**
   * 换快捕热键并落库。`accelerator` 语法见 lib/accelerator.ts。
   * 失败时（最常见是被别的应用占用）reject 一句中文，里面会说明原热键保持不变。
   */
  setCaptureHotkey(accelerator: string): Promise<void> {
    return call<void>('set_capture_hotkey', { accelerator })
  },

  /** 隐藏 / 显示 Dock 图标（仅 macOS 有实际效果），并落库。 */
  setHideDockIcon(hide: boolean): Promise<void> {
    return call<void>('set_hide_dock_icon', { hide })
  },

  /** 开 / 关开机自启（真的写系统的自启项），并落库。 */
  setAutostart(enabled: boolean): Promise<void> {
    return call<void>('set_autostart', { enabled })
  },

  // ---------- AI ----------

  /** AI 的开关、配置完整性与索引进度。设置面板每次打开与收到进度事件时都拉一次。 */
  aiStatus(): Promise<AiStatus> {
    return call<AiStatus>('ai_status')
  },

  /**
   * 开 / 关 AI，返回还有多少篇笔记等着建索引。
   *
   * 开启会真的开始调用模型服务、产生费用，所以调用方必须先拿 `pendingNotes`
   * 让用户确认，用户反悔就立刻 `aiEnable(false)` 回滚。
   */
  aiEnable(enabled: boolean): Promise<EnableReport> {
    return call<EnableReport>('ai_enable', { enabled })
  },

  /** 连通性自检。会真的各发一次 embedding 与对话请求。 */
  aiTestConnection(): Promise<ConnectionReport> {
    return call<ConnectionReport>('ai_test_connection')
  },

  /** 清空并重建全部向量索引，返回入队的笔记条数。换 embedding 模型后必须做。 */
  aiReindexAll(): Promise<number> {
    return call<number>('ai_reindex_all')
  },

  /** 重试之前向量化失败的笔记，返回重新入队的条数。 */
  aiRetryFailed(): Promise<number> {
    return call<number>('ai_retry_failed')
  },

  /**
   * 发起提问。**命令立刻返回**（Rust 侧另起线程干活），答案全部走 channel 流式推来，
   * 所以这个 Promise 落定不代表回答结束——别在 await 之后收起「正在思考」。
   *
   * 同一时刻只允许一个提问在飞，新的提问会自动取消上一个。
   * 调用方仍要负责在组件卸载或切换会话时调 `aiCancel`。
   *
   * 刻意不走 `call`：`Channel` 必须原样交给 `invoke`（它靠自身的 `toJSON`
   * 序列化成 `__CHANNEL__:<id>`），而返回值是 null，没有可转换的东西。
   */
  aiAsk(
    conversationId: number,
    question: string,
    onEvent: (event: AskEvent) => void,
  ): Promise<void> {
    // 回调经构造函数传入而不是事后赋值，少一个「忘了赋值就静默不响应」的窗口。
    const channel = new Channel<AskEvent>(onEvent)
    return invoke<void>('ai_ask', { conversationId, question, onEvent: channel })
  },

  /** 取消在飞的提问。没有在飞的提问时什么也不做，不是错误。 */
  aiCancel(): Promise<void> {
    return call<void>('ai_cancel')
  },

  /**
   * 语义检索。**AI 未启用 / 未配置全 / 查询为空 / limit 为 0 时返回 `[]` 而不是报错**，
   * 调用方不必自己判断能不能用，也不该为此弹错误横幅。
   */
  aiSemanticSearch(query: string, limit = 10): Promise<SemanticHit[]> {
    return call<SemanticHit[]>('ai_semantic_search', { query, limit })
  },

  /** 会话列表，按 updated_at 降序。 */
  aiListConversations(limit = 50, offset = 0): Promise<Conversation[]> {
    return call<Conversation[]>('ai_list_conversations', { limit, offset })
  },

  /** 新建空会话，返回它的 id。标题会在第一次提问后由后端改写。 */
  aiCreateConversation(): Promise<number> {
    return call<number>('ai_create_conversation')
  },

  /** 一个会话的全部消息，按时间升序。`citations` 为空时是 `[]` 而不是 null。 */
  aiGetMessages(conversationId: number): Promise<ChatMessage[]> {
    return call<ChatMessage[]>('ai_get_messages', { conversationId })
  },

  aiDeleteConversation(id: number): Promise<void> {
    return call<void>('ai_delete_conversation', { id })
  },

  aiRenameConversation(id: number, title: string): Promise<void> {
    return call<void>('ai_rename_conversation', { id, title })
  },
}
