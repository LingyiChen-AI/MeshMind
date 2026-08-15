// ⌘K 搜索面板：遮罩 + 居中输入框 + 结果列表。
//
// 两个容易踩的点，实现时刻意处理了：
// 1. 防抖必须在 effect 里做，并在清理函数里 clearTimeout。否则连打几个字会并发出多个
//    请求，回来的顺序无法保证，慢的旧请求会覆盖快的新结果。
// 2. 拼音命中（PinyinFull / PinyinHead）的 matchedTerms 是空数组——拼音串在原文里根本
//    不存在，没法定位。splitByTerms 遇到空 terms 会整段返回不高亮，这是预期行为。

import { useEffect, useRef, useState } from 'react'

import { splitByTerms } from '../lib/highlight'
import { ipc, type HitSource, type SearchHit } from '../lib/ipc'

const SOURCE_LABEL: Record<HitSource, string> = {
  Literal: '字面',
  PinyinFull: '全拼',
  PinyinHead: '首字母',
}

/** 把文本按命中词切片渲染，命中部分包 <mark>。 */
function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {splitByTerms(text, terms).map((slice, index) =>
        slice.hit ? <mark key={index}>{slice.text}</mark> : <span key={index}>{slice.text}</span>,
      )}
    </>
  )
}

export interface SearchPanelProps {
  onClose: () => void
  onPick: (noteId: number) => void
}

export function SearchPanel({ onClose, onPick }: SearchPanelProps) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [active, setActive] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // 已经拿到结果的那个关键词。用它判断「零结果」还是「还没搜完」，
  // 避免刚敲第一个字就闪一下「没有命中」。
  const [settledFor, setSettledFor] = useState('')
  const listRef = useRef<HTMLUListElement | null>(null)

  // 输入即搜，120ms 防抖。alive 标志保证被顶掉的那次请求即使已经发出，
  // 回来时也不会写进 state。
  useEffect(() => {
    const keyword = query.trim()
    if (keyword.length === 0) {
      setHits([])
      setActive(0)
      setError(null)
      setSettledFor('')
      return
    }

    let alive = true
    const timer = window.setTimeout(() => {
      ipc.searchNotes(keyword).then(
        (result) => {
          if (!alive) return
          setHits(result)
          setActive(0)
          setError(null)
          setSettledFor(keyword)
        },
        (err: unknown) => {
          if (!alive) return
          setHits([])
          setError(String(err))
          setSettledFor(keyword)
        },
      )
    }, 120)

    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [query])

  // 键盘导航挂在 document 上，这样即使焦点跑出输入框（点了结果项）也照样响应。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActive((prev) => (hits.length === 0 ? 0 : (prev + 1) % hits.length))
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActive((prev) => (hits.length === 0 ? 0 : (prev - 1 + hits.length) % hits.length))
        return
      }
      if (event.key === 'Enter') {
        const hit = hits[active]
        if (hit) {
          event.preventDefault()
          onPick(hit.noteId)
        }
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [hits, active, onClose, onPick])

  // 键盘移动时把当前项滚进视野。
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const keyword = query.trim()

  return (
    <div className="search-overlay" onClick={onClose}>
      {/* 点面板内部不该关闭，所以在这里截断冒泡 */}
      <div className="search-panel" onClick={(event) => event.stopPropagation()}>
        <input
          className="search-input"
          autoFocus
          value={query}
          placeholder="搜索笔记：中文、拼音连写（zhishitupu）或首字母（zstp）"
          onChange={(event) => setQuery(event.target.value)}
        />

        {error ? <div className="search-error">{error}</div> : null}

        {hits.length > 0 ? (
          <ul className="search-results" ref={listRef}>
            {hits.map((hit, index) => (
              <li
                key={hit.noteId}
                data-index={index}
                className={`search-hit${index === active ? ' active' : ''}`}
                onMouseEnter={() => setActive(index)}
                onClick={() => onPick(hit.noteId)}
              >
                <div className="search-hit-head">
                  <span className="search-hit-title">
                    <Highlighted text={hit.title.trim() || '无标题'} terms={hit.matchedTerms} />
                  </span>
                  <span className="search-hit-source">{SOURCE_LABEL[hit.source]}</span>
                </div>
                <p className="search-hit-excerpt">
                  <Highlighted text={hit.excerpt} terms={hit.matchedTerms} />
                </p>
              </li>
            ))}
          </ul>
        ) : keyword.length > 0 && keyword === settledFor && !error ? (
          <div className="search-empty">没有命中</div>
        ) : null}

        <div className="search-tip">↑↓ 选择 · Enter 打开 · Esc 关闭</div>
      </div>
    </div>
  )
}

export default SearchPanel
