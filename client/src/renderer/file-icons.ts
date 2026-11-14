const SVG = 'http://www.w3.org/2000/svg'
export type FileIconKind = 'tex' | 'bibliography' | 'markdown' | 'pdf' | 'image' | 'code' | 'file' | 'folder'
const TYPES: ReadonlyArray<readonly [FileIconKind, ReadonlySet<string>]> = [
  ['tex', new Set(['tex', 'sty', 'cls', 'ltx', 'dtx', 'ins'])],
  ['bibliography', new Set(['bib', 'bst', 'bbx', 'cbx'])],
  ['markdown', new Set(['md', 'markdown', 'mdown'])],
  ['image', new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'eps', 'bmp', 'tif', 'tiff', 'avif', 'ico'])],
  ['code', new Set(['js', 'ts', 'jsx', 'tsx', 'py', 'c', 'cpp', 'h', 'hpp', 'java', 'rs', 'go', 'lua', 'sh', 'bash', 'ps1', 'json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'xml', 'html', 'css'])]
]

/** Display-only extension classification; it grants no file access and does not normalize a path. */
export function fileIconKind(name: string, directory = false): FileIconKind {
  if (directory) return 'folder'
  const match = /\.([^.]+)$/.exec(name), extension = match?.[1]?.toLowerCase()
  if (extension === 'pdf') return 'pdf'
  return TYPES.find(([, extensions]) => !!extension && extensions.has(extension))?.[0] ?? 'file'
}

interface Shape { d: string; className?: string }
// Original 20×20 line artwork. No text glyphs, external sprites, assets or untrusted SVG markup.
const ART: Readonly<Record<FileIconKind, readonly Shape[]>> = {
  tex: [{ d: 'M1.5 4H9.5M5.5 4V12M3.5 12H7.5M8.5 12H12.5M8.5 12V16H12.5M8.5 14H11.5M13 4L18.5 12M18.5 4L13 12' }],
  bibliography: [{ d: 'M2 4.5C5 3.5 7 4 10 6V17C7 15 5 14.5 2 15.5ZM18 4.5C15 3.5 13 4 10 6V17C13 15 15 14.5 18 15.5ZM5 7L7.5 8M5 10L7.5 11M12.5 8L15 7M12.5 11L15 10' }],
  markdown: [{ d: 'M2 5H18V15H2ZM5 12V8L7 10L9 8V12M13 8V12M11 10L13 12L15 10' }],
  pdf: [{ d: 'M5 2H12L16 6V18H5ZM12 2V6H16', className: 'icon-page' },
    { d: 'M6 14C10 10 10 6.5 9 7.5C8 8.5 11 15.5 13.5 13.5C15 12 9 12 6 14Z' }],
  image: [{ d: 'M3 3H17V17H3ZM3 14L7 9L11 13L14 10L17 14M14.5 6.5A1 1 0 1 1 12.5 6.5A1 1 0 1 1 14.5 6.5' }],
  code: [{ d: 'M7 3H5.5C4.5 3 4 4 4 5V7.5C4 9 3 10 2 10C3 10 4 11 4 12.5V15C4 16 4.5 17 5.5 17H7M13 3H14.5C15.5 3 16 4 16 5V7.5C16 9 17 10 18 10C17 10 16 11 16 12.5V15C16 16 15.5 17 14.5 17H13M11.5 7L8.5 13' }],
  file: [{ d: 'M5 2H12L16 6V18H5ZM12 2V6H16M8 10H13M8 13H13' }],
  folder: [{ d: 'M2 5V16H18V7H9L7 4H2Z', className: 'folder-closed-shape' },
    { d: 'M2 7V4H7L9 7H17V10M2 7H9L10 9H19L16.5 16H3.5Z', className: 'folder-open-shape' }]
}

export function createFileIcon(name: string, directory = false): SVGSVGElement {
  const kind = fileIconKind(name, directory), icon = document.createElementNS(SVG, 'svg')
  const attributes = { class: `file-icon file-icon-${kind}`, viewBox: '0 0 20 20', width: '18', height: '18',
    'aria-hidden': 'true', focusable: 'false', 'data-file-icon': kind, fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.35', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }
  for (const [key, value] of Object.entries(attributes)) icon.setAttribute(key, value)
  for (const shape of ART[kind]) {
    const path = document.createElementNS(SVG, 'path'); path.setAttribute('d', shape.d)
    if (shape.className) path.setAttribute('class', shape.className)
    icon.append(path)
  }
  return icon
}
