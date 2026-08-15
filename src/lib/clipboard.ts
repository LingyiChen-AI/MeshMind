// 粘贴事件里的图片解析。编辑器的 onPaste 先问这里要不要接管：
// 拿到 PastedImage 就走 ipc.storeAttachment 存盘并插图，拿到 null 就 return false，
// 把事件交回浏览器默认的文本粘贴行为。

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
}

/** MIME 到扩展名。未知类型返回 'bin'，让文件仍能落盘而不是丢掉。 */
export function extensionForMime(mime: string): string {
  // DataTransferItem.type 偶尔带参数后缀（如 `image/jpeg; charset=binary`），先剥掉。
  const base = mime.split(';')[0].trim().toLowerCase()
  return MIME_EXT[base] ?? 'bin'
}

export interface PastedImage {
  /** 普通数字数组：Tauri IPC 的 JSON 通道不认 Uint8Array。 */
  bytes: number[]
  ext: string
}

/**
 * 从粘贴事件的 DataTransfer 里取第一个图片文件并读成字节数组。
 * 没有图片（纯文本粘贴、剪贴板为空）返回 null。
 */
export async function extractPastedImage(
  clipboardData: DataTransfer | null,
): Promise<PastedImage | null> {
  if (!clipboardData) return null

  const items = Array.from(clipboardData.items ?? [])
  const target = items.find(
    (item) => item.kind === 'file' && item.type.toLowerCase().startsWith('image/'),
  )
  if (!target) return null

  const file = target.getAsFile()
  if (!file) return null

  const buffer = await file.arrayBuffer()
  return {
    bytes: Array.from(new Uint8Array(buffer)),
    ext: extensionForMime(target.type),
  }
}
