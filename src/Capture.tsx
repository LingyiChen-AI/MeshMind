// 快捕窗口（label = capture）：无边框置顶，只有一个编辑区。
//
// 这个窗口是「隐藏而不是关闭」的——全局快捷键唤起时 show()，存完 hide()，
// 所以组件不会卸载，state 要自己清干净，否则下次唤起还留着上次的内容。

import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useCallback, useEffect, useRef, useState } from 'react'

import { collectAttachmentIds, isEmptyDoc } from './lib/doc'
import { Editor, EMPTY_DOC } from './editor/Editor'
import { ipc } from './lib/ipc'
import { keys } from './lib/platform'

export function Capture() {
  const [body, setBody] = useState<string>(EMPTY_DOC)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // 键盘处理器挂在 document 上，读到的必须是最新值；
  // 用 ref 中转以免每次输入都重新绑定监听器。
  const bodyRef = useRef(body)
  bodyRef.current = body
  const savingRef = useRef(saving)
  savingRef.current = saving

  // 收起窗口。主路径走 Rust 命令：前端直接 hide() 需要 `core:window:allow-hide`，
  // 而 capabilities 里的 `core:window:default` 是只读集合、不含它，会被 ACL 拒掉。
  // 命令不可用时（旧版外壳）再退回直接 hide——两条都失败才算真的收不起来，
  // 那时必须告诉用户，否则窗口赖在屏幕上而界面上毫无解释。
  const hide = useCallback(() => {
    ipc
      .hideCaptureWindow()
      .catch(async (err: unknown) => {
        console.error('[capture] hide_capture_window 失败，回退直接 hide', err)
        await getCurrentWindow().hide()
      })
      .catch((err: unknown) => {
        console.error('[capture] 隐藏窗口失败', err)
        setError(`窗口收不起来：${String(err)}`)
      })
  }, [])

  const save = useCallback(async () => {
    if (savingRef.current) return // 连按两次 ⌘Enter 不该存两条
    const bodyJson = bodyRef.current
    if (isEmptyDoc(bodyJson)) {
      hide()
      return
    }

    setSaving(true)
    try {
      await ipc.createNote(bodyJson, collectAttachmentIds(bodyJson))
      // 主窗口 listen('note-saved') 后会刷新列表
      await emit('note-saved')
      setBody(EMPTY_DOC)
      setError(null)
      hide()
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }, [hide])

  const cancel = useCallback(() => {
    // 有内容时二次确认：这个窗口按 Esc 太顺手了，误触一下刚敲的东西就没了。
    if (!isEmptyDoc(bodyRef.current) && !window.confirm('放弃这条笔记？')) return
    setBody(EMPTY_DOC)
    setError(null)
    hide()
  }, [hide])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        void save()
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        cancel()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [save, cancel])

  /**
   * 退出前把草稿存下来。
   *
   * 这个窗口是 hide 而不是关闭的，所以它随时可能攥着一段用户敲了一半、既没按
   * ⌘Enter 也没按 Esc 的内容。托盘点「退出」时这段内容有三种下场，取舍如下：
   *
   * 1. 静默丢掉 —— 排除。用户根本不知道快捕窗口里还留着东西。
   * 2. 弹确认框问「保存吗」 —— 排除。`window.confirm` 会同步阻塞 JS，而外壳只等
   *    2 秒就强杀：用户还在看那个框，进程已经没了，内容照样丢，还白卡两秒。
   *    更糟的是这个窗口此刻多半是隐藏的，那个框可能根本不在用户眼前。
   * 3. 直接存成一条笔记 —— 采用。快捕本来的语义就是「这段内容将来会成为一条笔记」，
   *    退出时替用户按一下 ⌘Enter 是最接近他本意的动作；真不想要的话，
   *    下次打开在回收站……不，在列表里删掉即可，代价远小于丢内容。
   *
   * **不调 confirm_quit**：那是主窗口的活儿。这里也调的话，两个窗口谁先存完谁就先
   * 让外壳退出——快捕这边只有一次 create_note，几乎总是先完成，于是主窗口的落盘
   * 会在写到一半时被 exit(0) 打断。而主窗口是不可能不存在的（点叉只是隐藏，
   * 见 src-tauri/src/main.rs 的 CloseRequested 处理），把回执交给它是安全的；
   * 万一它真的没响应，外壳的 2 秒兜底仍然兜得住。
   *
   * 也不 emit('note-saved')：主窗口正在退出，刷新列表没有意义。
   */
  const saveBeforeQuit = useCallback(async () => {
    // 正常保存已经在途：那次存的是同一份内容，再存一次就是两条重复笔记。
    if (savingRef.current) return
    const bodyJson = bodyRef.current
    if (isEmptyDoc(bodyJson)) return
    try {
      await ipc.createNote(bodyJson, collectAttachmentIds(bodyJson))
      setBody(EMPTY_DOC)
    } catch (err) {
      // 这里不重试也不阻塞：外壳最多再等 2 秒。错误照样摆出来——万一退出被兜底
      // 延后、或者用户又把窗口叫了出来，他至少知道发生过什么，内容也还在编辑器里。
      console.error('[capture] 退出前保存草稿失败', err)
      setError(String(err))
    }
  }, [])

  // listen 是异步的，清理函数不能是 async：用 cancelled 标志处理
  // 「还没拿到 unlisten 就卸载了」的竞态（和主窗口里那几个 listen 一个写法）。
  useEffect(() => {
    let cancelled = false
    let unlisten: UnlistenFn | null = null

    listen('app-quit-requested', () => {
      void saveBeforeQuit()
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
  }, [saveBeforeQuit])

  // 窗口是 hide/show 而不是重建，autoFocus 只在首次挂载生效。
  // 再次唤起时窗口拿到焦点，但光标不在编辑区里，用户敲字会掉进虚空——
  // 所以每次窗口获得焦点都把光标塞回可编辑区。
  useEffect(() => {
    function focusEditor() {
      document.querySelector<HTMLElement>('.editor [contenteditable="true"]')?.focus()
    }
    window.addEventListener('focus', focusEditor)
    return () => window.removeEventListener('focus', focusEditor)
  }, [])

  return (
    <div className="capture">
      <div className="capture-body">
        {/* 粘贴失败必须走界面：快捕窗口本来就只有一个编辑区，
            用户看不到 console，静默失败等于「⌘V 没反应」。 */}
        <Editor bodyJson={body} onChange={setBody} onError={setError} autoFocus />
      </div>
      {error ? (
        <div className="error-bar" role="alert" onClick={() => setError(null)}>
          {error}
          <span className="error-dismiss">点击关闭</span>
        </div>
      ) : null}
      <div className="capture-tip">
        {saving ? '保存中…' : `${keys.save} 保存 · Esc 取消 · 可直接粘贴截图`}
      </div>
    </div>
  )
}

export default Capture
