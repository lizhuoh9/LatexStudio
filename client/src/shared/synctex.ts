export interface SyncTexNode {
  file: number
  line: number
  page: number
  x: number
  y: number
  width: number
  height: number
  kind: 'leaf' | 'kern' | 'hbox' | 'vbox'
}

export interface SyncTexData {
  files: string[]
  nodes: SyncTexNode[]
}

export interface SyncTexTarget {
  page: number
  x: number
  y: number
  width: number
  height: number
}

export interface SyncTexSourceLocation {
  file: string
  line: number
}

interface ActiveBox {
  height: number
  depth: number
}

const MAX_RECORDS = 500_000
const SP_PER_BP = 65781.76
const POINT_LINE = /^([hvxkg$[\]()])([^,:]+),(\d+)(?:,\d+)?:(-?\d+),(-?\d+)(?::(-?\d+),(-?\d+),(-?\d+)|:(-?\d+))?/

/** Normalizes a SyncTeX Input path into a relative project path, returning null for external TeX runtime paths. */
export function normalizeSyncTexPath(rawPath: string, sourceRoot?: string): string | null {
  let value = rawPath.trim().replace(/\\/g, '/')
  if (!value) return null
  if (sourceRoot) {
    const root = sourceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
    if (root && value.length > root.length && value[root.length] === '/' &&
      value.slice(0, root.length).toLowerCase() === root.toLowerCase()) {
      value = value.slice(root.length + 1)
    }
  }
  while (value.startsWith('./')) value = value.slice(2)
  value = value.replace(/\/+(?:\.\/)+/g, '/').replace(/\/+$/, '')
  if (!value || value.startsWith('/') || /^[a-zA-Z]:/.test(value)) return null
  const segments = value.split('/')
  if (segments[0]?.toLowerCase() === '.paperstudio-output') return null
  if (segments.some(part => !part || part === '.' || part === '..' || /[\0\r\n]/.test(part))) return null
  return value
}

/** Parses decompressed SyncTeX v1 text into compact, normalized project-relative coordinates in PDF big points (bp). */
export function parseSyncTex(text: string, sourceRoot?: string): SyncTexData | null {
  if (!text) return null
  const lines = text.split(/\r?\n/)
  let unit = 1, magnification = 1000, xOffset = 0, yOffset = 0
  let inContent = false, currentPage = 0
  const files: string[] = []
  const fileIndexByPath = new Map<string, number>()
  const tagToFile = new Map<number, number>()
  const boxStack: ActiveBox[] = []
  const nodes: SyncTexNode[] = []

  const scale = (): number => (unit * (magnification / 1000)) / SP_PER_BP
  const registerInput = (line: string): void => {
    const sep = line.indexOf(':', 6)
    if (sep <= 6) return
    const tag = Number(line.slice(6, sep))
    const normalized = normalizeSyncTexPath(line.slice(sep + 1), sourceRoot)
    if (!Number.isInteger(tag) || tag <= 0 || !normalized) return
    let index = fileIndexByPath.get(normalized)
    if (index === undefined) { index = files.length; files.push(normalized); fileIndexByPath.set(normalized, index) }
    tagToFile.set(tag, index)
  }

  for (const line of lines) {
    if (!line) continue
    if (line.startsWith('Input:')) { registerInput(line); continue }
    if (!inContent) {
      if (line === 'Content:') { inContent = true; continue }
      if (line.startsWith('Unit:')) { const n = Number(line.slice(5)); if (Number.isFinite(n) && n > 0) unit = n }
      else if (line.startsWith('Magnification:')) { const n = Number(line.slice(14)); if (Number.isFinite(n) && n > 0) magnification = n }
      else if (line.startsWith('X Offset:')) { const n = Number(line.slice(9)); if (Number.isFinite(n)) xOffset = n }
      else if (line.startsWith('Y Offset:')) { const n = Number(line.slice(9)); if (Number.isFinite(n)) yOffset = n }
      continue
    }

    if (line.startsWith('Postamble:') || line.startsWith('Post scriptum:')) break
    const first = line[0]!
    if (first === '!') continue
    if (first === '{') {
      const page = Number(line.slice(1))
      if (Number.isInteger(page) && page >= 1) { currentPage = page; boxStack.length = 0 }
      continue
    }
    if (first === '}') { currentPage = 0; boxStack.length = 0; continue }
    if (first === ')' || first === ']') { if (boxStack.length > 0) boxStack.pop(); continue }
    if (currentPage < 1 || nodes.length >= MAX_RECORDS) continue

    const match = POINT_LINE.exec(line)
    if (!match) continue
    const code = match[1]!, tag = Number(match[2]), srcLine = Number(match[3])
    const rawH = Number(match[4]), rawV = Number(match[5])
    const factor = scale()
    let x = (rawH + xOffset) * factor
    const baselineY = (rawV + yOffset) * factor

    let width = 0, boxH = 0, boxD = 0
    if (match[6] !== undefined) {
      width = Math.max(0, Number(match[6]) * factor)
      boxH = Math.max(0, Number(match[7]) * factor)
      boxD = Math.max(0, Number(match[8]) * factor)
    } else if (match[9] !== undefined) {
      width = Math.max(0, Number(match[9]) * factor)
      if (code === 'k') x -= width
      const enclosing = boxStack.at(-1)
      boxH = enclosing?.height ?? 10
      boxD = enclosing?.depth ?? 2
    } else {
      const enclosing = boxStack.at(-1)
      boxH = enclosing?.height ?? 10
      boxD = enclosing?.depth ?? 2
    }

    if (code === '(' || code === '[') boxStack.push({ height: boxH, depth: boxD })
    const file = tagToFile.get(tag)
    if (file === undefined || !Number.isInteger(srcLine) || srcLine < 1) continue

    const kind: SyncTexNode['kind'] = code === '[' ? 'vbox' : code === '(' ? 'hbox' : code === 'k' ? 'kern' : 'leaf'
    nodes.push({ file, line: srcLine, page: currentPage, x, y: baselineY - boxH, width, height: boxH + boxD, kind })
  }

  return files.length && nodes.length ? { files, nodes } : null
}

function findFileIndex(files: string[], target: string): number {
  const exact = files.indexOf(target)
  if (exact >= 0) return exact
  const lower = target.toLowerCase()
  return files.findIndex(item => item.toLowerCase() === lower)
}

function axisDeltas(node: SyncTexNode, x: number, y: number): { dx: number; dy: number } {
  const w = Math.max(node.width, 6), h = Math.max(node.height, 8)
  const dx = x < node.x ? node.x - x : x > node.x + w ? x - (node.x + w) : 0
  const dy = y < node.y ? node.y - y : y > node.y + h ? y - (node.y + h) : 0
  return { dx, dy }
}

/** Finds the best PDF region matching a source file, 1-based line number and optional horizontal line fraction [0..1]. */
export function forwardSync(data: SyncTexData, file: string, line: number, columnFraction = 0.5): SyncTexTarget | null {
  const normalized = normalizeSyncTexPath(file)
  if (!normalized || !Number.isInteger(line) || line < 1) return null
  const fileIndex = findFileIndex(data.files, normalized)
  if (fileIndex < 0) return null

  const candidates = data.nodes.filter(node => node.file === fileIndex)
  if (!candidates.length) return null

  let exact = candidates.filter(node => node.line === line)
  if (!exact.length) {
    let bestLine = candidates[0]!.line, bestDiff = Math.abs(bestLine - line)
    for (const node of candidates) {
      const diff = Math.abs(node.line - line)
      if (diff < bestDiff || (diff === bestDiff && node.line >= line && bestLine < line)) {
        bestDiff = diff; bestLine = node.line
      }
    }
    exact = candidates.filter(node => node.line === bestLine)
  }

  const leaves = exact.filter(node => node.kind === 'leaf')
  const hboxes = exact.filter(node => node.kind === 'hbox')
  const pool = leaves.length ? leaves : hboxes.length ? hboxes : exact
  const primaryPage = pool[0]!.page
  const onPage = pool.filter(node => node.page === primaryPage).sort((a, b) => (a.y - b.y) || (a.x - b.x))
  const fraction = Number.isFinite(columnFraction) ? Math.max(0, Math.min(1, columnFraction)) : 0.5

  if (leaves.length) {
    const picked = onPage[Math.min(onPage.length - 1, Math.floor(fraction * onPage.length))]!
    return {
      page: primaryPage,
      x: picked.x,
      y: picked.y,
      width: Math.max(28, Math.min(picked.width || 44, 72)),
      height: Math.max(12, Math.min(picked.height || 14, 24))
    }
  }

  const box = onPage[0]!
  const width = Math.min(Math.max(28, box.width * 0.25), 72)
  const x = box.x + Math.max(0, box.width - width) * fraction
  return {
    page: primaryPage,
    x,
    y: box.y,
    width,
    height: Math.max(12, Math.min(box.height || 14, 24))
  }
}

const KIND_RANK: Record<SyncTexNode['kind'], number> = { leaf: 0, hbox: 1, kern: 2, vbox: 3 }

/** Finds the closest source file and line corresponding to a PDF point (1-based page, top-left bp coordinates). */
export function inverseSync(data: SyncTexData, page: number, x: number, y: number): SyncTexSourceLocation | null {
  if (!Number.isInteger(page) || page < 1 || !Number.isFinite(x) || !Number.isFinite(y)) return null
  const onPage = data.nodes.filter(node => node.page === page)
  if (!onPage.length) return null

  const ranked = onPage.map(node => {
    const { dx, dy } = axisDeltas(node, x, y)
    const dist = Math.hypot(dx, dy)
    // Inline leaf points sit along the exact text baseline; prefer same-line leaves within a word/gap span over container boxes.
    const score = node.kind === 'leaf' && dy <= 3 && dx <= 60 ? dy * 4 + dx * 0.05 : dist * 4 + KIND_RANK[node.kind] * 8
    const area = Math.max(node.width, 1) * Math.max(node.height, 1)
    return { node, score, dist, area }
  })

  ranked.sort((a, b) => (a.score - b.score) || (KIND_RANK[a.node.kind] - KIND_RANK[b.node.kind]) || (a.area - b.area) || (a.dist - b.dist))
  const best = ranked[0]?.node
  if (!best) return null
  const file = data.files[best.file]
  return file ? { file, line: best.line } : null
}
