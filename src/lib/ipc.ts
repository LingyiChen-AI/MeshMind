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

  readAttachment(id: number): Promise<number[]> {
    return call<number[]>('read_attachment', { id })
  },

  /** 清理无人引用的附件，返回删除的文件数 */
  collectGarbage(): Promise<number> {
    return call<number>('collect_garbage')
  },
}
