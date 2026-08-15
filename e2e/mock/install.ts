import type { MockInit } from './state'

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
///
/// ## `__TAURI_INTERNALS__` 的形状按 @tauri-apps/api 2.11.1 的源码对齐
///
/// - `core.js`：`invoke(cmd, args, options)`、`transformCallback(cb, once)`、
///   `unregisterCallback(id)`、`convertFileSrc(path, protocol)`
/// - `window.js`：`metadata.currentWindow.label`（`getCurrentWindow()` 读它）
/// - `event.js` 的 `_unlisten` 会先调
///   **`window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener(event, eventId)`**，
///   再 invoke `plugin:event|unlisten`。这个全局对象不摆出来的话，任何一次
///   unlisten 都会 TypeError——而 React StrictMode 一挂载就会 listen/unlisten 一轮，
///   所以是必现的白屏，不是边角情况。
export function installMock(init: MockInit): void {
  interface Call {
    cmd: string
    args: Record<string, unknown>
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

  const initial = init.notes.map((n) => ({ ...n }))

  const state = {
    notes: initial as Note[],
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
  }

  // 跨 page 的事件通道。两个窗口是两个独立的 page，内存不共享，
  // 靠同源的 BroadcastChannel 传递事件。
  const channel = new BroadcastChannel('meshmind-e2e-events')

  const w = window as unknown as Record<string, unknown>

  w.__IPC_MOCK__ = {
    calls: () => state.calls.map((c) => ({ cmd: c.cmd, args: c.args })),
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
        return { ...state.settings }

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
      state.calls.push({
        cmd,
        // 深拷一份：调用方（比如 TipTap 的正文对象）之后还会继续变，
        // 存引用的话断言拿到的是「测试跑完那一刻的样子」而不是「调用当时的样子」。
        args: JSON.parse(JSON.stringify(recorded)) as Record<string, unknown>,
      })
      const delay = state.delays[cmd]
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
      const failure = state.failCommands[cmd]
      // 裸字符串，不是 Error：真实 CommandError 就是这么序列化的。
      if (failure) throw failure
      return handle(cmd, recorded)
    },
  }
}
