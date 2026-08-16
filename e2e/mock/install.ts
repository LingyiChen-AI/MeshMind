import type { MockChatMessage, MockCitation, MockInit } from './state'

/// 在应用加载前顶替 `window.__TAURI_INTERNALS__`，用一份内存假实现冒充 Rust 外壳。
///
/// ## 这个函数会被序列化后在浏览器里执行
///
/// Playwright 的 `addInitScript` 把函数体转成字符串扔进页面，**闭包变量不会跟过去**。
/// 所以这里不能引用任何外部标识符，只能用它自己的参数（`import type` 会被完全擦掉，
/// 不算引用）。
///
/// ## 假实现同时是间谍
///
/// 本项目已确证的三个真实缺陷（自动保存漏传 attachmentIds、matched_terms 混入标点、
/// 托盘退出未落盘）全是**调用形状**的缺陷，断言页面长什么样一个都抓不住。
/// 所以每次 invoke 都记进 `state.calls`，测试断言的是「发出去的那串调用对不对」。
///
/// ## 保真度纪律（漂移了会让测试全绿而应用是坏的，比没有测试更糟）
///
/// 1. 结构体字段一律 **snake_case**（`body_json` / `note_id` / `matched_terms`）——
///    真实 Rust 侧 serde 默认序列化就是这样，前端的 `toCamel` 负责转换。
///    这里图省事返回 camelCase，`toCamel` 自身的 bug 就永远测不出来。
/// 2. 两个刻意绕开 `toCamel` 的命令照抄真实情况：`read_attachment` 返回
///    **ArrayBuffer**（不是数组），`get_settings` 的键是**设置项名**
///    （`macos.hide_dock_icon`，含点号，不该被 camel 化）。
/// 3. 失败时 reject 的是**裸字符串**，不是 Error 对象——真实 `CommandError`
///    就是这么序列化的，前端各处 `String(err)` 拿到的就是那句中文。
/// 4. `AskEvent` 照 serde 的**外部标签**写：有字段的变体是单键对象
///    （`{ Delta: { text } }`、`{ Done: { message_id } }`），无字段的 `Cancelled`
///    是**裸字符串**。这条路径不经过 `toCamel`，`message_id` / `note_id` 写成
///    camelCase 的话前端一条都匹配不上，界面安静地什么都不显示、还不报错。
/// 5. `get_settings` 要照 `redact_settings` 那样**把 `ai.api_key` 摘掉、换成合成的
///    `ai.api_key_set`**。原样吐回密钥的话，「密钥永远不经 IPC 回到 webview」
///    这条约束就没人守了，而且设置面板读的是那个合成键，不摆出来它永远显示「未设置」。
///
/// ## `__TAURI_INTERNALS__` 的形状按 @tauri-apps/api 2.11.1 的源码对齐
///
/// - `core.js`：`invoke(cmd, args, options)`、`transformCallback(cb, once)`、
///   `unregisterCallback(id)`、`convertFileSrc(path, protocol)`
/// - `window.js`：`metadata.currentWindow.label`（`getCurrentWindow()` 读它）
/// - `event.js` 的 `_unlisten` 会先调
///   **`window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener(event, eventId)`**，
///   再 invoke `plugin:event|unlisten`。这个全局对象不摆出来的话，`_unlisten`
///   会在第一行就 TypeError，后面那句 invoke 根本到不了——于是监听器永远摘不掉。
///   React StrictMode 一挂载就会 listen / unlisten / listen 一轮，泄漏是必现的，
///   后果是每个事件被投递两次（实测：`app-quit-requested` 让 `confirm_quit`
///   被调用 2 次而不是 1 次）。页面不会白屏，所以这个坑只会以「时序测试莫名其妙
///   数字翻倍」的形式暴露出来。
export function installMock(init: MockInit): void {
  interface Call {
    cmd: string
    args: Record<string, unknown>
    /// invoke 进来的时刻（performance.now()）
    startedAt: number
    /// 结果落地的时刻。还在途中时是 null——两个字段一起就能回答
    /// 「有没有两次调用在时间上重叠」，也就是串行化到底生没生效。
    settledAt: number | null
  }

  interface Note {
    id: number
    uuid: string
    title: string
    body_json: string
    body_text: string
    created_at: number
    updated_at: number
    deleted_at: number | null
    tags: string[]
    attachment_ids: number[]
  }

  /// 一次在飞的提问。`ai_ask` 开一条，测试用 `emitAsk` 往里投事件。
  interface AskSession {
    /// Channel 构造时从 transformCallback 拿到的回调 id
    callbackId: number
    conversationId: number
    /// 下一个信封的序号。Channel 内部靠它保序，跳号的消息会被永远压在队列里
    index: number
    /// 已经投出去的 Delta 拼起来。`Done` 时按真实实现落库
    answer: string
    citations: MockCitation[]
    /// 终止事件已经发过了。真实实现里那之后 Tauri 会把回调注销
    ended: boolean
  }

  const initial = init.notes.map((n) => ({ ...n }))

  // 深拷一份：假实现会就地改它（新建会话、落库消息、改 pendingNotes），
  // 而 init 是注入进来的那份初始数据，改它等于让「初始状态」随测试跑动而漂移。
  const ai = JSON.parse(JSON.stringify(init.ai)) as MockInit['ai']

  const state = {
    notes: initial as Note[],
    appVersion: init.appVersion,
    update: init.update,
    settings: { ...init.settings },
    nextId: initial.reduce((max, n) => Math.max(max, n.id), 0) + 1,
    // 单调时钟。真实后端用 `now_ms()`，同一次会话里后写的一定更大；
    // 用 `updated_at += 1` 会撞上别的笔记的时间戳，让「刚编辑的那条跳到最前」
    // 这条列表语义在测试里失真。
    clock: initial.reduce((max, n) => Math.max(max, n.updated_at, n.deleted_at ?? 0), 0) + 1,
    calls: [] as Call[],
    failCommands: { ...init.failCommands },
    delays: { ...init.delays },
    searchHits: init.searchHits,
    // eventId → 事件名。真实实现里 eventId 就等于 transformCallback 给的回调 id
    // （见 mocks.js 的 unregisterListener 直接拿它去 unregisterCallback）。
    listeners: new Map<number, string>(),
    callbacks: new Map<number, (payload: unknown) => void>(),
    nextCallbackId: 1,
    ai,
    // 按 `ai_ask` 的调用顺序排。测试用下标指定「投给第几次提问的那条 channel」——
    // 「上一次提问的取消事件迟到了」这种场景没有下标就构造不出来。
    asks: [] as AskSession[],
    nextConversationId:
      ai.conversations.reduce((max, c) => Math.max(max, c.id), 0) + 1,
    nextMessageId:
      Object.values(ai.messages)
        .flat()
        .reduce((max, m) => Math.max(max, m.id), 0) + 1,
  }

  // 跨 page 的事件通道。两个窗口是两个独立的 page，内存不共享，
  // 靠同源的 BroadcastChannel 传递事件。
  const channel = new BroadcastChannel('meshmind-e2e-events')

  const w = window as unknown as Record<string, unknown>

  w.__IPC_MOCK__ = {
    calls: () => state.calls.map((c) => ({ ...c })),
    reset: () => {
      state.calls.length = 0
    },
    failCommand: (cmd: string, message: string) => {
      state.failCommands[cmd] = message
    },
    clearFailure: (cmd: string) => {
      delete state.failCommands[cmd]
    },
    setDelay: (cmd: string, ms: number) => {
      state.delays[cmd] = ms
    },
    setSearchHits: (hits: unknown) => {
      state.searchHits = hits as MockInit['searchHits']
    },
    setSemanticHits: (hits: unknown) => {
      state.ai.semanticHits = hits as MockInit['ai']['semanticHits']
    },
    /// 把一个 `AskEvent` 投给第 `which` 次 `ai_ask` 开出来的 channel（null = 最后一次）。
    ///
    /// **信封是 `{ index, message }`，index 从 0 起严格递增。** 这不是可有可无的包装：
    /// `Channel` 登记进 `transformCallback` 的**不是**调用方给的 `onmessage`，
    /// 而是它内部的一个保序泵（见 @tauri-apps/api 2.11.1 的 core.js）。泵收到的
    /// index 和它期待的对不上就压进 `pendingMessages` 里等着，`onmessage` 一次都不会
    /// 触发。直接投裸 `AskEvent` 的话面板永远空白，**而且不报任何错**——
    /// 假实现全绿、应用是坏的，正是这份文件顶上那段纪律要防的东西。
    emitAsk: (event: unknown, which: number | null) => {
      const session = which === null ? state.asks[state.asks.length - 1] : state.asks[which]
      // 抛而不是静默返回。投不出去只有两种原因：前端根本没发 `ai_ask`，
      // 或者这条 channel 已经结束了——两种都该让用例当场红掉。
      if (session === undefined) throw new Error('还没有第 ' + String(which) + ' 条 ai_ask channel')
      if (session.ended) throw new Error('这条 channel 已经收过终止事件，Tauri 早把它注销了')
      const callback = state.callbacks.get(session.callbackId)
      if (callback === undefined) throw new Error('channel 的回调已经不在了')

      let terminal = event === 'Cancelled'
      if (typeof event === 'object' && event !== null) {
        // 摊平成「四个键都可选」：`Partial<联合类型>` 会按分支分配，
        // 每个分支都只认得自己那一个键，取别的键就成了类型错误。
        const body = event as {
          Retrieved?: { citations: MockCitation[] }
          Delta?: { text: string }
          Done?: { message_id: number }
          Failed?: { message: string }
        }
        if (body.Retrieved) session.citations = body.Retrieved.citations
        if (body.Delta) session.answer += body.Delta.text
        if (body.Failed) terminal = true
        if (body.Done) {
          terminal = true
          // 真实实现在发 `Done` **之前**就把回答落库了（ask.rs：append_assistant
          // 拿到 id，再 send(Done { message_id })）。顺序反过来的话，前端收到 Done
          // 立刻重拉消息，会拉到一个还没有助手回答的会话，屏幕上闪一下空白。
          // 失败与取消不落库——「半截回答不该留在消息流里」那条用例守的就是这个。
          appendMessage(
            session.conversationId,
            'assistant',
            session.answer,
            session.citations,
            body.Done.message_id,
          )
        }
      }

      callback({ index: session.index++, message: event })

      if (terminal) {
        session.ended = true
        // Rust 侧的 `Channel` 在提问线程结束时被丢弃，Tauri 随即补一个
        // `{ end: true, index }`（index 等于已发条数），JS 侧收到它才 unregisterCallback。
        callback({ index: session.index++, end: true })
      }
    },
    // 页面加载之后才让更新源「上新」，这样查到的那一次只可能来自手动检查——
    // 启动那次早就跑完并且返回了 null。
    setUpdate: (update: unknown) => {
      state.update = update as MockInit['update']
    },
    notes: () => state.notes.map((n) => ({ ...n })),
    settings: () => ({ ...state.settings }),
  }

  /// 一行行的纯文本。照抄 crates/core/src/notes/tiptap.rs 的 `extract_text`：
  /// 先塞自己的 text，再递归子节点，块级节点结束后换行；最后 trim 每行、丢掉空行。
  function plainText(bodyJson: string): string {
    const BLOCK_TYPES = [
      'paragraph',
      'heading',
      'listItem',
      'taskItem',
      'blockquote',
      'codeBlock',
      'horizontalRule',
    ]
    let doc: unknown
    try {
      doc = JSON.parse(bodyJson)
    } catch {
      // 真实后端在这里会返回 InvalidContent 错误，但前端从不发坏 JSON，
      // 真发了当空文档处理即可，不值得为此在假实现里造一条错误路径。
      return ''
    }
    let buffer = ''
    const walk = (node: Record<string, unknown>) => {
      if (typeof node.text === 'string') buffer += node.text
      const kids = node.content
      if (Array.isArray(kids)) kids.forEach((k) => walk(k as Record<string, unknown>))
      if (typeof node.type === 'string' && BLOCK_TYPES.indexOf(node.type) >= 0) buffer += '\n'
    }
    walk(doc as Record<string, unknown>)
    return buffer
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .join('\n')
  }

  /// 标题 = 正文首个非空行，最多 120 字符（tiptap::derive_title）。
  function deriveTitle(bodyText: string): string {
    const first = bodyText.split('\n').find((line) => line.trim() !== '')
    return first === undefined ? '' : [...first.trim()].slice(0, 120).join('')
  }

  /// 摘要 = 标题之后的正文，换行压成空格，最多 200 字符（tiptap::excerpt）。
  function excerpt(bodyText: string): string {
    const rest = bodyText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .slice(1)
      .join(' ')
    return [...rest].slice(0, 200).join('')
  }

  /// `#` 必须在行首或空白之后（tags::parse_tags 的正则），统一小写、按首次出现去重。
  function parseTags(text: string): string[] {
    const found = text.match(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu) ?? []
    const out: string[] = []
    for (const raw of found) {
      const tag = raw.trim().slice(1).toLowerCase()
      if (out.indexOf(tag) < 0) out.push(tag)
    }
    return out
  }

  /// NoteSummary。`withTags` 区分两条真实路径：`list` / `list_by_tag` 会为每条
  /// 补上 `tags::of_note`，而 `list_deleted` **不补**（那条 SQL 之后没有回填循环），
  /// 回收站里的笔记拿到的就是空数组。
  function summary(n: Note, withTags: boolean) {
    return {
      id: n.id,
      uuid: n.uuid,
      title: n.title,
      excerpt: excerpt(n.body_text),
      updated_at: n.updated_at,
      // tags::of_note 按名称排序
      tags: withTags ? [...n.tags].sort() : [],
    }
  }

  function live(): Note[] {
    return state.notes.filter((n) => n.deleted_at === null)
  }

  /// ORDER BY updated_at DESC, id DESC
  function byRecency(a: Note, b: Note): number {
    return b.updated_at - a.updated_at || b.id - a.id
  }

  function slice<T>(rows: T[], args: Record<string, unknown>): T[] {
    const offset = Number(args.offset ?? 0)
    const limit = Number(args.limit ?? 100)
    return rows.slice(offset, offset + limit)
  }

  function find(args: Record<string, unknown>): Note {
    const target = state.notes.find((n) => n.id === Number(args.id))
    // CoreError::NoteNotFound 的 Display 就是这句
    if (!target) throw `笔记不存在: ${String(args.id)}`
    return target
  }

  // ---------- AI ----------
  //
  // 开关与配置完整性一律**从 settings 派生**，和真实后端一个来源
  // （`config::is_enabled` / `config::load` / `config::missing`）。
  // 摆成两个独立的布尔的话，`ai_enable` 只写了库却没让状态跟着变这类缺陷
  // 在测试里完全看不见——而那正是「开关看着是开的，一篇笔记都不会被索引」的样子。

  /// 会话默认标题（`chat::UNTITLED`）。首个提问会把它改写成问题本身。
  const UNTITLED = '新对话'
  /// 标题最多取问题的前几个字（`chat::TITLE_MAX_CHARS`）。
  const TITLE_MAX_CHARS = 30

  function aiSetting(key: string): string {
    return (state.settings[key] ?? '').trim()
  }

  /// `settings::read_bool` 比的是**没 trim 过的原值**，这里照做。
  function aiIsEnabled(): boolean {
    return state.settings['ai.enabled'] === 'true'
  }

  /// 照抄 `crates/shell/src/ai/config.rs` 的 `missing`，**包括判断顺序**——
  /// 引导页上「还缺：X」显示的就是第一个不满足的那一项。
  /// Ollama 走本机，没有密钥这回事，所以它不检查 API Key。
  function aiMissing(): string | null {
    if (aiSetting('ai.base_url') === '') return 'Base URL'
    if (aiSetting('ai.chat_model') === '') return '对话模型'
    if (aiSetting('ai.embed_model') === '') return 'Embedding 模型'
    if (aiSetting('ai.provider') !== 'ollama' && aiSetting('ai.api_key') === '') return 'API Key'
    return null
  }

  /// 追加一条消息，并按 `chat::insert` 的两个副作用同步会话：顶起 `updated_at`
  /// （不然会话列表的排序永远停在创建时刻），首个提问改写标题（之后不再改）。
  function appendMessage(
    conversationId: number,
    role: 'user' | 'assistant',
    content: string,
    citations: MockCitation[],
    forcedId?: number,
  ): number {
    const target = state.ai.conversations.find((c) => c.id === conversationId)
    // CoreError::ConversationNotFound 的 Display 就是这句
    if (!target) throw `对话不存在: ${String(conversationId)}`
    const id = forcedId ?? state.nextMessageId
    state.nextMessageId = Math.max(state.nextMessageId, id + 1)
    const now = state.clock++
    const bucket = state.ai.messages[String(conversationId)] ?? []
    state.ai.messages[String(conversationId)] = bucket
    bucket.push({ id, role, content, citations: citations.map((c) => ({ ...c })), created_at: now })
    target.updated_at = now
    if (role === 'user' && target.title === UNTITLED) {
      target.title = [...content].slice(0, TITLE_MAX_CHARS).join('')
    }
    return id
  }

  /// 照抄 `commands::redact_settings`：把 `ai.api_key` 摘掉，换成合成的
  /// `ai.api_key_set`。密钥只有一条单向的写入路径，永远不经 IPC 回到 webview。
  function redactSettings(): Record<string, string> {
    const out = { ...state.settings }
    const has = (out['ai.api_key'] ?? '').trim() !== ''
    delete out['ai.api_key']
    out['ai.api_key_set'] = has ? 'true' : 'false'
    return out
  }

  function toArrayBuffer(bytes: number[]): ArrayBuffer {
    const view = new Uint8Array(bytes)
    return view.buffer
  }

  // 一张 1x1 的透明 PNG。read_attachment 真的会被 <img> 消费（lib/attachments.ts
  // 把字节包成 blob URL），给一段真能解码的字节，图片节点才会真的渲染出来。
  const PNG_1X1 = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]

  function handle(cmd: string, args: Record<string, unknown>): unknown {
    switch (cmd) {
      // ---------- 笔记 ----------

      case 'list_notes':
        return slice(live().sort(byRecency), args).map((n) => summary(n, true))

      case 'list_notes_by_tag':
        return slice(
          live()
            .filter((n) => n.tags.indexOf(String(args.tag)) >= 0)
            .sort(byRecency),
          args,
        ).map((n) => summary(n, true))

      case 'list_deleted_notes':
        return slice(
          state.notes
            .filter((n) => n.deleted_at !== null)
            // ORDER BY deleted_at DESC, id DESC
            .sort((a, b) => (b.deleted_at ?? 0) - (a.deleted_at ?? 0) || b.id - a.id),
          args,
        ).map((n) => summary(n, false))

      case 'list_all_tags': {
        // ORDER BY note_count DESC, name ASC；只统计未软删的笔记，计数为 0 的标签
        // 被 JOIN 直接滤掉，不会出现在结果里。
        const counts = new Map<string, number>()
        live().forEach((n) => n.tags.forEach((t) => counts.set(t, (counts.get(t) ?? 0) + 1)))
        return [...counts.entries()]
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      }

      case 'get_note': {
        const found = state.notes.find((n) => n.id === Number(args.id) && n.deleted_at === null)
        if (!found) throw `笔记不存在: ${String(args.id)}`
        return { ...found, attachment_ids: [...found.attachment_ids].sort((a, b) => a - b) }
      }

      case 'create_note': {
        const body_json = String(args.bodyJson)
        const body_text = plainText(body_json)
        const id = state.nextId++
        const now = state.clock++
        const created: Note = {
          id,
          uuid: `uuid-${id}`,
          title: deriveTitle(body_text),
          body_json,
          body_text,
          created_at: now,
          updated_at: now,
          deleted_at: null,
          tags: parseTags(body_text),
          attachment_ids: [...((args.attachmentIds as number[] | undefined) ?? [])].sort(
            (a, b) => a - b,
          ),
        }
        state.notes.push(created)
        return created
      }

      case 'update_note': {
        const target = find(args)
        target.body_json = String(args.bodyJson)
        target.body_text = plainText(target.body_json)
        target.title = deriveTitle(target.body_text)
        target.tags = parseTags(target.body_text)
        // note_attachments 是整表替换：漏传 attachmentIds 就等于把附件全解绑，
        // 下一轮 collect_garbage 会把文件真删掉。这里照样整表替换，
        // 好让「自动保存传了什么」这件事在断言里有可见后果。
        target.attachment_ids = [...((args.attachmentIds as number[] | undefined) ?? [])].sort(
          (a, b) => a - b,
        )
        target.updated_at = state.clock++
        return target
      }

      case 'delete_note': {
        const target = find(args)
        // 软删那条 SQL 是 `SET deleted_at = ?2, updated_at = ?2`，两个字段同值——
        // 回收站显示的「删除于」读的就是 updated_at。
        const now = state.clock++
        target.deleted_at = now
        target.updated_at = now
        return null
      }

      case 'restore_note': {
        const target = find(args)
        target.deleted_at = null
        target.updated_at = state.clock++
        return null
      }

      case 'purge_note': {
        const index = state.notes.findIndex((n) => n.id === Number(args.id))
        if (index < 0) throw `笔记不存在: ${String(args.id)}`
        state.notes.splice(index, 1)
        return null
      }

      case 'purge_all_deleted': {
        const before = state.notes.length
        state.notes = state.notes.filter((n) => n.deleted_at === null)
        return before - state.notes.length
      }

      // ---------- 检索 ----------

      case 'search_notes': {
        if (state.searchHits !== null) return state.searchHits.slice(0, Number(args.limit ?? 30))
        const q = String(args.query).trim()
        if (q === '') return []
        // 粗糙但方向正确的近似：真实实现是「字面 → 全拼 → 首字母」三条通道依次执行。
        // 纯 ASCII 的查询在这里一律当拼音命中处理，因为测试真正在乎的是
        // 「拼音通道的 matched_terms 必须是空数组」——拼音串在原文里根本不存在，
        // 给一个定位不到的词会让前端把不相干的文字刷成高亮。
        const isPinyin = /^[\x20-\x7e]+$/.test(q)
        return live()
          .filter((n) => (isPinyin ? true : n.body_text.indexOf(q) >= 0))
          .sort(byRecency)
          .slice(0, Number(args.limit ?? 30))
          .map((n) => ({
            note_id: n.id,
            uuid: n.uuid,
            title: n.title,
            excerpt: excerpt(n.body_text),
            matched_terms: isPinyin ? [] : [q],
            source: isPinyin ? 'PinyinFull' : 'Literal',
          }))
      }

      case 'rebuild_index':
        return live().length

      // ---------- 附件 ----------

      case 'store_attachment': {
        const bytes = (args.bytes as number[] | undefined) ?? []
        return {
          id: 42,
          sha256: 'a'.repeat(64),
          ext: String(args.ext),
          byte_size: bytes.length,
          width: 1,
          height: 1,
        }
      }

      case 'read_attachment':
        // 真实实现走 Tauri 的 raw 通道返回二进制，JS 拿到的是 ArrayBuffer 而不是数组。
        // 返回数组的话 `new Uint8Array(buffer)` 会静默得到一个空视图，
        // 而 ipc.readAttachment 刻意绕开 toCamel 的那条注释也就没人守得住了。
        return toArrayBuffer(PNG_1X1)

      case 'collect_garbage':
        return 0

      // ---------- 窗口与退出 ----------

      case 'hide_capture_window':
      case 'confirm_quit':
        return null

      // Capture 在 hide_capture_window 失败后会退回 getCurrentWindow().hide()
      case 'plugin:window|hide':
        return null

      // ---------- 设置 ----------

      case 'get_settings':
        // 键是设置项名（含点号），真实前端刻意绕开 toCamel——camel 化之后
        // `macos.hide_dock_icon` 会变成 `macos.hideDockIcon`，取值全是 undefined。
        // 密钥不在返回值里，换成合成的 `ai.api_key_set`（见 redactSettings）。
        return redactSettings()

      case 'set_setting':
        state.settings[String(args.key)] = String(args.value)
        return null

      case 'set_capture_hotkey':
        state.settings['hotkey.capture'] = String(args.accelerator).trim()
        return null

      case 'set_hide_dock_icon':
        state.settings['macos.hide_dock_icon'] = args.hide ? 'true' : 'false'
        return null

      case 'set_autostart':
        state.settings['startup.autostart'] = args.enabled ? 'true' : 'false'
        return null

      // ---------- AI ----------

      case 'ai_status': {
        const missing = aiMissing()
        return {
          enabled: aiIsEnabled(),
          configured: missing === null,
          missing_field: missing,
          pending_notes: state.ai.pendingNotes,
          indexed_chunks: state.ai.indexedChunks,
          memory_bytes: state.ai.memoryBytes,
          dim_mismatches: state.ai.dimMismatches,
          last_error: state.ai.lastError,
        }
      }

      case 'ai_preview_index':
        // **只读**（真实实现是 index::indexable_note_count）：不写设置、不入队、
        // 不起线程、不发一个模型请求。「确认框点取消，一个调用都没发」这条用例
        // 守的就是它确实什么都没改。
        return { pending_notes: live().length }

      case 'ai_enable': {
        const enabled = args.enabled === true
        state.settings['ai.enabled'] = enabled ? 'true' : 'false'
        // 置真时全量入队（enqueue_all）：之前写的笔记一篇都没被向量化过。
        // 关闭时队列原样留着，返回的还是当前待索引篇数。
        if (enabled) state.ai.pendingNotes = live().length
        return { pending_notes: state.ai.pendingNotes }
      }

      case 'ai_test_connection':
        return { ...state.ai.connection }

      case 'ai_reindex_all':
        // 裸数字，不是对象：清空旧向量并全量入队，返回入队篇数。
        state.ai.pendingNotes = live().length
        state.ai.indexedChunks = 0
        state.ai.dimMismatches = 0
        return state.ai.pendingNotes

      case 'ai_retry_failed': {
        const reset = state.ai.failedNotes
        state.ai.failedNotes = 0
        state.ai.pendingNotes += reset
        state.ai.lastError = null
        return reset
      }

      case 'ai_ask': {
        const conversationId = Number(args.conversationId)
        // Channel 在**构造时**就把自己登记进了 transformCallback，这里拿到的
        // 就是那个 id。序列化成 `__CHANNEL__:<id>` 的是它的 toJSON，
        // 而 handle 收到的是没被序列化过的原始对象。
        const onEvent = args.onEvent as { id: number } | undefined
        if (onEvent === undefined) throw 'ai_ask 没有收到 onEvent 通道'
        // 真实实现**先落库再检索**：用户敲的那句话在任何事件到达之前就已经在库里了。
        // 所以失败或取消之后重拉消息，提问仍在——有用例守着这一条。
        appendMessage(conversationId, 'user', String(args.question), [])
        state.asks.push({
          callbackId: onEvent.id,
          conversationId,
          index: 0,
          answer: '',
          citations: [],
          ended: false,
        })
        // 命令立刻返回，答案全部走 channel。它落定**不代表回答结束**。
        return null
      }

      case 'ai_cancel':
        // 真实实现只是把取消标志置起来；`Cancelled` 事件仍由那条 channel 补发，
        // 而且可能迟到。所以这里什么都不投。
        return null

      case 'ai_semantic_search': {
        const query = String(args.query ?? '').trim()
        const limit = Number(args.limit ?? 0)
        // AI 没开、没配全、查询为空、limit 为 0 时返回**空数组而不是错误**——
        // 搜索框每敲一个键都会调它，为一个本来就没开的功能弹红色横幅不可接受。
        if (!aiIsEnabled() || aiMissing() !== null || query === '' || limit === 0) return []
        return state.ai.semanticHits.slice(0, limit)
      }

      case 'ai_list_conversations':
        // ORDER BY updated_at DESC, id DESC
        return slice(
          [...state.ai.conversations].sort((a, b) => b.updated_at - a.updated_at || b.id - a.id),
          args,
        ).map((c) => ({ ...c }))

      case 'ai_create_conversation': {
        const id = state.nextConversationId++
        const now = state.clock++
        state.ai.conversations.push({ id, title: UNTITLED, created_at: now, updated_at: now })
        state.ai.messages[String(id)] = []
        // 裸数字：新会话的 id
        return id
      }

      case 'ai_get_messages':
        // 按时间升序；没有引用时是 `[]` 而不是 null。
        return (state.ai.messages[String(Number(args.conversationId))] ?? []).map(
          (m: MockChatMessage) => ({ ...m, citations: m.citations.map((c) => ({ ...c })) }),
        )

      case 'ai_delete_conversation': {
        const id = Number(args.id)
        state.ai.conversations = state.ai.conversations.filter((c) => c.id !== id)
        delete state.ai.messages[String(id)]
        return null
      }

      case 'ai_rename_conversation': {
        const target = state.ai.conversations.find((c) => c.id === Number(args.id))
        if (!target) throw `对话不存在: ${String(args.id)}`
        target.title = String(args.title)
        return null
      }

      // ---------- 更新器 ----------
      //
      // 三个命令的形状照抄 @tauri-apps/plugin-updater 2.10.1 的 dist-js：
      //
      // - `check` 返回的是一份**元数据**（不是 Update 对象），JS 侧拿它
      //   `new Update(metadata)`，其中 `rid` 会进 Resource。没有更新时返回 null。
      // - `download_and_install` 的进度不走返回值，走 `onEvent` 这个 Channel：
      //   Channel 在构造时用 transformCallback 注册了自己，args.onEvent.id
      //   就是回调 id。回调收到的是 `{ index, message }`，**index 必须连续递增**——
      //   Channel 内部靠它保序，跳号的消息会被压进 pendingMessages 永远不投递，
      //   症状是进度条停在某个数字不动。
      // - `restart` 是 process 插件的（relaunch() 调的就是它），真实环境里
      //   调完进程就没了；这里返回 null，好让测试断言「装完确实请求了重启」。

      case 'plugin:app|version':
        return state.appVersion

      case 'plugin:updater|check': {
        if (state.update === null) return null
        return {
          rid: 1,
          currentVersion: state.appVersion,
          version: state.update.version,
          date: null,
          body: state.update.notes,
          rawJson: {},
        }
      }

      case 'plugin:updater|download_and_install': {
        const plan = state.update
        // 真实插件在这里会因为拿不到句柄而报错。构造不出这个场景也没关系，
        // 有个明确的错误总比默默成功强。
        if (plan === null) throw '没有可用的更新'
        const channel = args.onEvent as { id: number } | undefined
        let index = 0
        const emit = (message: unknown) => {
          if (!channel) return
          const callback = state.callbacks.get(channel.id)
          if (callback) callback({ index: index++, message })
        }
        // 返回 Promise：分块之间要真的等一会儿，否则界面从 0% 直接跳到重启，
        // 「下载进度可见」这条就断言不到。
        return (async () => {
          emit({
            event: 'Started',
            data:
              plan.contentLength === null ? {} : { contentLength: plan.contentLength },
          })
          for (const chunk of plan.chunks) {
            await new Promise((resolve) => setTimeout(resolve, plan.chunkDelayMs))
            emit({ event: 'Progress', data: { chunkLength: chunk } })
          }
          emit({ event: 'Finished' })
          return null
        })()
      }

      case 'plugin:process|restart':
        return null

      // ---------- 事件插件 ----------

      case 'plugin:event|listen': {
        // 真实实现返回一个 eventId，而 `_unlisten` 会把它直接喂给
        // unregisterCallback——两者是同一个 id。
        const id = Number(args.handler)
        state.listeners.set(id, String(args.event))
        return id
      }

      case 'plugin:event|unlisten':
        state.listeners.delete(Number(args.eventId))
        return null

      case 'plugin:event|emit':
        // 真实 emit 会广播给包括发送方在内的所有窗口。BroadcastChannel 不给
        // 自己回声，所以本窗口这份要手动派发。
        deliver(String(args.event), args.payload ?? null)
        channel.postMessage({ event: String(args.event), payload: args.payload ?? null })
        return null

      default:
        // 覆盖不全被抓到了，是好事：补上这个命令的分支即可。
        throw `mock 未实现的命令: ${cmd}`
    }
  }

  /// 把一个事件派发给本窗口注册的监听器。
  /// 回调收到的是 `{ event, id, payload }`（@tauri-apps/api 的 `Event` 形状）。
  function deliver(event: string, payload: unknown): void {
    state.listeners.forEach((name, id) => {
      if (name !== event) return
      const callback = state.callbacks.get(id)
      if (callback) callback({ event, id, payload })
    })
  }

  channel.onmessage = (message: MessageEvent) => {
    const data = message.data as { event: string; payload: unknown }
    deliver(data.event, data.payload)
  }

  // event.js 的 _unlisten 第一件事就是调它。不摆出来 → 每次卸载都 TypeError。
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (_event: string, eventId: number) => {
      state.callbacks.delete(eventId)
    },
  }

  w.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: init.windowLabel },
      currentWebview: { windowLabel: init.windowLabel, label: init.windowLabel },
    },
    // 真实实现把回调存进一张内部 Map 并返回 id（见 @tauri-apps/api 的 mocks.js），
    // 不是往 window 上挂 `_${id}` —— 那是 Tauri v1 的做法。
    transformCallback(callback: (payload: unknown) => void, once = false) {
      const id = state.nextCallbackId++
      state.callbacks.set(id, (payload: unknown) => {
        if (once) state.callbacks.delete(id)
        callback(payload)
      })
      return id
    },
    unregisterCallback(id: number) {
      state.callbacks.delete(id)
    },
    runCallback(id: number, data: unknown) {
      const callback = state.callbacks.get(id)
      if (callback) callback(data)
    },
    convertFileSrc(filePath: string, protocol = 'asset') {
      return `${protocol}://localhost/${encodeURIComponent(filePath)}`
    },
    async invoke(cmd: string, args: Record<string, unknown> = {}) {
      const recorded = args ?? {}
      const call: Call = {
        cmd,
        // 深拷一份：调用方（比如 TipTap 的正文对象）之后还会继续变，
        // 存引用的话断言拿到的是「测试跑完那一刻的样子」而不是「调用当时的样子」。
        args: JSON.parse(JSON.stringify(recorded)) as Record<string, unknown>,
        startedAt: performance.now(),
        settledAt: null,
      }
      state.calls.push(call)
      try {
        const delay = state.delays[cmd]
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
        const failure = state.failCommands[cmd]
        // 裸字符串，不是 Error：真实 CommandError 就是这么序列化的。
        if (failure) throw failure
        // await 而不是直接 return：`plugin:updater|download_and_install` 会返回一个
        // 真的要跑一会儿的 Promise，不 await 的话 settledAt 会在它落地之前就写下，
        // 而 settledAt 是「有没有并发」这类断言的唯一依据。
        return await handle(cmd, recorded)
      } finally {
        call.settledAt = performance.now()
      }
    },
  }
}
