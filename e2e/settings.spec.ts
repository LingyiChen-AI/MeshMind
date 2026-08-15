// 设置面板。三项设置都会**真的动系统**（注册全局热键、切 Dock 图标、写自启项），
// 失败率不低，所以这里最要紧的是「失败之后界面显示的仍是真实状态」——
// 显示成功了但实际没生效，是这一块最坏的一种谎报：用户从此以为热键能用，
// 直到某天需要它的时候才发现按下去没反应。

import { openApp, test, expect } from './fixtures'

/// 预置一个确定的热键，避免依赖平台默认值（mac 是 Alt+Space，其余是 Ctrl+Alt+Space）。
const SETTINGS = {
  'hotkey.capture': 'Control+Alt+P',
  'startup.autostart': 'true',
}

async function openSettings(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: '设置' }).click()
  await expect(page.locator('.settings-panel')).toBeVisible()
}

test('get_settings 的点号键不被 camel 化，设置才读得出来', async ({ page }) => {
  // 这是前端第二个刻意绕开 toCamel 的命令。返回的是一张 map，键是设置项名
  // （`macos.hide_dock_icon`）而不是结构体字段名；被 camel 化成
  // `macos.hideDockIcon` 之后取值全是 undefined，界面上的表现是
  // 「所有设置都是默认值，改完刷新又变回去」。
  await openApp(page, { settings: SETTINGS })

  await openSettings(page)
  await expect(page.locator('.settings-raw')).toHaveText('Control+Alt+P')
  await expect(page.locator('.settings-item', { hasText: '开机自启' }).locator('input')).toBeChecked()
})

test('热键改键成功后落到后端的是规范化后的字符串', async ({ page }) => {
  const mock = await openApp(page, { settings: SETTINGS })

  await openSettings(page)
  await page.getByRole('button', { name: '修改' }).click()
  await expect(page.getByRole('button', { name: '按下组合键…' })).toBeVisible()

  await page.keyboard.press('Control+Shift+K')

  await expect
    .poll(async () => (await mock.callsTo('set_capture_hotkey')).length, { timeout: 5_000 })
    .toBe(1)
  // 修饰键顺序必须是规范的 Control → Alt → Shift → Command，
  // 否则同一个组合按两次会得到两个「不一样」的热键字符串。
  expect(await mock.lastArgs('set_capture_hotkey')).toEqual({ accelerator: 'Control+Shift+K' })

  await expect(page.locator('.settings-raw')).toHaveText('Control+Shift+K')
  await expect(page.locator('.trash-notice')).toContainText('快捕热键已改为')
})

test('只按修饰键不会提前把半个组合发出去', async ({ page }) => {
  const mock = await openApp(page, { settings: SETTINGS })

  await openSettings(page)
  await page.getByRole('button', { name: '修改' }).click()
  await page.keyboard.down('Control')
  await page.keyboard.down('Shift')
  await page.waitForTimeout(300)

  expect(await mock.callsTo('set_capture_hotkey')).toHaveLength(0)
  await expect(page.getByRole('button', { name: '按下组合键…' })).toBeVisible()

  await page.keyboard.up('Shift')
  await page.keyboard.up('Control')
})

test('不带 Ctrl/Alt/Cmd 的组合当场就被挡掉，不发给外壳', async ({ page }) => {
  // 全局热键抢在所有应用之前生效，光一个字母会把日常打字里的这个键整个吞掉。
  const mock = await openApp(page, { settings: SETTINGS })

  await openSettings(page)
  await page.getByRole('button', { name: '修改' }).click()
  await page.keyboard.press('Shift+K')

  // 按内容挑那一条：Dock 那一节也有一条 .settings-warn，而且它的正文里同样出现
  // 「快捕热键」四个字，按 section 过滤是筛不开的。
  const warn = page.locator('.settings-warn', { hasText: '热键至少要带' })
  await expect(warn).toBeVisible()
  // 提示里得说清楚被拒的是哪个组合，只说「不行」用户不知道自己按了什么
  await expect(warn).toContainText('Shift+K')
  expect(await mock.callsTo('set_capture_hotkey')).toHaveLength(0)
  // 还留在录制态，让用户直接再按一次
  await expect(page.getByRole('button', { name: '按下组合键…' })).toBeVisible()
})

test('热键改键失败后 UI 回滚到原来那个键', async ({ page }) => {
  const mock = await openApp(page, { settings: SETTINGS })
  await mock.failCommand(
    'set_capture_hotkey',
    '全局热键「Control+Shift+K」注册失败：已被其它应用占用，原热键保持不变。',
  )

  await openSettings(page)
  await page.getByRole('button', { name: '修改' }).click()
  await page.keyboard.press('Control+Shift+K')

  await expect(page.locator('.search-error')).toContainText('已被其它应用占用')
  // 面板上显示的必须仍是原来那个键。显示成新键 = 界面说改成功了、系统上还是旧的，
  // 用户按新键没反应，还完全不知道该按什么。
  await expect(page.locator('.settings-raw')).toHaveText('Control+Alt+P')
  await expect(page.locator('.trash-notice')).toHaveCount(0)
})

test('开机自启开关失败后回到原位', async ({ page }) => {
  const mock = await openApp(page, { settings: SETTINGS })
  await mock.failCommand('set_autostart', '写入自启项失败：权限不足')

  await openSettings(page)
  const toggle = page.locator('.settings-item', { hasText: '开机自启' }).locator('input')
  await expect(toggle).toBeChecked()

  // 用 click 而不是 uncheck()：uncheck() 会断言点完之后状态真的变了，
  // 而这里**不变**才是对的——面板刻意不做乐观更新，等命令回来才认。
  await toggle.click()

  await expect
    .poll(async () => (await mock.callsTo('set_autostart')).length, { timeout: 5_000 })
    .toBe(1)
  expect(await mock.lastArgs('set_autostart')).toEqual({ enabled: false })

  await expect(page.locator('.search-error')).toContainText('权限不足')
  // 外壳在失败路径上不会改系统状态，界面保持旧值才是真实状态
  await expect(toggle).toBeChecked()
})

test('设置读不出来时给一个重试入口，而不是一片空白', async ({ page }) => {
  const mock = await openApp(page)
  await mock.failCommand('get_settings', '数据库错误: unable to open database file')

  await openSettings(page)
  await expect(page.locator('.search-error')).toContainText('unable to open database file')
  await expect(page.getByRole('button', { name: '重试' })).toBeVisible()

  await mock.clearFailure('get_settings')
  await page.getByRole('button', { name: '重试' }).click()
  await expect(page.locator('.settings-raw')).toBeVisible()
})

test.describe('macOS', () => {
  test.use({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  })

  test('macOS 上显示 Dock 开关，切换走的是专用命令', async ({ page }) => {
    const mock = await openApp(page, { settings: SETTINGS })

    await openSettings(page)
    const toggle = page.locator('.settings-item', { hasText: '隐藏 Dock 图标' }).locator('input')
    await expect(toggle).toBeVisible()

    await toggle.check()
    await expect
      .poll(async () => (await mock.callsTo('set_hide_dock_icon')).length, { timeout: 5_000 })
      .toBe(1)
    // 必须走专用命令而不是通用的 set_setting：只写库的话，库里是新值、
    // 系统上还是旧行为，而且没有任何报错。
    expect(await mock.lastArgs('set_hide_dock_icon')).toEqual({ hide: true })
    expect(await mock.callsTo('set_setting')).toHaveLength(0)
  })
})

test.describe('非 macOS', () => {
  test.use({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  })

  test('Windows 上不渲染 Dock 开关', async ({ page }) => {
    // 外壳在非 macOS 上只落库、什么也不做，摆一个点了没效果的开关是纯误导。
    await openApp(page, { settings: SETTINGS })

    await openSettings(page)
    await expect(page.locator('.settings-item', { hasText: '隐藏 Dock 图标' })).toHaveCount(0)
    // 另外两项照常在
    await expect(page.locator('.settings-raw')).toHaveText('Control+Alt+P')
    await expect(page.locator('.settings-item', { hasText: '开机自启' })).toBeVisible()
  })
})
