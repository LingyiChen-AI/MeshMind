// 左侧笔记流。纯展示组件：不发 IPC、不持有选中状态，
// 数据和回调全部由 App 注入，这样它在搜索结果、回收站等场景也能复用。
//
// 分页用「加载更多」按钮而不是滚动到底自动加载，理由见 App 里 loadMore 附近的注释。
// 这里只负责渲染三种末尾状态：可以加载更多 / 正在加载 / 到底了。

import type { ReactNode } from 'react'

import { listPhase, type Paged } from '../lib/pagination'
import type { NoteSummary } from '../lib/ipc'
import { keys } from '../lib/platform'

/** 后端存的是毫秒时间戳（crates/core 里 `as_millis`），直接喂 Date 即可。 */
function formatTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export interface NoteListProps {
  page: Paged<NoteSummary>
  selectedId: number | null
  /** 首屏 / 切换筛选时的加载态，用来避免闪一下空态 */
  loading: boolean
  /** 正在加载下一页 */
  loadingMore: boolean
  onSelect: (id: number) => void
  onDelete: (id: number) => void
  onLoadMore: () => void
  /** 空态文案。按标签筛选时和「一条笔记都没有」不是一回事。 */
  emptyHint?: ReactNode
}

export function NoteList({
  page,
  selectedId,
  loading,
  loadingMore,
  onSelect,
  onDelete,
  onLoadMore,
  emptyHint,
}: NoteListProps) {
  const phase = listPhase(loading, page.items.length)

  if (phase === 'loading') return <div className="note-list-empty">加载中…</div>

  if (phase === 'empty') {
    return (
      <div className="note-list-empty">
        {emptyHint ?? (
          <>
            <p>还没有笔记</p>
            <p className="hint">点「新建」开始写，或按 {keys.capture} 随手记一条。</p>
          </>
        )}
      </div>
    )
  }

  return (
    <>
      <ul className="note-list">
        {page.items.map((note) => (
          <li
            key={note.id}
            className={`note-item${note.id === selectedId ? ' selected' : ''}`}
            onClick={() => onSelect(note.id)}
          >
            <div className="note-item-head">
              <span className="note-item-title">{note.title.trim() || '无标题'}</span>
              <button
                type="button"
                className="note-item-delete"
                title="删除"
                aria-label="删除笔记"
                // 不 stopPropagation 的话点删除会连带触发 li 的 onSelect，
                // 于是「删掉一条」同时把它选中，右侧闪一下已经不存在的笔记。
                onClick={(event) => {
                  event.stopPropagation()
                  onDelete(note.id)
                }}
              >
                ×
              </button>
            </div>
            {note.excerpt.trim() ? <p className="note-item-excerpt">{note.excerpt}</p> : null}
            <div className="note-item-meta">
              <time>{formatTime(note.updatedAt)}</time>
              {note.tags.length > 0 ? (
                <span className="note-item-tags">
                  {note.tags.map((tag) => (
                    <span key={tag} className="tag">
                      #{tag}
                    </span>
                  ))}
                </span>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      <div className="list-more">
        {page.hasMore ? (
          <button type="button" className="subtle" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? '加载中…' : '加载更多'}
          </button>
        ) : (
          // 明确的终止态：不写这句，用户会一直往下拽找那个不存在的下一页。
          <span className="list-more-end">没有更多了</span>
        )}
      </div>
    </>
  )
}

export default NoteList
