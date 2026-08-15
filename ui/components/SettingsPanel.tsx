// 设置面板：遮罩 + 居中面板，Esc / 点遮罩关闭（和搜索、回收站同一套骨架）。
//
// 三项设置的共同点，也是这个组件里最要紧的约束：**它们都会真的动系统**
// （注册全局热键、切换 Dock 图标策略、写 LaunchAgent/注册表），失败率不低——
// 热键被别的应用占用是家常便饭。所以这里**一律不做乐观更新**：
// 先禁用控件、等命令回来、成功了才改本地 state。失败时 state 一动不动，
// 因为外壳那三个命令在失败路径上都会把系统状态回滚，界面保持旧值才是真实状态。
//
// 反过来说，乐观更新在这里的代价是：开关看着已经开了、Dock 图标却还在，
// 用户只能重启应用才知道到底哪个是真的。
//
// 自己发 IPC、自己显示错误（和 SearchPanel / TrashPanel 一致），不往 App 抛。

import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef, useState } from 'react'

import { acceleratorFromEvent, formatAccelerator } from '../lib/accelerator'
import { ipc } from '../lib/ipc'
import { isMac } from '../lib/platform'
import { type AppSettings, parseSettings } from '../lib/settings'
import { UpdateSettingsSection } from './UpdateNotice'

/** 哪一项正在提交。同一时刻只允许一项在途，其余控件一起禁用。 */
type Busy = 'hotkey' | 'dock' | 'autostart' | null

export interface SettingsPanelProps {
  onClose: () => void
}

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  // 正在等用户按组合键。录制期间所有按键都被这个面板吃掉（见 onRecordKeyDown）。
  const [recording, setRecording] = useState(false)
  // 录制过程中的即时反馈（「这个键不能用」之类），和真正的失败错误分开显示。
  const [recordHint, setRecordHint] = useState<string | null>(null)

  const recorderRef = useRef<HTMLButtonElement | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let alive = true
    setLoading(true)
    ipc.getSettings().then(
      (raw) => {
        if (!alive) return
        setSettings(parseSettings(raw, isMac))
        setError(null)
        setLoading(false)
      },
      (err: unknown) => {
        if (!alive) return
        setError(String(err))
        setLoading(false)
      },
    )
    return () => {
      alive = false
    }
  }, [reloadKey])

  // Esc 关面板。录制中的 Esc 不会走到这里：onRecordKeyDown 已经 stopPropagation 了，
  // 那时 Esc 的语义是「取消录制」而不是「关面板」。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // macOS 的 Safari/WKWebView 点按钮**不会**给它焦点，不显式 focus 的话
  // 键盘事件根本不会落到录制按钮上，用户按半天没反应。
  useEffect(() => {
    if (recording) recorderRef.current?.focus()
  }, [recording])

  const applyHotkey = useCallback(async (accelerator: string) => {
    setBusy('hotkey')
    setError(null)
    setNotice(null)
    setRecordHint(null)
    try {
      await ipc.setCaptureHotkey(accelerator)
      // 成功之后才认这个值。isDefault 归 false：现在设置表里真的有它了。
      setSettings((prev) =>
        prev === null ? prev : { ...prev, captureHotkey: accelerator, captureHotkeyIsDefault: false },
      )
      setNotice(`快捕热键已改为 ${formatAccelerator(accelerator, isMac)}`)
      setRecording(false)
    } catch (err) {
      // 外壳的错误消息里会带上冲突的键名并说明「原热键保持不变」，原样展示。
      // 不改 settings：这次改键没生效，界面必须继续显示原来那个键。
      setError(String(err))
      setRecording(false)
    } finally {
      setBusy(null)
    }
  }, [])

  const onRecordKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      // 录制期间把整个键盘接管过来：不拦的话 Esc 会关掉面板、⌘K 会把搜索面板
      // 顶到前面来，用户按的组合还没录上，界面先跳走了。
      event.preventDefault()
      event.stopPropagation()
      if (busy !== null) return

      if (event.code === 'Escape') {
        setRecording(false)
        setRecordHint(null)
        return
      }

      const outcome = acceleratorFromEvent(
        {
          code: event.code,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
        },
        isMac,
      )
      if (outcome.kind === 'modifiers-only') return // 还在按修饰键，等主键
      if (outcome.kind === 'rejected') {
        setRecordHint(outcome.message)
        return
      }
      void applyHotkey(outcome.accelerator)
    },
    [applyHotkey, busy],
  )

  const toggleDock = useCallback(async (hide: boolean) => {
    setBusy('dock')
    setError(null)
    setNotice(null)
    try {
      await ipc.setHideDockIcon(hide)
      setSettings((prev) => (prev === null ? prev : { ...prev, hideDockIcon: hide }))
      setNotice(hide ? 'Dock 图标已隐藏，主窗口改从托盘菜单或快捕热键唤回' : 'Dock 图标已恢复')
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }, [])

  const toggleAutostart = useCallback(async (enabled: boolean) => {
    setBusy('autostart')
    setError(null)
    setNotice(null)
    try {
      await ipc.setAutostart(enabled)
      setSettings((prev) => (prev === null ? prev : { ...prev, autostart: enabled }))
      setNotice(enabled ? '已开启开机自启' : '已关闭开机自启')
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }, [])

  const disabled = busy !== null

  return (
    <div className="search-overlay" onClick={onClose}>
      <div className="search-panel settings-panel" onClick={(event) => event.stopPropagation()}>
        <div className="trash-head">
          <span className="trash-title">设置</span>
        </div>

        {error ? <div className="search-error">{error}</div> : null}
        {notice ? <div className="trash-notice">{notice}</div> : null}

        {loading ? <div className="search-empty">加载中…</div> : null}

        {!loading && settings === null ? (
          <div className="search-empty">
            <p>读不到设置</p>
            <button type="button" onClick={() => setReloadKey((prev) => prev + 1)}>
              重试
            </button>
          </div>
        ) : null}

        {settings !== null ? (
          <div className="settings-body">
            <section className="settings-item">
              <div className="settings-row">
                <span className="settings-label">快捕热键</span>
                <span className="settings-value">
                  {formatAccelerator(settings.captureHotkey, isMac)}
                  <code className="settings-raw">{settings.captureHotkey}</code>
                </span>
                <button
                  type="button"
                  ref={recorderRef}
                  className={recording ? 'recording' : ''}
                  disabled={disabled}
                  onKeyDown={recording ? onRecordKeyDown : undefined}
                  onBlur={() => setRecording(false)}
                  onClick={() => {
                    setRecordHint(null)
                    setRecording((prev) => !prev)
                  }}
                >
                  {busy === 'hotkey' ? '设置中…' : recording ? '按下组合键…' : '修改'}
                </button>
              </div>
              <p className="settings-hint">
                {settings.captureHotkeyIsDefault
                  ? '当前用的是平台默认键（还没单独设置过）。'
                  : null}
                在任何应用里按这个组合都会唤起快捕窗口。
              </p>
              {recording ? (
                <p className="settings-hint">
                  {`直接按下想要的组合（至少带一个 ${
                    isMac ? 'Control / Option / Command' : 'Ctrl / Alt'
                  }），Esc 取消。注意：现在生效的那个快捕热键会被系统直接截走去开快捕窗口，按它是录不进来的。`}
                </p>
              ) : null}
              {recordHint ? <p className="settings-warn">{recordHint}</p> : null}
            </section>

            {/* 非 macOS 上不渲染这一项：Windows 的任务栏图标由窗口自己控制，
                Linux 各桌面环境行为不一，外壳在这两个平台上只落库、什么也不做。 */}
            {isMac ? (
              <section className="settings-item">
                <label className="settings-row">
                  <input
                    type="checkbox"
                    checked={settings.hideDockIcon}
                    disabled={disabled}
                    onChange={(event) => void toggleDock(event.target.checked)}
                  />
                  <span className="settings-label">隐藏 Dock 图标</span>
                  {busy === 'dock' ? <span className="settings-value">切换中…</span> : null}
                </label>
                <p className="settings-hint">
                  隐藏后 MeshMind 从 Dock 和 Cmd+Tab 里一起消失，变成纯菜单栏应用。
                  代价是「点 Dock 图标唤回主窗口」这条路也一起没了——之后唤回主窗口只剩
                  两个入口：<b>托盘菜单</b>和<b>快捕热键 {formatAccelerator(settings.captureHotkey, isMac)}</b>。
                </p>
                <p className="settings-warn">
                  开之前请先确认那个热键真的能用：全局热键被别的应用占用时会静默失效
                  （应用没有查询接口，这里查不出来，只有托盘图标的提示文字上会带一个 ⚠）。
                  万一热键正好是失效的，隐藏 Dock 图标之后就只剩托盘一个入口了。
                </p>
              </section>
            ) : null}

            <section className="settings-item">
              <label className="settings-row">
                <input
                  type="checkbox"
                  checked={settings.autostart}
                  disabled={disabled}
                  onChange={(event) => void toggleAutostart(event.target.checked)}
                />
                <span className="settings-label">开机自启</span>
                {busy === 'autostart' ? <span className="settings-value">切换中…</span> : null}
              </label>
              <p className="settings-hint">
                登录系统后自动在后台启动，随时可以用快捕热键记东西。
              </p>
            </section>

            {/* 手动检查更新。和启动时那次静默检查相反，这里**每一种结果都要说话**：
                用户主动点了一下却什么都没变，他分不清是已经最新还是按钮坏了。
                这一节自带状态与 IPC，不读设置表，只是借这个面板当入口。 */}
            <UpdateSettingsSection />
          </div>
        ) : null}

        <div className="search-tip">改动立即生效并写入设置 · Esc 关闭</div>
      </div>
    </div>
  )
}

export default SettingsPanel
