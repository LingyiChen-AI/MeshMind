// 主窗口的全屏遮罩层：搜索、回收站、设置。
//
// 为什么要一个状态而不是三个 boolean：三个面板全是 `position: fixed; inset: 0` 的
// 遮罩，同时开着的话它们会叠在一起，Esc 一次只关掉一层，用户看到的是「按了没反应」。
// 用三个 boolean 就得在每个入口处手工把另外两个关掉——入口有五处（三个按钮、⌘K、
// 搜索结果点击），漏一处就出叠层，而且加第四个面板时要改的地方是 O(n²)。
// 收敛成一个 `ActiveOverlay` 之后，「同时只有一层」是类型层面的事实，不是纪律问题。

export type OverlayKind = 'search' | 'trash' | 'settings'
export type ActiveOverlay = OverlayKind | null

/**
 * 开关某一层（⌘K 这类「同一个键既开又关」的入口用它）。
 *
 * 当前开着别的层时直接换成目标层，而不是先关再开：用户按 ⌘K 的意图是「我要搜索」，
 * 让他先按 Esc 关掉回收站再按 ⌘K 是多此一举。
 */
export function toggleOverlay(current: ActiveOverlay, target: OverlayKind): ActiveOverlay {
  return current === target ? null : target
}

/**
 * 关掉指定的那一层。
 *
 * 关键是**只在当前确实是这一层时才关**：面板的 onClose 可能来自一个异步回调
 * （回收站恢复成功之后才 onClose），那时前台可能已经换成别的层了，
 * 无条件置 null 会把用户刚打开的面板关掉。
 */
export function closeOverlay(current: ActiveOverlay, target: OverlayKind): ActiveOverlay {
  return current === target ? null : current
}
