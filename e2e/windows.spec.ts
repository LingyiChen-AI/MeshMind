// 跨窗口与退出时序。两个窗口是两个独立的 page（内存不共享，正如真实的两个 webview），
// 事件靠同源的 BroadcastChannel 走通。
//
// 这一组的断言几乎全是**顺序**和**有没有发**，不是页面外观：
// 「退出前先落盘再回执」如果反过来，外壳会在写完之前就 exit(0)，
// 而界面在被杀掉之前一直看起来一切正常。

import { emitFromShell, openApp, test, expect, typeInEditor } from './fixtures'
import { note } from './mock/state'

test('快捕窗口保存后，主窗口收到事件并重新拉列表', async ({ context }) => {
  const mainPage = await context.newPage()
  const mainMock = await openApp(mainPage, { windowLabel: 'main', notes: [note(1, '已有的笔记')] })

  const capturePage = await context.newPage()
  const captureMock = await openApp(capturePage, { windowLabel: 'capture' })

  const before = (await mainMock.callsTo('list_notes')).length

  await typeInEditor(capturePage, '随手记一条')
  await capturePage.keyboard.press('Control+Enter')

  // 快捕这边：存了，而且把正文里的附件 id 一起交回去了（空文档就是空数组）
  await expect
    .poll(async () => (await captureMock.callsTo('create_note')).length, { timeout: 5_000 })
    .toBe(1)
  const created = await captureMock.lastArgs('create_note')
  expect(String(created?.bodyJson)).toContain('随手记一条')
  expect(created?.attachmentIds).toEqual([])

  // 主窗口这边：收到 note-saved 之后重新拉了列表和标签
  await expect
    .poll(async () => (await mainMock.callsTo('list_notes')).length, { timeout: 5_000 })
    .toBeGreaterThan(before)
  expect((await mainMock.callsTo('list_all_tags')).length).toBeGreaterThan(1)

  // 存完窗口要自己收起来，且编辑区清空——它是 hide 不是 close，
  // 不清的话下次唤起还留着上次的内容。
  expect(await captureMock.callsTo('hide_capture_window')).toHaveLength(1)
  await expect(capturePage.locator('.editor')).not.toContainText('随手记一条')
})

test('收到退出请求时先落盘再回执', async ({ page }) => {
  const mock = await openApp(page, { notes: [] })

  await page.getByRole('button', { name: '新建' }).click()
  await expect(page.locator('.editor')).toBeVisible()
  await typeInEditor(page, '还没到防抖时间的内容')

  // 前提：防抖还没到点，这次编辑此刻只活在内存里。
  // 这一句不成立的话，下面测的就不是「退出前补一次落盘」而是「防抖正常工作」。
  expect(await mock.callsTo('update_note')).toHaveLength(0)

  // 立刻触发退出，不等 800ms
  await emitFromShell(page, 'app-quit-requested')

  await expect
    .poll(async () => (await mock.callsTo('confirm_quit')).length, { timeout: 5_000 })
    .toBe(1)

  const calls = await mock.calls()
  const saveIndex = calls.findIndex((c) => c.cmd === 'update_note')
  const quitIndex = calls.findIndex((c) => c.cmd === 'confirm_quit')

  // 顺序断言是这条测试的全部意义：confirm_quit 必须**在**落盘之后。
  // 反过来的话外壳会在写完之前就 exit(0)，最后那段编辑静默消失。
  expect(saveIndex).toBeGreaterThanOrEqual(0)
  expect(saveIndex).toBeLessThan(quitIndex)

  // 落的确实是那段还没到防抖时间的内容
  expect(String(calls[saveIndex]?.args.bodyJson)).toContain('还没到防抖时间的内容')
  const [stored] = (await mock.notes()) as { body_text: string }[]
  expect(stored?.body_text).toContain('还没到防抖时间的内容')
})

test('落盘失败也要回执，不能让退出菜单点了没反应', async ({ page }) => {
  const mock = await openApp(page, { notes: [note(1, '原文')] })

  await page.locator('.note-item', { hasText: '原文' }).click()
  await typeInEditor(page, '存不下去的内容')
  await mock.failCommand('update_note', '数据库错误: disk I/O error')

  await emitFromShell(page, 'app-quit-requested')

  // confirm_quit 在 finally 里，成功失败都要调：不调也退得掉（外壳 2 秒兜底），
  // 但那 2 秒里用户对着一个点了没反应的菜单项。
  await expect
    .poll(async () => (await mock.callsTo('confirm_quit')).length, { timeout: 5_000 })
    .toBe(1)
  expect((await mock.callsTo('update_note')).length).toBeGreaterThan(0)
})

test('退出请求只来一次，回执也只发一次', async ({ page }) => {
  const mock = await openApp(page, { notes: [] })

  await page.getByRole('button', { name: '新建' }).click()
  await typeInEditor(page, '内容')
  await emitFromShell(page, 'app-quit-requested')

  await expect
    .poll(async () => (await mock.callsTo('confirm_quit')).length, { timeout: 5_000 })
    .toBe(1)
  // 再等一会儿，确认没有第二发。StrictMode 的 listen/unlisten 一轮下来
  // 若监听器没摘干净，这里就会变成 2——而应用看起来完全正常。
  await page.waitForTimeout(1_500)
  expect(await mock.callsTo('confirm_quit')).toHaveLength(1)
})

test('快捕窗口退出时存草稿，但不替主窗口回执', async ({ page }) => {
  // 两个窗口都回执的话，谁先存完谁就先让外壳退出——快捕只有一次 create_note，
  // 几乎总是先完成，于是主窗口的落盘会在写到一半时被 exit(0) 打断。
  const mock = await openApp(page, { windowLabel: 'capture' })

  await typeInEditor(page, '敲了一半没按保存的草稿')
  await emitFromShell(page, 'app-quit-requested')

  await expect
    .poll(async () => (await mock.callsTo('create_note')).length, { timeout: 5_000 })
    .toBe(1)
  expect(String((await mock.lastArgs('create_note'))?.bodyJson)).toContain(
    '敲了一半没按保存的草稿',
  )

  // 也不 emit('note-saved')：主窗口正在退出，刷新列表没有意义
  expect(await mock.callsTo('confirm_quit')).toHaveLength(0)
  expect(await mock.callsTo('plugin:event|emit')).toHaveLength(0)
})

test('快捕窗口是空的时候，退出不该凭空造一条笔记', async ({ page }) => {
  const mock = await openApp(page, { windowLabel: 'capture' })

  await emitFromShell(page, 'app-quit-requested')
  await page.waitForTimeout(1_500)

  expect(await mock.callsTo('create_note')).toHaveLength(0)
})
