// 回收站。这里最要紧的一条是「彻底删除是两步确认」——按钮一旦武装好就是
// 不可撤销的，武装态什么时候该退回去，比它长什么样重要得多。

import { openApp, test, expect } from './fixtures'
import { note } from './mock/state'

const DELETED = [
  note(1, '被删掉的第一条', { deleted_at: 5_000, updated_at: 5_000 }),
  note(2, '被删掉的第二条', { deleted_at: 6_000, updated_at: 6_000 }),
]

async function openTrash(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: '回收站' }).click()
  await expect(page.locator('.trash-panel')).toBeVisible()
}

test('打开回收站列出已删除的笔记', async ({ page }) => {
  const mock = await openApp(page, { notes: [...DELETED, note(3, '还活着的笔记')] })

  await openTrash(page)

  await expect(page.locator('.trash-item')).toHaveCount(2)
  // 按 deleted_at DESC 排：后删的在前
  await expect(page.locator('.trash-item .search-hit-title').first()).toHaveText('被删掉的第二条')
  // 活着的笔记不该混进来
  await expect(page.locator('.trash-panel')).not.toContainText('还活着的笔记')

  const calls = await mock.callsTo('list_deleted_notes')
  expect(calls).not.toHaveLength(0)
  expect(calls[0]?.args).toMatchObject({ limit: 50, offset: 0 })
})

test('恢复：id 正确、面板关闭、主列表出现该笔记', async ({ page }) => {
  const mock = await openApp(page, { notes: DELETED })

  await openTrash(page)
  await page
    .locator('.trash-item', { hasText: '被删掉的第一条' })
    .getByRole('button', { name: '恢复' })
    .click()

  await expect
    .poll(async () => (await mock.callsTo('restore_note')).length, { timeout: 5_000 })
    .toBe(1)
  expect(await mock.lastArgs('restore_note')).toEqual({ id: 1 })

  // 恢复后回到主列表，不是留在回收站里
  await expect(page.locator('.trash-panel')).toHaveCount(0)
  await expect(page.locator('.note-item', { hasText: '被删掉的第一条' })).toBeVisible()
  await expect(page.locator('.sidebar-notice')).toContainText('已恢复')
})

test('清空回收站是两步确认', async ({ page }) => {
  const mock = await openApp(page, { notes: DELETED })

  await openTrash(page)

  // 第一次点只是武装，一次 IPC 都不该发出去
  await page.getByRole('button', { name: '清空回收站' }).click()
  expect(await mock.callsTo('purge_all_deleted')).toHaveLength(0)
  await expect(page.getByRole('button', { name: '确认清空（不可恢复）' })).toBeVisible()
  await expect(page.locator('.trash-item')).toHaveCount(2)

  // 第二次点才真的执行
  await page.getByRole('button', { name: '确认清空（不可恢复）' }).click()
  await expect
    .poll(async () => (await mock.callsTo('purge_all_deleted')).length, { timeout: 5_000 })
    .toBe(1)
  await expect(page.locator('.trash-item')).toHaveCount(0)
  // 主列表和标签也得跟着刷新：那两条笔记从库里真的没了
  expect((await mock.callsTo('list_notes')).length).toBeGreaterThan(1)
})

test('武装好的「清空」可以取消，取消之后再点是重新武装而不是直接执行', async ({ page }) => {
  const mock = await openApp(page, { notes: DELETED })

  await openTrash(page)
  await page.getByRole('button', { name: '清空回收站' }).click()
  await page.getByRole('button', { name: '取消' }).click()

  await expect(page.getByRole('button', { name: '清空回收站' })).toBeVisible()
  await page.getByRole('button', { name: '清空回收站' }).click()
  // 这一下只该重新武装。少了这条，「取消」就成了摆设：
  // 点完取消再点一次清空，回收站就空了。
  expect(await mock.callsTo('purge_all_deleted')).toHaveLength(0)
  await expect(page.getByRole('button', { name: '确认清空（不可恢复）' })).toBeVisible()
})

test('去干别的事会让武装态失效', async ({ page }) => {
  const mock = await openApp(page, { notes: DELETED })

  await openTrash(page)
  await page.getByRole('button', { name: '清空回收站' }).click()
  await expect(page.getByRole('button', { name: '确认清空（不可恢复）' })).toBeVisible()

  // 中途去彻底删了单独一条
  await page
    .locator('.trash-item', { hasText: '被删掉的第一条' })
    .getByRole('button', { name: '彻底删除' })
    .click()

  await expect
    .poll(async () => (await mock.callsTo('purge_note')).length, { timeout: 5_000 })
    .toBe(1)
  expect(await mock.lastArgs('purge_note')).toEqual({ id: 1 })

  // 不能让一个武装好的不可逆按钮在旁边等着下一次误点
  await expect(page.getByRole('button', { name: '清空回收站' })).toBeVisible()
  expect(await mock.callsTo('purge_all_deleted')).toHaveLength(0)
})

test('彻底删除之后要说清楚附件不会立刻消失', async ({ page }) => {
  // 附件回收有宽限期，删完去看目录文件还在。不说这句用户会以为删除没生效，
  // 转头去手删文件——那才是真的丢数据。
  await openApp(page, { notes: DELETED })

  await openTrash(page)
  await page.getByRole('button', { name: '清空回收站' }).click()
  await page.getByRole('button', { name: '确认清空（不可恢复）' }).click()

  await expect(page.locator('.trash-notice')).toContainText('附件')
  await expect(page.locator('.trash-notice')).toContainText('彻底删除 2 条')
})

test('回收站是空的时候说人话', async ({ page }) => {
  await openApp(page, { notes: [note(1, '还活着的笔记')] })

  await openTrash(page)
  await expect(page.locator('.search-empty')).toContainText('回收站是空的')
  // 空的时候「清空回收站」必须是禁用的
  await expect(page.getByRole('button', { name: '清空回收站' })).toBeDisabled()
})

test('恢复失败时不关面板、不谎报成功', async ({ page }) => {
  const mock = await openApp(page, { notes: DELETED })
  await mock.failCommand('restore_note', '笔记不存在: 1')

  await openTrash(page)
  await page
    .locator('.trash-item', { hasText: '被删掉的第一条' })
    .getByRole('button', { name: '恢复' })
    .click()

  await expect(page.locator('.search-error')).toContainText('笔记不存在')
  await expect(page.locator('.trash-panel')).toBeVisible()
  await expect(page.locator('.trash-item')).toHaveCount(2)
  await expect(page.locator('.sidebar-notice')).toHaveCount(0)
})
