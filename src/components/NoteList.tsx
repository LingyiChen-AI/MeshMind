// 左侧笔记流。纯展示组件：不发 IPC、不持有选中状态，
// 数据和回调全部由 App 注入，这样它在搜索结果、回收站等场景也能复用。

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
  notes: NoteSummary[]
  selectedId: number | null
  onSelect: (id: number) => void
  onDelete: (id: number) => void
}

export function NoteList({ notes, selectedId, onSelect, onDelete }: NoteListProps) {
  if (notes.length === 0) {
    return (
      <div className="note-list-empty">
        <p>还没有笔记</p>
        <p className="hint">点「新建」开始写，或按 {keys.capture} 随手记一条。</p>
      </div>
    )
  }

  return (
    <ul className="note-list">
      {notes.map((note) => (
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
  )
}

export default NoteList
