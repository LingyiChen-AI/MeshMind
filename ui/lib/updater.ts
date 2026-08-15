// 自动更新：和更新器插件之间唯一的通道，外加界面要用到的那几个纯函数。
//
// ## 两种触发方式，故意给两套完全不同的反馈
//
// 启动时是**静默**检查：没有新版什么都不显示，查询失败也什么都不显示（只 console.warn）。
// 启动那一刻网络不通是常态（还没连上 Wi-Fi、公司网关没过认证、GitHub 被墙），
// 为此弹一条错误横幅，用户每天开机都要关一次，纯噪音。
//
// 手动检查则**必须给明确结果**：有新版说版本号、已是最新明说「已是最新版本（x.y.z）」、
// 失败把错误摆出来。用户主动点了一下却什么都没发生，是最让人困惑的一种交互——
// 他分不清是「已经最新」还是「点坏了」，只会再点几次。
//
// 这条分岔全部收在 `phaseAfterCheck` 里，是纯函数，用 vitest 覆盖六种组合。
//
// ## 下载过程必须可见
//
// 本项目在「粘贴图片失败静默」上已经吃过一次教训：失败只进 console，
// 用户看到的是「点了没反应」。所以下载百分比、失败原因都要落到界面上，
// 不许只 console.error。
//
// ## 没有 `plugins.updater` 配置时
//
// `tauri.conf.json` 目前还没有 `plugins.updater`（endpoints 与 pubkey 要等密钥就位），
// 这时 `check()` 会直接抛错。表现正好是设计好的样子：启动检查咽掉，
// 手动检查把错误显示出来。

import { getVersion } from '@tauri-apps/api/app'
import { relaunch } from '@tauri-apps/plugin-process'
import { check, type Update } from '@tauri-apps/plugin-updater'

/** 查到的新版本。`handle` 是插件的资源句柄，只有它能发起下载。 */
export interface UpdateInfo {
  version: string
  notes: string
  handle: Update
}

/** 谁发起的这次检查。两者的失败与「无更新」反馈完全不同，见文件头。 */
export type CheckTrigger = 'startup' | 'manual'

/** 一次检查的结果，剥掉了不可序列化的句柄，方便当作纯函数的输入。 */
export type CheckOutcome =
  | { kind: 'available'; version: string; notes: string }
  | { kind: 'none' }
  | { kind: 'failed'; message: string }

/**
 * 更新 UI 的全部状态。
 *
 * `idle` 的含义是「界面上什么都不显示」——启动检查的「无更新」和「查询失败」
 * 都落在这里，这正是静默的实现方式。
 */
export type UpdatePhase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  /** 已是最新。只有手动检查会走到这里 */
  | { kind: 'latest'; currentVersion: string }
  | { kind: 'available'; version: string; notes: string }
  | { kind: 'downloading'; version: string; downloaded: number; total: number | null }
  /** 下载完、正在装，装完插件会重启应用 */
  | { kind: 'installing'; version: string }
  /**
   * `during` 决定文案说「检查更新失败」还是「更新失败」。两者的处置完全不同：
   * 前者多半是网络或更新源的问题，后者说明新包已经查到了、装不上——
   * 混成一句话，用户拿着错误消息也不知道该看哪儿。
   */
  | { kind: 'failed'; message: string; during: 'check' | 'install' }

/**
 * 把一次检查的结果翻译成界面状态。**启动检查与手动检查的全部差别都在这一个函数里。**
 *
 * - 有新版：两种触发都进 `available`，横幅/面板照常提示。
 * - 无新版：启动 → `idle`（什么都不显示）；手动 → `latest`（明说已是最新）。
 * - 失败：启动 → `idle`（调用方另外 console.warn）；手动 → `failed`（错误可见）。
 *
 * `currentVersion` 只在「手动 + 无新版」那一格用得上——「已是最新版本」后面不带
 * 版本号等于没说，用户没法判断自己手上这份到底是不是他以为的那个版本。
 */
export function phaseAfterCheck(
  trigger: CheckTrigger,
  outcome: CheckOutcome,
  currentVersion: string,
): UpdatePhase {
  if (outcome.kind === 'available') {
    return { kind: 'available', version: outcome.version, notes: outcome.notes }
  }
  if (trigger === 'startup') return { kind: 'idle' }
  if (outcome.kind === 'none') return { kind: 'latest', currentVersion }
  return { kind: 'failed', message: outcome.message, during: 'check' }
}

/**
 * 下载进度的百分比（0–100 的整数），总大小未知时返回 null。
 *
 * 三个都得挡住，否则界面上会出现 `NaN%` / `Infinity%` / `137%` 这类东西：
 * - `total` 为 null：服务端没给 Content-Length，这时只能报已下载字节数。
 * - `total` 为 0：除零。真出现过——空响应体加上一个乐观的 `?? 0`。
 * - `downloaded > total`：分块累加多算了一点，或者服务端的长度报小了。
 */
export function progressPercent(downloaded: number, total: number | null): number | null {
  if (total === null || total <= 0) return null
  if (!Number.isFinite(downloaded) || downloaded <= 0) return 0
  return Math.min(100, Math.floor((downloaded / total) * 100))
}

/** 字节数的人话版本。保留一位小数，1 KB 以下直接报字节。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${units[unit] as string}`
}

/**
 * 进度条旁边那行字。总大小未知时退化成「已下载 4.2 MB」——
 * 没有百分比也比一个一直停在 0% 的假进度诚实。
 */
export function progressText(downloaded: number, total: number | null): string {
  const percent = progressPercent(downloaded, total)
  if (percent === null) return `已下载 ${formatBytes(downloaded)}`
  return `${percent}%（${formatBytes(downloaded)} / ${formatBytes(total ?? 0)}）`
}

/**
 * 查有没有新版本。没有返回 null。
 *
 * 网络不通、更新源 404、还没配 `plugins.updater` 都会抛——调用方自己决定
 * 要不要打扰用户（`phaseAfterCheck` 就是干这个的）。
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const update = await check()
  if (!update) return null
  return { version: update.version, notes: update.body ?? '', handle: update }
}

/** 当前安装的版本号。取的是外壳报的版本，也就是 package.json 里那一个。 */
export async function currentVersion(): Promise<string> {
  return getVersion()
}

/**
 * 下载并安装，装完重启。`onProgress` 收到的是累计已下载字节数与总字节数。
 *
 * `Started` 事件也回调一次（0 字节）：不回调的话，从点下按钮到第一个数据块到达
 * 之间界面停在「下载中」却没有任何数字，慢网络下这段可以有十几秒。
 *
 * `onInstalling` 在字节收完、开始解包安装时回调一次。这一段没有任何进度可报，
 * 但它可能持续好几秒——不换文案的话界面会停在「下载中 100%」，看着像卡住了。
 */
export async function applyUpdate(
  info: UpdateInfo,
  onProgress: (downloaded: number, total: number | null) => void,
  onInstalling?: () => void,
): Promise<void> {
  let downloaded = 0
  let total: number | null = null
  await info.handle.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      total = event.data.contentLength ?? null
      onProgress(0, total)
    } else if (event.event === 'Progress') {
      downloaded += event.data.chunkLength
      onProgress(downloaded, total)
    } else if (event.event === 'Finished') {
      onInstalling?.()
    }
  })
  await relaunch()
}
