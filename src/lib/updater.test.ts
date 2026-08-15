import { describe, expect, it } from 'vitest'

import { formatBytes, phaseAfterCheck, progressPercent, progressText } from './updater'

describe('phaseAfterCheck', () => {
  const available = { kind: 'available', version: '0.1.1', notes: '修了几个 bug' } as const
  const none = { kind: 'none' } as const
  const failed = { kind: 'failed', message: '网络不可达' } as const

  it('有新版：两种触发都要提示', () => {
    expect(phaseAfterCheck('startup', available, '0.1.0')).toEqual({
      kind: 'available',
      version: '0.1.1',
      notes: '修了几个 bug',
    })
    expect(phaseAfterCheck('manual', available, '0.1.0')).toEqual({
      kind: 'available',
      version: '0.1.1',
      notes: '修了几个 bug',
    })
  })

  it('启动检查无新版：什么都不显示', () => {
    // 弹一句「已是最新版本」等于每次开机都打扰用户一次，而他并没有问。
    expect(phaseAfterCheck('startup', none, '0.1.0')).toEqual({ kind: 'idle' })
  })

  it('启动检查失败：也什么都不显示', () => {
    // 启动那一刻网络不通是常态，为此弹错误条是纯噪音。
    expect(phaseAfterCheck('startup', failed, '0.1.0')).toEqual({ kind: 'idle' })
  })

  it('手动检查无新版：必须明确说已是最新，并带上版本号', () => {
    expect(phaseAfterCheck('manual', none, '0.1.0')).toEqual({
      kind: 'latest',
      currentVersion: '0.1.0',
    })
  })

  it('手动检查失败：错误必须可见', () => {
    expect(phaseAfterCheck('manual', failed, '0.1.0')).toEqual({
      kind: 'failed',
      message: '网络不可达',
      // 这次失败发生在「查」这一步，文案要说「检查更新失败」而不是「更新失败」
      during: 'check',
    })
  })
})

describe('progressPercent', () => {
  it('正常区间向下取整', () => {
    expect(progressPercent(0, 100)).toBe(0)
    expect(progressPercent(1, 3)).toBe(33)
    expect(progressPercent(50, 100)).toBe(50)
    expect(progressPercent(100, 100)).toBe(100)
  })

  it('总大小未知时返回 null 而不是 NaN', () => {
    // 服务端没给 Content-Length。界面据此退化成「已下载 x MB」。
    expect(progressPercent(1024, null)).toBeNull()
  })

  it('总大小为 0 不除零', () => {
    expect(progressPercent(1024, 0)).toBeNull()
    expect(progressPercent(0, 0)).toBeNull()
  })

  it('已下载超过总数时封顶 100，不出现 137%', () => {
    expect(progressPercent(137, 100)).toBe(100)
  })

  it('负数与非有限值当作 0', () => {
    expect(progressPercent(-1, 100)).toBe(0)
    expect(progressPercent(Number.NaN, 100)).toBe(0)
  })
})

describe('formatBytes', () => {
  it('1 KB 以下报字节', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1)).toBe('1 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('按 1024 进位并保留一位小数', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(10 * 1024 * 1024)).toBe('10.0 MB')
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB')
  })

  it('超过 GB 不再进位，避免出现没人认得的单位', () => {
    expect(formatBytes(2048 * 1024 * 1024)).toBe('2.0 GB')
  })

  it('负数与非有限值退化成 0 B', () => {
    expect(formatBytes(-5)).toBe('0 B')
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B')
  })
})

describe('progressText', () => {
  it('知道总大小时给百分比和两个绝对值', () => {
    expect(progressText(5 * 1024 * 1024, 10 * 1024 * 1024)).toBe('50%（5.0 MB / 10.0 MB）')
  })

  it('不知道总大小时只报已下载', () => {
    // 停在 0% 的假进度条比没有进度条更糟：用户会以为卡住了。
    expect(progressText(3 * 1024 * 1024, null)).toBe('已下载 3.0 MB')
  })
})
