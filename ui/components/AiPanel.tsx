// 右侧问答栏：会话选择 + 消息流 + 输入框。
//
// 这个组件的全部难点都在「一次提问的生命周期」上，三条约束值得先读：
//
// 1. **`await ipc.aiAsk(...)` 落定不代表回答结束。** Rust 侧立刻返回，真正的工作在
//    另一个线程上跑，答案全部走 channel 流回来。所以 spinner 不能在 await 之后收，
//    要等终止事件（Done / Failed / Cancelled 三者之一，后端保证只到达其中一个）。
// 2. **「正在思考」在用户点发送的那一刻就要出现。** 第一次检索得先发一次 embedding
//    请求，慢网络下一两秒才有第一个事件；等 `Retrieved` 再显示等于界面先僵住。
// 3. **迟到的事件必须按序号丢弃。** 同一时刻只允许一个提问在飞，新的提问会让后端
//    给上一条 channel 补一个 `Cancelled`——不认序号的话，这条本属于旧提问的取消
//    会把**正在跑的**这一次判成已取消，界面上表现为「刚发的问题自己没了」。
//
// 事件的归并规则（终止态之后原样返回、`Cancelled` 是裸字符串）在 lib/ai.ts 的
// `reduceAsk` 里，有 vitest 覆盖；这里只负责把状态画出来。
//
// 未配置 / 未启用时**一次 `ai_ask` 都不发**，连输入框都不渲染，改为引导 + 打开设置。

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { initialAsk, reduceAsk, splitCitedText, type AskState } from '../lib/ai'
import {
  ipc,
  type AiStatus,
  type AskEvent,
  type ChatMessage,
  type Citation,
  type Conversation,
} from '../lib/ipc'

export interface AiPanelProps {
  /** 收起侧栏。⌘L 也能收，这里是标题栏上那个按钮 */
  onClose: () => void
  /** 点引用跳到对应笔记。App 负责选中并加载，问答栏保持打开 */
  onOpenNote: (noteId: number) => void
  /** 打开设置面板（引导页那个按钮） */
  onOpenSettings: () => void
  /**
   * 每次设置面板关掉时 +1。
   *
   * 用户很可能就是被引导页送去设置里配 AI 的，回来时这个面板必须重新拉一次状态，
   * 否则他配好了、启用了，眼前还是那句「先去设置里配置」。
   */
  statusToken: number
}

/** 离底部多近算「用户还在看最新内容」。留一行多的余量，免得差几像素就判成在翻旧内容。 */
const STICK_TO_BOTTOM_PX = 120

/** 一次提问从发出到落定之间，界面上多出来的那对气泡。 */
interface Pending {
  question: string
  conversationId: number
}

export function AiPanel({ onClose, onOpenNote, onOpenSettings, statusToken }: AiPanelProps) {
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [conversations, setConversations] = useState<Conversation[]>([])
  // null = 还没有会话（或用户点了「新对话」）。真正的会话在第一次提问时才创建——
  // 提前建的话，用户点一下「新对话」又改主意，库里就留下一个空壳。
  const [conversationId, setConversationId] = useState<number | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [ask, setAsk] = useState<AskState>(initialAsk())
  const [pending, setPending] = useState<Pending | null>(null)
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [deleteArmed, setDeleteArmed] = useState(false)

  const aliveRef = useRef(true)
  // 每次提问的序号。channel 的回调是按 ask 绑定的，认这个号才分得清「这条事件属于
  // 哪一次提问」——见文件头第 3 条。
  const askSeqRef = useRef(0)

  // 当前会话同时存一份 ref：settle 在 await 之后才用到它，那时闭包里的值可能已经过期。
  const conversationIdRef = useRef(conversationId)
  conversationIdRef.current = conversationId

  const streamRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // 卸载（收起侧栏、关窗）时取消在飞的提问：留着它只会继续烧 token，
  // 而答案已经没有任何人在看了。
  useEffect(() => {
    return () => {
      askSeqRef.current += 1
      void ipc.aiCancel().catch((err: unknown) => {
        console.error('[ai] 卸载时取消提问失败', err)
      })
    }
  }, [])

  useEffect(() => {
    let alive = true
    setStatusLoading(true)
    ipc.aiStatus().then(
      (next) => {
        if (!alive) return
        setStatus(next)
        setStatusLoading(false)
      },
      (err: unknown) => {
        if (!alive) return
        setError(String(err))
        setStatusLoading(false)
      },
    )
    return () => {
      alive = false
    }
  }, [statusToken])

  const ready = status !== null && status.enabled && status.configured

  // 会话列表。配好之前不拉：那时面板上根本没有可以选会话的地方。
  useEffect(() => {
    if (!ready) return
    let alive = true
    ipc.aiListConversations().then(
      (list) => {
        if (!alive) return
        setConversations(list)
        // 默认落在最近用过的那个会话上（列表按 updated_at 降序）。
        setConversationId((prev) => (prev === null ? (list[0]?.id ?? null) : prev))
      },
      (err: unknown) => {
        if (!alive) return
        setError(String(err))
      },
    )
    return () => {
      alive = false
    }
  }, [ready])

  // 选中的会话变了就重拉消息。alive 标志挡住「连点两个会话」时慢的那次盖住快的。
  useEffect(() => {
    if (conversationId === null) {
      setMessages([])
      return
    }
    let alive = true
    ipc.aiGetMessages(conversationId).then(
      (rows) => {
        if (alive) setMessages(rows)
      },
      (err: unknown) => {
        if (alive) setError(String(err))
      },
    )
    return () => {
      alive = false
    }
  }, [conversationId])

  // 新内容进来就滚到底。放在 effect 里而不是事件回调里，是因为要等 DOM 真的长高。
  //
  // **只在用户本来就贴着底部时才滚**：流式回答每来一个 Delta 就触发一次，
  // 无条件滚的话，用户往上翻去看引用的那篇笔记，会被一路拽回底部。
  useEffect(() => {
    const node = streamRef.current
    if (node === null) return
    const distanceToBottom = node.scrollHeight - node.scrollTop - node.clientHeight
    if (distanceToBottom < STICK_TO_BOTTOM_PX) node.scrollTop = node.scrollHeight
  }, [messages, ask.answer, pending])

  /**
   * 一次提问落定之后的收尾：把界面和数据库对齐。
   *
   * 三种终止态都要重拉，包括失败和取消——**提问在后端是先落库再检索的**，
   * 用户敲的那句话已经在库里了，不重拉的话它会随着乐观气泡一起消失。
   * 会话列表也一起拉：第一次提问之后后端会用问题改写会话标题。
   */
  const settle = useCallback(async (conversation: number, outcome: AskState['phase']) => {
    try {
      const [rows, list] = await Promise.all([
        ipc.aiGetMessages(conversation),
        ipc.aiListConversations(),
      ])
      if (!aliveRef.current) return
      // 这两个请求在飞的期间用户可能已经切走了会话。那时这批消息属于**上一个**会话，
      // 写进去会把眼前这个会话的记录整个换掉——和 App 里 stillCurrent 挡的是同一件事。
      if (conversationIdRef.current === conversation) setMessages(rows)
      setConversations(list)
    } catch (err) {
      if (aliveRef.current) setError(String(err))
    } finally {
      if (aliveRef.current) {
        setPending(null)
        // 失败要留住 `failed` 这个相位，横幅还得靠它显示 error；
        // 半截回答不会留下来——助手气泡只在 streaming 时才画。
        if (outcome !== 'failed') setAsk(initialAsk())
        if (outcome === 'cancelled') setNotice('已停止生成，这次的回答没有保存。')
      }
    }
  }, [])

  const submit = useCallback(async () => {
    const question = input.trim()
    if (question === '' || ask.phase === 'streaming') return

    setInput('')
    setError(null)
    setNotice(null)
    // 见文件头第 2 条：这一刻还一个事件都没来，phase 也得是 streaming。
    setAsk({ ...initialAsk(), phase: 'streaming' })
    const seq = (askSeqRef.current += 1)

    try {
      // 第一次提问时才真的建会话。
      const conversation = conversationId ?? (await ipc.aiCreateConversation())
      if (!aliveRef.current || seq !== askSeqRef.current) return
      if (conversationId === null) setConversationId(conversation)
      setPending({ question, conversationId: conversation })

      const onEvent = (event: AskEvent) => {
        // 迟到的事件属于上一次提问，丢掉（见文件头第 3 条）。
        if (!aliveRef.current || seq !== askSeqRef.current) return
        setAsk((prev) => reduceAsk(prev, event))

        if (typeof event === 'string') {
          void settle(conversation, 'cancelled')
          return
        }
        if ('Done' in event) void settle(conversation, 'done')
        else if ('Failed' in event) void settle(conversation, 'failed')
      }

      // 这个 await 落定**不代表回答结束**（见文件头第 1 条），别在这之后收 spinner。
      await ipc.aiAsk(conversation, question, onEvent)
    } catch (err) {
      if (!aliveRef.current || seq !== askSeqRef.current) return
      // 命令本身就没发出去（AI 刚被关掉、会话建不出来）：这时一个事件都不会来，
      // 终止态只能由这里给。
      setAsk((prev) => ({ ...prev, phase: 'failed', error: String(err) }))
      setPending(null)
    }
  }, [ask.phase, conversationId, input, settle])

  const cancel = useCallback(async () => {
    try {
      await ipc.aiCancel()
    } catch (err) {
      setError(String(err))
    }
    // 状态不在这里改：取消是后端确认的，`Cancelled` 事件回来时才收 spinner。
    // 在这里抢着置 cancelled 的话，一次「取消晚了、回答其实已经完成」会让
    // 已经落库的那条回答在界面上凭空消失。
  }, [])

  const startNewConversation = useCallback(() => {
    askSeqRef.current += 1
    void ipc.aiCancel().catch((err: unknown) => setError(String(err)))
    setConversationId(null)
    setMessages([])
    setAsk(initialAsk())
    setPending(null)
    setNotice(null)
    setDeleteArmed(false)
  }, [])

  const selectConversation = useCallback((id: number | null) => {
    // 切走之前先把在飞的提问停掉：它的答案会落进原来那个会话，
    // 而用户已经在看别的会话了，那些 Delta 只会画到错的地方去。
    askSeqRef.current += 1
    void ipc.aiCancel().catch((err: unknown) => setError(String(err)))
    setConversationId(id)
    setAsk(initialAsk())
    setPending(null)
    setNotice(null)
    setDeleteArmed(false)
  }, [])

  const deleteConversation = useCallback(async () => {
    if (conversationId === null) return
    // 第一次点只是武装：会话删了就没了，没有回收站。
    if (!deleteArmed) {
      setDeleteArmed(true)
      return
    }
    setDeleteArmed(false)
    askSeqRef.current += 1
    try {
      await ipc.aiCancel()
      await ipc.aiDeleteConversation(conversationId)
      const list = await ipc.aiListConversations()
      if (!aliveRef.current) return
      setConversations(list)
      setConversationId(list[0]?.id ?? null)
      setAsk(initialAsk())
      setPending(null)
    } catch (err) {
      if (aliveRef.current) setError(String(err))
    }
  }, [conversationId, deleteArmed])

  const streaming = ask.phase === 'streaming'
  // Done / Cancelled 之后到重拉回来之间，气泡要继续留在屏幕上，否则回答会先消失
  // 一瞬间再由数据库那份顶上来，看着像闪了一下。失败不留：那条回答根本没落库。
  const showLiveAnswer =
    streaming || ((ask.phase === 'done' || ask.phase === 'cancelled') && pending !== null)

  return (
    <aside className="ai-panel">
      <div className="trash-head">
        <span className="trash-title">知识问答</span>
        <div className="trash-head-actions">
          <button type="button" className="subtle" title="收起问答栏" onClick={onClose}>
            收起
          </button>
        </div>
      </div>

      {ready ? (
        <div className="ai-conversations">
          <select
            value={conversationId === null ? '' : String(conversationId)}
            onChange={(event) =>
              selectConversation(event.target.value === '' ? null : Number(event.target.value))
            }
          >
            {conversationId === null ? <option value="">新对话（还没开始）</option> : null}
            {conversations.map((item) => (
              <option key={item.id} value={String(item.id)}>
                {item.title.trim() || '未命名对话'}
              </option>
            ))}
          </select>
          <button type="button" className="subtle" onClick={startNewConversation}>
            新对话
          </button>
          <button
            type="button"
            className={deleteArmed ? 'danger' : 'subtle'}
            disabled={conversationId === null}
            title="删除这个对话，不可恢复"
            onClick={() => void deleteConversation()}
          >
            {deleteArmed ? '确认删除' : '删除'}
          </button>
        </div>
      ) : null}

      {error !== null ? (
        <div className="search-error" onClick={() => setError(null)}>
          {error}
        </div>
      ) : null}

      {/* Failed 单独渲染成横幅，而不是留一条半截的助手消息在消息流里 */}
      {ask.phase === 'failed' ? (
        <div className="search-error" onClick={() => setAsk(initialAsk())}>
          回答失败：{ask.error ?? '未知原因'}
        </div>
      ) : null}

      {notice !== null ? <div className="trash-notice">{notice}</div> : null}

      {!ready ? (
        <div className="ai-empty">
          {statusLoading ? (
            <p>加载中…</p>
          ) : status === null ? (
            <p>读不到 AI 状态</p>
          ) : !status.configured ? (
            <>
              <p>先在设置里配置 AI 服务</p>
              <p className="hint">还缺：{status.missingField ?? '必要配置'}</p>
            </>
          ) : (
            <>
              <p>AI 还没启用</p>
              <p className="hint">
                启用后会为已有笔记建立索引；提问时命中的笔记片段会发送给你配置的模型服务。
              </p>
            </>
          )}
          <button type="button" onClick={onOpenSettings}>
            打开设置
          </button>
        </div>
      ) : (
        <>
          <div className="ai-stream" ref={streamRef}>
            {messages.length === 0 && pending === null ? (
              <div className="ai-empty">
                <p>问点什么</p>
                <p className="hint">回答只依据检索到的笔记片段，并给出可点的引用。</p>
              </div>
            ) : null}

            {messages.map((message) => (
              <div key={message.id} className={`ai-message ai-message-${message.role}`}>
                {message.role === 'user' ? (
                  <p className="ai-text">{message.content}</p>
                ) : (
                  <>
                    <p className="ai-text">
                      {renderAnswer(message.content, message.citations, onOpenNote)}
                    </p>
                    <CitationList citations={message.citations} onOpenNote={onOpenNote} />
                  </>
                )}
              </div>
            ))}

            {pending !== null ? (
              <div className="ai-message ai-message-user">
                <p className="ai-text">{pending.question}</p>
              </div>
            ) : null}

            {showLiveAnswer ? (
              <div className="ai-message ai-message-assistant">
                {/* Retrieved 一定先于任何 Delta 到达，所以流式过程中引用条会先出现——
                    这是刻意的：用户要在模型开口之前就看见它读了哪些笔记。 */}
                {ask.citations.length > 0 ? (
                  <CitationList citations={ask.citations} onOpenNote={onOpenNote} />
                ) : null}
                {ask.answer === '' ? (
                  <p className="ai-thinking">正在思考…</p>
                ) : (
                  <p className="ai-text">{renderAnswer(ask.answer, ask.citations, onOpenNote)}</p>
                )}
              </div>
            ) : null}
          </div>

          <div className="ai-composer">
            <textarea
              className="ai-input"
              value={input}
              rows={3}
              placeholder="问一个关于你笔记的问题…"
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                // ⌘/Ctrl+Enter 发送，和快捕窗口保持一致；单独的 Enter 留给换行。
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault()
                  void submit()
                }
              }}
            />
            <div className="ai-composer-actions">
              {streaming ? (
                <button type="button" onClick={() => void cancel()}>
                  停止
                </button>
              ) : (
                <button
                  type="button"
                  className="primary"
                  disabled={input.trim() === ''}
                  onClick={() => void submit()}
                >
                  发送
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </aside>
  )
}

/** 引用条：`[1] 《标题》 > 小标题`，点了跳到那篇笔记。 */
function CitationList({
  citations,
  onOpenNote,
}: {
  citations: Citation[]
  onOpenNote: (noteId: number) => void
}) {
  if (citations.length === 0) return null
  return (
    <ul className="ai-citations">
      {citations.map((citation) => (
        <li key={citation.index}>
          <button
            type="button"
            className="ai-cite-link"
            title={citation.excerpt}
            onClick={() => onOpenNote(citation.noteId)}
          >
            [{citation.index}] 《{citation.title.trim() || '无标题'}》
            {citation.heading.trim() === '' ? '' : ` > ${citation.heading}`}
          </button>
        </li>
      ))}
    </ul>
  )
}

/**
 * 把回答正文画出来：`[n]` 变成可点的上标，其余照原样。
 *
 * **编号查不到就当普通文字画**。模型会写出越界的 `[9]`——`splitCitedText` 的注释
 * 专门交代了这件事。这里如果按位置去取（`citations[index - 1]`），拿到的是
 * undefined，点一下会静默跳到一篇 id 为 undefined 的笔记上。
 */
function renderAnswer(
  text: string,
  citations: Citation[],
  onOpenNote: (noteId: number) => void,
): ReactNode[] {
  return splitCitedText(text).map((part, at) => {
    if (part.kind === 'text') return <span key={at}>{part.text}</span>

    const citation = citations.find((item) => item.index === part.index)
    if (citation === undefined) return <span key={at}>[{part.index}]</span>

    return (
      <button
        key={at}
        type="button"
        className="ai-cite"
        title={`${citation.title.trim() || '无标题'}${
          citation.heading.trim() === '' ? '' : ` > ${citation.heading}`
        }`}
        onClick={() => onOpenNote(citation.noteId)}
      >
        [{part.index}]
      </button>
    )
  })
}

export default AiPanel
