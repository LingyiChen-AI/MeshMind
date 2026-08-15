// 快捕窗口（label = capture）：无边框置顶，只有一个编辑区。
//
// 这个窗口是「隐藏而不是关闭」的——全局快捷键唤起时 show()，存完 hide()，
// 所以组件不会卸载，state 要自己清干净，否则下次唤起还留着上次的内容。

import { emit } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useCallback, useEffect, useRef, useState } from 'react'

import { collectAttachmentIds, isEmptyDoc } from './components/doc'
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

  const hide = useCallback(() => {
    getCurrentWindow()
      .hide()
      .catch((err: unknown) => console.error('[capture] 隐藏窗口失败', err))
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
        <Editor bodyJson={body} onChange={setBody} autoFocus />
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
