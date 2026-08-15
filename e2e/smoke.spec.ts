// 冒烟：假 IPC 装上了、两个窗口各自渲染对了、列表分页的两端都对。

import { openApp, test, expect } from './fixtures'
import { note, notes } from './mock/state'
import { PAGE_SIZE } from '../src/lib/pagination'

test('主窗口加载后拉取笔记列表', async ({ page }) => {
  const mock = await openApp(page, { notes: [note(1, '知识图谱')] })

  await expect(page.getByText('知识图谱')).toBeVisible()

  const listCalls = await mock.callsTo('list_notes')
  expect(listCalls).not.toHaveLength(0)
  // 首屏就是第一页：offset 必须是 0，limit 必须是 PAGE_SIZE。
  // 这里写死是有意的——首屏发一个 limit=100 的请求也能让页面看起来一样，
  // 但那是另一种行为。
  expect(listCalls[0]?.args).toMatchObject({ limit: PAGE_SIZE, offset: 0 })
})

test('主窗口首屏同时拉全库标签', async ({ page }) => {
  const mock = await openApp(page, {
    notes: [note(1, '带标签的笔记 #rust', { tags: ['rust'] })],
  })

  await expect(page.locator('.tag-chip', { hasText: '#rust' })).toBeVisible()
  expect(await mock.callsTo('list_all_tags')).not.toHaveLength(0)
})

test('后端返回 snake_case，前端 toCamel 之后才认得出字段', async ({ page }) => {
  // updated_at / body_json 这类字段名如果没被 toCamel 转成 camelCase，
  // 列表上的时间会变成 Invalid Date、正文会是空的。断言它们真的渲染出来了，
  // 等于把 toCamel 这一层钉在测试里。
  await openApp(page, {
    notes: [note(1, '第一行', { body_text: '第一行\n第二行', updated_at: 1_760_000_000_000 })],
  })

  await expect(page.locator('.note-item-excerpt')).toHaveText('第二行')
  await expect(page.locator('.note-item-meta time')).not.toHaveText(/Invalid/)
})

test('快捕窗口渲染的是捕捉界面而不是主窗口', async ({ page }) => {
  await openApp(page, { windowLabel: 'capture' })

  await expect(page.locator('.capture')).toBeVisible()
  // 快捕窗口没有侧边栏的「新建」按钮
  await expect(page.getByRole('button', { name: '新建' })).toHaveCount(0)
})

test('分页：首屏只取一页，点「加载更多」时 offset 接在已加载条数之后', async ({ page }) => {
  const mock = await openApp(page, { notes: notes(60) })

  await expect(page.locator('.note-item')).toHaveCount(PAGE_SIZE)
  await page.getByRole('button', { name: '加载更多' }).click()

  await expect
    .poll(async () => (await mock.callsTo('list_notes')).length)
    .toBeGreaterThan(1)

  const listCalls = await mock.callsTo('list_notes')
  expect(listCalls[listCalls.length - 1]?.args).toMatchObject({
    limit: PAGE_SIZE,
    offset: PAGE_SIZE,
  })
  await expect(page.locator('.note-item')).toHaveCount(60)
})

test('分页：到底之后是明确的终止态，不再有「加载更多」', async ({ page }) => {
  await openApp(page, { notes: notes(60) })

  await page.getByRole('button', { name: '加载更多' }).click()
  await expect(page.locator('.note-item')).toHaveCount(60)

  await expect(page.getByRole('button', { name: '加载更多' })).toHaveCount(0)
  await expect(page.locator('.list-more-end')).toHaveText('没有更多了')
})
