# 计划 B：Playwright + mock IPC 测试栈

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**前置：** 计划 A 完成，CI 双平台绿。

**Goal:** 搭一套 Playwright 交互测试栈，用可控的假 IPC 顶掉 Tauri 内部接口，覆盖手工几乎无法复现的关键场景，并让测试同时断言「页面变成什么样」与「向后端发了什么调用」。

**Architecture:** Playwright 驱动 Chromium 访问 vite dev server。`page.addInitScript` 在应用加载前把 `window.__TAURI_INTERNALS__` 换成内存假实现。假实现同时是间谍：记录每次 `invoke` 的命令与参数，供测试断言调用形状。跨窗口事件用 `BroadcastChannel` 在两个 page 之间传递。

**Tech Stack:** @playwright/test / Chromium / vite dev server（端口 1420）

---

## 为什么 mock 必须兼做间谍

本项目已确证的三个真实缺陷全是**调用形状**的缺陷，不是渲染缺陷：

- 自动保存漏传 `attachmentIds` → 附件被解绑 → GC 删掉图片文件
- `matched_terms` 混入标点 → 前端把全文每个逗号刷成高亮
- 托盘退出未落盘 → 最后 800ms 编辑静默丢失

断言页面长什么样，这三个一个都抓不住；断言 invoke 参数，三个全能抓住。所以每个测试都要问自己：**它发出去的那串调用对不对？**

## 保真度纪律

假实现与真实 Rust 行为漂移，会让测试全绿而应用是坏的——比没有测试更糟。三条纪律：

1. **字段名照抄 Rust 的序列化形态**：结构体字段返回 **snake_case**（`body_json`、`note_id`、`matched_terms`），由前端的 `toCamel` 转换。返回 camelCase 会让 `toCamel` 的 bug 永远测不出来。
2. **两个例外照抄真实情况**：`read_attachment` 返回 `ArrayBuffer`（不是数组），`get_settings` 的键是设置项名（`macos.hide_dock_icon`，含点号，不该被 camel 化）。这两个命令在真实代码里就是绕开 `toCamel` 的。
3. **错误 reject 的是裸字符串**，不是 Error 对象——真实 `CommandError` 就是这样序列化的。

---

### Task 1: 安装 Playwright 与基础配置

**Files:**
- Modify: `package.json`
- Create: `playwright.config.ts`
- Modify: `.gitignore`

- [ ] **Step 1: 安装**

```bash
cd /Users/chenhao/codes/myself/MeshMind
pnpm add -D @playwright/test
pnpm exec playwright install chromium
```

只装 chromium。Tauri 在 macOS 用 WKWebView、Windows 用 WebView2，两者都不是 Chromium 但都是现代引擎；再装 firefox/webkit 只会拖慢 CI 而不增加对真实运行环境的覆盖。

- [ ] **Step 2: 写配置**

`playwright.config.ts`：

```ts
import { defineConfig } from '@playwright/test'

// 只跑 chromium：真实运行环境是 WKWebView / WebView2，
// 多装两个引擎并不会更接近真实，只会让 CI 更慢。
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:1420',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:1420',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
```

- [ ] **Step 3: 加脚本与忽略规则**

`package.json` 的 scripts 追加：

```json
"e2e": "playwright test",
"e2e:ui": "playwright test --ui"
```

`.gitignore` 追加：

```
test-results/
playwright-report/
.playwright/
```

- [ ] **Step 4: 确认能启动**

```bash
pnpm exec playwright test --list
```

Expected: 输出「Total: 0 tests」之类（还没有测试文件），不报配置错误。

- [ ] **Step 5: 提交**

```bash
git add package.json pnpm-lock.yaml playwright.config.ts .gitignore
git commit -m "test: 引入 Playwright 与基础配置"
```

---

### Task 2: 假 IPC 注入层

这是整个计划的核心。

**Files:**
- Create: `e2e/mock/state.ts`
- Create: `e2e/mock/install.ts`

- [ ] **Step 1: 定义假存储的初始状态**

`e2e/mock/state.ts`：

```ts
/// 注入到浏览器上下文的初始状态。必须是可结构化克隆的纯数据——
/// Playwright 的 addInitScript 只传一个序列化后的参数，闭包变量不会跟过去。
export interface MockNote {
  id: number
  uuid: string
  title: string
  body_json: string
  body_text: string
  created_at: number
  updated_at: number
  deleted_at: number | null
  tags: string[]
  attachment_ids: number[]
}

export interface MockInit {
  /// 当前窗口 label，决定 main.tsx 渲染主窗口还是快捕窗口
  windowLabel: 'main' | 'capture'
  notes: MockNote[]
  settings: Record<string, string>
  /// 命令名 → 错误消息。设了的命令每次调用都失败。
  failCommands: Record<string, string>
  /// 命令名 → 额外延迟毫秒，用来构造「保存很慢」这类竞态
  delays: Record<string, number>
}

export function initialState(overrides: Partial<MockInit> = {}): MockInit {
  return {
    windowLabel: 'main',
    notes: [],
    settings: {},
    failCommands: {},
    delays: {},
    ...overrides,
  }
}

export function note(id: number, text: string, patch: Partial<MockNote> = {}): MockNote {
  const body_json = JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  })
  return {
    id,
    uuid: `uuid-${id}`,
    title: text,
    body_json,
    body_text: text,
    created_at: 1_000 + id,
    updated_at: 1_000 + id,
    deleted_at: null,
    tags: [],
    attachment_ids: [],
    ...patch,
  }
}
```

- [ ] **Step 2: 写注入函数**

`e2e/mock/install.ts`。注意这个函数会被序列化后在浏览器里执行，**不能引用任何外部变量**，只能用它自己的参数。

```ts
import type { MockInit } from './state'

/// 在应用加载前顶替 window.__TAURI_INTERNALS__。
///
/// 返回的结构体字段一律 snake_case——真实 Rust 侧就是这么序列化的，
/// 前端的 toCamel 负责转换。这里若图省事返回 camelCase，
/// toCamel 自身的 bug 就永远测不出来。
export function installMock(init: MockInit): void {
  interface Call {
    cmd: string
    args: Record<string, unknown>
  }

  const state = {
    notes: init.notes.map((n) => ({ ...n })),
    settings: { ...init.settings },
    nextId: init.notes.reduce((max, n) => Math.max(max, n.id), 0) + 1,
    calls: [] as Call[],
    failCommands: { ...init.failCommands },
    delays: { ...init.delays },
    listeners: new Map<number, string>(),
  }

  // 跨 page 的事件通道。两个窗口是两个独立的 page，
  // 内存不共享，靠同源的 BroadcastChannel 传递事件。
  const channel = new BroadcastChannel('meshmind-e2e-events')

  const w = window as unknown as Record<string, unknown>

  w.__IPC_MOCK__ = {
    calls: () => state.calls.map((c) => ({ ...c })),
    reset: () => {
      state.calls.length = 0
    },
    failCommand: (cmd: string, message: string) => {
      state.failCommands[cmd] = message
    },
    clearFailure: (cmd: string) => {
      delete state.failCommands[cmd]
    },
    setDelay: (cmd: string, ms: number) => {
      state.delays[cmd] = ms
    },
    notes: () => state.notes.map((n) => ({ ...n })),
    settings: () => ({ ...state.settings }),
  }

  function summary(n: (typeof state.notes)[number]) {
    const lines = n.body_text.split('\n').filter((l) => l.trim() !== '')
    return {
      id: n.id,
      uuid: n.uuid,
      title: n.title,
      excerpt: lines.slice(1).join(' ').slice(0, 200),
      updated_at: n.updated_at,
      tags: n.tags,
    }
  }

  function plainText(bodyJson: string): string {
    const doc = JSON.parse(bodyJson) as { content?: unknown[] }
    const out: string[] = []
    const walk = (node: Record<string, unknown>) => {
      if (typeof node.text === 'string') out.push(node.text)
      const kids = node.content
      if (Array.isArray(kids)) kids.forEach((k) => walk(k as Record<string, unknown>))
      if (typeof node.type === 'string' && node.type === 'paragraph') out.push('\n')
    }
    walk(doc as Record<string, unknown>)
    return out
      .join('')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '')
      .join('\n')
  }

  function parseTags(text: string): string[] {
    const found = text.match(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu) ?? []
    return [...new Set(found.map((m) => m.trim().slice(1).toLowerCase()))]
  }

  function handle(cmd: string, args: Record<string, unknown>): unknown {
    switch (cmd) {
      case 'list_notes':
        return state.notes
          .filter((n) => n.deleted_at === null)
          .sort((a, b) => b.updated_at - a.updated_at || b.id - a.id)
          .slice(Number(args.offset ?? 0), Number(args.offset ?? 0) + Number(args.limit ?? 100))
          .map(summary)

      case 'list_deleted_notes':
        return state.notes.filter((n) => n.deleted_at !== null).map(summary)

      case 'list_notes_by_tag':
        return state.notes
          .filter((n) => n.deleted_at === null && n.tags.includes(String(args.tag)))
          .sort((a, b) => b.updated_at - a.updated_at || b.id - a.id)
          .slice(Number(args.offset ?? 0), Number(args.offset ?? 0) + Number(args.limit ?? 100))
          .map(summary)

      case 'list_all_tags': {
        const counts = new Map<string, number>()
        state.notes
          .filter((n) => n.deleted_at === null)
          .forEach((n) => n.tags.forEach((t) => counts.set(t, (counts.get(t) ?? 0) + 1)))
        return [...counts.entries()]
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      }

      case 'get_note': {
        const found = state.notes.find((n) => n.id === Number(args.id) && n.deleted_at === null)
        if (!found) throw `笔记不存在: ${args.id}`
        return found
      }

      case 'create_note': {
        const body_json = String(args.bodyJson)
        const body_text = plainText(body_json)
        const created = {
          id: state.nextId++,
          uuid: `uuid-${state.nextId}`,
          title: body_text.split('\n')[0] ?? '',
          body_json,
          body_text,
          created_at: 9_000,
          updated_at: 9_000,
          deleted_at: null,
          tags: parseTags(body_text),
          attachment_ids: (args.attachmentIds as number[]) ?? [],
        }
        state.notes.push(created)
        return created
      }

      case 'update_note': {
        const target = state.notes.find((n) => n.id === Number(args.id))
        if (!target) throw `笔记不存在: ${args.id}`
        target.body_json = String(args.bodyJson)
        target.body_text = plainText(target.body_json)
        target.title = target.body_text.split('\n')[0] ?? ''
        target.tags = parseTags(target.body_text)
        target.attachment_ids = (args.attachmentIds as number[]) ?? []
        target.updated_at += 1
        return target
      }

      case 'delete_note': {
        const target = state.notes.find((n) => n.id === Number(args.id))
        if (!target) throw `笔记不存在: ${args.id}`
        target.deleted_at = 9_999
        return null
      }

      case 'restore_note': {
        const target = state.notes.find((n) => n.id === Number(args.id))
        if (!target) throw `笔记不存在: ${args.id}`
        target.deleted_at = null
        return null
      }

      case 'purge_note': {
        const idx = state.notes.findIndex((n) => n.id === Number(args.id))
        if (idx < 0) throw `笔记不存在: ${args.id}`
        state.notes.splice(idx, 1)
        return null
      }

      case 'purge_all_deleted': {
        const before = state.notes.length
        state.notes = state.notes.filter((n) => n.deleted_at === null)
        return before - state.notes.length
      }

      case 'search_notes': {
        const q = String(args.query).trim()
        if (q === '') return []
        const ascii = /^[\x20-\x7e]+$/.test(q)
        return state.notes
          .filter((n) => n.deleted_at === null && n.body_text.includes(q))
          .map((n) => ({
            note_id: n.id,
            uuid: n.uuid,
            title: n.title,
            excerpt: summary(n).excerpt,
            // 拼音命中给不出可定位的片段，真实实现返回空数组
            matched_terms: ascii ? [] : [q],
            source: ascii ? 'PinyinFull' : 'Literal',
          }))
      }

      case 'rebuild_index':
        return state.notes.filter((n) => n.deleted_at === null).length

      case 'store_attachment':
        return { id: 42, sha256: 'a'.repeat(64), ext: String(args.ext), byte_size: 3, width: 1, height: 1 }

      case 'read_attachment':
        // 真实实现走 raw 通道返回 ArrayBuffer，不是数组
        return new Uint8Array([137, 80, 78, 71]).buffer

      case 'collect_garbage':
        return 0

      case 'get_settings':
        // 键是设置项名（含点号），真实前端刻意绕开 toCamel
        return { ...state.settings }

      case 'set_setting':
        state.settings[String(args.key)] = String(args.value)
        return null

      case 'set_capture_hotkey':
        state.settings['hotkey.capture'] = String(args.accelerator)
        return null

      case 'set_hide_dock_icon':
        state.settings['macos.hide_dock_icon'] = String(args.hide)
        return null

      case 'set_autostart':
        state.settings['startup.autostart'] = String(args.enabled)
        return null

      case 'hide_capture_window':
      case 'confirm_quit':
        return null

      case 'plugin:event|listen': {
        const id = Number(args.handler)
        state.listeners.set(id, String(args.event))
        return id
      }

      case 'plugin:event|unlisten':
        state.listeners.delete(Number(args.eventId))
        return null

      case 'plugin:event|emit':
        channel.postMessage({ event: String(args.event), payload: args.payload ?? null })
        return null

      default:
        throw `mock 未实现的命令: ${cmd}`
    }
  }

  channel.onmessage = (message: MessageEvent) => {
    const { event, payload } = message.data as { event: string; payload: unknown }
    state.listeners.forEach((name, id) => {
      if (name !== event) return
      const callback = (window as unknown as Record<string, unknown>)[`_${id}`]
      if (typeof callback === 'function') {
        ;(callback as (p: unknown) => void)({ event, id, payload })
      }
    })
  }

  w.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: init.windowLabel },
      currentWebview: { windowLabel: init.windowLabel, label: init.windowLabel },
    },
    transformCallback(callback: (p: unknown) => void, once: boolean) {
      const id = Math.floor(Math.random() * 1_000_000_000)
      ;(window as unknown as Record<string, unknown>)[`_${id}`] = (payload: unknown) => {
        if (once) delete (window as unknown as Record<string, unknown>)[`_${id}`]
        return callback(payload)
      }
      return id
    },
    async invoke(cmd: string, args: Record<string, unknown> = {}) {
      state.calls.push({ cmd, args: JSON.parse(JSON.stringify(args ?? {})) })
      const delay = state.delays[cmd]
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
      const failure = state.failCommands[cmd]
      if (failure) throw failure
      return handle(cmd, args ?? {})
    },
  }
}
```

- [ ] **Step 3: 提交**

```bash
git add e2e
git commit -m "test: 假 IPC 注入层，兼做调用间谍"
```

---

### Task 3: Playwright fixture 与冒烟测试

**Files:**
- Create: `e2e/fixtures.ts`
- Create: `e2e/smoke.spec.ts`

- [ ] **Step 1: 写 fixture**

`e2e/fixtures.ts`：

```ts
import { test as base, type Page } from '@playwright/test'

import { installMock } from './mock/install'
import { initialState, type MockInit } from './mock/state'

export interface IpcCall {
  cmd: string
  args: Record<string, unknown>
}

export interface MockHandle {
  calls(): Promise<IpcCall[]>
  callsTo(cmd: string): Promise<IpcCall[]>
  failCommand(cmd: string, message: string): Promise<void>
  clearFailure(cmd: string): Promise<void>
  setDelay(cmd: string, ms: number): Promise<void>
  notes(): Promise<unknown[]>
  settings(): Promise<Record<string, string>>
}

function handleFor(page: Page): MockHandle {
  return {
    calls: () => page.evaluate(() => (window as never as { __IPC_MOCK__: { calls(): IpcCall[] } }).__IPC_MOCK__.calls()),
    async callsTo(cmd) {
      const all = await this.calls()
      return all.filter((c) => c.cmd === cmd)
    },
    failCommand: (cmd, message) =>
      page.evaluate(([c, m]) => (window as never as { __IPC_MOCK__: { failCommand(a: string, b: string): void } }).__IPC_MOCK__.failCommand(c, m), [cmd, message] as const),
    clearFailure: (cmd) =>
      page.evaluate((c) => (window as never as { __IPC_MOCK__: { clearFailure(a: string): void } }).__IPC_MOCK__.clearFailure(c), cmd),
    setDelay: (cmd, ms) =>
      page.evaluate(([c, m]) => (window as never as { __IPC_MOCK__: { setDelay(a: string, b: number): void } }).__IPC_MOCK__.setDelay(c, m as number), [cmd, ms] as const),
    notes: () => page.evaluate(() => (window as never as { __IPC_MOCK__: { notes(): unknown[] } }).__IPC_MOCK__.notes()),
    settings: () => page.evaluate(() => (window as never as { __IPC_MOCK__: { settings(): Record<string, string> } }).__IPC_MOCK__.settings()),
  }
}

/// 打开一个装好假 IPC 的页面。windowLabel 决定渲染主窗口还是快捕窗口。
export async function openApp(page: Page, overrides: Partial<MockInit> = {}) {
  await page.addInitScript(installMock, initialState(overrides))
  await page.goto('/')
  return handleFor(page)
}

export const test = base
export { expect } from '@playwright/test'
```

- [ ] **Step 2: 写冒烟测试**

`e2e/smoke.spec.ts`：

```ts
import { openApp, test, expect } from './fixtures'
import { note } from './mock/state'

test('主窗口加载后拉取笔记列表', async ({ page }) => {
  const mock = await openApp(page, { notes: [note(1, '知识图谱')] })

  await expect(page.getByText('知识图谱')).toBeVisible()
  expect(await mock.callsTo('list_notes')).not.toHaveLength(0)
})

test('快捕窗口渲染的是捕捉界面而不是主窗口', async ({ page }) => {
  await openApp(page, { windowLabel: 'capture' })

  // 快捕窗口没有侧边栏的「新建」按钮
  await expect(page.getByRole('button', { name: '新建' })).toHaveCount(0)
})
```

- [ ] **Step 3: 跑起来**

```bash
cd /Users/chenhao/codes/myself/MeshMind
pnpm e2e
```

Expected: 2 个测试通过。

**这一步大概率不会一次过。** `__TAURI_INTERNALS__` 的确切形状随 `@tauri-apps/api` 版本变化，本项目装的是 2.11.x。失败时的排查顺序：

1. 页面白屏 → 打开 `pnpm e2e:ui` 看浏览器控制台，多半是 `metadata` 结构不对（`getCurrentWindow()` 读不到 label）
2. 报「mock 未实现的命令: xxx」→ 补上那个命令的分支，这是好事，说明 mock 覆盖不全被抓到了
3. 事件不通 → 检查 `transformCallback` 注册的全局回调名，实际实现可能不是 `_${id}`

**按实际情况调整 mock，不要改应用代码去迁就 mock。**

- [ ] **Step 4: 提交**

```bash
git add e2e
git commit -m "test: Playwright fixture 与冒烟测试"
```

---

### Task 4: 覆盖数据安全场景

这一类是本计划最有价值的部分——手工几乎复现不了。

**Files:**
- Create: `e2e/autosave.spec.ts`

- [ ] **Step 1: 写「自动保存必须带上完整附件 id」**

这条守的是曾经真实发生过的数据丢失：漏传 `attachmentIds` 会让附件被解绑，随后被 GC 删掉。

```ts
import { openApp, test, expect } from './fixtures'
import { note } from './mock/state'

const DOC_WITH_IMAGE = JSON.stringify({
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: '带图的笔记' }] },
    { type: 'attachmentImage', attrs: { attachmentId: 7 } },
  ],
})

test('自动保存把正文里的附件 id 一并传回后端', async ({ page }) => {
  const mock = await openApp(page, {
    notes: [note(1, '带图的笔记', { body_json: DOC_WITH_IMAGE, attachment_ids: [7] })],
  })

  await page.getByText('带图的笔记').click()
  await page.locator('.editor [contenteditable="true"]').click()
  await page.keyboard.type('补充')

  await expect
    .poll(async () => (await mock.callsTo('update_note')).length, { timeout: 5_000 })
    .toBeGreaterThan(0)

  const saves = await mock.callsTo('update_note')
  expect(saves[saves.length - 1].args.attachmentIds).toEqual([7])
})
```

- [ ] **Step 2: 写「保存失败后切换笔记不丢内容」**

```ts
test('保存失败后切换笔记，未落盘的内容不会消失', async ({ page }) => {
  const mock = await openApp(page, {
    notes: [note(1, '第一条'), note(2, '第二条')],
  })

  await page.getByText('第一条').click()
  await mock.failCommand('update_note', '数据库错误: database is locked')
  await page.locator('.editor [contenteditable="true"]').click()
  await page.keyboard.type('要保住的内容')

  // 等错误浮现
  await expect(page.locator('.error-bar')).toBeVisible({ timeout: 5_000 })

  // 恢复后切到另一条再切回来，内容必须还在
  await mock.clearFailure('update_note')
  await page.getByText('第二条').click()
  await page.getByText('第一条').click()

  await expect(page.locator('.editor')).toContainText('要保住的内容')
})
```

- [ ] **Step 3: 写「保存慢时不并发写同一条笔记」**

```ts
test('保存很慢时不会并发写同一条笔记', async ({ page }) => {
  const mock = await openApp(page, { notes: [note(1, '原文')] })

  await page.getByText('原文').click()
  await mock.setDelay('update_note', 1_500)

  const editor = page.locator('.editor [contenteditable="true"]')
  await editor.click()
  await page.keyboard.type('第一批')
  await page.waitForTimeout(1_000)
  await page.keyboard.type('第二批')

  await page.waitForTimeout(4_000)

  // 串行化生效的话，任意时刻只有一个 update_note 在途，
  // 且最后一次调用带的是最新内容
  const saves = await mock.callsTo('update_note')
  expect(saves.length).toBeGreaterThan(0)
  expect(String(saves[saves.length - 1].args.bodyJson)).toContain('第二批')
})
```

- [ ] **Step 4: 跑通并提交**

```bash
pnpm e2e
git add e2e
git commit -m "test: 覆盖自动保存的数据安全场景"
```

Expected: 全部通过。若第三条不稳定（时序敏感），把它标 `test.slow()` 并调大等待，但**不要**改成断言更弱的版本——这条测的就是时序。

---

### Task 5: 覆盖跨窗口与退出时序

**Files:**
- Create: `e2e/windows.spec.ts`

- [ ] **Step 1: 写「快捕保存后主窗口列表刷新」**

两个 page 实例，靠 `BroadcastChannel` 传事件。

```ts
import { openApp, test, expect } from './fixtures'

test('快捕窗口保存后，主窗口收到事件并重新拉列表', async ({ context }) => {
  const mainPage = await context.newPage()
  const mainMock = await openApp(mainPage, { windowLabel: 'main' })

  const capturePage = await context.newPage()
  await openApp(capturePage, { windowLabel: 'capture' })

  const before = (await mainMock.callsTo('list_notes')).length

  await capturePage.locator('.editor [contenteditable="true"]').click()
  await capturePage.keyboard.type('随手记一条')
  await capturePage.keyboard.press('Control+Enter')

  await expect
    .poll(async () => (await mainMock.callsTo('list_notes')).length, { timeout: 5_000 })
    .toBeGreaterThan(before)
})
```

- [ ] **Step 2: 写「退出前落盘的完整时序」**

```ts
test('收到退出请求时先落盘再回执', async ({ page }) => {
  const mock = await openApp(page, { notes: [] })

  await page.getByRole('button', { name: '新建' }).click()
  await page.locator('.editor [contenteditable="true"]').click()
  await page.keyboard.type('还没到防抖时间的内容')

  // 立刻触发退出，不等 800ms 防抖
  await page.evaluate(() => {
    const channel = new BroadcastChannel('meshmind-e2e-events')
    channel.postMessage({ event: 'app-quit-requested', payload: null })
  })

  await expect.poll(async () => (await mock.callsTo('confirm_quit')).length, { timeout: 5_000 }).toBe(1)

  const calls = await mock.calls()
  const saveIndex = calls.findIndex((c) => c.cmd === 'update_note' || c.cmd === 'create_note')
  const quitIndex = calls.findIndex((c) => c.cmd === 'confirm_quit')
  expect(saveIndex).toBeGreaterThanOrEqual(0)
  expect(saveIndex).toBeLessThan(quitIndex)
})
```

顺序断言是这条测试的全部意义：`confirm_quit` 必须**在**落盘之后。反过来的话外壳会在写完之前就 `exit(0)`。

- [ ] **Step 3: 跑通并提交**

```bash
pnpm e2e
git add e2e
git commit -m "test: 覆盖跨窗口事件与退出时序"
```

---

### Task 6: 覆盖搜索、回收站、分页、设置

前面几个 Task 已经把三种机制都示范过了：**断言调用形状**（Task 4 Step 1）、**注入失败**（Task 4 Step 2）、**跨 page 事件**（Task 5 Step 1）。这一 Task 按同样的模式补齐其余场景。

**Files:**
- Create: `e2e/search.spec.ts`
- Create: `e2e/trash.spec.ts`
- Create: `e2e/settings.spec.ts`

- [ ] **Step 1: 搜索（`e2e/search.spec.ts`）**

逐条写，每条的断言写死如下：

1. **⌘K 打开面板，输入触发搜索** —— 按 `Control+k`，输入「知识」，断言 `search_notes` 被调用且 `args.query` 为「知识」
2. **防抖生效** —— 连续输入「知」「识」「图」三个字符，等待 1 秒后断言 `search_notes` 调用次数 **小于** 3
3. **字面命中高亮** —— mock 返回 `matched_terms: ['知识']`，断言结果项里存在 `mark` 元素且文本为「知识」
4. **拼音命中不高亮** —— 输入 ASCII 查询，mock 返回 `matched_terms: []` 与 `source: 'PinyinFull'`，断言结果项里 `mark` 元素数量为 0，且来源标签显示「全拼」
5. **键盘导航** —— 按 `ArrowDown` 后按 `Enter`，断言 `get_note` 被调用且 id 是第二条结果的 id
6. **Esc 关闭** —— 断言面板不可见

- [ ] **Step 2: 回收站（`e2e/trash.spec.ts`）**

1. **打开回收站列出已删除笔记** —— 初始状态给一条 `deleted_at` 非 null 的笔记，断言它在面板里可见，且 `list_deleted_notes` 被调用
2. **恢复** —— 点「恢复」，断言 `restore_note` 被调用且 id 正确，面板关闭后主列表出现该笔记
3. **彻底删除是两步确认** —— 第一次点「清空回收站」时断言 `purge_all_deleted` **未**被调用且按钮文案变成确认态；再点一次才断言它被调用
4. **附件提示存在** —— 彻底删除后断言页面上出现提到「附件」的提示文案（附件不会立刻消失这条信息必须传达到）

- [ ] **Step 3: 设置（`e2e/settings.spec.ts`）**

1. **热键改键成功** —— 打开设置，触发录制，按下组合键，断言 `set_capture_hotkey` 被调用且 `args.accelerator` 是规范化后的字符串
2. **热键改键失败后 UI 回滚** —— `failCommand('set_capture_hotkey', '全局热键「X」注册失败…')`，断言错误消息可见，且面板上显示的仍是**原来那个键**（这条守的是「显示成功了但实际没生效」这类最坏的 UI 谎报）
3. **开机自启开关失败后回滚** —— 同上，断言开关回到原位
4. **非 macOS 不显示 Dock 开关** —— 用 `page.addInitScript` 覆盖 `navigator.userAgent` 为 Windows，断言该项不渲染

- [ ] **Step 4: 分页（并入 `e2e/smoke.spec.ts` 或单独文件）**

1. **加载更多** —— 初始 60 条笔记（`PAGE_SIZE` 是 50），断言首屏 50 条、存在「加载更多」，点击后断言 `list_notes` 带 `offset: 50` 被调用
2. **终止态** —— 加载完后断言「加载更多」消失或变成明确的终止文案

- [ ] **Step 5: 全部跑通并提交**

```bash
pnpm e2e
git add e2e
git commit -m "test: 覆盖搜索、回收站、设置与分页"
```

---

### Task 7: 接入 CI

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: 加 e2e 步骤**

在 `pnpm test` 之后、`cargo test` 之前插入：

```yaml
      - name: 安装 Playwright 浏览器
        run: pnpm exec playwright install --with-deps chromium

      - name: 交互测试
        run: pnpm e2e

      - name: 上传失败时的 trace
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report-${{ matrix.os }}
          path: playwright-report/
          retention-days: 7
          if-no-files-found: ignore
```

- [ ] **Step 2: 推送并确认双平台绿**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: 接入 Playwright 交互测试"
git push
gh run watch $(gh run list --limit 1 --json databaseId --jq '.[0].databaseId')
```

Expected: 两平台均 `success`。

Windows runner 上 Playwright 可能比 macOS 慢不少。若因超时失败，给该 job 加 `timeout-minutes`，**不要**为了让 CI 变绿而缩减测试。

---

## 完成标准

- `pnpm e2e` 本地全绿
- CI 在 macOS 与 Windows 上均跑 e2e 且绿
- 覆盖 spec §3 列出的全部关键场景
- 每个数据安全相关的测试都断言了 IPC 调用形状，而不只是页面外观

## 明确不在覆盖范围内

真实 Rust 逻辑、SQLite 行为、全局热键、托盘、窗口显示隐藏、系统权限、CSP。这些靠 `docs/manual-verification.md` 的人工清单与 Rust 侧的 177 个测试。**不要因为有了 Playwright 就删减人工清单。**
