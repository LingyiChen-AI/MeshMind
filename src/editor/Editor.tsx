// TipTap 编辑器封装。对外只暴露「一个 JSON 字符串进、一个 JSON 字符串出」，
// 上层不需要知道 TipTap 的存在，也拿不到 editor 实例——这样以后换编辑器内核
// 只用改这个文件。
//
// @tiptap v3：`setContent` 的第二个参数是 options 对象（v2 是位置参数
// `setContent(content, emitUpdate, parseOptions)`），抑制 update 事件要写
// `setContent(doc, { emitUpdate: false })`。

import type { JSONContent } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useRef } from 'react'

import { AttachmentImage } from './AttachmentImage'
import { extractPastedImage } from '../lib/clipboard'
import { ipc } from '../lib/ipc'

/** 空文档。新建笔记、正文损坏兜底都用它。 */
export const EMPTY_DOC = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] })

/**
 * 把库里存的正文字符串解析成 TipTap 文档。
 * 解析不出来（空字符串、历史脏数据）就退回空文档，绝不让编辑器崩在渲染里。
 */
function parseDoc(bodyJson: string): JSONContent {
  try {
    const parsed: unknown = JSON.parse(bodyJson)
    if (parsed && typeof parsed === 'object') return parsed as JSONContent
  } catch {
    // 落到下面的兜底
  }
  return JSON.parse(EMPTY_DOC) as JSONContent
}

/** 剪贴板里有没有图片文件项。必须同步判断——handlePaste 要同步返回 boolean。 */
function hasImageItem(clipboardData: DataTransfer | null): boolean {
  if (!clipboardData) return false
  return Array.from(clipboardData.items ?? []).some(
    (item) => item.kind === 'file' && item.type.toLowerCase().startsWith('image/'),
  )
}

export interface EditorProps {
  bodyJson: string
  onChange: (bodyJson: string) => void
  autoFocus?: boolean
}

export function Editor({ bodyJson, onChange, autoFocus }: EditorProps) {
  // onChange 每次渲染都可能是新函数，但编辑器实例只该创建一次：
  // 用 ref 中转，避免把 onChange 塞进 useEditor 的依赖里导致编辑器反复重建。
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const editor = useEditor({
    extensions: [StarterKit, AttachmentImage],
    content: parseDoc(bodyJson),
    autofocus: autoFocus ? 'end' : false,
    onUpdate: ({ editor: instance }) => {
      onChangeRef.current(JSON.stringify(instance.getJSON()))
    },
    editorProps: {
      handlePaste: (view, event) => {
        // 没有图片就交回 TipTap：纯文本、HTML、内部富文本片段它处理得比我们好。
        if (!hasImageItem(event.clipboardData)) return false

        // 有图片：接管。落盘是异步的，而这里必须同步返回 true 阻止默认行为，
        // 所以异步部分只能 fire-and-forget，落地后再 dispatch 一个事务插节点。
        void extractPastedImage(event.clipboardData)
          .then(async (image) => {
            if (!image) return
            const attachment = await ipc.storeAttachment(image.bytes, image.ext)
            if (view.isDestroyed) return

            const type = view.state.schema.nodes.attachmentImage
            if (!type) return
            const node = type.create({ attachmentId: attachment.id })
            view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView())
          })
          .catch((err: unknown) => {
            // ipc / attachments 层 reject 的是字符串。至少要留下痕迹，
            // 否则用户会看到「粘贴了但什么都没发生」。
            console.error('[editor] 粘贴图片失败', err)
          })

        return true
      },
    },
  })

  // 切换笔记（或外部改写正文）时把内容同步进来。
  // emitUpdate: false 是关键——否则刚载入就会触发一次 onUpdate，
  // 上层会把「加载」误判成「用户编辑」，白存一次盘，还可能把脏状态写回去。
  useEffect(() => {
    if (!editor) return
    const current = JSON.stringify(editor.getJSON())
    if (current === bodyJson) return
    editor.commands.setContent(parseDoc(bodyJson), { emitUpdate: false })
  }, [editor, bodyJson])

  return <EditorContent editor={editor} className="editor" />
}

export default Editor
