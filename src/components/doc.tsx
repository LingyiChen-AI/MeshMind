// 对正文 JSON 的两个只读判断，App 与 Capture 共用。
//
// 为什么需要 collectAttachmentIds：`update_note` 是**全量替换** note_attachments 的
// （crates/core/src/notes/mod.rs 里先 DELETE 再 link_attachments），
// 保存时传空数组等于把这条笔记的所有附件解绑，下一次 collect_garbage 就会把
// 粘贴进来的图片文件真删掉，正文里只剩「图片已丢失」。所以每次保存都得把正文里
// 实际引用的 attachmentId 一起交回去。

interface DocNode {
  type?: string
  text?: string
  attrs?: Record<string, unknown>
  content?: DocNode[]
}

function parse(bodyJson: string): DocNode | null {
  try {
    const parsed: unknown = JSON.parse(bodyJson)
    if (parsed && typeof parsed === 'object') return parsed as DocNode
  } catch {
    // 脏数据当作空文档处理，绝不抛给调用方
  }
  return null
}

function walk(node: DocNode, visit: (node: DocNode) => void): void {
  visit(node)
  for (const child of node.content ?? []) walk(child, visit)
}

/** 正文里实际引用到的附件 id，去重后按出现顺序返回。 */
export function collectAttachmentIds(bodyJson: string): number[] {
  const root = parse(bodyJson)
  if (!root) return []

  const ids: number[] = []
  walk(root, (node) => {
    const raw = node.attrs?.attachmentId
    if (typeof raw === 'number' && Number.isFinite(raw) && !ids.includes(raw)) ids.push(raw)
  })
  return ids
}

/** 没有任何非空白文字、也没有任何附件节点，就算空文档（不值得存）。 */
export function isEmptyDoc(bodyJson: string): boolean {
  const root = parse(bodyJson)
  if (!root) return true

  let empty = true
  walk(root, (node) => {
    if (typeof node.text === 'string' && node.text.trim().length > 0) empty = false
    if (node.attrs?.attachmentId !== undefined && node.attrs.attachmentId !== null) empty = false
  })
  return empty
}
