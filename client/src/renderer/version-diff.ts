const MAX_CHARS = 60_000
const MAX_LINES = 800
const LOOKAHEAD = MAX_LINES

/** Bounded, line-oriented display only. It never generates content to save or restore. */
export function compareVersions(before: string | null, after: string): { text: string; summary: string } {
  if (before === null) return { text: '', summary: '初始记录，暂无前一版本可比较。需要时可展开完整内容。' }
  const left = before ? before.slice(0, MAX_CHARS).split('\n').slice(0, MAX_LINES) : []
  const right = after ? after.slice(0, MAX_CHARS).split('\n').slice(0, MAX_LINES) : []
  const rows: string[] = []
  let a = 0, b = 0, removed = 0, added = 0
  while (a < left.length || b < right.length) {
    if (a < left.length && b < right.length && left[a] === right[b]) {
      rows.push(`  ${left[a++]}`); b++; continue
    }
    const nextLeft = b < right.length ? left.indexOf(right[b]!, a + 1) : -1
    const nextRight = a < left.length ? right.indexOf(left[a]!, b + 1) : -1
    if (nextLeft > a && nextLeft - a <= LOOKAHEAD && (nextRight < b || nextLeft - a <= nextRight - b)) {
      while (a < nextLeft) { rows.push(`− ${left[a++]}`); removed++ }
    } else if (nextRight > b && nextRight - b <= LOOKAHEAD) {
      while (b < nextRight) { rows.push(`＋ ${right[b++]}`); added++ }
    } else {
      if (a < left.length) { rows.push(`− ${left[a++]}`); removed++ }
      if (b < right.length) { rows.push(`＋ ${right[b++]}`); added++ }
    }
  }
  const truncated = (before?.length ?? 0) > MAX_CHARS || after.length > MAX_CHARS ||
    (before ?? '').split('\n').length > MAX_LINES || after.split('\n').length > MAX_LINES
  return { text: changedHunks(rows), summary: `显示范围：新增 ${added} 行、移除 ${removed} 行。${added + removed === 0 ? '显示范围内没有文本变化。' : '仅显示修改处及前后 2 行上下文。'}` +
    (truncated ? '内容较长，仅比较前 60000 字符 / 800 行；这不是完整差异。' : '“−”为此前内容，“＋”为此版本内容。') }
}

/** Collapse unchanged runs; hunk coordinates refer to the original compared snapshots. */
function changedHunks(rows: string[]): string {
  const visible = new Set<number>()
  rows.forEach((row, index) => {
    if (!row.startsWith('  ')) for (let n = Math.max(0, index - 2); n <= Math.min(rows.length - 1, index + 2); n++) visible.add(n)
  })
  const output: string[] = []
  let oldLine = 1, newLine = 1, previous = -2
  rows.forEach((row, index) => {
    if (visible.has(index)) {
      if (previous !== index - 1) output.push(`@@ 修改前第 ${oldLine} 行 / 此版本第 ${newLine} 行 @@`)
      output.push(row); previous = index
    }
    if (!row.startsWith('＋ ')) oldLine++
    if (!row.startsWith('− ')) newLine++
  })
  return output.join('\n')
}

export function versionPreview(value: string | null): string {
  if (value === null) return '（此前不存在此文件）'
  return value.length > MAX_CHARS ? value.slice(0, MAX_CHARS) + '\n（内容较长，仅显示前 60000 字符）' : value
}
