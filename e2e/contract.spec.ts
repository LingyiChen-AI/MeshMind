// 三份「命令名清单」必须对得上：前端调的、外壳注册的、假实现认的。
//
// 这条测试不开浏览器，纯读文件。它存在的理由是一次真事：`ipc.ts` 里有四个命令
// （list_notes_by_tag / list_all_tags / purge_note / purge_all_deleted）
// 前端一直在调，`crates/core` 里对应的函数也一直有、还带着测试，
// 但 `src-tauri` 从没把它们包成 `#[tauri::command]`、也没写进 `generate_handler!`。
// TS 编译器看不见 Rust，Rust 也不知道前端调了什么，两边都不会报错——
// 症状只会在运行时出现（主窗口一启动就弹「Command list_all_tags not found」，
// 标签筛选和回收站的彻底删除整个是死的）。
//
// 而这类缺陷恰恰是假实现最容易掩盖的：假实现照着 `ipc.ts` 写，
// 每个命令都实现得好好的，测试全绿，应用却是坏的。所以这里把三份清单对起来。

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

/// 前端实际会 invoke 的命令名。`ipc.ts` 是唯一允许调 invoke 的地方，
/// 所以扫它一个文件就够。
function frontendCommands(): string[] {
  const source = read('src/lib/ipc.ts')
  return [...new Set(matchAll(source, /(?:invoke|call)(?:<.*>)?\(\s*'([a-z_]+)'/g))].sort()
}

/// 外壳真正注册进 `generate_handler!` 的命令。没进这张表的命令，
/// 前端调过去只会得到 "Command xxx not found"。
function registeredCommands(): string[] {
  const source = read('src-tauri/src/main.rs')
  const block = /generate_handler!\[([\s\S]*?)\]/.exec(source)
  expect(block, 'main.rs 里找不到 generate_handler!').not.toBeNull()
  return [...new Set(matchAll(block?.[1] ?? '', /commands::(\w+)/g))].sort()
}

/// 假实现认得的命令。
function mockedCommands(): string[] {
  const source = read('e2e/mock/install.ts')
  return [...new Set(matchAll(source, /^\s*case '([a-z_|:]+)':/gm))].sort()
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
