import { Channel } from '@tauri-apps/api/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ipc, toCamel } from './ipc'
import type { AskEvent } from './ipc'

// 只顶替 `invoke`，`Channel` 保留 @tauri-apps/api 的真身。
//
// 这一点是刻意的：AI 这条路径上最容易错的恰恰是「我们对 Tauri 内部形状的理解」
// （回调属性叫什么、通道投递过来的载荷长什么样）。换成自制的假 Channel，
// 等于拿我们的猜测去验证我们的猜测，写错了照样全绿。
const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tauri-apps/api/core')>()
  return { ...actual, invoke: invokeMock }
})

/** 让下一次 invoke 解析成 `result`，返回那只 spy。 */
function mockInvoke(result: unknown) {
  invokeMock.mockReset()
  invokeMock.mockResolvedValue(result)
  return invokeMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('toCamel', () => {
  it('转换单层 snake_case 键', () => {
    expect(toCamel({ body_json: 'x', updated_at: 1 })).toEqual({ bodyJson: 'x', updatedAt: 1 })
  })

  it('转换嵌套对象', () => {
    expect(toCamel({ outer_key: { inner_key: { deep_key: 1 } } })).toEqual({
      outerKey: { innerKey: { deepKey: 1 } },
    })
  })

  it('转换对象数组', () => {
    expect(toCamel([{ note_id: 1 }, { note_id: 2 }])).toEqual([{ noteId: 1 }, { noteId: 2 }])
  })

  it('转换对象里的数组字段', () => {
    expect(toCamel({ attachment_ids: [1, 2], matched_terms: ['a'] })).toEqual({
      attachmentIds: [1, 2],
      matchedTerms: ['a'],
    })
  })

  it('null 不被当成对象', () => {
    expect(toCamel(null)).toBeNull()
    expect(toCamel({ width: null, byte_size: 3 })).toEqual({ width: null, byteSize: 3 })
    expect(toCamel([null, { a_b: 1 }])).toEqual([null, { aB: 1 }])
  })

  it('已经是 camelCase 的键不被破坏', () => {
    expect(toCamel({ bodyJson: 1, id: 2, uuid: 'u' })).toEqual({ bodyJson: 1, id: 2, uuid: 'u' })
  })

  it('原样返回标量', () => {
    expect(toCamel(1)).toBe(1)
    expect(toCamel('a_b')).toBe('a_b')
    expect(toCamel(undefined)).toBeUndefined()
    expect(toCamel(true)).toBe(true)
  })

  it('多下划线与尾部下划线处理稳定', () => {
    expect(toCamel({ a_b_c: 1 })).toEqual({ aBC: 1 })
    expect(toCamel({ _leading: 1 })).toEqual({ _leading: 1 })
  })

  it('转换 SearchHit 形状的真实载荷', () => {
    const hit = toCamel({
      note_id: 7,
      uuid: 'u',
      title: 't',
      excerpt: 'e',
      matched_terms: ['x'],
      source: 'PinyinHead',
    })
    expect(hit).toEqual({
      noteId: 7,
      uuid: 'u',
      title: 't',
      excerpt: 'e',
      matchedTerms: ['x'],
      source: 'PinyinHead',
    })
  })
})

describe('AI 命令', () => {
  it('aiSemanticSearch 的命令名与参数名，返回值过 toCamel', async () => {
    const spy = mockInvoke([
      { note_id: 3, uuid: 'u3', title: '标题', excerpt: '片段', score: 0.87 },
    ])
    const hits = await ipc.aiSemanticSearch('查询', 10)
    expect(spy).toHaveBeenCalledWith('ai_semantic_search', { query: '查询', limit: 10 })
    // 断言 noteId 而不只是断言调用形状：漏掉 toCamel 的话这里才会红。
    expect(hits[0].noteId).toBe(3)
    expect(hits[0].score).toBe(0.87)
  })

  it('多词参数名写成 camelCase，由 Tauri 转成 snake_case', async () => {
    const spy = mockInvoke([])
    await ipc.aiGetMessages(5)
    expect(spy).toHaveBeenCalledWith('ai_get_messages', { conversationId: 5 })
  })

  it('aiStatus 的 snake_case 字段被转成 camelCase', async () => {
    mockInvoke({
      enabled: true,
      configured: true,
      missing_field: null,
      pending_notes: 3,
      indexed_chunks: 120,
      memory_bytes: 4096,
      dim_mismatches: 0,
      last_error: null,
    })
    const status = await ipc.aiStatus()
    expect(status.pendingNotes).toBe(3)
    expect(status.indexedChunks).toBe(120)
    expect(status.memoryBytes).toBe(4096)
    expect(status.missingField).toBeNull()
    expect(status.dimMismatches).toBe(0)
  })

  it('aiEnable 的回执转成 camelCase', async () => {
    const spy = mockInvoke({ pending_notes: 12 })
    const report = await ipc.aiEnable(true)
    expect(spy).toHaveBeenCalledWith('ai_enable', { enabled: true })
    expect(report.pendingNotes).toBe(12)
  })

  it('aiTestConnection 的回执转成 camelCase', async () => {
    mockInvoke({ embed_ok: true, embed_dim: 1536, chat_ok: false, error: '模型名不存在' })
    const report = await ipc.aiTestConnection()
    expect(report.embedOk).toBe(true)
    expect(report.embedDim).toBe(1536)
    expect(report.chatOk).toBe(false)
    expect(report.error).toBe('模型名不存在')
  })

  it('会话消息里的 citations 逐条转成 camelCase', async () => {
    mockInvoke([
      {
        id: 1,
        role: 'assistant',
        content: '回答',
        citations: [
          { index: 1, note_id: 7, uuid: 'u7', title: '标题', heading: '', excerpt: '片段' },
        ],
        created_at: 100,
      },
    ])
    const messages = await ipc.aiGetMessages(1)
    expect(messages[0].citations[0].noteId).toBe(7)
    expect(messages[0].createdAt).toBe(100)
  })

  // aiAsk 是唯一一条走 Channel 的路径，也是全文件最容易写错的一处。
  // 这里用真实的 Channel，只把 `window.__TAURI_INTERNALS__.transformCallback` 换成间谍，
  // 于是三件事同时被钉住：参数名是 onEvent、回调挂的是 onmessage、
  // 以及 Tauri 投递的载荷是 `{ index, message }` 而不是裸事件。
  it('aiAsk 把回调接到 Channel 上，通道投递的事件原样交给它', async () => {
    const spy = mockInvoke(null)
    const raws: Array<(payload: unknown) => void> = []
    vi.stubGlobal('window', {
      __TAURI_INTERNALS__: {
        transformCallback(callback: (payload: unknown) => void) {
          raws.push(callback)
          return 7
        },
        unregisterCallback() {},
      },
    })

    const seen: AskEvent[] = []
    await ipc.aiAsk(3, '知识图谱是什么', (event) => seen.push(event))

    expect(spy).toHaveBeenCalledTimes(1)
    const [command, args] = spy.mock.calls[0] as [string, Record<string, unknown>]
    expect(command).toBe('ai_ask')
    expect(args.conversationId).toBe(3)
    expect(args.question).toBe('知识图谱是什么')
    expect(args.onEvent).toBeInstanceOf(Channel)
    // Channel 被序列化成 `__CHANNEL__:<id>`，Rust 侧靠这串字符串找回通道。
    expect(JSON.stringify(args.onEvent)).toBe('"__CHANNEL__:7"')

    expect(raws).toHaveLength(1)
    const deliver = raws[0]
    // 引用的字段名保持 snake_case：这条路径没有 toCamel，谁也不会替它转。
    const retrieved = {
      Retrieved: {
        citations: [
          { index: 1, note_id: 42, uuid: 'u42', title: '部署流程', heading: '灰度', excerpt: '片段' },
        ],
      },
    }
    deliver({ index: 0, message: retrieved })
    deliver({ index: 1, message: { Delta: { text: '甲' } } })
    // 无字段变体是裸字符串，不能在半路被包成对象。
    deliver({ index: 2, message: 'Cancelled' })

    expect(seen).toEqual([retrieved, { Delta: { text: '甲' } }, 'Cancelled'])
  })

  it('aiCancel 不带参数', async () => {
    const spy = mockInvoke(null)
    await ipc.aiCancel()
    expect(spy).toHaveBeenCalledWith('ai_cancel', undefined)
  })

  it('会话增删改查的命令名与参数名', async () => {
    const spy = mockInvoke([])
    await ipc.aiListConversations(20, 0)
    expect(spy).toHaveBeenCalledWith('ai_list_conversations', { limit: 20, offset: 0 })

    mockInvoke(11)
    expect(await ipc.aiCreateConversation()).toBe(11)
    expect(invokeMock).toHaveBeenCalledWith('ai_create_conversation', undefined)

    mockInvoke(null)
    await ipc.aiDeleteConversation(4)
    expect(invokeMock).toHaveBeenCalledWith('ai_delete_conversation', { id: 4 })

    mockInvoke(null)
    await ipc.aiRenameConversation(4, '新标题')
    expect(invokeMock).toHaveBeenCalledWith('ai_rename_conversation', { id: 4, title: '新标题' })
  })

  it('索引维护命令返回裸数字', async () => {
    mockInvoke(9)
    expect(await ipc.aiReindexAll()).toBe(9)
    expect(invokeMock).toHaveBeenCalledWith('ai_reindex_all', undefined)

    mockInvoke(2)
    expect(await ipc.aiRetryFailed()).toBe(2)
    expect(invokeMock).toHaveBeenCalledWith('ai_retry_failed', undefined)
  })
})
