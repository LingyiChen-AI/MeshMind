// 主窗口：左侧笔记流 + 右侧编辑器，⌘/Ctrl+K 唤起搜索。
//
// 状态归属：笔记列表（分页）、标签、当前笔记正文、遮罩层都在这里；
// NoteList / TagFilter 是纯展示组件。主列表相关的 IPC 都在这一层收口并 catch，
// 失败统一落到底部错误栏——ipc 层 reject 的是字符串，String(e) 就是可读的中文消息。
// SearchPanel / TrashPanel / SettingsPanel 自带独立的数据流，
// 在自己内部发 IPC、自己显示错误，只在数据真的变了之后回调这里刷新。
//
// 三个面板都是全屏遮罩，用一个 `overlay` 状态互斥（lib/overlay.ts），不是三个 boolean。
//
// 退出：托盘「退出」不会直接杀进程，外壳先 emit('app-quit-requested') 等这里落盘。
// 主窗口是唯一负责回 confirm_quit 的窗口——见下面那个 effect 的注释。
//
// 列表分页的两种刷新语义，改之前先读明白（reloadList / refreshAfterSave 各自的注释）：
// 「集合变了」重拉已加载的全部页，「保存完了」只重拉第一页再并回来。
// 任何一次刷新都不许把用户退回第一页。
//
// 自动保存的关键约束：
// 1. 待保存的目标（笔记 id + 正文）存在 ref 里而不是闭包里，且在「切换笔记 / 新建 /
//    删除」之前先 flush。否则 800ms 防抖窗口内切走笔记，定时器落地时会把新笔记的
//    正文写进旧笔记的 id。
// 2. 保存失败时那份内容必须**放回** pendingRef 并重新武装定时器。丢掉它等于：
//    用户看到红条 → 点开另一条笔记 → openNote 里的 flushSave 成了空操作 →
//    加载新正文覆盖编辑器 → 刚才那次编辑再也没有任何持有者，连卸载兜底都救不回来。

import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useCallback, useEffect, useRef, useState } from 'react'

import { NoteList } from './components/NoteList'
import { SearchPanel } from './components/SearchPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { TagFilter } from './components/TagFilter'
import { TrashPanel } from './components/TrashPanel'
import { UpdateBanner, useUpdater } from './components/UpdateNotice'
import { Editor, EMPTY_DOC } from './editor/Editor'
import { collectAttachmentIds } from './lib/doc'
import { ipc, type NoteSummary, type TagCount } from './lib/ipc'
import { type ActiveOverlay, closeOverlay, toggleOverlay } from './lib/overlay'
import {
  appendPage,
  emptyPage,
  mergeHead,
  nextOffset,
  PAGE_SIZE,
  refreshLimit,
  replacePage,
  type Paged,
} from './lib/pagination'
import { keys } from './lib/platform'
import { resolveActiveTag, sortTags } from './lib/tags'

const AUTOSAVE_MS = 800

// 退出前等在途保存结束的上限。
//
// 为什么要等：在途的那次存的是**旧内容**，pendingRef 里才是最新的。两者并发写同一条
// 笔记时落地顺序不可控，旧的可能盖掉新的。等它结束再写就没有这个问题。
// 为什么有上限：外壳 2 秒后强杀，等太久等于把落盘的时间全花在等待上。
// 等超时了仍然照写——并发写是「可能丢」，不写是「一定丢」。
const QUIT_INFLIGHT_WAIT_MS = 600
const QUIT_POLL_MS = 25

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
  const [page, setPageState] = useState<Paged<NoteSummary>>(emptyPage<NoteSummary>())
  const [listLoading, setListLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [tags, setTags] = useState<TagCount[]>([])
  const [currentId, setCurrentId] = useState<number | null>(null)
  const [body, setBody] = useState<string>(EMPTY_DOC)
  const [status, setStatus] = useState<SaveStatus>('idle')
  // 三个全屏遮罩（搜索 / 回收站 / 设置）共用这一个状态——理由见 lib/overlay.ts。
  const [overlay, setOverlay] = useState<ActiveOverlay>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
  const [rebuilding, setRebuilding] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  // 分页状态同时存进 ref：刷新和「加载更多」都在 await 之后才用到它，
  // 那时闭包里的 page 已经可能是上一轮的了。setPage 是唯一的写入口，两者不会分家。
  const pageRef = useRef(page)
  const setPage = useCallback((next: Paged<NoteSummary>) => {
    pageRef.current = next
    setPageState(next)
  }, [])
  // 「加载更多」的并发闸：按钮 disabled 挡得住鼠标，挡不住 await 期间被重复触发。
  const loadingMoreRef = useRef(false)

  const timerRef = useRef<number | null>(null)
  const pendingRef = useRef<{ id: number; bodyJson: string } | null>(null)
  // 在途保存的笔记 id（null = 空闲）。同一时刻只允许一次 update_note 在途：
  // 并发写同一条笔记时落地顺序不可控，后发的旧内容可能覆盖先发的新内容。
  const inFlightIdRef = useRef<number | null>(null)
  const retriesRef = useRef(0)
  // 已删除的笔记 id：保存失败后不该把它们的内容再放回 pending 重试。
  const abandonedRef = useRef<Set<number>>(new Set())

  // 更新检查。启动时静默查一次：查到新版才出横幅，没有新版或查询失败一个字都不显示
  // （理由见 lib/updater.ts）。手动检查的入口在设置面板里，那边是另一份状态。
  const updater = useUpdater()
  const checkUpdate = updater.check
  useEffect(() => {
    void checkUpdate('startup')
  }, [checkUpdate])

  // 选中的标签可能因为笔记被删、被改而在库里彻底消失，这时按「全部」处理。
  const activeTag = resolveActiveTag(selectedTag, tags)

  /** 取一页笔记：没选标签走 list_notes，选了走 list_notes_by_tag（筛选在后端做）。 */
  const listPage = useCallback(
    (limit: number, offset: number): Promise<NoteSummary[]> =>
      activeTag === null
        ? ipc.listNotes(limit, offset)
        : ipc.listNotesByTag(activeTag, limit, offset),
    [activeTag],
  )

  // 写列表之前的守卫：await 期间用户可能已经切了标签，这时旧请求的结果必须丢掉，
  // 否则「全部」的一页会盖在刚选中的标签结果上，而 chip 还亮着那个标签。
  const activeTagRef = useRef(activeTag)
  activeTagRef.current = activeTag
  const stillCurrent = useCallback((tag: string | null) => activeTagRef.current === tag, [])

  /**
   * refresh 的语义：**重拉用户已经加载出来的全部页**，而不是退回第一页。
   * 退回第一页意味着用户翻了十页、删掉一条笔记之后又得从头翻——滚了半天白滚。
   * 靠 refreshLimit 把「已加载 N 条」换成一次 limit=N 的请求，仍然只发一个 IPC。
   * 用在删除 / 新建 / 回收站操作 / 快捕窗口存了新笔记这些**集合真的变了**的场合。
   */
  const reloadList = useCallback(async () => {
    const tag = activeTag
    const limit = refreshLimit(pageRef.current.items.length)
    try {
      const batch = await listPage(limit, 0)
      if (stillCurrent(tag)) setPage(replacePage(batch, limit))
    } catch (err) {
      setError(String(err))
    }
  }, [activeTag, listPage, setPage, stillCurrent])

  /**
   * 自动保存成功后的刷新：只重拉第一页再并回来。
   * 保存是高频路径（每 800ms 防抖一次），而它对列表的影响是确定的——列表按
   * updated_at 倒序，被编辑的那条跳到最前，别的相对顺序不变，拉一页就够。
   * 按标签筛选时例外：改标签会让笔记直接进出这个集合，位置推不出来，老实重拉全部页。
   */
  const refreshAfterSave = useCallback(async () => {
    if (activeTag !== null) {
      await reloadList()
      return
    }
    const tag = activeTag
    try {
      const head = await listPage(PAGE_SIZE, 0)
      if (stillCurrent(tag)) setPage(mergeHead(pageRef.current, head, PAGE_SIZE))
    } catch (err) {
      setError(String(err))
    }
  }, [activeTag, listPage, reloadList, setPage, stillCurrent])

  /** 全库标签。笔记增删改都可能让标签新增或归零消失，所以每次变更后都要重拉。 */
  const refreshTags = useCallback(async () => {
    try {
      setTags(sortTags(await ipc.listAllTags()))
    } catch (err) {
      setError(String(err))
    }
  }, [])

  /** 笔记集合变了：列表和标签一起刷新。两个请求互不依赖，并发发出去。 */
  const refresh = useCallback(async () => {
    await Promise.all([reloadList(), refreshTags()])
  }, [reloadList, refreshTags])

  const loadMore = useCallback(async () => {
    const current = pageRef.current
    // hasMore 是终止态：到底之后不再发请求。loadingMoreRef 挡住 await 期间的重复触发。
    if (!current.hasMore || loadingMoreRef.current) return
    const tag = activeTag
    loadingMoreRef.current = true
    setLoadingMore(true)
    try {
      const batch = await listPage(PAGE_SIZE, nextOffset(current))
      if (stillCurrent(tag)) setPage(appendPage(pageRef.current, batch, PAGE_SIZE))
    } catch (err) {
      setError(String(err))
    } finally {
      loadingMoreRef.current = false
      setLoadingMore(false)
    }
  }, [activeTag, listPage, setPage, stillCurrent])

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
      // 标题、摘要、标签都由后端从正文推导，存完必须重新拉才能看到变化。
      // 这里刻意不走 reloadList：见 refreshAfterSave 的注释。
      await Promise.all([refreshAfterSave(), refreshTags()])
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
  }, [cancelTimer, refreshAfterSave, refreshTags, schedule, settleStatus])

  flushRef.current = flushSave

  /**
   * 退出前的最后一次落盘。**不是** flushSave，两者的取舍完全不同：
   *
   * - 不重试。flushSave 失败会按 1.5s/3s/6s/12s 退避重排，而外壳只给 2 秒，
   *   第一次退避就已经超时了——等于用一次必然被强杀的等待换一次可能成功的重试。
   *   宁可丢这一次编辑，也不能让「退出」这个动作变成 2 秒的卡顿。
   * - 不管在途的串行化闸门。flushSave 见到在途保存会直接返回、把 pending 留给下一轮，
   *   但退出场景没有下一轮了：留下就是丢。所以这里先等在途结束（有上限），再写。
   * - 失败只记一笔日志、顺带把错误摆到界面上（万一退出被兜底延后，用户还能看见）。
   */
  const flushBeforeQuit = useCallback(async () => {
    cancelTimer()

    const deadline = Date.now() + QUIT_INFLIGHT_WAIT_MS
    while (inFlightIdRef.current !== null && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, QUIT_POLL_MS))
    }

    const job = pendingRef.current
    pendingRef.current = null
    if (!job) return

    try {
      await ipc.updateNote(job.id, job.bodyJson, collectAttachmentIds(job.bodyJson))
      // 刻意不刷新列表和标签：应用马上就没了，那两个请求只会跟落盘抢那 2 秒。
      settleStatus()
    } catch (err) {
      console.error('[app] 退出前保存失败', err)
      setError(String(err))
    }
  }, [cancelTimer, settleStatus])

  // 首屏 / 切换标签筛选：回到第一页重新开始分页。
  // listPage 的身份只随 activeTag 变，所以这个 effect 不会因为别的 state 抖动而重跑。
  // alive 标志处理「连点两个标签」的竞态：慢的旧请求回来时不许写进 state。
  useEffect(() => {
    let alive = true
    setListLoading(true)
    listPage(PAGE_SIZE, 0).then(
      (batch) => {
        if (!alive) return
        setPage(replacePage(batch, PAGE_SIZE))
        setListLoading(false)
      },
      (err: unknown) => {
        if (!alive) return
        setError(String(err))
        setListLoading(false)
      },
    )
    return () => {
      alive = false
    }
  }, [listPage, setPage])

  // 首屏拉标签（之后由各处变更触发刷新）
  useEffect(() => {
    void refreshTags()
  }, [refreshTags])

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

  // 托盘「退出」→ 外壳 emit('app-quit-requested') → 这里落盘 → 回 confirm_quit → 退出。
  // 没有这一段的话，800ms 防抖窗口里的最后一次编辑会被静默丢掉。
  //
  // confirm_quit 放在 finally 里，落盘成功失败都要调：不调也退得掉（外壳 2 秒兜底），
  // 但那 2 秒里用户对着一个点了没反应的菜单项，只会以为应用卡死了。
  // 连点两次「退出」不必在这里去重——外壳侧用原子量挡住了，事件只会来一次。
  useEffect(() => {
    let cancelled = false
    let unlisten: UnlistenFn | null = null

    listen('app-quit-requested', () => {
      void (async () => {
        try {
          await flushBeforeQuit()
        } finally {
          // confirmQuit 自己也可能 reject（外壳没起来之类）。这里不能让它变成
          // 未处理的 rejection——虽然进程马上就要没了，但真出问题时日志是唯一线索。
          await ipc.confirmQuit().catch((err: unknown) => {
            console.error('[app] confirm_quit 失败，等外壳的 2 秒兜底', err)
          })
        }
      })()
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
  }, [flushBeforeQuit])

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

  // ⌘/Ctrl+K 开关搜索面板。Esc 由各面板自己处理。
  // toggleOverlay 天然保证「同时只有一层」：开着回收站时按 ⌘K 直接换成搜索。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOverlay((prev) => toggleOverlay(prev, 'search'))
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
      setOverlay((prev) => closeOverlay(prev, 'search'))
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

  /** 回收站里恢复 / 彻底删除之后：主列表和标签都可能变。 */
  const handleTrashChanged = useCallback(() => {
    void refresh()
  }, [refresh])

  const handleRestored = useCallback((note: NoteSummary) => {
    setNotice(`已恢复《${note.title.trim() || '无标题'}》`)
  }, [])

  return (
    <div className="app">
      {/* 绝大多数启动里这里什么都不渲染——没有新版、或者根本没查通，都归 idle。 */}
      <UpdateBanner updater={updater} />

      <aside className="sidebar">
        <div className="sidebar-actions">
          <button type="button" className="primary" onClick={() => void createNote()}>
            新建
          </button>
          <button type="button" onClick={() => setOverlay('search')}>
            搜索 {keys.search}
          </button>
        </div>
        <TagFilter tags={tags} selected={activeTag} onSelect={setSelectedTag} />
        <div className="sidebar-list">
          <NoteList
            page={page}
            selectedId={currentId}
            loading={listLoading}
            loadingMore={loadingMore}
            onSelect={(id) => void openNote(id)}
            onDelete={(id) => void deleteNote(id)}
            onLoadMore={() => void loadMore()}
            emptyHint={
              activeTag === null ? undefined : (
                <>
                  <p>「{activeTag}」下还没有笔记</p>
                  <p className="hint">点「全部」回到完整列表。</p>
                </>
              )
            }
          />
        </div>
        <div className="sidebar-footer">
          <button
            type="button"
            className="subtle"
            title="被删除的笔记会先落在回收站，可以恢复"
            onClick={() => setOverlay('trash')}
          >
            回收站
          </button>
          <button
            type="button"
            className="subtle"
            title="快捕热键、Dock 图标与开机自启"
            onClick={() => setOverlay('settings')}
          >
            设置
          </button>
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

      {/* 三层遮罩由 overlay 一个状态决定，天然互斥；各面板的 onClose 只关掉自己那层
          （closeOverlay），因为它可能是异步回调，那时前台可能已经换层了。 */}
      {overlay === 'search' ? (
        <SearchPanel
          onClose={() => setOverlay((prev) => closeOverlay(prev, 'search'))}
          onPick={handlePick}
        />
      ) : null}

      {overlay === 'trash' ? (
        <TrashPanel
          onClose={() => setOverlay((prev) => closeOverlay(prev, 'trash'))}
          onChanged={handleTrashChanged}
          onRestored={handleRestored}
        />
      ) : null}

      {overlay === 'settings' ? (
        <SettingsPanel onClose={() => setOverlay((prev) => closeOverlay(prev, 'settings'))} />
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
