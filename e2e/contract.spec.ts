// 三份「命令名清单」必须对得上：前端调的、外壳注册的、假实现认的。
//
// 这条测试不开浏览器，纯读文件。它存在的理由是一次真事：`ipc.ts` 里有四个命令
// （list_notes_by_tag / list_all_tags / purge_note / purge_all_deleted）
// 前端一直在调，`crates/core` 里对应的函数也一直有、还带着测试，
// 但 `crates/shell` 从没把它们包成 `#[tauri::command]`、也没写进 `generate_handler!`。
// TS 编译器看不见 Rust，Rust 也不知道前端调了什么，两边都不会报错——
// 症状只会在运行时出现（主窗口一启动就弹「Command list_all_tags not found」，
// 标签筛选和回收站的彻底删除整个是死的）。
//
// 而这类缺陷恰恰是假实现最容易掩盖的：假实现照着 `ipc.ts` 写，
// 每个命令都实现得好好的，测试全绿，应用却是坏的。所以这里把三份清单对起来。
//
// ## 为什么要先剥注释
//
// 三份清单都是拿正则从源码里抠出来的，而正则不认识注释。把 `main.rs` 里的
// `commands::list_all_tags,` 改成 `// commands::list_all_tags,`，命令实际上已经
// 不再注册、应用已经坏了，`/commands::(\w+)/` 却照样匹配得到——守卫全绿。
// 一个不会红的守卫比没有守卫更糟，因为它制造安全感。
//
// 另外两处提取有同样的病：`ipc.ts` 里把一整句 `return call<T>('xxx', …)` 注释掉，
// 或者假实现里用块注释包住一段 `case 'xxx':`，正则一样看不见注释这回事。
// 所以三处统一先过 `stripComments`。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { test, expect } from './fixtures'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function read(relative: string): string {
  return readFileSync(join(root, relative), 'utf8')
}

function matchAll(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((m) => m[1] as string)
}

// ---------- 剥注释 ----------

/// `rust` 与 `ts` 的注释语法大体相同，差别都在「什么东西长得像注释但不是」上：
/// Rust 的块注释可以嵌套、`'a` 是生命周期不是字符串开头、还有 `r#"…"#` 原始字符串；
/// TS 有反引号模板串（`` `${p}://host` `` 里的 `//` 不是注释）。
export type Dialect = 'rust' | 'ts'

/// 把源码里的注释抹成空格，换行原样保留。
///
/// 抹成空格而不是删掉，是为了让字符偏移和行号完全不变：下游的
/// `/^\s*case '…':/m` 靠行首锚点定位，`generate_handler!\[([\s\S]*?)\]` 靠块的
/// 起止位置，删字符会把这两件事一起搅乱。
///
/// 字符串字面量里的 `//` 和 `/*` 不是注释，必须原样留下——`install.ts` 里
/// `` `${protocol}://localhost/…` `` 就是现成的例子，把它当行注释剥掉会把那一行
/// 后半截连同闭合反引号一起抹平。
export function stripComments(source: string, dialect: Dialect): string {
  const n = source.length
  const out = source.split('')

  /// 抹掉 [from, to)，但保留换行——行号不能变。
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k += 1) {
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '
    }
  }

  let i = 0
  while (i < n) {
    const ch = source[i]
    const next = source[i + 1]

    // 行注释：抹到行尾（换行本身留着）
    if (ch === '/' && next === '/') {
      let j = i + 2
      while (j < n && source[j] !== '\n') j += 1
      blank(i, j)
      i = j
      continue
    }

    // 块注释。Rust 的块注释**可以嵌套**（`/* /* */ */` 整块都是注释），
    // TS 的不行（第一个 `*/` 就收尾）。没闭合就一路抹到文件尾，和编译器的看法一致。
    if (ch === '/' && next === '*') {
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (dialect === 'rust' && source[j] === '/' && source[j + 1] === '*') {
          depth += 1
          j += 2
          continue
        }
        if (source[j] === '*' && source[j + 1] === '/') {
          depth -= 1
          j += 2
          continue
        }
        j += 1
      }
      blank(i, j)
      i = j
      continue
    }

    if (ch === '"') {
      i = skipQuoted(source, i, '"')
      continue
    }

    if (ch === '`' && dialect === 'ts') {
      i = skipQuoted(source, i, '`')
      continue
    }

    if (ch === "'") {
      if (dialect === 'ts') {
        i = skipQuoted(source, i, "'")
        continue
      }
      const end = rustCharLiteralEnd(source, i)
      // 认不出字符字面量就是生命周期（`'a` / `'static`），当普通代码往下走。
      i = end === null ? i + 1 : end
      continue
    }

    // Rust 原始字符串 `r"…"` / `r#"…"#` / `br#"…"#`：里面没有转义，
    // 结束符是引号加同样数量的 `#`。前一个字符是标识符字符时那个 `r` 是词尾，不是前缀。
    if (dialect === 'rust' && (ch === 'r' || ch === 'b') && !isIdentChar(source[i - 1])) {
      const end = rustRawStringEnd(source, i)
      if (end !== null) {
        i = end
        continue
      }
    }

    i += 1
  }

  return out.join('')
}

/// 跳过一段引号包起来的字面量，返回闭合引号之后的位置。反斜杠转义会跳过下一个字符。
/// 没闭合就算到文件尾。
///
/// 模板串里的 `${…}` 不做嵌套解析：真出现「插值里又套一个反引号字符串」时这里会看歪。
/// 本仓库三个被扫的文件都没有这种写法，为它引一个完整词法分析器不划算。
function skipQuoted(source: string, start: number, quote: string): number {
  let j = start + 1
  while (j < source.length) {
    const ch = source[j]
    if (ch === '\\') {
      j += 2
      continue
    }
    if (ch === quote) return j + 1
    j += 1
  }
  return source.length
}

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch)
}

/// Rust 里 `'` 有两种身份：字符字面量（`'a'` / `'\n'` / `'\u{1F600}'`）和
/// 生命周期（`'a` / `'static`）。把生命周期错当成字符串开头会把后面**整个文件**
/// 都吞进「字符串」里，清单直接变空——所以只有真能在近处找到闭合引号才认。
///
/// 返回闭合引号之后的位置；不像字符字面量则返回 null。
function rustCharLiteralEnd(source: string, start: number): number | null {
  if (source[start + 1] === '\\') {
    // 转义形式最长也就 `'\u{10FFFF}'` 这个量级
    const limit = Math.min(source.length, start + 14)
    for (let j = start + 2; j < limit; j += 1) {
      if (source[j] === '\n') return null
      if (source[j] === "'") return j + 1
    }
    return null
  }
  // 非转义的字符字面量正好三个 code unit；补充平面的字符占两个，于是是四个。
  if (source[start + 2] === "'") return start + 3
  const code = source.charCodeAt(start + 1)
  if (code >= 0xd800 && code <= 0xdbff && source[start + 3] === "'") return start + 4
  return null
}

/// `r"…"` / `r#"…"#` / `br#"…"#`。返回结束符之后的位置，不是原始字符串则返回 null。
function rustRawStringEnd(source: string, start: number): number | null {
  let j = start
  if (source[j] === 'b') j += 1
  if (source[j] !== 'r') return null
  j += 1
  let hashes = 0
  while (source[j] === '#') {
    hashes += 1
    j += 1
  }
  if (source[j] !== '"') return null
  const terminator = `"${'#'.repeat(hashes)}`
  const end = source.indexOf(terminator, j + 1)
  return end < 0 ? source.length : end + terminator.length
}

// ---------- 三处提取（纯函数，输入是源码文本） ----------

/// 前端实际会 invoke 的命令名。
export function extractFrontendCommands(source: string): string[] {
  const code = stripComments(source, 'ts')
  return [...new Set(matchAll(code, /(?:invoke|call)(?:<.*>)?\(\s*'([a-z_]+)'/g))].sort()
}

/// 外壳真正注册进 `generate_handler!` 的命令。
export function extractRegisteredCommands(source: string): string[] {
  const code = stripComments(source, 'rust')
  const block = /generate_handler!\[([\s\S]*?)\]/.exec(code)
  // 抛而不是返回空数组：找不到那张表说明这个提取已经失效，
  // 悄悄返回空集合会让下面所有「差集为空」的断言全部通过。
  if (block === null) throw new Error('main.rs 里找不到 generate_handler!')
  return [...new Set(matchAll(block[1] ?? '', /commands::(\w+)/g))].sort()
}

/// 假实现认得的命令。
export function extractMockedCommands(source: string): string[] {
  const code = stripComments(source, 'ts')
  return [...new Set(matchAll(code, /^\s*case '([a-z_|:]+)':/gm))].sort()
}

// ---------- 三处提取（读真文件） ----------

/// `ipc.ts` 是唯一允许调 invoke 的地方，所以扫它一个文件就够。
function frontendCommands(): string[] {
  return extractFrontendCommands(read('ui/lib/ipc.ts'))
}

/// 没进 `generate_handler!` 的命令，前端调过去只会得到 "Command xxx not found"。
function registeredCommands(): string[] {
  return extractRegisteredCommands(read('crates/shell/src/main.rs'))
}

function mockedCommands(): string[] {
  return extractMockedCommands(read('e2e/mock/install.ts'))
}

test('前端调的每个命令，外壳都注册了', () => {
  const registered = new Set(registeredCommands())
  const missing = frontendCommands().filter((cmd) => !registered.has(cmd))
  expect(missing, `这些命令 ipc.ts 在调，但 main.rs 的 generate_handler! 里没有`).toEqual([])
})

test('前端调的每个命令，假实现都认', () => {
  const mocked = new Set(mockedCommands())
  const missing = frontendCommands().filter((cmd) => !mocked.has(cmd))
  expect(missing, '这些命令 ipc.ts 在调，但 e2e 的假实现没有对应分支').toEqual([])
})

test('假实现不认识外壳根本没有的命令', () => {
  // 反方向也要对：假实现里凭空多出来的分支意味着测试可能在演一出
  // 后端根本演不了的戏。`plugin:` 开头的是 Tauri 内置插件命令，不走 generate_handler!。
  const registered = new Set(registeredCommands())
  const extra = mockedCommands().filter((cmd) => !cmd.startsWith('plugin:') && !registered.has(cmd))
  expect(extra, '假实现里有外壳没注册的命令').toEqual([])
})

test('清单不是空的（正则失效时这条会先炸）', () => {
  // 上面三条都是「差集为空」，正则一旦失配就会全部变成空集合、全部通过。
  expect(frontendCommands().length).toBeGreaterThan(15)
  expect(registeredCommands().length).toBeGreaterThan(15)
  expect(mockedCommands().length).toBeGreaterThan(15)
  // 抽查几个必须在场的
  for (const cmd of ['create_note', 'update_note', 'get_settings', 'confirm_quit']) {
    expect(frontendCommands()).toContain(cmd)
    expect(registeredCommands()).toContain(cmd)
    expect(mockedCommands()).toContain(cmd)
  }
})

// ---------- stripComments 自己的单测 ----------
//
// 剥注释这段逻辑本身就是最容易写歪的地方：写松了（漏剥）守卫回到原来的盲点，
// 写紧了（把字符串当注释剥掉）会把好好的源码搅烂、清单凭空少几项。
// 它是纯函数，直接喂字符串测，不需要浏览器。
//
// 这些用例走 Playwright 而不是 vitest：vitest 的 include 是 `ui/**/*.test.{ts,tsx}`，
// 收不到 `e2e/` 下的文件，而这次改动只允许动 `e2e/`。何况被测的就是本文件里的函数，
// 和守卫放在一起，改正则的人一定看得见它们。

/// 剥完注释后逐行 trim 再拼回来。用例关心的是「哪些字符还在」，
/// 一个个数被抹出来的空格只会让断言难读、改一个字就全错。
/// 「长度必须不变」这条性质在这里顺手一起守住——每一条用例都会验它。
function strippedCode(source: string, dialect: Dialect): string {
  const out = stripComments(source, dialect)
  expect(out, '剥注释不许改变长度：字符偏移和行号得原样保留').toHaveLength(source.length)
  return out
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
}

test('剥注释：行尾注释', () => {
  expect(strippedCode('let a = 1; // 注释\nlet b = 2;', 'ts')).toBe('let a = 1;\nlet b = 2;')
})

test('剥注释：整行注释', () => {
  expect(strippedCode('a\n// 整行都是注释\nb', 'ts')).toBe('a\n\nb')
})

test('剥注释：块注释跨多行', () => {
  // 行数一个不少（换行没被抹掉），中间三行的内容一个不剩
  expect(strippedCode('keep1\n/* 第一行\n第二行\n第三行 */ keep2\nkeep3', 'ts')).toBe(
    'keep1\n\n\nkeep2\nkeep3',
  )
})

test('剥注释：块注释在一行之内', () => {
  // `/* x */` 是 7 个字符，抹成 7 个空格，两侧的代码一个字不动
  expect(strippedCode('a /* x */ b', 'ts')).toBe(`a ${' '.repeat(7)} b`)
})

test('剥注释：字符串字面量里的 // 不是注释', () => {
  expect(strippedCode(`const u = 'http://a/b' // 真注释`, 'ts')).toBe(`const u = 'http://a/b'`)
  expect(strippedCode(`const u = "http://a/b"`, 'ts')).toBe(`const u = "http://a/b"`)
  // install.ts 里真有这么一行；剥错了会把后半截连同闭合反引号一起抹平
  expect(strippedCode('`${protocol}://localhost/${p}`\nnext', 'ts')).toBe(
    '`${protocol}://localhost/${p}`\nnext',
  )
})

test('剥注释：字符串字面量里的 /* 不会开启块注释', () => {
  expect(strippedCode(`const s = '/*'\nconst t = 1`, 'ts')).toBe(`const s = '/*'\nconst t = 1`)
})

test('剥注释：字符串里的转义引号不算收尾', () => {
  expect(strippedCode(`const s = 'a\\'// 还在串里' // 注释`, 'ts')).toBe(
    `const s = 'a\\'// 还在串里'`,
  )
})

test('剥注释：Rust 的块注释可以嵌套，TS 的不行', () => {
  const source = '/* a /* b */ c */ d'
  expect(strippedCode(source, 'rust')).toBe('d')
  // TS 里第一个 */ 就收尾，后面的 `c */ d` 是代码
  expect(strippedCode(source, 'ts')).toBe('c */ d')
})

test('剥注释：Rust 的生命周期不是字符串开头', () => {
  // 认错的话 `'a` 会吞掉后面整个文件，`commands::keep` 就提不出来了
  const stripped = strippedCode("fn f<'a>(x: &'a str) {} // 注释\ncommands::keep,", 'rust')
  expect(stripped).toBe("fn f<'a>(x: &'a str) {}\ncommands::keep,")
})

test('剥注释：Rust 的字符字面量照样是字面量', () => {
  expect(strippedCode(`let c = '/'; // x`, 'rust')).toBe(`let c = '/';`)
  expect(strippedCode(`let c = '\\''; // x`, 'rust')).toBe(`let c = '\\'';`)
})

test('剥注释：Rust 原始字符串里的 // 不是注释', () => {
  expect(strippedCode('let s = r#"http://a // b"#; // 真注释', 'rust')).toBe(
    'let s = r#"http://a // b"#;',
  )
})

test('剥注释：没闭合的块注释一路抹到文件尾', () => {
  // 和编译器的看法一致：`/*` 之后的东西全在注释里，`commands::gone` 不算数
  expect(strippedCode('keep\n/* 没有收尾\ncommands::gone,', 'rust')).toBe('keep\n\n')
})

// ---------- 三处提取对注释的敏感度 ----------
//
// 下面这六条是「注释掉一个命令，守卫必须看得见」这件事的常驻回归测试。
// 手工反证（真去 main.rs 里注释掉一行看守卫红不红）只在改动当时做过一次，
// 这些用例才是以后一直有人守着的部分。

test('提取：外壳里被注释掉的命令不算注册', () => {
  const source = `
    .invoke_handler(tauri::generate_handler![
        commands::create_note,
        // commands::list_all_tags,
        /* commands::purge_note, */
        commands::update_note,      // 行尾注释里的 commands::decoy 也不算
    ])
  `
  expect(extractRegisteredCommands(source)).toEqual(['create_note', 'update_note'])
})

test('提取：外壳里整块注释掉的一段命令都不算注册', () => {
  const source = `
    .invoke_handler(tauri::generate_handler![
        commands::create_note,
        /*
        commands::purge_note,
        commands::purge_all_deleted,
        */
    ])
  `
  expect(extractRegisteredCommands(source)).toEqual(['create_note'])
})

test('提取：找不到 generate_handler! 就抛，不返回空清单', () => {
  expect(() => extractRegisteredCommands('fn main() {}')).toThrow('generate_handler!')
})

test('提取：前端里被注释掉的调用不算在调', () => {
  const source = `
    export const ipc = {
      createNote() { return call<Note>('create_note', {}) },
      // listAllTags() { return call<TagCount[]>('list_all_tags') },
      /* purgeNote(id: number) { return call<void>('purge_note', { id }) }, */
      getSettings() { return invoke<Record<string, string>>('get_settings') },
    }
  `
  expect(extractFrontendCommands(source)).toEqual(['create_note', 'get_settings'])
})

test('提取：假实现里被注释掉的分支不算认识', () => {
  const source = `
    switch (cmd) {
      case 'create_note':
        return a
      // case 'list_all_tags':
      //   return b
      /*
      case 'purge_note':
        return c
      */
      case 'plugin:event|listen':
        return d
    }
  `
  expect(extractMockedCommands(source)).toEqual(['create_note', 'plugin:event|listen'])
})

test('提取：真文件过一遍剥注释之后清单没有缩水', () => {
  // 剥注释写紧了（把字符串或生命周期当注释）的表现就是清单突然少几项。
  // 上面「清单不是空的」只管下限，这里点名几个最容易被剥没的：
  // install.ts 里 `${protocol}://localhost` 之后还有一堆分支，
  // main.rs 的 generate_handler! 前面全是大段注释。
  expect(mockedCommands()).toContain('plugin:process|restart')
  expect(mockedCommands()).toContain('set_autostart')
  expect(registeredCommands()).toContain('set_autostart')
  expect(frontendCommands()).toContain('set_autostart')
})
