// 自动更新的界面。这一组守的是**两种触发方式的反馈必须不一样**这件事：
//
// - 启动时是静默检查。没有新版什么都不显示；查询失败**也**什么都不显示。
//   启动那一刻网络不通是常态，为此弹一条错误横幅，用户每天开机都要关一次。
// - 手动检查每一种结果都要说话。用户主动点了却什么都没变，他分不清是
//   「已经最新」还是「按钮坏了」，只会再点几次。
//
// 另一条是下载：进度和失败必须落到界面上。本项目在「粘贴图片失败静默」上
// 已经吃过一次亏——失败只进 console，用户看到的是「点了没反应」。

import { openApp, test, expect } from './fixtures'
import { availableUpdate, note } from './mock/state'

const NOTES = [note(1, '一条笔记')]

async function openSettings(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: '设置' }).click()
  await expect(page.locator('.settings-panel')).toBeVisible()
}

test('启动时没有新版：页面上不出现任何更新提示', async ({ page }) => {
  const mock = await openApp(page, { notes: NOTES })

  // 检查确实发生了——否则下面那条「什么都没显示」会因为「压根没查」而假绿。
  await expect
    .poll(async () => (await mock.callsTo('plugin:updater|check')).length, { timeout: 5_000 })
    .toBeGreaterThan(0)

  await expect(page.locator('.update-banner')).toHaveCount(0)
  // 「已是最新版本」这句话在主窗口里一次都不该出现
  await expect(page.getByText('已是最新版本')).toHaveCount(0)
})

test('启动时查询失败：仍然什么都不显示', async ({ page }) => {
  const mock = await openApp(page, {
    notes: NOTES,
    failCommands: { 'plugin:updater|check': '更新源不可达: error sending request' },
  })

  await expect
    .poll(async () => (await mock.callsTo('plugin:updater|check')).length, { timeout: 5_000 })
    .toBeGreaterThan(0)

  await expect(page.locator('.update-banner')).toHaveCount(0)
  // 底部那条通用错误栏也不许被这件事点亮
  await expect(page.locator('.error-bar')).toHaveCount(0)
})

test('启动时有新版：出现横幅，带上新旧两个版本号', async ({ page }) => {
  await openApp(page, {
    notes: NOTES,
    appVersion: '0.1.0',
    update: availableUpdate('0.1.1'),
  })

  const banner = page.locator('.update-banner')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('0.1.1')
  // 只说「有新版」不说当前版本，用户没法判断这一跳到底跨了多远
  await expect(banner).toContainText('0.1.0')
  await expect(banner.getByRole('button', { name: '更新' })).toBeVisible()
})

test('横幅点「稍后」就收起来，不再回来', async ({ page }) => {
  await openApp(page, { notes: NOTES, update: availableUpdate('0.1.1') })

  const banner = page.locator('.update-banner')
  await expect(banner).toBeVisible()
  await banner.getByRole('button', { name: '稍后' }).click()
  await expect(banner).toHaveCount(0)

  // 「稍后」之后又自己冒出来，比一开始就不让关还烦人
  await page.waitForTimeout(500)
  await expect(banner).toHaveCount(0)
})

test('点更新：下载进度看得见，装完请求重启', async ({ page }) => {
  const mock = await openApp(page, {
    notes: NOTES,
    // 分块之间留出间隔，好让进度真的能被观察到
    update: availableUpdate('0.1.1', { chunkDelayMs: 250 }),
  })

  const banner = page.locator('.update-banner')
  await banner.getByRole('button', { name: '更新' }).click()

  // 百分比必须出现在界面上。只进 console 的进度等于没有进度。
  await expect(banner).toContainText('正在下载')
  await expect(banner).toContainText('%')
  await expect(banner).toContainText('MB')

  await expect(banner).toContainText('正在重启应用', { timeout: 10_000 })
  // 装完必须真的请求重启：不重启的话新版本要到用户下次自己开应用才生效，
  // 而界面已经说「更新完成」了。
  expect(await mock.callsTo('plugin:process|restart')).toHaveLength(1)
})

test('下载失败：错误摆在横幅上，并且能重试', async ({ page }) => {
  const mock = await openApp(page, { notes: NOTES, update: availableUpdate('0.1.1') })
  await mock.failCommand('plugin:updater|download_and_install', '签名校验失败: invalid signature')

  const banner = page.locator('.update-banner')
  await banner.getByRole('button', { name: '更新' }).click()

  await expect(banner.locator('.update-error')).toContainText('签名校验失败')
  // 「检查更新失败」与「更新失败」是两回事：前者多半是网络，后者是包装不上。
  await expect(banner.locator('.update-error')).toContainText('更新失败')
  await expect(banner.locator('.update-error')).not.toContainText('检查更新失败')

  // 失败之后必须留一条出路，否则用户只能重启应用再试
  await mock.clearFailure('plugin:updater|download_and_install')
  await banner.getByRole('button', { name: '重试' }).click()
  await expect(banner).toContainText('正在重启应用', { timeout: 10_000 })
})

test('设置面板显示当前版本号', async ({ page }) => {
  // 发版验证的最后一步就是「重启后在设置面板里确认版本号变了」，
  // 这个数字读不出来，整条更新链路就没法收尾。
  await openApp(page, { notes: NOTES, appVersion: '0.2.3' })

  await openSettings(page)
  await expect(page.locator('.update-settings')).toContainText('0.2.3')
})

test('手动检查、已是最新：明确说出来，并带上版本号', async ({ page }) => {
  const mock = await openApp(page, { notes: NOTES, appVersion: '0.1.0' })

  await openSettings(page)
  await page.getByRole('button', { name: '检查更新' }).click()

  // 手动点了却没任何反应是最让人困惑的交互
  await expect(page.locator('.update-status')).toHaveText('已是最新版本（0.1.0）')
  expect((await mock.callsTo('plugin:updater|check')).length).toBeGreaterThan(1)
})

test('手动检查失败：错误必须可见', async ({ page }) => {
  // 同一次运行里两种触发都覆盖到了：启动那次静默咽掉，手动这次必须说话。
  await openApp(page, {
    notes: NOTES,
    failCommands: { 'plugin:updater|check': '更新源不可达: error sending request' },
  })

  await expect(page.locator('.update-banner')).toHaveCount(0)

  await openSettings(page)
  await page.getByRole('button', { name: '检查更新' }).click()

  const status = page.locator('.update-settings .update-error')
  await expect(status).toContainText('检查更新失败')
  await expect(status).toContainText('error sending request')
})

test('手动检查发现新版：面板里给版本号、更新说明和安装按钮', async ({ page }) => {
  const mock = await openApp(page, { notes: NOTES })

  await openSettings(page)
  // 面板打开之后更新源才有新版本，所以这一条只可能是手动那次查到的
  await mock.setUpdate(availableUpdate('0.9.0', { notes: '修好了粘贴图片失败不提示的问题' }))
  await page.getByRole('button', { name: '检查更新' }).click()

  const section = page.locator('.update-settings')
  await expect(section).toContainText('发现新版本 0.9.0')
  await expect(section).toContainText('修好了粘贴图片失败不提示的问题')
  await expect(section.getByRole('button', { name: '下载并安装' })).toBeVisible()

  expect(await mock.callsTo('plugin:updater|download_and_install')).toHaveLength(0)
})
