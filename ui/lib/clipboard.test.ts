import { describe, expect, it } from 'vitest'

import { extensionForMime, extractPastedImage } from './clipboard'

describe('extensionForMime', () => {
  it('映射常见图片 MIME', () => {
    expect(extensionForMime('image/png')).toBe('png')
    expect(extensionForMime('image/jpeg')).toBe('jpg')
    expect(extensionForMime('image/gif')).toBe('gif')
    expect(extensionForMime('image/webp')).toBe('webp')
    expect(extensionForMime('image/bmp')).toBe('bmp')
    expect(extensionForMime('image/svg+xml')).toBe('svg')
  })

  it('未知类型退回 bin', () => {
    expect(extensionForMime('image/tiff')).toBe('bin')
    expect(extensionForMime('application/pdf')).toBe('bin')
    expect(extensionForMime('')).toBe('bin')
  })

  it('忽略大小写与参数后缀', () => {
    expect(extensionForMime('IMAGE/PNG')).toBe('png')
    expect(extensionForMime('image/jpeg; charset=binary')).toBe('jpg')
  })
})

describe('extractPastedImage', () => {
  it('传 null 返回 null', async () => {
    await expect(extractPastedImage(null)).resolves.toBeNull()
  })

  it('没有 file 项时返回 null', async () => {
    const data = {
      items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
    } as unknown as DataTransfer
    await expect(extractPastedImage(data)).resolves.toBeNull()
  })

  it('有非图片 file 项时返回 null', async () => {
    const data = {
      items: [
        { kind: 'file', type: 'application/pdf', getAsFile: () => new Blob([new Uint8Array([1])]) },
      ],
    } as unknown as DataTransfer
    await expect(extractPastedImage(data)).resolves.toBeNull()
  })

  it('取第一个图片 file 项并读成字节数组', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 255])], { type: 'image/png' })
    const data = {
      items: [
        { kind: 'string', type: 'text/html', getAsFile: () => null },
        { kind: 'file', type: 'image/png', getAsFile: () => blob },
        { kind: 'file', type: 'image/gif', getAsFile: () => new Blob([new Uint8Array([9])]) },
      ],
    } as unknown as DataTransfer

    await expect(extractPastedImage(data)).resolves.toEqual({
      bytes: [1, 2, 3, 255],
      ext: 'png',
    })
  })
})
