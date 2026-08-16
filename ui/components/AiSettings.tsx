// 设置面板里的「AI 与知识问答」三节：总开关、模型服务、索引状态。
//
// 和同一个面板里的另外三项设置正好相反：那三项**都会真的动系统**，所以一律不做
// 乐观更新（见 SettingsPanel 顶部）。这里的六个配置项是**纯记录型**——写进库就算
// 生效，Rust 侧下一次用到配置时才读，没有「库改了而系统没改」的中间态，
// 所以它们走 `ipc.setSetting`（哪些键允许走它，见 ipc.ts 上那段注释）。
//
// 唯一的例外是总开关 `ai.enabled`：它必须走 `ipc.aiEnable`，因为开启要把全部笔记
// 入队并起后台线程，关闭要取消在飞的提问、停线程、把内存索引还给系统。
//
// 这一节存在的最大理由是「不能偷偷烧钱」：启用 AI 会真的开始一篇一篇地调用
// 用户配置的模型服务。所以关→开这条路上必须有一次带具体篇数的确认，
// 而且用户反悔时要能立刻停下来（见 toggleEnabled / cancelEnable）。
//
// 自己发 IPC、自己显示错误（和 SearchPanel / TrashPanel / UpdateSettingsSection 一致）。

import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useCallback, useEffect, useRef, useState } from 'react'

import { formatBytes } from '../lib/ai'
import {
  AI_INDEX_PROGRESS_EVENT,
  ipc,
  type AiStatus,
  type ConnectionReport,
  type IndexProgress,
} from '../lib/ipc'
import {
  SETTING_KEYS,
  parseAiSettings,
  type AiFormSettings,
  type AiProvider,
  type RecordOnlySettingKey,
} from '../lib/settings'

/** 哪一项正在提交。同一时刻只允许一项在途，其余控件一起禁用。 */
type Busy = 'enable' | 'save' | 'key' | 'test' | 'reindex' | 'retry' | null

/** 三个失焦即保存的文本框。 */
type TextField = 'baseUrl' | 'chatModel' | 'embedModel'

const TEXT_FIELD_KEYS: Record<TextField, RecordOnlySettingKey> = {
  baseUrl: SETTING_KEYS.aiBaseUrl,
  chatModel: SETTING_KEYS.aiChatModel,
  embedModel: SETTING_KEYS.aiEmbedModel,
}

const TEXT_FIELD_LABELS: Record<TextField, string> = {
  baseUrl: 'Base URL',
  chatModel: '对话模型',
  embedModel: 'Embedding 模型',
}

/**
 * Base URL 的占位提示按服务商换。
 *
 * 不是纯装饰：两种协议的地址形状完全不一样（OpenAI 兼容那条要带 `/v1`，
 * Ollama 是裸的本机端口），填错的表现是一句 404，用户很难从中看出是地址写法的问题。
 */
const BASE_URL_PLACEHOLDER: Record<AiProvider, string> = {
  openai: 'https://api.openai.com/v1',
  ollama: 'http://localhost:11434',
}

export function AiSettings() {
  const [status, setStatus] = useState<AiStatus | null>(null)
  // form 是编辑中的值，saved 是「已经落库的那一份」。
  // 两份分开存，才能在失焦时判断「值真的变了吗」——不判断的话每次失焦都写一次库，
  // 而换 Embedding 模型的重建提示也会在用户只是路过输入框时冒出来。
  const [form, setForm] = useState<AiFormSettings | null>(null)
  const [saved, setSaved] = useState<AiFormSettings | null>(null)
  // 密钥输入框永远从空开始：库里那份不会回到前端（外壳只给一个「设没设过」的布尔）。
  const [apiKey, setApiKey] = useState('')

  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // 等用户确认的「要为 N 篇笔记建索引」。非 null 时 AI **已经是开着的**（见 toggleEnabled）。
  const [enableConfirm, setEnableConfirm] = useState<number | null>(null)
  // 重建索引的二段式确认：第一次点只是武装，第二次才真的重建（和回收站的清空一个套路）。
  const [reindexArmed, setReindexArmed] = useState(false)
  // 换过 Embedding 模型但还没重建。存旧模型名，好在提示里说清楚换的是什么。
  const [staleEmbedModel, setStaleEmbedModel] = useState<string | null>(null)
  const [report, setReport] = useState<ConnectionReport | null>(null)

  // 面板是随手开关的，一次请求很可能在它关掉之后才回来。
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const refreshStatus = useCallback(async () => {
    try {
      const next = await ipc.aiStatus()
      if (aliveRef.current) setStatus(next)
    } catch (err) {
      if (aliveRef.current) setError(String(err))
    }
  }, [])

  useEffect(() => {
    let alive = true
    // 两个请求互不依赖，并发发出去。
    Promise.all([ipc.getSettings(), ipc.aiStatus()]).then(
      ([raw, next]) => {
        if (!alive) return
        const parsed = parseAiSettings(raw)
        setForm(parsed)
        setSaved(parsed)
        setStatus(next)
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
  }, [])

  // 索引进度。listen 是异步的（清理函数不能是 async），所以用 cancelled 标志处理
  // 「还没拿到 unlisten 就卸载了」的竞态——和 App.tsx 里那两处一样。
  useEffect(() => {
    let cancelled = false
    let unlisten: UnlistenFn | null = null

    listen<IndexProgress>(AI_INDEX_PROGRESS_EVENT, (event) => {
      const { pending, indexed } = event.payload
      setStatus((prev) => (prev === null ? prev : { ...prev, pendingNotes: pending, indexedChunks: indexed }))
      // 队列见底时再完整拉一次：内存占用、维度不符、最后一次错误都不在这个事件里，
      // 而它们恰好是索引跑完之后用户最想看的三件事。
      if (pending === 0) void refreshStatus()
    }).then(
      (fn) => {
        if (cancelled) fn()
        else unlisten = fn
      },
      (err: unknown) => setError(String(err)),
    )

    return () => {
      cancelled = true
      if (unlisten) unlisten()
    }
  }, [refreshStatus])

  /**
   * 开 / 关 AI。
   *
   * 开启这条路上的顺序是被后端定死的：`ai_enable(true)` 自己就是「真的开」——
   * 它写库、全量入队、起 worker，然后才把待索引篇数还给我们。也就是说，
   * **确认框只能在它返回之后弹**，那一刻索引已经开始跑了。
   * 所以取消这条路必须真的能停下来：`cancelEnable` 立刻调 `ai_enable(false)`，
   * 它会停 worker、取消在飞的请求、释放内存索引。
   */
  const toggleEnabled = useCallback(async (next: boolean) => {
    setBusy('enable')
    setError(null)
    setNotice(null)
    try {
      const enabled = await ipc.aiEnable(next)
      if (!aliveRef.current) return
      // 命令已经落地，界面反映的就是真实状态，这不是乐观更新。
      setStatus((prev) =>
        prev === null ? prev : { ...prev, enabled: next, pendingNotes: enabled.pendingNotes },
      )
      if (next) setEnableConfirm(enabled.pendingNotes)
      else setEnableConfirm(null)
    } catch (err) {
      if (aliveRef.current) setError(String(err))
    } finally {
      if (aliveRef.current) setBusy(null)
    }
  }, [])

  const cancelEnable = useCallback(async () => {
    setEnableConfirm(null)
    await toggleEnabled(false)
    if (aliveRef.current) setNotice('已取消，AI 保持关闭，刚开始的索引也已经停下。')
  }, [toggleEnabled])

  const confirmEnable = useCallback(async () => {
    setEnableConfirm(null)
    setNotice('已开始建立索引，可以关掉这个面板，索引在后台继续。')
    await refreshStatus()
  }, [refreshStatus])

  /** 文本框失焦即保存。值没变就一个 IPC 都不发。 */
  const commitText = useCallback(
    async (field: TextField) => {
      if (form === null || saved === null) return
      const next = form[field].trim()
      const previous = saved[field]
      if (next === previous) return

      setBusy('save')
      setError(null)
      setNotice(null)
      try {
        await ipc.setSetting(TEXT_FIELD_KEYS[field], next)
        if (!aliveRef.current) return
        setForm((prev) => (prev === null ? prev : { ...prev, [field]: next }))
        setSaved((prev) => (prev === null ? prev : { ...prev, [field]: next }))
        setNotice(`${TEXT_FIELD_LABELS[field]}已保存`)
        // 换 Embedding 模型而不重建，库里就会同时躺着两个模型的向量。检索照样能跑，
        // 只是拿不同向量空间里的数去比大小，结果毫无意义且没有任何报错。
        // 之前没填过模型名的那次不算「换」：那时还不存在任何向量。
        if (field === 'embedModel' && previous.trim() !== '') setStaleEmbedModel(previous)
        // 缺哪一项、配没配全都可能因此改变。
        await refreshStatus()
      } catch (err) {
        if (aliveRef.current) setError(String(err))
      } finally {
        if (aliveRef.current) setBusy(null)
      }
    },
    [form, refreshStatus, saved],
  )

  const changeProvider = useCallback(
    async (next: AiProvider) => {
      setForm((prev) => (prev === null ? prev : { ...prev, provider: next }))
      setBusy('save')
      setError(null)
      setNotice(null)
      try {
        await ipc.setSetting(SETTING_KEYS.aiProvider, next)
        if (!aliveRef.current) return
        setSaved((prev) => (prev === null ? prev : { ...prev, provider: next }))
        // Ollama 不需要密钥，切过去之后「缺 API Key」这条会自己消失，反之亦然。
        await refreshStatus()
      } catch (err) {
        if (aliveRef.current) setError(String(err))
      } finally {
        if (aliveRef.current) setBusy(null)
      }
    },
    [refreshStatus],
  )

  /**
   * 保存密钥。
   *
   * **输入框是空的就一个字节都不发**：空串写进去等于把用户已经存好的密钥清掉，
   * 而他只是路过这个输入框而已。想清除有单独的按钮（clearApiKey），
   * 那是一个显式动作。按钮的 disabled 也挡了一道，这里再挡一次是因为
   * 「留空不清空」这条约束值不起一次回归。
   */
  const saveApiKey = useCallback(async () => {
    const value = apiKey.trim()
    if (value === '') return

    setBusy('key')
    setError(null)
    setNotice(null)
    try {
      await ipc.setSetting(SETTING_KEYS.aiApiKey, value)
      if (!aliveRef.current) return
      // 存完立刻从 state 里抹掉：这份明文没有任何继续留在内存和 DOM 里的理由。
      setApiKey('')
      setForm((prev) => (prev === null ? prev : { ...prev, apiKeySet: true }))
      setSaved((prev) => (prev === null ? prev : { ...prev, apiKeySet: true }))
      setNotice('密钥已保存')
      await refreshStatus()
    } catch (err) {
      if (aliveRef.current) setError(String(err))
    } finally {
      if (aliveRef.current) setBusy(null)
    }
  }, [apiKey, refreshStatus])

  const clearApiKey = useCallback(async () => {
    setBusy('key')
    setError(null)
    setNotice(null)
    try {
      await ipc.setSetting(SETTING_KEYS.aiApiKey, '')
      if (!aliveRef.current) return
      setApiKey('')
      setForm((prev) => (prev === null ? prev : { ...prev, apiKeySet: false }))
      setSaved((prev) => (prev === null ? prev : { ...prev, apiKeySet: false }))
      setNotice('密钥已清除')
      await refreshStatus()
    } catch (err) {
      if (aliveRef.current) setError(String(err))
    } finally {
      if (aliveRef.current) setBusy(null)
    }
  }, [refreshStatus])

  const testConnection = useCallback(async () => {
    setBusy('test')
    setError(null)
    setNotice(null)
    setReport(null)
    try {
      const next = await ipc.aiTestConnection()
      if (aliveRef.current) setReport(next)
    } catch (err) {
      if (aliveRef.current) setError(String(err))
    } finally {
      if (aliveRef.current) setBusy(null)
    }
  }, [])

  const reindexAll = useCallback(async () => {
    // 第一次点只是武装：重建会把全部笔记重新发给 embedding 服务，是要花钱的动作。
    if (!reindexArmed) {
      setReindexArmed(true)
      return
    }
    setReindexArmed(false)
    setBusy('reindex')
    setError(null)
    setNotice(null)
    try {
      const queued = await ipc.aiReindexAll()
      if (!aliveRef.current) return
      setStaleEmbedModel(null)
      setNotice(`已清空旧向量，重新入队 ${queued} 篇笔记`)
      await refreshStatus()
    } catch (err) {
      if (aliveRef.current) setError(String(err))
    } finally {
      if (aliveRef.current) setBusy(null)
    }
  }, [refreshStatus, reindexArmed])

  const retryFailed = useCallback(async () => {
    setBusy('retry')
    setError(null)
    setNotice(null)
    try {
      const reset = await ipc.aiRetryFailed()
      if (!aliveRef.current) return
      setNotice(reset === 0 ? '没有需要重试的笔记' : `已重新入队 ${reset} 篇笔记`)
      await refreshStatus()
    } catch (err) {
      if (aliveRef.current) setError(String(err))
    } finally {
      if (aliveRef.current) setBusy(null)
    }
  }, [refreshStatus])

  if (loading) {
    return (
      <section className="settings-item">
        <div className="settings-row">
          <span className="settings-label">AI 与知识问答</span>
        </div>
        <p className="settings-hint">加载中…</p>
      </section>
    )
  }

  if (form === null || status === null) {
    return (
      <section className="settings-item">
        <div className="settings-row">
          <span className="settings-label">AI 与知识问答</span>
        </div>
        <p className="settings-error">{error ?? '读不到 AI 状态'}</p>
      </section>
    )
  }

  const disabled = busy !== null
  // 配置没填全时不让开：worker 一醒来就会因为「缺 X」失败，攒一堆没意义的错误。
  // 关的方向永远允许——用户随时可以停掉。
  const cannotEnable = !status.enabled && !status.configured

  return (
    <>
      <section className="settings-item ai-settings">
        <label className="settings-row">
          <input
            type="checkbox"
            checked={status.enabled}
            disabled={disabled || cannotEnable}
            onChange={(event) => void toggleEnabled(event.target.checked)}
          />
          <span className="settings-label">启用 AI 与知识问答</span>
          {busy === 'enable' ? <span className="settings-value">切换中…</span> : null}
        </label>
        {/* spec §9.3 要求这句话必须出现在界面上：这是用户唯一一次被明确告知
            「笔记内容会离开这台机器」的机会。 */}
        <p className="settings-hint">
          启用后，提问时命中的笔记片段会发送给你配置的模型服务。
        </p>
        {cannotEnable ? (
          <p className="settings-hint">
            还不能启用：缺少{status.missingField ?? '必要配置'}。先在下面把模型服务配好。
          </p>
        ) : null}

        {enableConfirm !== null ? (
          <div className="settings-warn">
            <p>
              将为 {enableConfirm} 篇笔记建立索引，会调用你配置的模型服务并产生费用，继续？
            </p>
            <p>索引已经开始了。点「取消」会立刻停下并把 AI 关回去。</p>
            <div className="trash-item-actions">
              <button type="button" className="primary" disabled={disabled} onClick={() => void confirmEnable()}>
                继续
              </button>
              <button type="button" disabled={disabled} onClick={() => void cancelEnable()}>
                取消
              </button>
            </div>
          </div>
        ) : null}

        {error ? <p className="settings-error">{error}</p> : null}
        {notice ? <p className="settings-hint">{notice}</p> : null}
      </section>

      <section className="settings-item ai-settings">
        <div className="settings-row">
          <span className="settings-label">模型服务</span>
          <span className="settings-value">
            {status.configured ? '配置完整' : `缺少${status.missingField ?? '必要配置'}`}
          </span>
        </div>

        <label className="ai-field">
          <span className="ai-field-label">服务商</span>
          <select
            value={form.provider}
            disabled={disabled}
            onChange={(event) => void changeProvider(event.target.value === 'ollama' ? 'ollama' : 'openai')}
          >
            <option value="openai">OpenAI 兼容</option>
            <option value="ollama">Ollama</option>
          </select>
        </label>

        {(['baseUrl', 'chatModel', 'embedModel'] as const).map((field) => (
          <label className="ai-field" key={field}>
            <span className="ai-field-label">{TEXT_FIELD_LABELS[field]}</span>
            <input
              type="text"
              value={form[field]}
              disabled={disabled}
              placeholder={field === 'baseUrl' ? BASE_URL_PLACEHOLDER[form.provider] : undefined}
              onChange={(event) => {
                const value = event.target.value
                setForm((prev) => (prev === null ? prev : { ...prev, [field]: value }))
              }}
              onBlur={() => void commitText(field)}
            />
          </label>
        ))}

        {/* Ollama 走本机，没有密钥这回事，留着一个填了也没用的输入框只会让人以为漏配了。
            但**库里已经存着密钥时照样要显示**：从 OpenAI 切到 Ollama 的用户否则
            既看不到「这台机器上存着一份凭证」的提醒，也没有清除它的入口。 */}
        {form.provider === 'openai' || form.apiKeySet ? (
          <>
            <p className="settings-hint">
              API Key：{form.apiKeySet ? '已设置（留空则不修改）' : '未设置'}
              {form.provider === 'ollama' ? '。Ollama 不需要密钥，可以清除。' : ''}
            </p>
            <div className="ai-field">
              <span className="ai-field-label">API Key</span>
              <input
                type="password"
                value={apiKey}
                disabled={disabled}
                placeholder={form.apiKeySet ? '留空则不修改' : 'sk-…'}
                autoComplete="off"
                onChange={(event) => setApiKey(event.target.value)}
              />
              <button type="button" disabled={disabled || apiKey.trim() === ''} onClick={() => void saveApiKey()}>
                {busy === 'key' ? '保存中…' : '保存密钥'}
              </button>
              <button
                type="button"
                className="subtle"
                disabled={disabled || !form.apiKeySet}
                title="把库里存的密钥写成空串"
                onClick={() => void clearApiKey()}
              >
                清除密钥
              </button>
            </div>
            {/* spec §9.2 要求的原话。用户选择了把密钥存进 SQLite，
                那就得让他知道这个文件本身等同于凭证。 */}
            <p className="settings-warn">密钥保存在本地数据库中，请勿分享该文件。</p>
          </>
        ) : null}

        <div className="settings-row">
          <button type="button" disabled={disabled} onClick={() => void testConnection()}>
            {busy === 'test' ? '测试中…' : '测试连接'}
          </button>
          <span className="settings-value">会真的各发一次 embedding 与对话请求</span>
        </div>

        {report !== null ? (
          <div className="ai-report">
            <p className={report.embedOk ? 'settings-hint' : 'settings-error'}>
              Embedding {report.embedOk ? `✓ ${report.embedDim ?? '?'} 维` : '✗ 不通'}
            </p>
            <p className={report.chatOk ? 'settings-hint' : 'settings-error'}>
              对话 {report.chatOk ? '✓ 通' : '✗ 不通'}
            </p>
            {report.error !== null ? <p className="settings-error">{report.error}</p> : null}
          </div>
        ) : null}

        {staleEmbedModel !== null ? (
          <div className="settings-warn">
            <p>
              Embedding 模型已从「{staleEmbedModel}」换成「{saved?.embedModel ?? ''}」。
              旧向量来自上一个模型，和新向量不在同一个空间里，混着检索出来的结果会莫名其妙——
              建议现在重建索引。
            </p>
            <div className="trash-item-actions">
              <button type="button" disabled={disabled} onClick={() => void reindexAll()}>
                {reindexArmed ? '确认重建（会重新调用模型）' : '重建索引'}
              </button>
              <button type="button" className="subtle" disabled={disabled} onClick={() => setStaleEmbedModel(null)}>
                以后再说
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="settings-item ai-settings">
        <div className="settings-row">
          <span className="settings-label">索引</span>
          <span className="settings-value">
            待索引 {status.pendingNotes} 篇 · 已索引 {status.indexedChunks} 块 · 内存{' '}
            {formatBytes(status.memoryBytes)}
          </span>
        </div>

        {status.dimMismatches > 0 ? (
          <p className="settings-warn">
            有 {status.dimMismatches} 条向量来自其他模型（维度对不上，已被跳过），建议重建索引。
          </p>
        ) : null}

        {status.lastError !== null ? (
          <div className="ai-report">
            <p className="settings-error">上一次索引失败：{status.lastError}</p>
            <button type="button" disabled={disabled} onClick={() => void retryFailed()}>
              {busy === 'retry' ? '处理中…' : '重试全部'}
            </button>
          </div>
        ) : null}

        <div className="trash-item-actions">
          <button
            type="button"
            className={reindexArmed ? 'danger' : ''}
            disabled={disabled}
            title="清空全部向量并从头再算一遍，会重新调用 embedding 服务"
            onClick={() => void reindexAll()}
          >
            {busy === 'reindex' ? '重建中…' : reindexArmed ? '确认重建（会重新调用模型）' : '重建索引'}
          </button>
          {reindexArmed ? (
            <button type="button" className="subtle" onClick={() => setReindexArmed(false)}>
              取消
            </button>
          ) : null}
        </div>
        <p className="settings-hint">
          换过 Embedding 模型之后必须重建一次，否则新旧向量会混在一起。
        </p>
      </section>
    </>
  )
}

export default AiSettings
