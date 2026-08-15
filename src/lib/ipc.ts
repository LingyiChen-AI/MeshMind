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

import { invoke } from '@tauri-apps/api/core'

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
}
