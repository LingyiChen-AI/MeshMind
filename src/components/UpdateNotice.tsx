// 更新相关的全部界面：主窗口顶部的横幅 + 设置面板里的「软件更新」一节。
//
// 两处共用一个 `useUpdater`，但**各自持有一份状态**（两个 hook 实例）。
// 这是刻意的：横幅是「启动时静默查到的那次结果」，设置面板是「用户刚点的那一下」，
// 合成一份状态之后，用户在设置里点一下检查，主窗口的横幅也会跟着抖——
// 而他并没有对横幅做任何操作。
//
// 状态机本身（尤其「启动 vs 手动」的分岔）在 lib/updater.ts 里，是纯函数，
// 有 vitest 覆盖；这个文件只负责把状态画出来。

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  applyUpdate,
  checkForUpdate,
  currentVersion,
  phaseAfterCheck,
  progressText,
  type CheckOutcome,
  type CheckTrigger,
  type UpdateInfo,
  type UpdatePhase,
} from '../lib/updater'

export interface Updater {
  phase: UpdatePhase
  /** 当前安装的版本号，还没问到之前是 null */
  version: string | null
  check: (trigger: CheckTrigger) => Promise<void>
  /** 下载并安装刚查到的那个版本。没查到东西时是空操作 */
  install: () => Promise<void>
  /** 回到「什么都不显示」。「稍后」和「关闭」用它 */
  dismiss: () => void
}

export function useUpdater(): Updater {
  const [phase, setPhase] = useState<UpdatePhase>({ kind: 'idle' })
  const [version, setVersion] = useState<string | null>(null)

  // 句柄不进 state：它是插件的资源对象，不可序列化，也不该参与渲染比较。
  const infoRef = useRef<UpdateInfo | null>(null)
  // 卸载后不再 setState。面板是随手开关的，一次检查很可能在面板关掉之后才回来。
  const aliveRef = useRef(true)
  const checkingRef = useRef(false)
  // 版本号只问一次。StrictMode 下 effect 会跑两遍，缓存 promise 而不是缓存结果，
  // 才能把「两次并发的问询」也合并成一次 IPC。
  const versionPromiseRef = useRef<Promise<string> | null>(null)

  // 必须是第一个 effect：后面的 effect 依赖 aliveRef 已经被置回 true
  // （StrictMode 的 mount → cleanup → mount 会把它设成 false 再用）。
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const resolveVersion = useCallback(async (): Promise<string> => {
    if (versionPromiseRef.current === null) {
      versionPromiseRef.current = currentVersion().catch((err: unknown) => {
        // 版本号读不到不该挡住任何事，退化成一个明说「不知道」的占位。
        console.warn('[updater] 读不到当前版本号', err)
        return '未知'
      })
    }
    const resolved = await versionPromiseRef.current
    if (aliveRef.current) setVersion(resolved)
    return resolved
  }, [])

  useEffect(() => {
    void resolveVersion()
  }, [resolveVersion])

  const check = useCallback(
    async (trigger: CheckTrigger) => {
      // 一次在途就够了。启动检查和用户手快连点两下会撞在一起，
      // 后一次的结果覆盖前一次时，界面会先说「已是最新」再跳成「有新版」。
      if (checkingRef.current) return
      checkingRef.current = true
      // 只有手动检查显示「检查中…」：启动检查全程不占界面。
      if (trigger === 'manual' && aliveRef.current) setPhase({ kind: 'checking' })

      let outcome: CheckOutcome
      try {
        const info = await checkForUpdate()
        infoRef.current = info
        outcome =
          info === null
            ? { kind: 'none' }
            : { kind: 'available', version: info.version, notes: info.notes }
      } catch (err) {
        infoRef.current = null
        outcome = { kind: 'failed', message: String(err) }
        if (trigger === 'startup') {
          // 启动那一刻网络不通是常态（没连上 Wi-Fi、网关没过认证）。
          // 只记一笔日志，界面上一个字都不显示——见 phaseAfterCheck。
          console.warn('[updater] 启动检查更新失败（已忽略）', err)
        }
      } finally {
        checkingRef.current = false
      }

      const installed = await resolveVersion()
      if (aliveRef.current) setPhase(phaseAfterCheck(trigger, outcome, installed))
    },
    [resolveVersion],
  )

  const install = useCallback(async () => {
    const info = infoRef.current
    if (info === null) return
    if (aliveRef.current) {
      setPhase({ kind: 'downloading', version: info.version, downloaded: 0, total: null })
    }
    try {
      await applyUpdate(
        info,
        (downloaded, total) => {
          if (aliveRef.current) {
            setPhase({ kind: 'downloading', version: info.version, downloaded, total })
          }
        },
        () => {
          if (aliveRef.current) setPhase({ kind: 'installing', version: info.version })
        },
      )
      // 正常情况下走不到这里：applyUpdate 最后一步是 relaunch()，进程已经在重启了。
      // 真走到了说明重启没生效，那也得让用户知道「装完了，重启一下」。
      if (aliveRef.current) setPhase({ kind: 'installing', version: info.version })
    } catch (err) {
      // 下载或安装失败必须看得见。只进 console 的话用户看到的是「点了没反应」——
      // 本项目在「粘贴图片失败静默」上已经吃过一次这个亏。
      if (aliveRef.current) {
        setPhase({ kind: 'failed', message: String(err), during: 'install' })
      }
    }
  }, [])

  const dismiss = useCallback(() => {
    if (aliveRef.current) setPhase({ kind: 'idle' })
  }, [])

  return { phase, version, check, install, dismiss }
}

/**
 * 主窗口顶部的更新横幅。
 *
 * `idle` / `checking` / `latest` 一律不渲染——启动检查的「无更新」与「失败」
 * 都落在 `idle`，横幅因此在绝大多数启动里根本不存在。
 */
export function UpdateBanner({ updater }: { updater: Updater }) {
  const { phase, version } = updater
  if (phase.kind === 'idle' || phase.kind === 'checking' || phase.kind === 'latest') return null

  return (
    <div className="update-banner" role="status">
      {phase.kind === 'available' ? (
        <>
          <span className="update-text">
            MeshMind {phase.version} 可用{version === null ? '' : `（当前 ${version}）`}
          </span>
          <button type="button" className="primary" onClick={() => void updater.install()}>
            更新
          </button>
          <button type="button" className="subtle" onClick={updater.dismiss}>
            稍后
          </button>
        </>
      ) : null}

      {phase.kind === 'downloading' ? (
        <span className="update-text">
          正在下载 {phase.version}… {progressText(phase.downloaded, phase.total)}
        </span>
      ) : null}

      {phase.kind === 'installing' ? (
        <span className="update-text">{phase.version} 已下载完成，正在重启应用…</span>
      ) : null}

      {phase.kind === 'failed' ? (
        <>
          <span className="update-text update-error">
            {phase.during === 'check' ? '检查更新失败：' : '更新失败：'}
            {phase.message}
          </span>
          <button type="button" onClick={() => void updater.install()}>
            重试
          </button>
          <button type="button" className="subtle" onClick={updater.dismiss}>
            关闭
          </button>
        </>
      ) : null}
    </div>
  )
}

/**
 * 设置面板里的「软件更新」一节。和启动横幅相反，**每一种结果都要说话**：
 * 用户主动点了检查却什么都没变，他分不清是已经最新还是按钮坏了。
 */
export function UpdateSettingsSection() {
  const updater = useUpdater()
  const { phase, version } = updater
  const busy =
    phase.kind === 'checking' || phase.kind === 'downloading' || phase.kind === 'installing'

  return (
    <section className="settings-item update-settings">
      <div className="settings-row">
        <span className="settings-label">软件更新</span>
        <span className="settings-value">
          当前版本
          {/* 刻意不复用 .settings-raw：那个类是「热键的原始加速键字符串」专用的，
              版本号挤进去之后，按它定位热键的断言会一次挑到两个元素。 */}
          <code className="update-version">{version ?? '…'}</code>
        </span>
        <button type="button" disabled={busy} onClick={() => void updater.check('manual')}>
          {phase.kind === 'checking' ? '检查中…' : '检查更新'}
        </button>
      </div>

      {phase.kind === 'idle' ? (
        <p className="settings-hint">启动时会静默查一次，只有真有新版才提示。</p>
      ) : null}

      {phase.kind === 'checking' ? <p className="update-status">正在检查更新…</p> : null}

      {phase.kind === 'latest' ? (
        <p className="update-status">已是最新版本（{phase.currentVersion}）</p>
      ) : null}

      {phase.kind === 'available' ? (
        <div className="update-status">
          <div className="settings-row">
            <span>发现新版本 {phase.version}</span>
            <button type="button" className="primary" onClick={() => void updater.install()}>
              下载并安装
            </button>
          </div>
          {phase.notes.trim() === '' ? null : <p className="update-notes">{phase.notes}</p>}
        </div>
      ) : null}

      {phase.kind === 'downloading' ? (
        <p className="update-status">
          正在下载 {phase.version}… {progressText(phase.downloaded, phase.total)}
        </p>
      ) : null}

      {phase.kind === 'installing' ? (
        <p className="update-status">{phase.version} 已下载完成，正在重启应用…</p>
      ) : null}

      {phase.kind === 'failed' ? (
        <div className="update-status update-error">
          <div className="settings-row">
            <span>
              {phase.during === 'check' ? '检查更新失败：' : '更新失败：'}
              {phase.message}
            </span>
            <button
              type="button"
              onClick={() =>
                void (phase.during === 'check' ? updater.check('manual') : updater.install())
              }
            >
              重试
            </button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
