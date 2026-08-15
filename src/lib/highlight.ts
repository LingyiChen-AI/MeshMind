// 把文本按命中词切成若干片段，供搜索结果里给命中部分套高亮标签。
// 放在这里而不是组件里，是因为切片逻辑（大小写、元字符转义、边界）值得单测，
// 而组件只负责把 Slice[] 渲染成 <mark> / 纯文本。

export interface Slice {
  text: string
  hit: boolean
}

/** 正则元字符按字面处理：搜索词里出现 `+` `.` `(` 之类不能被当成正则语法。 */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 按命中词把文本切片。忽略大小写；terms 为空或全是空白时返回单个未命中片段。
 * 长词优先匹配，避免 ['a', 'ab'] 这种情况下短词先吃掉前缀。
 */
export function splitByTerms(text: string, terms: string[]): Slice[] {
  const cleaned = terms
    .filter((t) => t.trim().length > 0)
    .sort((a, b) => b.length - a.length)

  if (cleaned.length === 0 || text.length === 0) {
    return [{ text, hit: false }]
  }

  const pattern = new RegExp(cleaned.map(escapeRegExp).join('|'), 'gi')
  const slices: Slice[] = []
  let cursor = 0

  for (const match of text.matchAll(pattern)) {
    const start = match.index
    // 空匹配理论上不会出现（已过滤空白词），但真出现了得跳过，否则死循环式产出空片段。
    if (match[0].length === 0) continue
    if (start > cursor) slices.push({ text: text.slice(cursor, start), hit: false })
    slices.push({ text: match[0], hit: true })
    cursor = start + match[0].length
  }

  if (cursor < text.length) slices.push({ text: text.slice(cursor), hit: false })
  if (slices.length === 0) return [{ text, hit: false }]

  return slices
}
