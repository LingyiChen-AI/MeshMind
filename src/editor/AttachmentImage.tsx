// 正文里的图片节点。
//
// **核心设计约束**：文档 JSON 里只存 `attachmentId`（一个数字），
// 绝不存 blob URL。blob URL 是 `URL.createObjectURL` 产生的进程内句柄，
// 应用一重启就全部失效；一旦写进正文并落库，等于在笔记里埋了一颗定时炸弹——
// 今天能显示，明天打开就是一堆裂图，而且坏数据已经进了 SQLite，改不回来。
// 所以：持久化的是 id，blob URL 只在 NodeView 渲染时按需现取（走
// `attachmentUrl` 的进程内缓存），是纯粹的视图层产物。

import { Node } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react'
import { useEffect, useState } from 'react'

import { attachmentUrl } from '../lib/attachments'

function AttachmentImageView(props: ReactNodeViewProps) {
  // node.attrs 是 Record<string, any>，这里收窄成实际会出现的两种值。
  const attachmentId = props.node.attrs.attachmentId as number | null
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (attachmentId === null || attachmentId === undefined) {
      setUrl(null)
      setFailed(true)
      return
    }

    // 切换笔记时 NodeView 会被大批量卸载，而 attachmentUrl 是异步的：
    // 不加这个标志，Promise 落地时组件早已不在，setState 会报警告。
    let alive = true
    setUrl(null)
    setFailed(false)

    attachmentUrl(attachmentId).then(
      (resolved) => {
        if (alive) setUrl(resolved)
      },
      (err: unknown) => {
        // ipc 层 reject 的是字符串（中文消息），不是 Error。
        console.error('[attachmentImage] 读取附件失败', attachmentId, err)
        if (alive) setFailed(true)
      },
    )

    return () => {
      alive = false
    }
  }, [attachmentId])

  return (
    <NodeViewWrapper className="attachment-image">
      {failed ? (
        <span className="attachment-missing">图片已丢失（#{attachmentId ?? '?'}）</span>
      ) : url ? (
        <img src={url} data-attachment-id={attachmentId ?? undefined} alt="" />
      ) : null}
    </NodeViewWrapper>
  )
}

export const AttachmentImage = Node.create({
  name: 'attachmentImage',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      attachmentId: {
        default: null,
        parseHTML: (element) => {
          const raw = element.getAttribute('data-attachment-id')
          if (raw === null) return null
          const id = Number(raw)
          return Number.isFinite(id) ? id : null
        },
        renderHTML: (attributes) => {
          if (attributes.attachmentId === null || attributes.attachmentId === undefined) return {}
          return { 'data-attachment-id': String(attributes.attachmentId) }
        },
      },
    }
  },

  parseHTML() {
    return [{ tag: 'img[data-attachment-id]' }]
  },

  // 注意这里输出的 <img> 没有 src：序列化出来的 HTML 只是 id 的载体，
  // 真正的图源在 NodeView 里现取。
  renderHTML({ HTMLAttributes }) {
    return ['img', HTMLAttributes]
  },

  addNodeView() {
    return ReactNodeViewRenderer(AttachmentImageView)
  },
})

export default AttachmentImage
