// 标签筛选。这里唯一值得写的一条就是「筛选到底在哪一侧做」：
// 在前端过滤已加载的那一页，页面看起来一模一样，但「标签」实际变成了
// 「最近 50 条里出现过的标签」，更早的笔记带同一个标签也筛不出来。
// 断言外观抓不住它，断言发出去的是 list_notes_by_tag 才抓得住。

import { openApp, test, expect } from './fixtures'
import { note, notes } from './mock/state'
import { PAGE_SIZE } from '../ui/lib/pagination'

/// 60 条笔记，带 #rust 的那条是 id 最小、更新最早的一条——
/// 它排在第 60 位，铁定不在首屏那一页里。
function withBuriedTag() {
  const all = notes(60)
  all[0] = note(1, '埋在最底下的 #rust 笔记', { tags: ['rust'] })
  return all
}

test('筛选走后端，能翻出首屏那一页之外的笔记', async ({ page }) => {
  const mock = await openApp(page, { notes: withBuriedTag() })

  await expect(page.locator('.note-item')).toHaveCount(PAGE_SIZE)
  // 首屏这 50 条里没有它
  await expect(page.locator('.note-item', { hasText: '埋在最底下的' })).toHaveCount(0)

  await page.locator('.tag-chip', { hasText: '#rust' }).click()

  await expect
    .poll(async () => (await mock.callsTo('list_notes_by_tag')).length, { timeout: 5_000 })
    .toBeGreaterThan(0)
  // 筛选是后端做的，而且是从第一页重新开始分页
  expect(await mock.lastArgs('list_notes_by_tag')).toEqual({
    tag: 'rust',
    limit: PAGE_SIZE,
    offset: 0,
  })
  await expect(page.locator('.note-item', { hasText: '埋在最底下的' })).toBeVisible()
  await expect(page.locator('.note-item')).toHaveCount(1)
})

test('标签计数是全库的，不是已加载那一页里的', async ({ page }) => {
  const all = notes(60)
  // 第 1 条和第 60 条都带 #rust，一条在首屏内、一条在首屏外
  all[0] = note(1, '最早的 #rust', { tags: ['rust'] })
  all[59] = note(60, '最新的 #rust', { tags: ['rust'] })

  await openApp(page, { notes: all })

  // 只数已加载那一页的话这里会是 1
  await expect(page.locator('.tag-chip', { hasText: '#rust' })).toContainText('2')
})

test('再点一次同一个标签取消筛选，回到完整列表', async ({ page }) => {
  const mock = await openApp(page, { notes: withBuriedTag() })

  const chip = page.locator('.tag-chip', { hasText: '#rust' })
  await chip.click()
  await expect(page.locator('.note-item')).toHaveCount(1)

  await chip.click()
  await expect(page.locator('.note-item')).toHaveCount(PAGE_SIZE)
  // 取消筛选走回 list_notes，而不是拿一个空 tag 去调 list_notes_by_tag
  const byTag = await mock.callsTo('list_notes_by_tag')
  for (const call of byTag) expect(call.args.tag).toBe('rust')
})

test('筛选中新建笔记不会把用户甩回「全部」', async ({ page }) => {
  await openApp(page, { notes: withBuriedTag() })

  await page.locator('.tag-chip', { hasText: '#rust' }).click()
  await expect(page.locator('.note-item')).toHaveCount(1)

  await page.getByRole('button', { name: '新建' }).click()
  // chip 还亮着，列表也还是筛过的那一份（新建的空笔记没有标签，不属于这个集合）
  await expect(page.locator('.tag-chip', { hasText: '#rust' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.locator('.note-item')).toHaveCount(1)
})

test('选中的标签在库里消失后按「全部」处理，不会卡在一个死掉的筛选上', async ({ page }) => {
  // 标签会因为笔记被删、被改而在库里彻底消失。这时候还认着它，用户看到的是
  // 一个永远空的列表和一个点不掉的 chip。
  const mock = await openApp(page, {
    notes: [note(1, '唯一带标签的 #rust', { tags: ['rust'] }), note(2, '不带标签的')],
  })

  await page.locator('.tag-chip', { hasText: '#rust' }).click()
  await expect(page.locator('.note-item')).toHaveCount(1)

  // 把这个标签下唯一的笔记删掉，标签随之归零消失
  await page.locator('.note-item').getByRole('button').click()

  await expect(page.locator('.tag-chip', { hasText: '#rust' })).toHaveCount(0)
  // 退回完整列表，而不是继续拿一个已经不存在的标签去查
  await expect(page.locator('.note-item', { hasText: '不带标签的' })).toBeVisible()
  const byTag = await mock.callsTo('list_notes_by_tag')
  expect(byTag[byTag.length - 1]?.args.tag).toBe('rust')
  expect((await mock.callsTo('list_notes')).length).toBeGreaterThan(1)
})
