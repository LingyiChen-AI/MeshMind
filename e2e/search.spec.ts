// ⌘/Ctrl+K 搜索面板。
//
// 高亮那两条守的是已经真实发生过的缺陷：`matched_terms` 里混进标点，前端就把
// 全文每个逗号都刷成了高亮。所以这里既断言「该高亮的高亮了」，
// 也断言「不该高亮的一个都没有」。

import { openApp, test, expect } from './fixtures'
import { note } from './mock/state'

/// 三条笔记，够做键盘导航
const NOTES = [note(1, '知识图谱构建'), note(2, '知识管理'), note(3, '无关的笔记')]

async function openPanel(page: import('@playwright/test').Page) {
  await page.keyboard.press('Control+k')
  await expect(page.locator('.search-panel')).toBeVisible()
}

test('⌘K 打开面板，输入触发搜索', async ({ page }) => {
  const mock = await openApp(page, { notes: NOTES })

  await openPanel(page)
  await page.locator('.search-input').fill('知识')

  await expect
    .poll(async () => (await mock.callsTo('search_notes')).length, { timeout: 5_000 })
    .toBeGreaterThan(0)

  // limit 写死断言：ipc.searchNotes 的默认 limit 是 30，改了这个数字
  // 结果条数会静默变化，而页面上「少了几条」根本看不出来。
  expect(await mock.lastArgs('search_notes')).toEqual({ query: '知识', limit: 30 })
  await expect(page.locator('.search-hit')).toHaveCount(2)
})

test('防抖生效：连打三个字符只发一次搜索', async ({ page }) => {
  const mock = await openApp(page, { notes: NOTES })

  await openPanel(page)
  // 每个字符间隔 40ms，三个字符全落在 120ms 的防抖窗口里。
  // 没有防抖的话这里会是 3 次请求，而且回来的顺序不保证——
  // 慢的旧请求会盖掉快的新结果。
  await page.locator('.search-input').pressSequentially('知识图', { delay: 40 })
  await page.waitForTimeout(1_000)

  const searches = await mock.callsTo('search_notes')
  expect(searches.length).toBeLessThan(3)
  // 而且发出去的是完整的最终关键词，不是打到一半的前缀
  expect(searches[searches.length - 1]?.args.query).toBe('知识图')
})

test('字面命中：matched_terms 里的词被高亮', async ({ page }) => {
  const mock = await openApp(page, { notes: NOTES })
  await mock.setSearchHits([
    {
      note_id: 1,
      uuid: 'uuid-1',
      title: '知识图谱构建',
      excerpt: '先谈知识，再谈图谱。',
      matched_terms: ['知识'],
      source: 'Literal',
    },
  ])

  await openPanel(page)
  await page.locator('.search-input').fill('知识')

  const marks = page.locator('.search-hit mark')
  await expect(marks.first()).toBeVisible()
  // 高亮的只能是命中词本身。标题和摘要里各有一处「知识」，一共两处。
  await expect(marks).toHaveCount(2)
  for (const text of await marks.allTextContents()) expect(text).toBe('知识')
  await expect(page.locator('.search-hit-source')).toHaveText('字面')
})

test('拼音命中不高亮，且来源标成「全拼」', async ({ page }) => {
  // 拼音串在原文里根本不存在，没法定位。后端因此返回空的 matched_terms，
  // 前端必须整段不高亮——给一个定位不到的串，或者退而求其次拿标点凑数，
  // 结果就是把不相干的文字刷成一片高亮。
  const mock = await openApp(page, { notes: NOTES })
  await mock.setSearchHits([
    {
      note_id: 1,
      uuid: 'uuid-1',
      title: '知识图谱构建',
      excerpt: '先谈知识，再谈图谱。',
      matched_terms: [],
      source: 'PinyinFull',
    },
  ])

  await openPanel(page)
  await page.locator('.search-input').fill('zhishitupu')

  await expect(page.locator('.search-hit')).toHaveCount(1)
  await expect(page.locator('.search-hit mark')).toHaveCount(0)
  await expect(page.locator('.search-hit-source')).toHaveText('全拼')
  // 原文一个字不少地显示出来了，只是没有高亮
  await expect(page.locator('.search-hit-excerpt')).toHaveText('先谈知识，再谈图谱。')
})

test('键盘导航：↓ 之后回车打开的是第二条结果', async ({ page }) => {
  const mock = await openApp(page, { notes: NOTES })

  await openPanel(page)
  await page.locator('.search-input').fill('知识')
  await expect(page.locator('.search-hit')).toHaveCount(2)

  // mock 的检索按 updated_at DESC, id DESC 排，所以第二条是 note 1
  const second = await page.locator('.search-hit').nth(1).getAttribute('data-index')
  expect(second).toBe('1')

  await page.keyboard.press('ArrowDown')
  await expect(page.locator('.search-hit.active')).toHaveAttribute('data-index', '1')
  await page.keyboard.press('Enter')

  await expect(page.locator('.search-panel')).toHaveCount(0)
  await expect
    .poll(async () => (await mock.callsTo('get_note')).length, { timeout: 5_000 })
    .toBeGreaterThan(0)
  expect(await mock.lastArgs('get_note')).toEqual({ id: 1 })
})

test('Esc 关闭面板', async ({ page }) => {
  await openApp(page, { notes: NOTES })

  await openPanel(page)
  await page.keyboard.press('Escape')
  await expect(page.locator('.search-panel')).toHaveCount(0)
})

test('空关键词不发请求', async ({ page }) => {
  const mock = await openApp(page, { notes: NOTES })

  await openPanel(page)
  await page.locator('.search-input').fill('   ')
  await page.waitForTimeout(600)

  // 空表达式喂给 FTS5 会匹配到全部记录，这一步必须在前端就挡掉
  expect(await mock.callsTo('search_notes')).toHaveLength(0)
  await expect(page.locator('.search-empty')).toHaveCount(0)
})

test('搜索失败时报错，不装作没有命中', async ({ page }) => {
  const mock = await openApp(page, { notes: NOTES })
  await mock.failCommand('search_notes', '数据库错误: no such table: notes_fts')

  await openPanel(page)
  await page.locator('.search-input').fill('知识')

  await expect(page.locator('.search-error')).toContainText('notes_fts')
  // 「没有命中」和「搜不了」是两回事，混在一起用户会以为库里真的没有这条笔记
  await expect(page.locator('.search-empty')).toHaveCount(0)
})
