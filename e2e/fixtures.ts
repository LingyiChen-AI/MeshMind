// Playwright 侧的把手：开一个装好假 IPC 的页面，并把浏览器里的间谍暴露成
// 可以 await 的方法。
//
// 所有 `page.evaluate` 都只传可结构化克隆的参数（字符串、数字、数组），
// 不传函数、不捕获闭包——闭包变量到不了浏览器那边。

import { test as base, type Page } from '@playwright/test'

import { installMock } from './mock/install'
import {
  initialState,
  type MockAskEvent,
  type MockInit,
  type MockSearchHit,
  type MockSemanticHit,
  type MockUpdate,
} from './mock/state'

export interface IpcCall {
  cmd: string
  args: Record<string, unknown>
  /// invoke 进来的时刻（页面内的 performance.now()）
  startedAt: number
  /// 结果落地的时刻，还在途中则是 null
  settledAt: number | null
}

/// 有没有两次调用在时间上重叠。`overlaps(await mock.callsTo('update_note'))`
/// 就是「同一条笔记被并发写了」的直接证据——串行化生效时它必须是 false。
export function overlaps(calls: IpcCall[]): boolean {
  const sorted = [...calls].sort((a, b) => a.startedAt - b.startedAt)
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1] as IpcCall
    const current = sorted[i] as IpcCall
    // 上一次还没落地（settledAt 为 null 视作「至今仍在途」）就又发了一次
    if (previous.settledAt === null || previous.settledAt > current.startedAt) return true
  }
  return false
}

interface MockBridge {
  calls(): IpcCall[]
  reset(): void
  failCommand(cmd: string, message: string): void
  clearFailure(cmd: string): void
  setDelay(cmd: string, ms: number): void
  setSearchHits(hits: MockSearchHit[] | null): void
  setSemanticHits(hits: MockSemanticHit[]): void
  emitAsk(event: MockAskEvent, which: number | null): void
  setUpdate(update: MockUpdate | null): void
  notes(): unknown[]
  settings(): Record<string, string>
}

export interface MockHandle {
  /// 迄今为止的全部 invoke，按发生顺序。顺序本身常常就是断言的内容
  /// （比如「退出前必须先落盘再回执」）。
  calls(): Promise<IpcCall[]>
  /// 忘掉迄今为止记下的调用。「从这一刻起一个调用都不该发」这类断言靠它写成
  /// `expect(await mock.calls()).toEqual([])`，比记住基线数字再做减法可靠。
  reset(): Promise<void>
  /// 只看某个命令的调用
  callsTo(cmd: string): Promise<IpcCall[]>
  /// 某个命令最后一次调用的参数，一次都没调过则返回 null
  lastArgs(cmd: string): Promise<Record<string, unknown> | null>
  failCommand(cmd: string, message: string): Promise<void>
  clearFailure(cmd: string): Promise<void>
  setDelay(cmd: string, ms: number): Promise<void>
  /// 写死 search_notes 的返回，用来精确构造 matched_terms / source 的组合
  setSearchHits(hits: MockSearchHit[] | null): Promise<void>
  /// 写死 ai_semantic_search 的返回。AI 没开 / 没配全时假实现照样返回 `[]`，
  /// 摆了数据也不会漏出来——这一点和真实后端一致。
  setSemanticHits(hits: MockSemanticHit[]): Promise<void>
  /// 往一次提问的 channel 上投一个事件。`which` 是 `ai_ask` 的第几次调用
  /// （0 起），省略则投给最后一次。
  ///
  /// 事件会被包成 Channel 要的 `{ index, message }` 信封（index 由假实现自己
  /// 维护）。终止事件之后假实现还会补一个 `{ index, end: true }`，
  /// 和 Rust 侧 Channel 被丢弃时的行为一致——所以同一条 channel 收过
  /// Done / Failed / Cancelled 之后再投就会抛。
  emitAsk(event: MockAskEvent, which?: number): Promise<void>
  /// 让更新源「上新」或者「下架」。页面加载之后才调的话，
  /// 启动那次静默检查已经跑完了，之后查到的只可能来自手动检查。
  setUpdate(update: MockUpdate | null): Promise<void>
  /// 假存储里现在的笔记（snake_case，和后端返回的形状一致）
  notes(): Promise<unknown[]>
  settings(): Promise<Record<string, string>>
}

function handleFor(page: Page): MockHandle {
  const handle: MockHandle = {
    calls: () =>
      page.evaluate(
        () => (window as unknown as { __IPC_MOCK__: MockBridge }).__IPC_MOCK__.calls() as IpcCall[],
      ),

    reset: () =>
      page.evaluate(() =>
        (window as unknown as { __IPC_MOCK__: MockBridge }).__IPC_MOCK__.reset(),
      ),

    async callsTo(cmd) {
      const all = await handle.calls()
      return all.filter((call) => call.cmd === cmd)
    },

    async lastArgs(cmd) {
      const matching = await handle.callsTo(cmd)
      return matching.length === 0 ? null : (matching[matching.length - 1] as IpcCall).args
    },

    failCommand: (cmd, message) =>
      page.evaluate(
        ([c, m]) =>
          (window as unknown as { __IPC_MOCK__: MockBridge }).__IPC_MOCK__.failCommand(
            c as string,
            m as string,
          ),
        [cmd, message],
      ),

    clearFailure: (cmd) =>
      page.evaluate(
        (c) => (window as unknown as { __IPC_MOCK__: MockBridge }).__IPC_MOCK__.clearFailure(c),
        cmd,
      ),

    setDelay: (cmd, ms) =>
      page.evaluate(
        ([c, m]) =>
          (window as unknown as { __IPC_MOCK__: MockBridge }).__IPC_MOCK__.setDelay(
            c as string,
            m as number,
          ),
        [cmd, ms] as [string, number],
      ),

    setSearchHits: (hits) =>
      page.evaluate(
        (h) =>
          (window as unknown as { __IPC_MOCK__: MockBridge }).__IPC_MOCK__.setSearchHits(
            h as MockSearchHit[] | null,
          ),
        hits,
      ),

    setSemanticHits: (hits) =>
      page.evaluate(
        (h) =>
          (window as unknown as { __IPC_MOCK__: MockBridge }).__IPC_MOCK__.setSemanticHits(
            h as MockSemanticHit[],
          ),
        hits,
      ),

    emitAsk: (event, which) =>
      page.evaluate(
        (payload) =>
          (window as unknown as { __IPC_MOCK__: MockBridge }).__IPC_MOCK__.emitAsk(
            payload.event as MockAskEvent,
            payload.which,
          ),
        { event, which: which ?? null } as { event: MockAskEvent; which: number | null },
      ),

    setUpdate: (update) =>
      page.evaluate(
        (u) =>
          (window as unknown as { __IPC_MOCK__: MockBridge }).__IPC_MOCK__.setUpdate(
            u as MockUpdate | null,
          ),
        update,
      ),

    notes: () =>
      page.evaluate(() => (window as unknown as { __IPC_MOCK__: MockBridge }).__IPC_MOCK__.notes()),

    settings: () =>
      page.evaluate(() =>
        (window as unknown as { __IPC_MOCK__: MockBridge }).__IPC_MOCK__.settings(),
      ),
  }
  return handle
}

/// 打开一个装好假 IPC 的页面。`windowLabel` 决定 main.tsx 渲染主窗口还是快捕窗口。
export async function openApp(page: Page, overrides: Partial<MockInit> = {}): Promise<MockHandle> {
  await page.addInitScript(installMock, initialState(overrides))
  await page.goto('/')
  // 等 React 挂完再交回去：否则第一条断言可能撞在空的 #root 上。
  await page.waitForSelector('.app, .capture')
  return handleFor(page)
}

/// 把光标放进编辑器正文并追加文字。
///
/// 点 `.editor p` 而不是整个 contenteditable：正文里有图片这类 atom 节点时，
/// 点在编辑区中央有可能选中那个节点，接着一打字就把图片替换掉了——
/// 而「正文里的附件有没有被一起存回去」正是这一组测试要守的东西。
export async function typeInEditor(page: Page, text: string, paragraph = 0) {
  await page.locator('.editor p').nth(paragraph).click()
  await page.keyboard.press('End')
  await page.keyboard.type(text)
}

/// 手动往事件通道上打一个事件，冒充外壳（托盘点「退出」时 emit 的
/// `app-quit-requested` 就是这么来的）。
///
/// BroadcastChannel 不给发送者自己回声，但同一个 page 里的**另一个** channel
/// 对象照样收得到——mock 内部持有的正是另一个对象，所以这个函数对本窗口
/// 和别的窗口一样有效。
export async function emitFromShell(page: Page, event: string, payload: unknown = null) {
  await page.evaluate(
    ([name, data]) => {
      new BroadcastChannel('meshmind-e2e-events').postMessage({ event: name, payload: data })
    },
    [event, payload] as [string, unknown],
  )
}

export const test = base
export { expect } from '@playwright/test'
