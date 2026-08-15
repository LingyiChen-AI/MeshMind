// 主窗口：左侧笔记流 + 右侧编辑器，⌘/Ctrl+K 唤起搜索。
//
// 状态归属：笔记列表、当前笔记正文、搜索面板开关都在这里；
// NoteList / SearchPanel 是纯展示组件。所有 IPC 调用都在这一层收口并 catch，
// 失败统一落到底部错误栏——ipc 层 reject 的是字符串，String(e) 就是可读的中文消息。
//
// 自动保存的关键约束：待保存的目标（笔记 id + 正文）存在 ref 里而不是闭包里，
// 且在「切换笔记 / 新建 / 删除」之前先 flush。否则 800ms 防抖窗口内切走笔记，
// 定时器落地时会把新笔记的正文写进旧笔记的 id。

import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useCallback, useEffect, useRef, useState } from 'react'

import { collectAttachmentIds } from './components/doc'
import { NoteList } from './components/NoteList'
import { SearchPanel } from './components/SearchPanel'
import { Editor, EMPTY_DOC } from './editor/Editor'
import { ipc, type NoteSummary } from './lib/ipc'

const AUTOSAVE_MS = 800

type SaveStatus = 'idle' | 'dirty' | 'saving'

export function App() {
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [currentId, setCurrentId] = useState<number | null>(null)
  const [body, setBody] = useState<string>(EMPTY_DOC)
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [searchOpen, setSearchOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const timerRef = useRef<number | null>(null)
  const pendingRef = useRef<{ id: number; bodyJson: string } | null>(null)

  const refresh = useCallback(async () => {
    try {
      setNotes(await ipc.listNotes())
    } catch (err) {
      setError(String(err))
    }
  }, [])

  /** 立刻写盘：取消防抖计时器并把待保存内容存下去。没有待保存内容时是空操作。 */
  const flushSave = useCallback(async () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const job = pendingRef.current
    pendingRef.current = null
    if (!job) return

    setStatus('saving')
    try {
      // 附件 id 必须一起传：update 会整表替换 note_attachments，漏传等于解绑图片。
      await ipc.updateNote(job.id, job.bodyJson, collectAttachmentIds(job.bodyJson))
      setStatus('idle')
      // 标题和摘要由后端从正文推导，存完必须重新拉列表才能看到变化。
      await refresh()
    } catch (err) {
      setStatus('dirty')
      setError(String(err))
    }
  }, [refresh])

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
        setStatus('idle')
      } catch (err) {
        setError(String(err))
      }
    },
    [flushSave],
  )

  const createNote = useCallback(async () => {
    await flushSave()
    try {
      const note = await ipc.createNote(EMPTY_DOC)
      setCurrentId(note.id)
      setBody(note.bodyJson)
      setStatus('idle')
      await refresh()
    } catch (err) {
      setError(String(err))
    }
  }, [flushSave, refresh])

  const deleteNote = useCallback(
    async (id: number) => {
      // 待保存的正好是被删的这条就直接丢弃，别把它又写回去。
      if (pendingRef.current?.id === id) {
        pendingRef.current = null
        if (timerRef.current !== null) {
          window.clearTimeout(timerRef.current)
          timerRef.current = null
        }
      }
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
    [currentId, refresh],
  )

  // Editor 是受控的：onChange 回来的字符串必须存进 state 再传回去。
  const handleChange = useCallback(
    (bodyJson: string) => {
      setBody(bodyJson)
      if (currentId === null) return

      pendingRef.current = { id: currentId, bodyJson }
      setStatus('dirty')
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        void flushSave()
      }, AUTOSAVE_MS)
    },
    [currentId, flushSave],
  )

  const handlePick = useCallback(
    (noteId: number) => {
      setSearchOpen(false)
      void openNote(noteId)
    },
    [openNote],
  )

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-actions">
          <button type="button" className="primary" onClick={() => void createNote()}>
            新建
          </button>
          <button type="button" onClick={() => setSearchOpen(true)}>
            搜索 ⌘K
          </button>
        </div>
        <div className="sidebar-list">
          <NoteList
            notes={notes}
            selectedId={currentId}
            onSelect={(id) => void openNote(id)}
            onDelete={(id) => void deleteNote(id)}
          />
        </div>
      </aside>

      <main className="workspace">
        {currentId === null ? (
          <div className="workspace-empty">
            <p>选一条笔记开始编辑</p>
            <p className="hint">或者点左上角「新建」，⌘K 搜索已有内容。</p>
          </div>
        ) : (
          <>
            <div className="workspace-status">
              {status === 'saving' ? '保存中…' : status === 'dirty' ? '未保存' : '已保存'}
            </div>
            {/* 切换笔记只换 bodyJson，绝不能加 key——加了会重建编辑器、丢 undo 与焦点 */}
            <Editor bodyJson={body} onChange={handleChange} />
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
