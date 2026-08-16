// 自动保存的数据安全场景。这一组是整个测试栈最有价值的部分——手工几乎复现不了，
// 而且它们守的都是**调用形状**，不是页面外观：断言页面长什么样，这里每一条
// 都能在应用坏掉的情况下照样通过。

import { openApp, overlaps, test, expect, typeInEditor } from './fixtures'
import { note } from './mock/state'

/// 一段带图片的正文：一个段落 + 一个 attachmentImage 节点（附件 id = 7）。
const DOC_WITH_IMAGE = JSON.stringify({
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: '带图的笔记' }] },
    { type: 'attachmentImage', attrs: { attachmentId: 7 } },
  ],
})

test('自动保存把正文里的附件 id 一并传回后端', async ({ page }) => {
  // 守的是曾经真实发生过的数据丢失：update_note 会整表替换 note_attachments，
  // 漏传 attachmentIds 等于把图片解绑，下一轮 collect_garbage 就把文件真删了，
  // 正文里只剩「图片已丢失」。页面在那一刻看起来完全正常。
  const mock = await openApp(page, {
    notes: [note(1, '带图的笔记', { body_json: DOC_WITH_IMAGE, attachment_ids: [7] })],
  })

  await page.locator('.note-item', { hasText: '带图的笔记' }).click()
  await expect(page.locator('.editor .attachment-image')).toBeVisible()

  await typeInEditor(page, '补充')

  await expect
    .poll(async () => (await mock.callsTo('update_note')).length, { timeout: 5_000 })
    .toBeGreaterThan(0)

  const args = await mock.lastArgs('update_note')
  expect(args?.attachmentIds).toEqual([7])
  // 正文确实带着那个节点一起存回去了，附件 id 不是从别处硬凑的
  expect(String(args?.bodyJson)).toContain('attachmentImage')

  // 假存储里的关联关系也没被解开
  const [stored] = (await mock.notes()) as { attachment_ids: number[] }[]
  expect(stored?.attachment_ids).toEqual([7])
})

test('附件读取走的是 ArrayBuffer 而不是数组', async ({ page }) => {
  // read_attachment 是前端仅有的两个绕开 toCamel 的命令之一。真实实现走 raw 通道
  // 返回 ArrayBuffer；假实现要是图省事返回数组，`new Uint8Array(buffer)` 会静默
  // 得到一个空视图，blob 里一个字节都没有，而 <img> 只是不显示、不报错。
  const mock = await openApp(page, {
    notes: [note(1, '带图的笔记', { body_json: DOC_WITH_IMAGE, attachment_ids: [7] })],
  })

  await page.locator('.note-item', { hasText: '带图的笔记' }).click()

  const image = page.locator('.editor .attachment-image img')
  await expect(image).toBeVisible()
  // 图片真的解码了才有非零的 naturalWidth——字节没传到的话这里是 0
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)
  await expect(page.locator('.attachment-missing')).toHaveCount(0)

  expect(await mock.lastArgs('read_attachment')).toEqual({ id: 7 })
})

test('保存失败后切换笔记，未落盘的内容不会消失', async ({ page }) => {
  const mock = await openApp(page, { notes: [note(1, '第一条'), note(2, '第二条')] })

  await page.locator('.note-item', { hasText: '第一条' }).click()
  await mock.failCommand('update_note', '数据库错误: database is locked')
  await typeInEditor(page, '要保住的内容')

  // 等错误浮现，确认那次保存真的失败了（不然下面测的就是另一回事）
  await expect(page.locator('.error-bar')).toBeVisible({ timeout: 5_000 })
  await expect(page.locator('.error-bar')).toContainText('database is locked')
  // 状态栏不许在这时候谎报「已保存」
  await expect(page.locator('.workspace-status')).not.toHaveText('已保存')

  // 恢复后切到另一条再切回来，内容必须还在
  await mock.clearFailure('update_note')
  await page.locator('.note-item', { hasText: '第二条' }).click()
  await expect(page.locator('.editor')).toContainText('第二条')

  await page.locator('.note-item', { hasText: '要保住的内容' }).click()
  await expect(page.locator('.editor')).toContainText('要保住的内容')

  // 而且它是真的落盘了，不只是留在编辑器里
  const stored = (await mock.notes()) as { id: number; body_text: string }[]
  expect(stored.find((n) => n.id === 1)?.body_text).toContain('要保住的内容')
})

test('保存失败不会把别的笔记的内容写进这一条', async ({ page }) => {
  // 800ms 防抖窗口内切走笔记，定时器落地时若读的是闭包里的 id，
  // 就会把新笔记的正文写进旧笔记——一次静默的串号。
  const mock = await openApp(page, { notes: [note(1, '第一条'), note(2, '第二条')] })

  await page.locator('.note-item', { hasText: '第一条' }).click()
  await typeInEditor(page, 'AAA')
  // 不等防抖到点就切走
  await page.locator('.note-item', { hasText: '第二条' }).click()
  await expect(page.locator('.editor')).toContainText('第二条')
  await typeInEditor(page, 'BBB')

  await expect
    .poll(async () => (await mock.callsTo('update_note')).length, { timeout: 5_000 })
    .toBeGreaterThanOrEqual(2)

  const saves = await mock.callsTo('update_note')
  for (const save of saves) {
    const body = String(save.args.bodyJson)
    if (save.args.id === 1) {
      expect(body).toContain('AAA')
      expect(body).not.toContain('BBB')
    } else {
      expect(body).toContain('BBB')
      expect(body).not.toContain('AAA')
    }
  }
})

test('保存很慢时不会并发写同一条笔记', async ({ page }) => {
  // 时序敏感：mock 里给 update_note 挂了 1.5 秒延迟，一整轮要跑好几秒。
  test.slow()

  const mock = await openApp(page, { notes: [note(1, '原文')] })

  await page.locator('.note-item', { hasText: '原文' }).click()
  await mock.setDelay('update_note', 1_500)

  await typeInEditor(page, '第一批')
  // 等第一次保存真的发出去并且还在途中，再敲第二批——这样才构造得出竞态
  await expect
    .poll(async () => (await mock.callsTo('update_note')).length, { timeout: 5_000 })
    .toBe(1)
  await typeInEditor(page, '第二批')

  // 等到最新内容真的落进假存储为止。
  // 注意不能等「最后一次 update_note 的参数里有第二批」——调用是在 invoke 进来的
  // 那一刻就记下的，而它要 1.5 秒后才落地，那样等出来的是「发出去了」而不是「写进去了」。
  // 用 poll 只是把固定 sleep 换成条件等待，断言本身一个字没松。
  await expect
    .poll(
      async () => {
        const [current] = (await mock.notes()) as { body_text: string }[]
        return current?.body_text ?? ''
      },
      { timeout: 20_000 },
    )
    .toContain('第二批')

  const saves = await mock.callsTo('update_note')
  // 串行化生效的话，任意时刻只有一个 update_note 在途——这是这条测试的全部意义。
  // 重叠意味着两次写同一条笔记的落地顺序不可控，旧内容可能盖掉新内容。
  expect(overlaps(saves)).toBe(false)
  expect(String(saves[saves.length - 1]?.args.bodyJson)).toContain('第二批')

  // 落盘的结果里两批内容都在，一个都没被覆盖掉
  const [stored] = (await mock.notes()) as { body_text: string }[]
  expect(stored?.body_text).toContain('第一批')
})

/// 保存失败后的重试退避档位，抄自 App.tsx 的 `SAVE_RETRY_BASE_MS`。
/// 「一次都没重试」这种断言必须等过这个窗口才算数，否则等于什么都没验。
const SAVE_RETRY_BASE_MS = 1_500

test('删掉正在保存的那条笔记，不会把它又写回去', async ({ page }) => {
  test.slow()

  const mock = await openApp(page, { notes: [note(1, '要删掉的')] })

  await page.locator('.note-item', { hasText: '要删掉的' }).click()
  // 在途窗口开到 2 秒。这条测试要构造的是「删除发生在保存落地之前」，
  // 窗口越窄越靠运气——原来是 1 秒，macOS CI 上偶尔就先失败后删除了。
  await mock.setDelay('update_note', 2_000)
  await mock.failCommand('update_note', '数据库错误: disk I/O error')
  await typeInEditor(page, '编辑中')

  // 等到这次保存**发出去并且还在途中**（settledAt 仍是 null）。
  //
  // 原来只等「发出去了」，而 expect.poll 的默认间隔是 100/250/500/1000ms：
  // 防抖稍微晚一点点撞过某个刻度，下一次回头看就是将近一秒之后——那时保存
  // 已经失败落地，abandonedRef 那条路根本没走到，测的就成了另一个场景
  // （先失败后删除：红条弹出来，而删除又顺手取消了重试定时器，
  // 于是「只调用一次」照样成立、只有 `.error-bar` 那条红——正是 CI 上看到的样子）。
  await expect
    .poll(
      async () => {
        const [first] = await mock.callsTo('update_note')
        return first === undefined ? '还没发出去' : first.settledAt === null ? '在途' : '已落地'
      },
      { timeout: 10_000, intervals: [50] },
    )
    .toBe('在途')

  // 在途期间把这条笔记删掉。列表上的标题仍是「要删掉的」——那次保存失败了，
  // 列表压根没重拉过，这本身就是「保存失败时界面不许假装存上了」的一个侧证。
  await page.locator('.note-item', { hasText: '要删掉的' }).getByRole('button').click()
  await expect(page.locator('.note-item')).toHaveCount(0)

  const [save] = await mock.callsTo('update_note')
  const [remove] = await mock.callsTo('delete_note')

  // 前提复核。这不是被守的行为，是这条测试成立的前提：删除必须发生在那次保存
  // 落地之前。前提没成立时下面两条断言验的是另一个场景，与其让它们以「红条不该在」
  // 这种看不出所以然的方式红掉，不如在这里把话说明白。
  expect(remove, '删除请求没发出去，前提就不成立').toBeDefined()
  expect(
    save?.settledAt === null || (save?.settledAt ?? 0) > (remove?.startedAt ?? 0),
    '删除必须发生在那次保存落地之前，否则构造出来的是「先失败后删除」，不是本测试的场景',
  ).toBe(true)

  // 等那次保存真的**失败落地**——mock 只在结果落地时才写 settledAt，
  // 它从 null 变成数字的那一刻，就是 reject 递到应用手里的那一刻。
  // 比「大概过了几秒」精确，机器快慢也影响不到。
  await expect
    .poll(async () => (await mock.callsTo('update_note'))[0]?.settledAt, {
      timeout: 15_000,
      intervals: [50],
    })
    .not.toBeNull()

  // 失败已经递到应用手里了。走错路的实现会做两件事：把错误摆上红条（同步 setState，
  // 一个渲染 tick 就到），并按 SAVE_RETRY_BASE_MS 排一次重试（1.5 秒后）。
  //
  // 「不该发生的事」没有可以 poll 的正向信号，只能把那个窗口走完再看。但等待不再是
  // 拍脑袋的 4 秒墙钟：起点是上面确认过的「失败已落地」，长度来自应用自己的退避常量，
  // 而且走的是**页面自己的时钟**（performance.now()，和 mock 记 settledAt、
  // 和重试的 setTimeout 用的是同一把尺子）——页面被卡住时这个等待跟着一起延后，
  // 不会出现「测试等够了、页面其实还没走到」这种慢机器上的假绿。
  const failedAt = (await mock.callsTo('update_note'))[0]?.settledAt ?? 0
  await page.waitForFunction(
    (deadline) => performance.now() >= deadline,
    failedAt + SAVE_RETRY_BASE_MS * 2,
  )

  // 失败的那次不该被重试到一条已经不存在的笔记上，也不该弹红条吓人
  expect(await mock.callsTo('update_note')).toHaveLength(1)
  await expect(page.locator('.error-bar')).toHaveCount(0)
})
