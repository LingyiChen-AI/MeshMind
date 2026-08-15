// 附件字节 → 可直接塞进 <img src> 的 URL。
//
// 为什么用 blob URL 而不是 Tauri 的 asset 协议（`convertFileSrc`）：
// asset 协议要在 tauri.conf.json 里配 assetProtocol scope，要处理路径转义
// （Windows 盘符、空格、中文名各有各的坑），而且 macOS 的 `asset://` 与
// Windows 的 `http://asset.localhost/` 在 CSP 和相对路径解析上行为并不一致，
// 两个平台得分别调。blob URL 零配置、零平台差异，走的是已经拿到手的字节。
// 代价是图片常驻内存——个人笔记这个量级（几百张图、单张几百 KB）完全够用；
// 真到了撑不住的那天再换 asset 协议，换的时候只需要改这一个函数。

import { ipc } from './ipc'

// 同一张图会在列表、编辑器、预览里被反复请求，缓存的是 Promise 而不是结果：
// 并发请求同一 id 时只会真正读一次盘。
const cache = new Map<number, Promise<string>>()

/**
 * 按魔数猜 MIME。`readAttachment` 只回字节不回类型，而 blob 的 type 为空时
 * <img> 只能靠自己嗅探——位图能蒙对，SVG 蒙不对（必须显式 image/svg+xml 才渲染）。
 * 猜不出就留空，交给浏览器嗅探。
 */
function sniffMime(bytes: Uint8Array): string {
  const at = (offset: number, ...sig: number[]) => sig.every((b, i) => bytes[offset + i] === b)
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  // RIFF....WEBP：'WEBP' 在偏移 8，前 4 字节是 RIFF，中间 4 字节是长度
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
  if (at(0, 0x42, 0x4d)) return 'image/bmp'
  // SVG 是文本，开头可能是 `<svg`、BOM 或 `<?xml`，统一按前几个非空白字符判断
  const head = new TextDecoder().decode(bytes.subarray(0, 64)).trimStart()
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'image/svg+xml'
  return ''
}

/** 取附件的 blob URL，按 id 缓存。失败时不留下坏缓存，下次调用会重试。 */
export async function attachmentUrl(id: number): Promise<string> {
  const cached = cache.get(id)
  if (cached) return cached

  // readAttachment 回的是 ArrayBuffer（raw 通道）。Uint8Array 只是套在同一块内存上的
  // 视图，给 sniffMime 用，不产生拷贝；Blob 直接吃 ArrayBuffer。
  const pending = ipc.readAttachment(id).then((buffer) => {
    const view = new Uint8Array(buffer)
    return URL.createObjectURL(new Blob([buffer], { type: sniffMime(view) }))
  })

  cache.set(id, pending)
  pending.catch(() => cache.delete(id))
  return pending
}
