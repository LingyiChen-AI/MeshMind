// 回收站：遮罩 + 居中面板，Esc 关闭（和 ⌘K 搜索面板保持一致的交互习惯）。
//
// 为什么需要它：delete_note 是**软删除**，笔记只是被打上 deleted_at。在这个面板出现
// 之前，被删的笔记既看不见也恢复不了，而且它们仍然「引用着」自己的附件，
// 于是那些附件永远过不了 GC——回收站不只是撤销入口，也是磁盘占用的唯一出口。
//
// 自己发 IPC（和 SearchPanel 一样），只在数据真的变了之后回调 onChanged 通知 App
// 刷新主列表和标签。恢复成功后直接关面板：需求是「恢复后回到主列表」。
//
// 显示的时间用 NoteSummary.updatedAt——软删除那条 SQL 是
// `SET deleted_at = ?2, updated_at = ?2`，两个字段同值，所以对回收站里的笔记来说
// updated_at 就是删除时间。（NoteSummary 里没有单独的 deleted_at 字段。）

import { useCallback, useEffect, useRef, useState } from 'react'

import { ipc, type NoteSummary } from '../lib/ipc'
import {
  appendPage,
  emptyPage,
  listPhase,
  nextOffset,
  PAGE_SIZE,
  removeItem,
  replacePage,
  type Paged,
} from '../lib/pagination'
import { confirmLabel, nextConfirmState, purgedAllMessage, purgedOneMessage } from '../lib/trash'

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export interface TrashPanelProps {
  onClose: () => void
  /** 回收站里的内容变了（恢复 / 彻底删除），主列表和标签需要重拉 */
  onChanged: () => void
  /** 恢复成功，顺带把提示交给 App 的通知位 */
  onRestored: (note: NoteSummary) => void
}

export function TrashPanel({ onClose, onChanged, onRestored }: TrashPanelProps) {
  const [page, setPage] = useState<Paged<NoteSummary>>(emptyPage<NoteSummary>())
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [confirm, setConfirm] = useState<'idle' | 'armed'>('idle')
  const [purging, setPurging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // loadMore 要读当前页而又不想因此重建回调（重建会让按钮在加载中被换掉）。
  const pageRef = useRef(page)
  pageRef.current = page

  useEffect(() => {
    let alive = true
    ipc.listDeletedNotes(PAGE_SIZE, 0).then(
      (batch) => {
        if (!alive) return
        setPage(replacePage(batch, PAGE_SIZE))
        setLoading(false)
      },
      (err: unknown) => {
        if (!alive) return
        setError(String(err))
        setLoading(false)
      },
    )
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const loadMore = useCallback(async () => {
    const current = pageRef.current
    if (!current.hasMore) return
    setLoadingMore(true)
    try {
      const batch = await ipc.listDeletedNotes(PAGE_SIZE, nextOffset(current))
      setPage(appendPage(pageRef.current, batch, PAGE_SIZE))
    } catch (err) {
      setError(String(err))
    } finally {
      setLoadingMore(false)
    }
  }, [])

  const restore = useCallback(
    async (note: NoteSummary) => {
      setBusyId(note.id)
      try {
        await ipc.restoreNote(note.id)
        onChanged()
        onRestored(note)
        onClose()
      } catch (err) {
        setError(String(err))
        setBusyId(null)
      }
    },
    [onChanged, onClose, onRestored],
  )

  const purgeOne = useCallback(
    async (note: NoteSummary) => {
      setBusyId(note.id)
      setError(null)
      // 去干别的了，「清空回收站」的确认就该失效——不能让一个武装好的不可逆按钮
      // 在旁边等着下一次误点。
      setConfirm('idle')
      try {
        await ipc.purgeNote(note.id)
        // 就地摘掉而不是重拉：重拉会把「加载更多」的进度一起清掉。
        const next = removeItem(pageRef.current, note.id)
        if (next.items.length === 0 && next.hasMore) {
          // 把当前这页删空了，但后面还有——这时候显示「回收站是空的」是假的，补一页。
          setPage(replacePage(await ipc.listDeletedNotes(PAGE_SIZE, 0), PAGE_SIZE))
        } else {
          setPage(next)
        }
        setNotice(purgedOneMessage(note.title))
        onChanged()
      } catch (err) {
        setError(String(err))
      } finally {
        setBusyId(null)
      }
    },
    [onChanged],
  )

  const purgeAll = useCallback(async () => {
    // 第一次点只是武装（按钮变成「确认清空（不可恢复）」），第二次才真的执行。
    if (confirm === 'idle') {
      setConfirm(nextConfirmState(confirm, 'arm'))
      return
    }
    setConfirm('idle')
    setPurging(true)
    setError(null)
    try {
      const count = await ipc.purgeAllDeleted()
      setPage(emptyPage<NoteSummary>())
      setNotice(purgedAllMessage(count))
      onChanged()
    } catch (err) {
      setError(String(err))
    } finally {
      setPurging(false)
    }
  }, [confirm, onChanged])

  const phase = listPhase(loading, page.items.length)
  const busy = purging || busyId !== null

  return (
    <div className="search-overlay" onClick={onClose}>
      <div className="search-panel trash-panel" onClick={(event) => event.stopPropagation()}>
        <div className="trash-head">
          <span className="trash-title">回收站</span>
          <div className="trash-head-actions">
            {confirm === 'armed' ? (
              <button
                type="button"
                className="subtle"
                onClick={() => setConfirm(nextConfirmState(confirm, 'cancel'))}
              >
                取消
              </button>
            ) : null}
            <button
              type="button"
              className={confirm === 'armed' ? 'danger' : ''}
              disabled={purging || page.items.length === 0}
              onClick={() => void purgeAll()}
            >
              {purging ? '清空中…' : confirmLabel(confirm)}
            </button>
          </div>
        </div>

        {error ? <div className="search-error">{error}</div> : null}
        {notice ? <div className="trash-notice">{notice}</div> : null}

        {phase === 'loading' ? <div className="search-empty">加载中…</div> : null}

        {phase === 'empty' ? (
          <div className="search-empty">
            <p>回收站是空的</p>
            <p>删掉的笔记会先落在这里，可以恢复；彻底删除之后才会释放附件占用的空间。</p>
          </div>
        ) : null}

        {phase === 'list' ? (
          <ul className="search-results">
            {page.items.map((note) => (
              <li key={note.id} className="trash-item">
                <div className="search-hit-head">
                  <span className="search-hit-title">{note.title.trim() || '无标题'}</span>
                  <span className="search-hit-source">删除于 {formatTime(note.updatedAt)}</span>
                </div>
                {note.excerpt.trim() ? (
                  <p className="search-hit-excerpt">{note.excerpt}</p>
                ) : null}
                <div className="trash-item-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void restore(note)}
                  >
                    恢复
                  </button>
                  <button
                    type="button"
                    className="subtle"
                    disabled={busy}
                    title="不可撤销"
                    onClick={() => void purgeOne(note)}
                  >
                    彻底删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        {phase === 'list' && page.hasMore ? (
          <div className="list-more">
            <button type="button" className="subtle" disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? '加载中…' : '加载更多'}
            </button>
          </div>
        ) : null}

        <div className="search-tip">彻底删除不可撤销 · Esc 关闭</div>
      </div>
    </div>
  )
}

export default TrashPanel
