// 分页状态的推进逻辑。刻意做成纯函数放在这里，而不是散在 App 的 setState 回调里：
// 「下一页从哪个 offset 取」「还有没有更多」「刷新时该重拉多少条」这几件事各自只有
// 一行代码，但错一个符号的表现是「翻页跳过一批笔记」或「滚到底无限发请求」，
// 而组件层现在还没有测试基建（environment 是 node，没有 jsdom）。
//
// 三条约定：
// 1. `hasMore` 由「后端返回的条数是否填满了 limit」推出。这会在总数正好是 limit 的
//    整数倍时多留一次「加载更多」，点下去拿到空数组、终止态落地。宁可多一次空请求，
//    也不要漏掉最后一页——后者是数据看不见，前者只是一次多余的往返。
// 2. 去重按 id。两次分页请求之间笔记可能被改（列表按 updated_at 倒序，被编辑的笔记
//    会跳到最前），于是同一条既出现在已加载的部分、又出现在新一页里。不去重就会
//    渲染出重复的 key。
// 3. 状态是不可变的：每个函数都返回新对象，调用方直接 setState。

/** 一次分页请求的条数。比 ipc 默认的 100 小，首屏更快，且「加载更多」有存在感。 */
export const PAGE_SIZE = 50

export interface Paged<T> {
  items: T[]
  /** 后端还有没有下一页。false 是终止态，调用方不该再发请求。 */
  hasMore: boolean
}

interface HasId {
  id: number
}

export function emptyPage<T>(): Paged<T> {
  return { items: [], hasMore: false }
}

/** 下一页的 offset：已加载多少条就从多少条之后接着取。 */
export function nextOffset<T>(page: Paged<T>): number {
  return page.items.length
}

/**
 * 首屏 / 重新筛选：用一批结果整体替换。
 * `limit` 是发请求时用的那个值，用来判断有没有下一页。
 */
export function replacePage<T>(batch: T[], limit: number): Paged<T> {
  return { items: batch, hasMore: batch.length >= limit && limit > 0 }
}

/** 「加载更多」：把新一页接到尾巴上，丢掉已经在列表里的 id。 */
export function appendPage<T extends HasId>(page: Paged<T>, batch: T[], limit: number): Paged<T> {
  const seen = new Set(page.items.map((item) => item.id))
  const fresh = batch.filter((item) => !seen.has(item.id))
  return {
    items: fresh.length === 0 ? page.items : [...page.items, ...fresh],
    // 注意用 batch.length 而不是 fresh.length：后端确实给满了一页，
    // 只是其中有几条我们已经有了，不代表到底了。
    hasMore: batch.length >= limit && limit > 0,
  }
}

/**
 * 刷新已加载的全部分页时该用多大的 limit：把已加载条数向上取整到整页，至少一页。
 * 这样「重拉一次」只发一个请求，而不是把 N 页各拉一遍。
 */
export function refreshLimit(loadedCount: number, pageSize: number = PAGE_SIZE): number {
  if (pageSize <= 0) return 0
  if (loadedCount <= pageSize) return pageSize
  return Math.ceil(loadedCount / pageSize) * pageSize
}

/**
 * 只重拉第一页，然后并回已加载的列表。用在「自动保存成功后刷新列表」这条高频路径上：
 * 保存只会让被编辑的那条笔记跳到最前（列表按 updated_at 倒序），后面的相对顺序不变，
 * 所以拉一页就够了，不必为每次保存重拉用户已经滚出来的几百条。
 *
 * 合并规则：新的第一页整体在前；老列表里凡是出现在新第一页中的都删掉（它挪走了或者
 * 位置没变），剩下的按原顺序接在后面——被挤出第一页的那条正好落回它该在的位置。
 *
 * 特例：新第一页没装满，说明库里的总数还不到一页，老列表的尾巴必然是脏数据，直接丢。
 */
export function mergeHead<T extends HasId>(
  page: Paged<T>,
  head: T[],
  pageSize: number = PAGE_SIZE,
): Paged<T> {
  if (head.length < pageSize) return { items: head, hasMore: false }
  const headIds = new Set(head.map((item) => item.id))
  const tail = page.items.filter((item) => !headIds.has(item.id))
  return { items: [...head, ...tail], hasMore: page.hasMore }
}

/** 从列表里就地摘掉一条（删除、恢复之后用），不动 hasMore。 */
export function removeItem<T extends HasId>(page: Paged<T>, id: number): Paged<T> {
  const items = page.items.filter((item) => item.id !== id)
  return items.length === page.items.length ? page : { items, hasMore: page.hasMore }
}

/**
 * 列表该渲染成什么。抽出来是因为「首屏加载中」和「真的一条都没有」必须分开：
 * 混在一起会在每次筛选切换时闪一下「还没有笔记」的空态。
 */
export type ListPhase = 'loading' | 'empty' | 'list'

export function listPhase(loading: boolean, count: number): ListPhase {
  if (count > 0) return 'list'
  return loading ? 'loading' : 'empty'
}
