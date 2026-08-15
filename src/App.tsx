// 主窗口：左侧笔记流 + 右侧编辑器，⌘/Ctrl+K 唤起搜索。
//
// 状态归属：笔记列表、当前笔记正文、搜索面板开关都在这里；
// NoteList / TagFilter / SearchPanel 是纯展示组件。所有 IPC 调用都在这一层收口并 catch，
// 失败统一落到底部错误栏——ipc 层 reject 的是字符串，String(e) 就是可读的中文消息。
//
// 自动保存的关键约束：
// 1. 待保存的目标（笔记 id + 正文）存在 ref 里而不是闭包里，且在「切换笔记 / 新建 /
//    删除」之前先 flush。否则 800ms 防抖窗口内切走笔记，定时器落地时会把新笔记的
//    正文写进旧笔记的 id。
// 2. 保存失败时那份内容必须**放回** pendingRef 并重新武装定时器。丢掉它等于：
//    用户看到红条 → 点开另一条笔记 → openNote 里的 flushSave 成了空操作 →
//    加载新正文覆盖编辑器 → 刚才那次编辑再也没有任何持有者，连卸载兜底都救不回来。

import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { NoteList } from './components/NoteList'
import { SearchPanel } from './components/SearchPanel'
import { collectTags, TagFilter } from './components/TagFilter'
import { Editor, EMPTY_DOC } from './editor/Editor'
import { collectAttachmentIds } from './lib/doc'
import { ipc, type NoteSummary } from './lib/ipc'
import { keys } from './lib/platform'

const AUTOSAVE_MS = 800

// 失败重试用指数退避（1.5s / 3s / 6s / 12s）而不是继续按 800ms 死循环：
// 磁盘满、库被 WAL checkpoint 锁住这类故障不会在一秒内自愈，
// 高频重试只会把错误栏刷爆、把 CPU 烧在必然失败的 IPC 上。
const SAVE_RETRY_BASE_MS = 1500
// 退避到头就停手，把错误留在界面上等用户处理（内容仍在 pendingRef 和编辑器里）。
// 用户下一次敲键盘会重置这个预算，等于「修好问题后继续编辑即自动重试」。
const MAX_SAVE_RETRIES = 4

type SaveStatus = 'idle' | 'dirty' | 'saving' | 'retrying'

const STATUS_TEXT: Record<SaveStatus, string> = {
  idle: '已保存',
  dirty: '未保存',
  saving: '保存中…',
  retrying: '保存失败，正在重试…',
}

export function App() {
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [currentId, setCurrentId] = useState<number | null>(null)
  const [body, setBody] = useState<string>(EMPTY_DOC)
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [searchOpen, setSearchOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
  const [rebuilding, setRebuilding] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const timerRef = useRef<number | null>(null)
  const pendingRef = useRef<{ id: number; bodyJson: string } | null>(null)
  // 在途保存的笔记 id（null = 空闲）。同一时刻只允许一次 update_note 在途：
  // 并发写同一条笔记时落地顺序不可控，后发的旧内容可能覆盖先发的新内容。
  const inFlightIdRef = useRef<number | null>(null)
  const retriesRef = useRef(0)
  // 已删除的笔记 id：保存失败后不该把它们的内容再放回 pending 重试。
  const abandonedRef = useRef<Set<number>>(new Set())

  const refresh = useCallback(async () => {
    try {
      setNotes(await ipc.listNotes())
    } catch (err) {
      setError(String(err))
    }
  }, [])

  /**
   * 保存状态的唯一真相来源：pending 空了就是「已保存」，
   * 还留着东西则看有没有排队中的重试。切换笔记后也要按它重算——
   * 上一条的内容可能还在重试队列里，状态栏不能因为切了笔记就谎报「已保存」。
   */
  const settleStatus = useCallback(() => {
    if (pendingRef.current === null) setStatus('idle')
    else setStatus(retriesRef.current > 0 ? 'retrying' : 'dirty')
  }, [])

  const cancelTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // flushSave 要在自己内部重新武装定时器（重试、以及在途期间攒下的新改动），
  // 而定时器回调又要调 flushSave——用 ref 打破这个循环依赖。
  const flushRef = useRef<() => Promise<void>>(async () => {})

  const schedule = useCallback(
    (delayMs: number) => {
      cancelTimer()
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        void flushRef.current()
      }, delayMs)
    },
    [cancelTimer],
  )

  /** 立刻写盘：取消防抖计时器并把待保存内容存下去。没有待保存内容时是空操作。 */
  const flushSave = useCallback(async () => {
    cancelTimer()
    // 已有一次在途：留着 pending 不动，那一次结束后会把剩下的接着存。
    if (inFlightIdRef.current !== null) return

    const job = pendingRef.current
    pendingRef.current = null
    if (!job) return

    inFlightIdRef.current = job.id
    setStatus('saving')
    let retryDelay: number | null = null
    try {
      // 附件 id 必须一起传：update 会整表替换 note_attachments，漏传等于解绑图片。
      await ipc.updateNote(job.id, job.bodyJson, collectAttachmentIds(job.bodyJson))
      retriesRef.current = 0
      settleStatus()
      // 标题和摘要由后端从正文推导，存完必须重新拉列表才能看到变化。
      await refresh()
    } catch (err) {
      if (abandonedRef.current.has(job.id)) {
        // 笔记在保存途中被删掉了：这次失败已经无关紧要，安静收场，别弹红条吓人，
        // 更别把内容放回去重试一条已经不存在的笔记。
        abandonedRef.current.delete(job.id)
        settleStatus()
      } else {
        // 这份内容还给 pendingRef，否则它就没有任何持有者了。
        // 期间用户可能已经打出更新的内容——那份更新，别用旧的盖掉它。
        if (pendingRef.current === null) pendingRef.current = job
        setError(String(err))

        if (retriesRef.current < MAX_SAVE_RETRIES) {
          retryDelay = SAVE_RETRY_BASE_MS * 2 ** retriesRef.current
          retriesRef.current += 1
          setStatus('retrying')
        } else {
          // 退到 0 是有意的：重试预算已经耗尽，下一次编辑重新开始计数。
          retriesRef.current = 0
          setStatus('dirty')
          setError(
            `${String(err)}（已连续重试 ${MAX_SAVE_RETRIES} 次，暂停自动重试。` +
              '内容仍留在编辑器里，处理完问题后继续编辑即可重新尝试保存）',
          )
        }
      }
    } finally {
      inFlightIdRef.current = null
    }

    if (retryDelay !== null) schedule(retryDelay)
    // 在途期间攒下来的新改动：按正常防抖节奏补一次。
    else if (pendingRef.current !== null && timerRef.current === null) schedule(AUTOSAVE_MS)
  }, [cancelTimer, refresh, schedule, settleStatus])

  flushRef.current = flushSave

  // 首屏拉列表
  useEffect(() => {
    void refresh()
  }, [refresh])

  // 快捕窗口存完笔记会 emit('note-saved')，主窗口据此刷新列表。
  // listen 是异步的：清理函数不能是 async，所以用 cancelled 标志处理
  // 「还没拿到 unlisten 就卸载了」的竞态。
  useEffect(() => {
    let cancelled = false
    let unlisten: UnlistenFn | null = null

    listen('note-saved', () => {
      void refresh()
    }).then(
      (fn) => {
        if (cancelled) fn()
        else unlisten = fn
      },
      (err: unknown) => setError(String(err)),
    )

    return () => {
      cancelled = true
      if (unlisten) unlisten()
    }
  }, [refresh])

  // 卸载时清计时器，并尽力把最后一次改动写下去（不能 await，清理函数是同步的）。
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = null
      const job = pendingRef.current
      pendingRef.current = null
      if (job) {
        ipc.updateNote(job.id, job.bodyJson, collectAttachmentIds(job.bodyJson)).catch((err: unknown) => {
          console.error('[app] 卸载前保存失败', err)
        })
      }
    }
  }, [])

  // 「重建了 N 条」这类提示是一次性的，留着会一直挂在侧边栏底下，过几秒自己消失。
  useEffect(() => {
    if (notice === null) return
    const timer = window.setTimeout(() => setNotice(null), 6000)
    return () => window.clearTimeout(timer)
  }, [notice])

  // ⌘/Ctrl+K 开关搜索面板。Esc 由 SearchPanel 自己处理。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSearchOpen((prev) => !prev)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const openNote = useCallback(
    async (id: number) => {
      await flushSave()
      try {
        const note = await ipc.getNote(id)
        setCurrentId(note.id)
        setBody(note.bodyJson)
        settleStatus()
      } catch (err) {
        setError(String(err))
      }
    },
    [flushSave, settleStatus],
  )

  const createNote = useCallback(async () => {
    await flushSave()
    try {
      const note = await ipc.createNote(EMPTY_DOC)
      setCurrentId(note.id)
      setBody(note.bodyJson)
      settleStatus()
      await refresh()
    } catch (err) {
      setError(String(err))
    }
  }, [flushSave, refresh, settleStatus])

  const deleteNote = useCallback(
    async (id: number) => {
      // 待保存的正好是被删的这条就直接丢弃，别把它又写回去。
      if (pendingRef.current?.id === id) {
        pendingRef.current = null
        cancelTimer()
      }
      // 这条的保存正在途中：失败后不该把它放回 pending 重试一条已删除的笔记。
      if (inFlightIdRef.current === id) abandonedRef.current.add(id)
      try {
        await ipc.deleteNote(id)
        if (currentId === id) {
          setCurrentId(null)
          setBody(EMPTY_DOC)
          setStatus('idle')
        }
        await refresh()
      } catch (err) {
        setError(String(err))
      }
    },
    [cancelTimer, currentId, refresh],
  )

  // Editor 是受控的：onChange 回来的字符串必须存进 state 再传回去。
  const handleChange = useCallback(
    (bodyJson: string) => {
      setBody(bodyJson)
      if (currentId === null) return

      pendingRef.current = { id: currentId, bodyJson }
      // 重新武装防抖计时器。若之前重试预算已经耗尽（那时 retriesRef 归零），
      // 这一次编辑就等于重新开始尝试；若还在退避中间，则沿用当前的退避档位，
      // 免得一边打字一边把失败的请求按 800ms 一次地砸出去。
      settleStatus()
      schedule(AUTOSAVE_MS)
    },
    [currentId, schedule, settleStatus],
  )

  const handlePick = useCallback(
    (noteId: number) => {
      setSearchOpen(false)
      void openNote(noteId)
    },
    [openNote],
  )

  /** FTS 与 notes 对不上时的自救入口（spec §7）。耗时操作，禁止并发点。 */
  const rebuildIndex = useCallback(async () => {
    if (rebuilding) return
    setRebuilding(true)
    setNotice(null)
    try {
      const count = await ipc.rebuildIndex()
      setNotice(`索引已重建：${count} 条笔记`)
    } catch (err) {
      setError(String(err))
    } finally {
      setRebuilding(false)
    }
  }, [rebuilding])

  const tags = useMemo(() => collectTags(notes), [notes])
  // 选中的标签可能因为笔记被删、被改而从列表里消失。这时按「全部」处理，
  // 否则会得到一个空列表加一个已经不存在的筛选条件，用户无从解释。
  const activeTag =
    selectedTag !== null && tags.some((tag) => tag.name === selectedTag) ? selectedTag : null
  const visibleNotes = useMemo(
    () => (activeTag === null ? notes : notes.filter((note) => note.tags.includes(activeTag))),
    [notes, activeTag],
  )

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-actions">
          <button type="button" className="primary" onClick={() => void createNote()}>
            新建
          </button>
          <button type="button" onClick={() => setSearchOpen(true)}>
            搜索 {keys.search}
          </button>
        </div>
        <TagFilter tags={tags} selected={activeTag} onSelect={setSelectedTag} />
        <div className="sidebar-list">
          <NoteList
            notes={visibleNotes}
            selectedId={currentId}
            onSelect={(id) => void openNote(id)}
            onDelete={(id) => void deleteNote(id)}
          />
        </div>
        <div className="sidebar-footer">
          <button
            type="button"
            className="subtle"
            disabled={rebuilding}
            title="搜索结果和笔记对不上时用它：从正文全量重算全文索引"
            onClick={() => void rebuildIndex()}
          >
            {rebuilding ? '重建索引中…' : '重建索引'}
          </button>
          {notice ? <span className="sidebar-notice">{notice}</span> : null}
        </div>
      </aside>

      <main className="workspace">
        {currentId === null ? (
          <div className="workspace-empty">
            <p>选一条笔记开始编辑</p>
            <p className="hint">或者点左上角「新建」，{keys.search} 搜索已有内容。</p>
          </div>
        ) : (
          <>
            <div className="workspace-status">{STATUS_TEXT[status]}</div>
            {/* 切换笔记只换 bodyJson，绝不能加 key——加了会重建编辑器、丢 undo 与焦点 */}
            <Editor bodyJson={body} onChange={handleChange} onError={setError} />
          </>
        )}
      </main>

      {searchOpen ? (
        <SearchPanel onClose={() => setSearchOpen(false)} onPick={handlePick} />
      ) : null}

      {error ? (
        <div className="error-bar" role="alert" onClick={() => setError(null)}>
          {error}
          <span className="error-dismiss">点击关闭</span>
        </div>
      ) : null}
    </div>
  )
}

export default App
