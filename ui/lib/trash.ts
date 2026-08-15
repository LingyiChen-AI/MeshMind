// 回收站的文案与二次确认状态。都是纯函数，组件只负责渲染。
//
// 单独抽出来的理由是「彻底删除」不可逆：确认状态机（未武装 → 已武装 → 执行）
// 和「附件不是立刻消失」这句提示都属于说错一次就会造成误删或误解的东西，
// 值得有测试钉住。

/**
 * 附件回收有宽限期（crates/core 的 GC 不删刚解除引用的文件），
 * 所以彻底删除笔记之后去看附件目录，文件还在。不说这句用户会以为删除没生效。
 */
export const ATTACHMENT_GC_HINT = '附件不会立刻消失，会在下一轮清理（约 1 小时后）回收'

/** 彻底删除单条之后的提示。 */
export function purgedOneMessage(title: string): string {
  const name = title.trim() || '无标题'
  return `已彻底删除《${name}》。${ATTACHMENT_GC_HINT}`
}

/** 清空回收站之后的提示。0 条要说人话，不能说「已彻底删除 0 条」。 */
export function purgedAllMessage(count: number): string {
  if (count <= 0) return '回收站本来就是空的'
  return `已清空回收站，彻底删除 ${count} 条。${ATTACHMENT_GC_HINT}`
}

/**
 * 「清空回收站」的二次确认状态机。
 * - idle：显示「清空回收站」
 * - armed：显示「确认清空」+「取消」，只有这一步点下去才真的执行
 * 列表变空、面板关闭、执行完毕都要退回 idle，否则下次打开会直接停在
 * 「确认清空」上——一个误点就没了。
 */
export type ConfirmState = 'idle' | 'armed'

export function nextConfirmState(current: ConfirmState, action: 'arm' | 'cancel'): ConfirmState {
  return action === 'arm' && current === 'idle' ? 'armed' : 'idle'
}

/** 清空按钮上的字。 */
export function confirmLabel(state: ConfirmState): string {
  return state === 'armed' ? '确认清空（不可恢复）' : '清空回收站'
}
