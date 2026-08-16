// ⌘K 搜索面板：遮罩 + 居中输入框 + 两组结果（关键词匹配 / 语义相关）。
//
// 两个容易踩的点，实现时刻意处理了：
// 1. 防抖必须在 effect 里做，并在清理函数里 clearTimeout。否则连打几个字会并发出多个
//    请求，回来的顺序无法保证，慢的旧请求会覆盖快的新结果。
// 2. 拼音命中（PinyinFull / PinyinHead）的 matchedTerms 是空数组——拼音串在原文里根本
//    不存在，没法定位。splitByTerms 遇到空 terms 会整段返回不高亮，这是预期行为。
//
// 语义那一组和字面那一组不是一回事，别把它们的代码合起来：
// - 它每敲一个键都要先过一次 embedding 请求，慢一个数量级，所以防抖更长（600ms），
//   loading 也是独立的一份；
// - 它慢就意味着结果会乱序回来，所以走 `createLatestOnly` 的序号闸门；
// - **AI 关着时这个命令返回 `[]` 而不是报错**，所以它既不接错误横幅，
//   也不显示任何「未启用」占位——搜索框不该变成 AI 的广告位。

import { useEffect, useRef, useState } from 'react'

import { createLatestOnly, dropSeenNotes, type LatestOnly } from '../lib/ai'
import { splitByTerms } from '../lib/highlight'
import { ipc, type HitSource, type SearchHit, type SemanticHit } from '../lib/ipc'

/**
 * 两档防抖。字面检索是本地 FTS，120ms 已经足够挡住连打；
 * 语义检索要真的发一次网络请求（还要花钱），拖到 600ms——
 * 用同一个数字等于每敲一个键都掏一次钱包。
 */
const LITERAL_DEBOUNCE_MS = 120
const SEMANTIC_DEBOUNCE_MS = 600

/** 语义那一组最多要几条。去重之后通常还会更少。 */
const SEMANTIC_LIMIT = 10

/** 语义结果连同它属于哪个关键词一起存：查询变了而结果还没回来时，旧的一组不能留在屏幕上。 */
interface SemanticState {
  query: string
  hits: SemanticHit[]
}

/**
 * 一次语义检索。**拿不到就算了**：AI 没开、没配全、查询为空时后端返回 `[]`；
 * 真出错了（embedding 请求打不通）也只当成「这次没有语义结果」。
 *
 * 这一组是锦上添花，为它在搜索框上弹一条红色横幅，代价是把用户从「我在找东西」
 * 里拽出来，去处理一个和他要找的东西无关的问题。
 */
async function semanticSearch(keyword: string): Promise<SemanticHit[]> {
  try {
    return await ipc.aiSemanticSearch(keyword, SEMANTIC_LIMIT)
  } catch {
    return []
  }
}

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

  const [semantic, setSemantic] = useState<SemanticState>({ query: '', hits: [] })
  const [semanticLoading, setSemanticLoading] = useState(false)
  // 「这台机器上的 AI 是开着的」的唯一证据：真的拿到过语义结果。
  //
  // 关着 AI 时 `ai_semantic_search` 返回的也是 `[]`，我们分不清「没开」和「没匹配」。
  // 所以在拿到第一批结果之前，这一组的任何东西都不渲染——**包括「检索中…」**。
  // 否则一个压根没配 AI 的用户，每敲一个键都会看见一行 AI 的广告。
  const [semanticSeen, setSemanticSeen] = useState(false)

  // 面板是随手开关的，请求很可能在它关掉之后才回来。
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // 闸门的序号要活得比一次 render 长（它记的就是「最新的是第几次」），所以放进 ref。
  const runSemantic = useRef<LatestOnly<SemanticHit[]> | null>(null)
  if (runSemantic.current === null) runSemantic.current = createLatestOnly(semanticSearch)

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
    }, LITERAL_DEBOUNCE_MS)

    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [query])

  // 语义检索。和上面那个 effect 分开是因为两者的节奏完全不同（见文件头）。
  //
  // 这里**没有**上面那种 `alive` 标志：过期结果由 `createLatestOnly` 的序号统一丢弃，
  // 两道判据不一样（一个是「effect 被顶掉了」，一个是「这不是最新那次请求」），
  // 混在一起只会让其中一道失效而没人发现。卸载由 `aliveRef` 兜。
  useEffect(() => {
    const keyword = query.trim()
    if (keyword.length === 0) {
      setSemantic({ query: '', hits: [] })
      setSemanticLoading(false)
      return
    }

    const timer = window.setTimeout(() => {
      setSemanticLoading(true)
      void runSemantic.current?.(keyword, (hits) => {
        if (!aliveRef.current) return
        setSemantic({ query: keyword, hits })
        setSemanticLoading(false)
        if (hits.length > 0) setSemanticSeen(true)
      })
    }, SEMANTIC_DEBOUNCE_MS)

    return () => window.clearTimeout(timer)
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

  // 语义结果只在**和当前关键词对得上**时才算数：查询已经换了而新结果还没回来的那几百毫秒，
  // 旧关键词的语义结果留在屏幕上，比空着更让人困惑。
  //
  // 去重放在渲染时算而不是落库时算：两组的到达顺序不固定（字面 120ms，语义 600ms 起），
  // 谁先到都要能正确地去掉重合的那几篇。
  const semanticHits =
    semantic.query === keyword ? dropSeenNotes(semantic.hits, hits.map((hit) => hit.noteId)) : []
  // 「这一组马上就有东西了」：只在已经确认 AI 开着的前提下才占位（见 semanticSeen）。
  const semanticBusy =
    semanticSeen && keyword.length > 0 && (semanticLoading || semantic.query !== keyword)
  const showSemantic = semanticHits.length > 0 || semanticBusy

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

        {hits.length > 0 || showSemantic ? (
          <div className="search-groups">
            {hits.length > 0 ? (
              <section className="search-group">
                <h2 className="search-group-title">关键词匹配</h2>
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
                          <Highlighted
                            text={hit.title.trim() || '无标题'}
                            terms={hit.matchedTerms}
                          />
                        </span>
                        <span className="search-hit-source">{SOURCE_LABEL[hit.source]}</span>
                      </div>
                      <p className="search-hit-excerpt">
                        <Highlighted text={hit.excerpt} terms={hit.matchedTerms} />
                      </p>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {/* ↑↓ 与 Enter 只在关键词那一组里走：让它跨两组的话 active 就成了两个列表
                合起来的下标，而两组的长度各自异步变化，键盘选中的东西会自己漂。
                语义这一组只接受点击。 */}
            {showSemantic ? (
              <section className="search-group">
                <h2 className="search-group-title">语义相关</h2>
                {semanticHits.length > 0 ? (
                  <ul className="search-results">
                    {semanticHits.map((hit) => (
                      <li
                        key={hit.noteId}
                        className="search-hit"
                        onClick={() => onPick(hit.noteId)}
                      >
                        <div className="search-hit-head">
                          <span className="search-hit-title">{hit.title.trim() || '无标题'}</span>
                          <span className="search-hit-source">语义</span>
                        </div>
                        <p className="search-hit-excerpt">{hit.excerpt}</p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="search-empty">检索中…</div>
                )}
              </section>
            ) : null}
          </div>
        ) : keyword.length > 0 && keyword === settledFor && !error ? (
          <div className="search-empty">没有命中</div>
        ) : null}

        <div className="search-tip">↑↓ 选择 · Enter 打开 · Esc 关闭</div>
      </div>
    </div>
  )
}

export default SearchPanel
