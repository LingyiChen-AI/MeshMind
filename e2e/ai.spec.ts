// 右侧问答栏、设置里的 AI 三节，以及搜索面板的「语义相关」那一组。
//
// 这一组测试的重心不在「页面长什么样」，而在**发出去的调用对不对**：
// 这一块最贵的三种错法全都在界面上看不出来——
//
// 1. 启用 AI 之前没先做只读预览，用户看见确认框时 embedding 请求已经在路上了；
// 2. Channel 事件的字段名对不上（`note_id` 写成 `noteId`），点引用跳到 undefined；
// 3. 迟到的取消事件不认序号，把**正在跑的**这一次判成已取消。
//
// 所以断言优先看 `mock.calls()`，其次才看 DOM。
//
// ## 关于 `mock.emitAsk`
//
// 它把事件包成 Channel 要的 `{ index, message }` 信封再投。**这层信封不是可有可无
// 的包装**：`Channel` 登记进 `transformCallback` 的是它内部的一个保序泵，index
// 对不上就把消息压进队列里等，`onmessage` 一次都不会触发——面板永远空白，
// 而且不报任何错。假实现里投裸事件的话，下面每一条流式用例都会「通过」。

import { openApp, test, expect } from './fixtures'
import {
  aiConfigured,
  aiEnabled,
  aiState,
  citation,
  conversation,
  note,
  notes,
  type MockChatMessage,
} from './mock/state'

/// 三条笔记。「知识」这个词命中前两条，第三条留给语义那一组。
const NOTES = [note(1, '知识图谱构建'), note(2, '知识管理'), note(3, '无关的笔记')]

/// 一条指向笔记 1 的引用。`heading` 非空，顺手把「《标题》 > 小标题」的拼接也验掉。
const CITE_1 = citation(1, 1, {
  title: '知识图谱构建',
  heading: '定义',
  excerpt: '知识图谱是一种结构化的知识表示。',
})

type Page = import('@playwright/test').Page
type Mock = import('./fixtures').MockHandle

async function openAi(page: Page) {
  await page.keyboard.press('Control+l')
  await expect(page.locator('.ai-panel')).toBeVisible()
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: '设置' }).click()
  await expect(page.locator('.settings-panel')).toBeVisible()
}

/// 设置面板里那个总开关。按标题文字挑，不按顺序——AI 一共三节，都带 `.ai-settings`。
function enableToggle(page: Page) {
  return page
    .locator('.settings-item', { hasText: '启用 AI 与知识问答' })
    .locator('input[type="checkbox"]')
}

/// 提问并等 `ai_ask` 真的发出去。`nth` 是「这是第几次提问」（1 起）。
async function ask(page: Page, mock: Mock, question: string, nth = 1) {
  await page.locator('.ai-input').fill(question)
  // ⌘/Ctrl+Enter 发送，单独的 Enter 留给换行
  await page.keyboard.press('Control+Enter')
  await expect
    .poll(async () => (await mock.callsTo('ai_ask')).length, { timeout: 5_000 })
    .toBe(nth)
}

// ---------- 引导态 ----------

test('没配 AI：引导去设置，一个 ai_ask 都不发', async ({ page }) => {
  const mock = await openApp(page, { notes: NOTES })
  await openAi(page)

  await expect(page.locator('.ai-empty')).toContainText('先在设置里配置 AI 服务')
  // 缺的那一项要说出来。`missing_field` 是后端按固定顺序给的第一项。
  await expect(page.locator('.ai-empty')).toContainText('还缺：Base URL')
  // 连输入框都不渲染：有输入框就会有「打完字点发送才发现用不了」这回事
  await expect(page.locator('.ai-input')).toHaveCount(0)
  expect(await mock.callsTo('ai_ask')).toHaveLength(0)
  // 也不该去拉会话列表：那时面板上根本没有选会话的地方
  expect(await mock.callsTo('ai_list_conversations')).toHaveLength(0)
})

test('配好了但没启用：说的是「还没启用」，不是「先去配置」', async ({ page }) => {
  // 两句话对应两个完全不同的下一步动作，混成一句用户不知道该去干嘛。
  const mock = await openApp(page, { notes: NOTES, settings: aiConfigured() })
  await openAi(page)

  await expect(page.locator('.ai-empty')).toContainText('AI 还没启用')
  await expect(page.locator('.ai-empty')).not.toContainText('先在设置里配置')
  await expect(page.locator('.ai-input')).toHaveCount(0)
  expect(await mock.callsTo('ai_ask')).toHaveLength(0)
})

// ---------- 一次提问的生命周期 ----------

test('Retrieved 先到：引用条在任何回答文字出现之前就可见', async ({ page }) => {
  const mock = await openApp(page, { notes: NOTES, settings: aiEnabled() })
  await openAi(page)
  await ask(page, mock, '知识图谱是什么')

  // 命令发出去了，事件一个都还没来——「正在思考」必须在这一刻就已经在了。
  // 等 `Retrieved` 再显示的话，慢网络下界面会先僵住一两秒。
  await expect(page.locator('.ai-thinking')).toBeVisible()

  // 会话是第一次提问时才建的（点「新对话」不建）
  expect(await mock.callsTo('ai_create_conversation')).toHaveLength(1)
  const args = await mock.lastArgs('ai_ask')
  expect(args?.conversationId).toBe(1)
  expect(args?.question).toBe('知识图谱是什么')
  // Channel 序列化成 `__CHANNEL__:<id>` 这么一个字符串，不是一个对象
  expect(String(args?.onEvent)).toMatch(/^__CHANNEL__:\d+$/)

  await mock.emitAsk({ Retrieved: { citations: [CITE_1] } })

  await expect(page.locator('.ai-citations .ai-cite-link')).toHaveText(
    '[1] 《知识图谱构建》 > 定义',
  )
  // 模型还没开口。引用条先出现是刻意的：用户要在回答之前就看见它读了哪些笔记。
  await expect(page.locator('.ai-thinking')).toBeVisible()
  await expect(page.locator('.ai-message-assistant .ai-text')).toHaveCount(0)
})

test('多个 Delta 拼成完整回答，Done 之后和库里那条对得上', async ({ page }) => {
  const mock = await openApp(page, { notes: NOTES, settings: aiEnabled() })
  await openAi(page)
  await ask(page, mock, '知识图谱是什么')

  await mock.emitAsk({ Retrieved: { citations: [CITE_1] } })
  await mock.emitAsk({ Delta: { text: '知识图谱是' } })
  await mock.emitAsk({ Delta: { text: '一种结构化的' } })
  await mock.emitAsk({ Delta: { text: '知识表示 [1]。' } })

  const answer = page.locator('.ai-message-assistant .ai-text')
  await expect(answer).toHaveText('知识图谱是一种结构化的知识表示 [1]。')

  await mock.emitAsk({ Done: { message_id: 7 } })

  // 三种终止态都要重拉：提问那句话是后端先落的库，不重拉它会随乐观气泡一起消失。
  await expect
    .poll(async () => (await mock.callsTo('ai_get_messages')).length, { timeout: 5_000 })
    .toBeGreaterThan(0)
  await expect(page.locator('.ai-thinking')).toHaveCount(0)
  // 还是同一句话，只是这一份来自数据库——中间不该闪一下空白
  await expect(answer).toHaveText('知识图谱是一种结构化的知识表示 [1]。')
  await expect(page.locator('.ai-message-assistant')).toHaveCount(1)
  await expect(page.locator('.ai-message-user .ai-text')).toHaveText('知识图谱是什么')
  // 第一个提问决定会话标题
  await expect(page.locator('.ai-conversations select')).toHaveValue('1')
  await expect(page.locator('.ai-conversations option')).toHaveText(['知识图谱是什么'])
})

test('点引用条打开那篇笔记，问答栏保持打开', async ({ page }) => {
  const mock = await openApp(page, { notes: NOTES, settings: aiEnabled() })
  await openAi(page)
  await ask(page, mock, '知识图谱是什么')
  await mock.emitAsk({ Retrieved: { citations: [CITE_1] } })

  await page.locator('.ai-cite-link').click()

  await expect
    .poll(async () => (await mock.callsTo('get_note')).length, { timeout: 5_000 })
    .toBeGreaterThan(0)
  // Channel 那条路径**不经过 `toCamel`**，假实现给的是 `note_id`，归一化由
  // `lib/ai.ts` 自己做。漏了这一步的话这里发出去的是 `{}`
  // （`undefined` 被 JSON 丢掉），而界面上一点异常都看不出来——真实发生过一次。
  expect(await mock.lastArgs('get_note')).toEqual({ id: 1 })
  // 用户要对照着看，跳笔记不该把问答栏关掉
  await expect(page.locator('.ai-panel')).toBeVisible()
})

test('回答里越界的 [9]：当普通文字画，不产生可点的元素', async ({ page }) => {
  const mock = await openApp(page, { notes: NOTES, settings: aiEnabled() })
  await openAi(page)
  await ask(page, mock, '知识图谱是什么')

  // 引用只有 [1] 一条，模型却写出了 [9]——这是常态，不是异常输入。
  await mock.emitAsk({ Retrieved: { citations: [CITE_1] } })
  await mock.emitAsk({ Delta: { text: '见 [1] 与 [9]，另见数组[i]。' } })

  const answer = page.locator('.ai-message-assistant .ai-text')
  // 一个字都不能少，[9] 照原样留在正文里
  await expect(answer).toHaveText('见 [1] 与 [9]，另见数组[i]。')

  // 按位置取（`citations[index - 1]`）的话 [9] 是一个 undefined，
  // 点一下会静默跳到一篇 id 为 undefined 的笔记上。
  const inline = page.locator('.ai-message-assistant .ai-cite')
  await expect(inline).toHaveCount(1)
  await expect(inline).toHaveText('[1]')
  // 而且没把面板带崩：输入框和引用条都还在
  await expect(page.locator('.ai-input')).toBeVisible()
  await expect(page.locator('.ai-cite-link')).toHaveCount(1)
})

test('Failed：错误摆成横幅，消息流里不留半截回答', async ({ page }) => {
  const mock = await openApp(page, { notes: NOTES, settings: aiEnabled() })
  await openAi(page)
  await ask(page, mock, '知识图谱是什么')

  await mock.emitAsk({ Retrieved: { citations: [CITE_1] } })
  await mock.emitAsk({ Delta: { text: '知识图谱是' } })
  await mock.emitAsk({ Failed: { message: 'embedding 请求失败: 401 Unauthorized' } })

  await expect(page.locator('.ai-panel .search-error')).toContainText(
    '回答失败：embedding 请求失败: 401 Unauthorized',
  )
  // 那半截回答根本没落库，留在消息流里就是一条永远对不上数据库的假记录
  await expect(page.locator('.ai-message-assistant')).toHaveCount(0)
  await expect(page.locator('.ai-thinking')).toHaveCount(0)
  // 但用户敲的那句话还在：后端是先落库再检索的
  await expect(page.locator('.ai-message-user .ai-text')).toHaveText('知识图谱是什么')
})

test('点「停止」发 ai_cancel；Cancelled 回来才收起，而且不算错误', async ({ page }) => {
  const mock = await openApp(page, { notes: NOTES, settings: aiEnabled() })
  await openAi(page)
  await ask(page, mock, '知识图谱是什么')

  await mock.emitAsk({ Retrieved: { citations: [CITE_1] } })
  await mock.emitAsk({ Delta: { text: '知识图谱是' } })

  // 从这一刻起重新计数。StrictMode 挂载时会跑一轮「装→卸→装」，卸的那一下
  // 已经发过一次 aiCancel，用绝对条数断言会把它算进来。
  await mock.reset()
  await page.getByRole('button', { name: '停止' }).click()
  await expect
    .poll(async () => (await mock.callsTo('ai_cancel')).length, { timeout: 5_000 })
    .toBe(1)

  // 取消由后端确认。抢在这里就置成已取消的话，一次「取消晚了、回答其实已经完成」
  // 会让已经落库的那条回答在界面上凭空消失。
  await expect(page.locator('.ai-message-assistant .ai-text')).toHaveText('知识图谱是')
  await expect(page.getByRole('button', { name: '停止' })).toBeVisible()

  // 无字段变体在 serde 的外部标签下是**裸字符串**，不是 `{ Cancelled: {} }`
  await mock.emitAsk('Cancelled')

  await expect(page.locator('.trash-notice')).toContainText('已停止生成')
  await expect(page.locator('.ai-thinking')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '发送' })).toBeVisible()
  // 取消不是错误，不该有红色横幅
  await expect(page.locator('.ai-panel .search-error')).toHaveCount(0)
  // 这次的回答没保存，提问还在
  await expect(page.locator('.ai-message-assistant')).toHaveCount(0)
  await expect(page.locator('.ai-message-user .ai-text')).toHaveText('知识图谱是什么')
})

test('上一次提问迟到的 Cancelled 不会把当前回答判成已取消', async ({ page }) => {
  const mock = await openApp(page, { notes: NOTES, settings: aiEnabled() })
  await openAi(page)

  await ask(page, mock, '第一问', 1)
  await mock.emitAsk({ Retrieved: { citations: [CITE_1] } }, 0)

  // 用户改主意点了「新对话」。前端这一下会 aiCancel，但后端的取消事件是
  // **之后**才补到上一条 channel 上的。
  await page.getByRole('button', { name: '新对话' }).click()
  // 顺手验一条：「新对话」是惰性的，点它只清空选中，不建会话——
  // 建了的话用户点一下又改主意，库里就留下一个空壳。
  expect(await mock.callsTo('ai_create_conversation')).toHaveLength(1)

  await ask(page, mock, '第二问', 2)
  await mock.emitAsk({ Retrieved: { citations: [CITE_1] } }, 1)
  await mock.emitAsk({ Delta: { text: '这是第二问的回答' } }, 1)

  const answer = page.locator('.ai-message-assistant .ai-text')
  await expect(answer).toHaveText('这是第二问的回答')

  // 迟到的取消属于**上一次**提问（第 0 条 channel）。不认序号的话，
  // 它会把正在跑的这一次判成已取消，界面上表现为「刚发的问题自己没了」。
  await mock.emitAsk('Cancelled', 0)
  await page.waitForTimeout(300)

  await expect(answer).toHaveText('这是第二问的回答')
  await expect(page.locator('.trash-notice')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '停止' })).toBeVisible()
})

// ---------- 会话 ----------

const CONVERSATIONS = [conversation(1, '第一问'), conversation(2, '第二问')]

const MESSAGES: Record<string, MockChatMessage[]> = {
  1: [
    { id: 11, role: 'user', content: '第一问', citations: [], created_at: 1_100 },
    { id: 12, role: 'assistant', content: '第一答', citations: [], created_at: 1_101 },
  ],
  2: [{ id: 21, role: 'user', content: '第二问', citations: [], created_at: 1_200 }],
}

test('切换会话拉的是对应会话的消息', async ({ page }) => {
  const mock = await openApp(page, {
    notes: NOTES,
    settings: aiEnabled(),
    ai: aiState({ conversations: CONVERSATIONS, messages: MESSAGES }),
  })
  await openAi(page)

  // 列表按 updated_at 降序，默认落在最近用过的那个会话上
  await expect
    .poll(async () => (await mock.callsTo('ai_get_messages')).length, { timeout: 5_000 })
    .toBe(1)
  // 参数名写死断言：Tauri 会把 camelCase 转成 Rust 的 snake_case，
  // 这里写成 conversation_id 的话后端收到的是一个它不认识的键。
  expect(await mock.lastArgs('ai_get_messages')).toEqual({ conversationId: 2 })
  await expect(page.locator('.ai-message-user .ai-text')).toHaveText('第二问')

  await page.locator('.ai-conversations select').selectOption('1')

  await expect
    .poll(async () => (await mock.callsTo('ai_get_messages')).length, { timeout: 5_000 })
    .toBe(2)
  expect(await mock.lastArgs('ai_get_messages')).toEqual({ conversationId: 1 })
  await expect(page.locator('.ai-message-user .ai-text')).toHaveText('第一问')
  await expect(page.locator('.ai-message-assistant .ai-text')).toHaveText('第一答')
  // 切走要顺手停掉在飞的提问：它的答案会落进原来那个会话，
  // 而用户已经在看别的会话了
  expect((await mock.callsTo('ai_cancel')).length).toBeGreaterThan(0)
})

// ---------- 设置：总开关 ----------

test('启用确认框点「取消」：一个调用都不发，AI 保持关闭', async ({ page }) => {
  const mock = await openApp(page, { notes: notes(3), settings: aiConfigured() })
  await openSettings(page)

  const toggle = enableToggle(page)
  await expect(toggle).not.toBeChecked()
  // `check()` 会等着复选框真的变成选中，而这里它**不该**变——用 click。
  await toggle.click()

  const confirm = page.locator('.settings-warn', { hasText: '将为' })
  await expect(confirm).toContainText('将为 3 篇笔记建立索引')
  // 到这一步为止只发过一次**只读的**预览，一个 embedding 请求都还没出去
  expect(await mock.callsTo('ai_preview_index')).toHaveLength(1)
  expect(await mock.callsTo('ai_enable')).toHaveLength(0)

  await mock.reset()
  await confirm.getByRole('button', { name: '取消' }).click()
  await page.waitForTimeout(300)

  // 「取消」就是什么都没发生：AI 从头到尾没被打开过，没有需要回滚的东西。
  // 这里少一个断言，「先开了再问」这种写法照样能全绿。
  expect(await mock.calls()).toEqual([])
  await expect(page.locator('.settings-hint', { hasText: '已取消，AI 保持关闭' })).toBeVisible()
  await expect(toggle).not.toBeChecked()
  expect((await mock.settings())['ai.enabled']).toBeUndefined()
})

test('关→开：先只读预览，点「继续」才真的启用', async ({ page }) => {
  const mock = await openApp(page, { notes: notes(3), settings: aiConfigured() })
  await openSettings(page)

  await enableToggle(page).click()
  const confirm = page.locator('.settings-warn', { hasText: '将为' })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: '继续' }).click()

  await expect
    .poll(async () => (await mock.callsTo('ai_enable')).length, { timeout: 5_000 })
    .toBe(1)
  expect(await mock.lastArgs('ai_enable')).toEqual({ enabled: true })
  // 顺序是死的：只读的预览在前，真的开在后
  const order = (await mock.calls())
    .filter((call) => call.cmd === 'ai_preview_index' || call.cmd === 'ai_enable')
    .map((call) => call.cmd)
  expect(order).toEqual(['ai_preview_index', 'ai_enable'])

  await expect(enableToggle(page)).toBeChecked()
  expect((await mock.settings())['ai.enabled']).toBe('true')
  await expect(page.locator('.settings-hint', { hasText: '已开始建立索引' })).toBeVisible()
})

test('关闭 AI：直接发 ai_enable(false)，不预览也不确认', async ({ page }) => {
  // 关的方向要立刻生效：它会停 worker、取消在飞的提问、把内存索引还给系统。
  const mock = await openApp(page, { notes: notes(3), settings: aiEnabled() })
  await openSettings(page)

  const toggle = enableToggle(page)
  await expect(toggle).toBeChecked()
  await mock.reset()
  await toggle.click()

  await expect
    .poll(async () => (await mock.callsTo('ai_enable')).length, { timeout: 5_000 })
    .toBe(1)
  expect(await mock.lastArgs('ai_enable')).toEqual({ enabled: false })
  expect(await mock.callsTo('ai_preview_index')).toHaveLength(0)
  await expect(toggle).not.toBeChecked()
  expect((await mock.settings())['ai.enabled']).toBe('false')
})

// ---------- 设置：密钥 ----------

test('密钥框留空点保存：一次 set_setting 都不发', async ({ page }) => {
  // 空串写进去等于把用户已经存好的密钥清掉，而他可能只是路过这个输入框。
  // 想清除有单独的按钮，那是一个显式动作。
  const mock = await openApp(page, { notes: NOTES, settings: aiConfigured() })
  await openSettings(page)

  // 库里存着密钥，但它不经 IPC 回到前端——界面读的是合成的 `ai.api_key_set`
  await expect(page.locator('.settings-hint', { hasText: 'API Key：已设置' })).toBeVisible()

  const field = page.locator('.ai-field', { hasText: 'API Key' }).locator('input')
  const save = page.getByRole('button', { name: '保存密钥' })

  await expect(save).toBeDisabled()
  await field.fill('   ')
  await expect(save).toBeDisabled()

  await mock.reset()
  await save.click({ force: true })
  await page.waitForTimeout(300)
  expect(await mock.calls()).toEqual([])
  // 库里那份一个字都没动
  expect((await mock.settings())['ai.api_key']).toBe('sk-test')

  // 反证：真填了东西就必须发出去，否则上面那条断言是空的
  await field.fill('sk-new')
  await expect(save).toBeEnabled()
  await save.click()

  await expect
    .poll(async () => (await mock.callsTo('set_setting')).length, { timeout: 5_000 })
    .toBe(1)
  expect(await mock.lastArgs('set_setting')).toEqual({ key: 'ai.api_key', value: 'sk-new' })
  // 存完立刻从输入框里抹掉：这份明文没有继续留在 DOM 里的理由
  await expect(field).toHaveValue('')
})

test('切到 Ollama：旧密钥仍显示「已设置」，并且给得出清除入口', async ({ page }) => {
  // Ollama 不需要密钥，但库里存着的那份不会自己消失。把整块藏掉的话，
  // 用户既看不到「这台机器上存着一份凭证」，也没有清除它的地方。
  const mock = await openApp(page, { notes: NOTES, settings: aiConfigured() })
  await openSettings(page)

  await page.locator('.ai-field', { hasText: '服务商' }).locator('select').selectOption('ollama')
  await expect
    .poll(async () => (await mock.callsTo('set_setting')).length, { timeout: 5_000 })
    .toBe(1)
  expect(await mock.lastArgs('set_setting')).toEqual({ key: 'ai.provider', value: 'ollama' })

  await expect(page.locator('.settings-hint', { hasText: 'API Key：已设置' })).toContainText(
    'Ollama 不需要密钥，可以清除',
  )
  const clear = page.getByRole('button', { name: '清除密钥' })
  await expect(clear).toBeEnabled()
  await clear.click()

  await expect
    .poll(async () => (await mock.callsTo('set_setting')).length, { timeout: 5_000 })
    .toBe(2)
  expect(await mock.lastArgs('set_setting')).toEqual({ key: 'ai.api_key', value: '' })
  // 清干净之后整块才消失：Ollama 模式下留一个填了也没用的输入框，
  // 只会让人以为自己漏配了什么。
  await expect(page.getByRole('button', { name: '清除密钥' })).toHaveCount(0)
  await expect(page.locator('.ai-settings input[type="password"]')).toHaveCount(0)
  expect((await mock.settings())['ai.api_key']).toBe('')
})

// ---------- 搜索面板的语义分组 ----------

test('AI 关着：搜索面板不出现「语义相关」这一组', async ({ page }) => {
  const mock = await openApp(page, { notes: NOTES })

  await page.keyboard.press('Control+k')
  await page.locator('.search-input').fill('知识')

  // 命令照发（后端负责在没开时静默返回空数组，而不是报错）
  await expect
    .poll(async () => (await mock.callsTo('ai_semantic_search')).length, { timeout: 5_000 })
    .toBeGreaterThan(0)
  await page.waitForTimeout(300)

  // 但界面上一个字都不能多：搜索框不该变成 AI 的广告位。
  // 「检索中…」也一样——那会让一个压根没配 AI 的用户每敲一个键都看见一行 AI 的字。
  await expect(page.locator('.search-group')).toHaveCount(1)
  await expect(page.locator('.search-group-title')).toHaveText('关键词匹配')
  await expect(page.locator('.search-panel')).not.toContainText('语义相关')
  await expect(page.locator('.search-panel')).not.toContainText('检索中')
})

test('AI 开着：语义结果单独一组，和关键词组重合的那篇被去掉', async ({ page }) => {
  const mock = await openApp(page, {
    notes: NOTES,
    settings: aiEnabled(),
    ai: aiState({
      semanticHits: [
        // 笔记 1 关键词那组已经有了。两组重合是常态，同一个标题在一屏里出现两次，
        // 用户第一反应是「点哪个」而不是「这篇很相关」。
        { note_id: 1, uuid: 'uuid-1', title: '知识图谱构建', excerpt: '重合的那篇', score: 0.91 },
        { note_id: 3, uuid: 'uuid-3', title: '无关的笔记', excerpt: '讲的是别的事', score: 0.82 },
      ],
    }),
  })

  await page.keyboard.press('Control+k')
  await page.locator('.search-input').fill('知识')

  const groups = page.locator('.search-group')
  await expect(groups).toHaveCount(2)
  await expect(groups.nth(0).locator('.search-group-title')).toHaveText('关键词匹配')
  await expect(groups.nth(1).locator('.search-group-title')).toHaveText('语义相关')
  // limit 写死断言：SEMANTIC_LIMIT 改了结果条数会静默变化，页面上看不出来
  expect(await mock.lastArgs('ai_semantic_search')).toEqual({ query: '知识', limit: 10 })

  // 两组都用 `.search-hit`，所以只能按组数——全局计数会把两组加在一起
  await expect(groups.nth(0).locator('.search-hit')).toHaveCount(2)
  await expect(groups.nth(1).locator('.search-hit')).toHaveCount(1)
  await expect(groups.nth(1).locator('.search-hit-title')).toHaveText('无关的笔记')

  await groups.nth(1).locator('.search-hit').click()
  await expect
    .poll(async () => (await mock.callsTo('get_note')).length, { timeout: 5_000 })
    .toBeGreaterThan(0)
  expect(await mock.lastArgs('get_note')).toEqual({ id: 3 })
})
