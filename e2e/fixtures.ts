// Playwright 侧的把手：开一个装好假 IPC 的页面，并把浏览器里的间谍暴露成
// 可以 await 的方法。
//
// 所有 `page.evaluate` 都只传可结构化克隆的参数（字符串、数字、数组），
// 不传函数、不捕获闭包——闭包变量到不了浏览器那边。

import { test as base, type Page } from '@playwright/test'

import { installMock } from './mock/install'
import { initialState, type MockInit, type MockSearchHit } from './mock/state'

export interface IpcCall {
  cmd: string
  args: Record<string, unknown>
}

interface MockBridge {
  calls(): IpcCall[]
  reset(): void
  failCommand(cmd: string, message: string): void
  clearFailure(cmd: string): void
  setDelay(cmd: string, ms: number): void
  setSearchHits(hits: MockSearchHit[] | null): void
  notes(): unknown[]
  settings(): Record<string, string>
}

export interface MockHandle {
  /// 迄今为止的全部 invoke，按发生顺序。顺序本身常常就是断言的内容
  /// （比如「退出前必须先落盘再回执」）。
  calls(): Promise<IpcCall[]>
  /// 只看某个命令的调用
  callsTo(cmd: string): Promise<IpcCall[]>
  /// 某个命令最后一次调用的参数，一次都没调过则返回 null
  lastArgs(cmd: string): Promise<Record<string, unknown> | null>
  failCommand(cmd: string, message: string): Promise<void>
  clearFailure(cmd: string): Promise<void>
  setDelay(cmd: string, ms: number): Promise<void>
  /// 写死 search_notes 的返回，用来精确构造 matched_terms / source 的组合
  setSearchHits(hits: MockSearchHit[] | null): Promise<void>
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
