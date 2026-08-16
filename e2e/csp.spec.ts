// CSP 违规守卫：把 `tauri.conf.json` 里那份**生产** CSP 真的挂到文档响应头上，
// 再走一遍关键流程，断言全程零违规。
//
// 为什么值得单独一组测试：CSP 写错的表现是「某一类资源静默不加载」——图片变裂图、
// 某个面板空白、字体退化——页面既不白屏也不报错到用户眼前，只在 devtools 控制台里
// 留一行红字。手工验证时很容易看漏，而且策略每收紧一次就要把整个应用重走一遍。
//
// 策略**从配置文件读**（`crates/shell/tauri.conf.json` → `app.security.csp`），
// 不在测试里抄第二份：抄一份就会漂移，改了配置而测试还在验旧策略，是比没有测试
// 更坏的结果。
//
// ## 这份守卫**验不到**什么（务必先读完再决定要不要省掉人工验证）
//
// 1. **Tauri 注入到真实 webview 的初始化脚本**。真实运行时 Tauri 会往页面里注入
//    `__TAURI_INTERNALS__` 的引导脚本、IPC 桥、以及各插件的初始化代码；Playwright
//    这边跑的是 vite dev server，那些脚本一行都不存在（假 IPC 是 `addInitScript`
//    塞进去的，走的是 CDP 而不是页面里的 `<script>`，不受 CSP 管辖）。
//    真实注入脚本被 `script-src 'self'` 挡下来的可能性，这里测不出来。
// 2. **`connect-src` 里的 `ipc:` 与 `http://ipc.localhost`**。假 IPC 是一个内存函数，
//    根本不发网络请求，所以这两项在这里既不会被用到、也不会被验证。真实 IPC 走的是
//    自定义协议，它是否被 `connect-src` 放行，只有真机能回答。
// 3. **生产策略与 dev 策略的差异**。这份守卫用的是 `app.security.csp`（生产），而
//    `pnpm tauri dev` 跑的是 `app.security.devCsp`（多了 `'unsafe-inline'`
//    `'unsafe-eval'` 和 vite 的 ws/http 端口）。devCsp 更松，所以「dev 下能跑」
//    从来不能证明生产策略可用——这也正是这份守卫存在的理由；反过来，devCsp 自身
//    写错（比如漏了 ws 端口导致 HMR 断掉）这里也测不出来。
// 4. **真实 WKWebView / WebView2 与 Chromium 对 CSP 的解释差异**。三个引擎对
//    `blob:`、自定义协议、`'self'` 是否覆盖 `ws:` 的处理并不完全一致。这里跑的是
//    Chromium，结论只在 Chromium 上成立。
//
// 结论：真机人工验证仍然需要，但范围小很多——见 `docs/manual-verification.md`。
//
// ## 一处**测试环境专属**的放宽，以及它为什么不污染生产策略
//
// vite dev server 会往 `index.html` 里注入一段**内联** module 脚本（react-refresh
// 的 preamble）。生产策略是 `script-src 'self'`，不含 `'unsafe-inline'`，所以那段
// 注入脚本必然被拦——但它是**开发服务器的产物，不是应用代码**，为它给生产策略加
// `'unsafe-inline'` 等于把真正要守的东西拆了。
//
// 这里的处理是：只在**响应头**（不是配置文件）里追加一个 `'nonce-…'`，并只给
// 「文档里没有 `src` 的 `<script>`」打上这个 nonce。效果是：
//
// - 应用自己的脚本仍然只能来自 `'self'`，运行时新插入的内联脚本仍然被拦
//   （下面「守卫自检」那条测试就是拿这个反证的）；
// - `crates/shell/tauri.conf.json` 里的策略**一个字都没改**，发出去的还是严策略。
//
// 另有一条测试钉住「仓库的 `index.html` 里没有任何内联脚本」，避免哪天应用真往
// 首页加了内联脚本，却被这个 nonce 顺手放行、守卫还是绿的。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import type { Page } from '@playwright/test'

import { openApp, test, expect } from './fixtures'
import { note } from './mock/state'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function read(relative: string): string {
  return readFileSync(join(root, relative), 'utf8')
}

interface TauriConfig {
  app?: { security?: { csp?: string | null; devCsp?: string | null } }
}

/// 生产 CSP，唯一来源是配置文件本身。
function productionCsp(): string {
  const config = JSON.parse(read('crates/shell/tauri.conf.json')) as TauriConfig
  const csp = config.app?.security?.csp
  // `csp: null` 是「完全关闭」。守卫在这种情况下会挂一个空策略然后一路全绿，
  // 制造「CSP 已验证」的假象——所以这里直接失败，而不是跳过。
  if (typeof csp !== 'string' || csp.trim() === '') {
    throw new Error('tauri.conf.json 的 app.security.csp 不是一个非空字符串，CSP 守卫无从验起')
  }
  return csp
}

/// 测试环境专属的 nonce（只进响应头，不进配置文件）。值是什么不重要，
/// 重要的是它只被贴到 dev server 注入的那段内联脚本上。
const DEV_SERVER_NONCE = 'e2e-csp-guard-dev-server-preamble'

/// 往 `script-src` 后面追加 nonce；策略里没有 `script-src` 时退回给 `default-src`。
function withDevServerNonce(policy: string, nonce: string): string {
  const directives = policy.split(';').map((part) => part.trim()).filter((part) => part !== '')
  const target = directives.findIndex((part) => /^script-src(\s|$)/i.test(part))
  if (target >= 0) {
    directives[target] = `${directives[target]} 'nonce-${nonce}'`
    return directives.join('; ')
  }
  return `${directives.join('; ')}; script-src 'self' 'nonce-${nonce}'`
}

/// 给「没有 `src` 属性的 `<script>`」贴 nonce，返回改写后的 HTML 与贴中的个数。
function nonceInlineScripts(html: string, nonce: string): { html: string; count: number } {
  let count = 0
  const patched = html.replace(/<script\b([^>]*)>/gi, (whole, attrs: string) => {
    if (/\bsrc\s*=/i.test(attrs)) return whole
    count += 1
    return `<script nonce="${nonce}"${attrs}>`
  })
  return { html: patched, count }
}

interface Guard {
  /// 迄今为止收集到的违规，原样保留 Chromium / DOM 事件给出的文本
  violations(): Promise<string[]>
  /// dev server 往文档里注入了几段内联脚本（贴了几个 nonce）
  noncedInlineScripts(): number
}

/// 给页面挂上真实的 CSP 响应头，并开始收集违规。**必须在 `openApp` 之前调用**：
/// 路由和 init script 都只对之后发生的导航生效。
async function armCsp(page: Page): Promise<Guard> {
  const policy = withDevServerNonce(productionCsp(), DEV_SERVER_NONCE)
  let noncedCount = 0

  // 来源一：Chromium 的控制台。文案形如
  // `Refused to load the image 'blob:…' because it violates the following
  //  Content Security Policy directive: "img-src 'self' data:"`。
  const fromConsole: string[] = []
  const looksLikeViolation = (text: string) =>
    /Content Security Policy/i.test(text) || /Refused to .* because it violates/i.test(text)

  page.on('console', (message) => {
    const text = message.text()
    if (looksLikeViolation(text)) fromConsole.push(`[console] ${text}`)
  })
  page.on('pageerror', (error) => {
    const text = `${error.message}`
    if (looksLikeViolation(text)) fromConsole.push(`[pageerror] ${text}`)
  })

  // 来源二：页面里的 `securitypolicyviolation` 事件。比控制台文本更结构化
  // （能直接拿到被违反的指令名），而且不依赖 Chromium 的文案措辞。两路都收：
  // 只靠文案匹配的话，措辞一改守卫就变成永远全绿。
  await page.addInitScript(() => {
    const store: string[] = []
    ;(window as unknown as Record<string, unknown>).__CSP_VIOLATIONS__ = store
    document.addEventListener('securitypolicyviolation', (event) => {
      const e = event as SecurityPolicyViolationEvent
      store.push(
        `[event] 指令 ${e.effectiveDirective || e.violatedDirective} 拦下 ` +
          `${e.blockedURI || '(inline)'}` +
          `（来源 ${e.sourceFile || '(未知)'}:${e.lineNumber}，策略 "${e.originalPolicy}"）`,
      )
    })
  })

  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') {
      await route.fallback()
      return
    }
    const response = await route.fetch()
    const patched = nonceInlineScripts(await response.text(), DEV_SERVER_NONCE)
    noncedCount = patched.count

    // content-length 要丢掉：改写过 body 之后原值已经不对了。
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(response.headers())) {
      if (name.toLowerCase() === 'content-length') continue
      headers[name] = value
    }
    headers['content-security-policy'] = policy

    await route.fulfill({ status: response.status(), headers, body: patched.html })
  })

  return {
    async violations() {
      // 违规是异步浮现的（资源加载失败要走完一轮网络栈），刚做完一步就断言容易
      // 抢在事件之前。给一个很短的沉降窗口；漏掉的那些也会被后续步骤的断言接住，
      // 因为收集器是累积的。
      await page.waitForTimeout(120)
      const fromPage = await page.evaluate(
        () => ((window as unknown as Record<string, unknown>).__CSP_VIOLATIONS__ ?? []) as string[],
      )
      return [...fromConsole, ...fromPage]
    },
    noncedInlineScripts: () => noncedCount,
  }
}

/// 断言零违规。违规消息**原样**进失败信息：只说「有违规」的话，排查时还得自己
/// 复现一遍才知道是哪条指令挡的。
async function expectClean(guard: Guard, step: string): Promise<void> {
  const found = await guard.violations()
  expect(
    found,
    `「${step}」之后出现 ${found.length} 条 CSP 违规：\n${found.join('\n')}`,
  ).toEqual([])
}

/// 一段带图片的正文：一个段落 + 一个 attachmentImage 节点（附件 id = 7）。
/// 假实现的 `read_attachment` 返回 ArrayBuffer，前端把它包成 blob URL 再塞进
/// `<img src>`——所以 `img-src blob:` 这条在这里是**真的**被走到的。
const DOC_WITH_IMAGE = JSON.stringify({
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: '带图的笔记' }] },
    { type: 'attachmentImage', attrs: { attachmentId: 7 } },
  ],
})

test('配置里的生产 CSP 是一份真策略，不是 null', () => {
  // 守卫的地基：策略被改回 null（或空串）时必须立刻红，而不是安静地验一个空策略。
  //
  // 这里**只**验「有一份能生效的策略」，不逐条比对指令内容——把 `img-src … blob:`
  // 这类字符串抄进测试就是在造第二份真相，改了配置之后两边谁对谁错说不清。
  // 每条指令够不够用，由下面那些真的走一遍应用的测试回答（比如附件图片那条：
  // 少了 `blob:` 时 `naturalWidth` 就是 0，骗不了人）。
  const csp = productionCsp()
  expect(csp).toContain('default-src')
})

test('仓库的 index.html 里没有内联脚本，nonce 只可能落在 dev server 注入的那段上', () => {
  // 这条守的是守卫自己：应用要是往首页塞了内联脚本，会被上面那个 nonce 顺手放行，
  // 而生产环境（`script-src 'self'`，没有 nonce）里它是被拦的——测试全绿、应用是坏的。
  const inline = [...read('index.html').matchAll(/<script\b([^>]*)>/gi)].filter(
    (m) => !/\bsrc\s*=/i.test(m[1] as string),
  )
  expect(inline, 'index.html 里出现了内联脚本，生产 CSP 会拦它，而这份守卫会漏掉').toHaveLength(0)
})

test('主窗口关键流程全程零 CSP 违规', async ({ page }) => {
  const guard = await armCsp(page)

  await openApp(page, {
    notes: [note(1, '知识图谱 #rust', { tags: ['rust'] }), note(2, '第二条笔记')],
  })

  // 1. 启动 + 主窗口渲染
  await expect(page.locator('.app')).toBeVisible()
  await expectClean(guard, '应用启动、主窗口渲染')

  // dev server 确实注入了内联脚本；哪天它不再注入（vite 换实现），这里会红，
  // 提醒把上面那段 nonce 的解释一并更新掉，而不是留一段没人看得懂的死代码。
  expect(guard.noncedInlineScripts()).toBeGreaterThan(0)

  // 2. 笔记列表
  await expect(page.locator('.note-item')).toHaveCount(2)
  await expect(page.getByText('知识图谱')).toBeVisible()
  await expectClean(guard, '笔记列表出现')

  // 3. ⌘K 搜索面板并输入
  await page.keyboard.press('Control+k')
  await expect(page.locator('.search-panel')).toBeVisible()
  await page.locator('.search-input').fill('知识')
  await expect(page.locator('.search-hit')).not.toHaveCount(0)
  await expectClean(guard, '⌘K 打开搜索面板并输入')
  await page.keyboard.press('Escape')

  // 4. 设置面板
  await page.getByRole('button', { name: '设置' }).click()
  await expect(page.locator('.settings-panel')).toBeVisible()
  await expectClean(guard, '打开设置面板')
  await page.keyboard.press('Escape')

  // 5. 回收站
  await page.getByRole('button', { name: '回收站' }).click()
  await expect(page.locator('.trash-panel')).toBeVisible()
  await expectClean(guard, '打开回收站')
})

test('带附件图片的笔记：图片真的显示出来（img-src blob: 的直接验证）', async ({ page }) => {
  // 整份策略里最容易写错的一条。附件图片全部走 blob URL 渲染，`img-src` 漏了
  // `blob:` 的话每张图都碎——而页面不报错、不白屏，只是图没了。
  const guard = await armCsp(page)

  const mock = await openApp(page, {
    notes: [note(1, '带图的笔记', { body_json: DOC_WITH_IMAGE, attachment_ids: [7] })],
  })

  await page.locator('.note-item', { hasText: '带图的笔记' }).click()

  const image = page.locator('.editor .attachment-image img')
  await expect(image).toBeVisible()
  // src 确实是 blob URL，不是别的什么被 `'self'` 顺带放行的东西
  await expect(image).toHaveAttribute('src', /^blob:/)

  // 违规断言放在 naturalWidth 之前：两条都能抓到「图片被拦了」，但只有这条能
  // 直接说出**是哪条指令**挡的。反过来先撞上 naturalWidth 的超时，失败信息里
  // 只有一句「Received: 0」，还得自己再复现一遍才知道原因。
  await expectClean(guard, '打开带附件图片的笔记，图片开始加载')

  // 真的解码了才有非零的 naturalWidth。被 CSP 拦下时 <img> 不抛错、不白屏，
  // naturalWidth 停在 0——所以这条断言才是「图片显示出来了」的唯一硬证据。
  await expect
    .poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 5_000 })
    .toBeGreaterThan(0)
  await expect(page.locator('.attachment-missing')).toHaveCount(0)

  expect(await mock.lastArgs('read_attachment')).toEqual({ id: 7 })
  await expectClean(guard, '带附件图片的笔记渲染完成')
})

test('快捕窗口渲染并输入，零 CSP 违规', async ({ page }) => {
  const guard = await armCsp(page)

  await openApp(page, { windowLabel: 'capture' })

  await expect(page.locator('.capture')).toBeVisible()
  await expectClean(guard, '快捕窗口渲染')

  await page.locator('.editor p').first().click()
  await page.keyboard.type('随手记一条')
  await expect(page.locator('.editor')).toContainText('随手记一条')
  await expectClean(guard, '快捕窗口输入')
})

test('守卫自检：策略真的挂上去了，内联脚本会被拦、并且被收集到', async ({ page }) => {
  // 反证。没有这条的话，`page.route` 哪天失效（选择器写错、resourceType 判断漂了）
  // 会让所有断言变成「零违规」——因为压根没有策略在生效。一个不会红的守卫比没有
  // 守卫更糟，因为它制造安全感。
  const guard = await armCsp(page)
  await openApp(page, { notes: [note(1, '随便一条')] })
  await expectClean(guard, '自检的起点')

  // 运行时插入一段内联脚本：它没有 nonce（nonce 只贴给文档里 dev server 注入的
  // 那段），生产策略的 `script-src 'self'` 必须把它拦下来。
  await page.evaluate(() => {
    const script = document.createElement('script')
    script.textContent = 'window.__CSP_GUARD_ESCAPED__ = true'
    document.head.appendChild(script)
  })

  const found = await guard.violations()
  expect(found.join('\n'), '内联脚本没有被拦下：CSP 响应头根本没生效').toMatch(/script-src/i)
  expect(
    await page.evaluate(() => (window as unknown as Record<string, unknown>).__CSP_GUARD_ESCAPED__),
  ).toBeUndefined()
})
