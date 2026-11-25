/**
 * Wire format between the app and the macOS compile helper (resources/darwin/compiler/latexstudio-compiler.c,
 * protocol 1). Pure encoding/decoding: no process, no filesystem. Every frame is one ASCII header line followed by
 * the payload bytes whose length the header states.
 */
export const MAC_HELPER_PROTOCOL = 1
export type MacTool = 'pdflatex' | 'xelatex' | 'xdvipdfmx' | 'bibtex'
export type MacProbeKind = 'read' | 'write' | 'connect' | 'exec-read'
export type MacFrame =
  | { type: 'ready'; protocol: number; sandboxed: boolean; root: string }
  | { type: 'ok' }
  | { type: 'err'; code: string }
  | { type: 'started'; pgid: number }
  | { type: 'out'; stream: 1 | 2; data: Buffer }
  | { type: 'exit'; code: number }
  | { type: 'file'; data: Buffer }
  | { type: 'none' }
  | { type: 'probe'; allowed: boolean; errno: number }
  | { type: 'closed'; clean: boolean }

const MAX_HEADER = 256
const MAX_PATH = 1024
const MAX_ARGS = 64
const MAX_ARG = 2048
export const MAC_MAX_FILE = 64 * 1024 * 1024
const NUMBER = /^(?:0|[1-9]\d{0,9})$/
const TOOLS: readonly string[] = ['pdflatex', 'xelatex', 'xdvipdfmx', 'bibtex']
const PROBES: readonly string[] = ['read', 'write', 'connect', 'exec-read']

function invalid(message: string): Error { return new Error(`Mac helper protocol: ${message}`) }
function count(text: string | undefined, maximum: number): number {
  if (text === undefined || !NUMBER.test(text) || Number(text) > maximum) throw invalid('bad number')
  return Number(text)
}
/** Snapshot-relative POSIX path: no absolute path, no empty/dot components, no control bytes. */
export function relativePath(path: string): Buffer {
  const bytes = Buffer.from(path, 'utf8')
  if (!path || bytes.length > MAX_PATH || path.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(path) ||
    path.split('/').some(part => part === '' || part === '.' || part === '..')) throw invalid('bad path')
  return bytes
}
function frame(header: string, ...payload: Buffer[]): Buffer { return Buffer.concat([Buffer.from(`${header}\n`, 'ascii'), ...payload]) }

export function encodeMkdir(path: string): Buffer {
  const bytes = relativePath(path)
  return frame(`MKDIR ${bytes.length}`, bytes)
}
export function encodePut(path: string, data: Uint8Array): Buffer {
  if (data.length > MAC_MAX_FILE) throw invalid('file too large')
  const bytes = relativePath(path)
  return frame(`PUT ${bytes.length} ${data.length}`, bytes, Buffer.from(data.buffer, data.byteOffset, data.length))
}
export function encodeRun(tool: MacTool, args: readonly string[]): Buffer {
  if (!TOOLS.includes(tool) || args.length > MAX_ARGS) throw invalid('bad run request')
  const parts = args.map(arg => {
    const bytes = Buffer.from(arg, 'utf8')
    if (typeof arg !== 'string' || arg.includes('\0') || bytes.length > MAX_ARG) throw invalid('bad argument')
    return Buffer.concat([bytes, Buffer.alloc(1)])
  })
  const payload = Buffer.concat(parts)
  return frame(`RUN ${tool} ${payload.length}`, payload)
}
/** A file name of the fixed output folder, never a path. */
export function encodeGet(name: string): Buffer {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(name)) throw invalid('bad output name')
  return frame(`GET ${name.length}`, Buffer.from(name, 'ascii'))
}
export function encodeProbe(kind: MacProbeKind, argument: string): Buffer {
  const bytes = Buffer.from(argument, 'utf8')
  if (!PROBES.includes(kind) || !bytes.length || bytes.length > MAX_PATH || argument.includes('\0')) throw invalid('bad probe')
  return frame(`PROBE ${kind} ${bytes.length}`, bytes)
}
export const ENCODED_CANCEL = Buffer.from('CANCEL\n', 'ascii')
export const ENCODED_CLOSE = Buffer.from('CLOSE\n', 'ascii')

interface Pending { build: (payload: Buffer) => MacFrame; length: number }

/** Incremental decoder for the helper's output. Any malformed input throws and the session must be abandoned. */
export class MacFrameReader {
  private buffered: Buffer = Buffer.alloc(0)
  private pending: Pending | null = null
  private readonly parts: Buffer[] = []
  private waiting = 0

  push(chunk: Uint8Array): MacFrame[] {
    // A large payload arrives in many chunks: collect them and join once, instead of re-copying on every chunk.
    this.parts.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length)); this.waiting += chunk.length
    if (this.pending && this.buffered.length + this.waiting < this.pending.length) return []
    this.buffered = Buffer.concat([this.buffered, ...this.parts])
    this.parts.length = 0; this.waiting = 0
    const frames: MacFrame[] = []
    for (;;) {
      if (this.pending) {
        if (this.buffered.length < this.pending.length) return frames
        frames.push(this.pending.build(Buffer.from(this.buffered.subarray(0, this.pending.length))))
        this.buffered = this.buffered.subarray(this.pending.length)
        this.pending = null
        continue
      }
      const end = this.buffered.indexOf(0x0a)
      if (end < 0) {
        if (this.buffered.length > MAX_HEADER) throw invalid('header too long')
        return frames
      }
      if (end > MAX_HEADER) throw invalid('header too long')
      const header = this.buffered.subarray(0, end).toString('latin1')
      this.buffered = this.buffered.subarray(end + 1)
      const parsed = this.header(header)
      if ('type' in parsed) frames.push(parsed)
      else if (parsed.length === 0) frames.push(parsed.build(Buffer.alloc(0)))
      else this.pending = parsed
    }
  }
  /** True when no partial frame is buffered (a clean end of stream). */
  get idle(): boolean { return !this.pending && this.buffered.length === 0 && this.waiting === 0 }

  private header(line: string): MacFrame | Pending {
    if (!/^[\x20-\x7e]+$/.test(line)) throw invalid('bad header bytes')
    const [name, a, b, c, extra] = line.split(' ')
    if (extra !== undefined) throw invalid('bad header')
    const none = (limit: number): void => { if ([a, b, c].filter(part => part !== undefined).length !== limit) throw invalid('bad header') }
    switch (name) {
      case 'OK': none(0); return { type: 'ok' }
      case 'NONE': none(0); return { type: 'none' }
      case 'ERR': none(1); if (!/^[a-z-]{1,32}$/.test(a ?? '')) throw invalid('bad error code'); return { type: 'err', code: a as string }
      // 0 and 1 are never a tool's process group; as kill targets they would mean "my own group" and "everyone".
      case 'STARTED': { none(1); const pgid = count(a, 0x7fffffff); if (pgid < 2) throw invalid('bad process group')
        return { type: 'started', pgid } }
      case 'EXIT': none(1); return { type: 'exit', code: count(a, 255) }
      case 'CLOSED': none(1); return { type: 'closed', clean: count(a, 1) === 1 }
      case 'PROBE': none(2); if (a !== 'allowed' && a !== 'denied') throw invalid('bad probe result')
        return { type: 'probe', allowed: a === 'allowed', errno: count(b, 0x7fffffff) }
      case 'OUT': { none(2); const stream = count(a, 2); if (stream < 1) throw invalid('bad stream')
        return { length: count(b, 4096), build: data => ({ type: 'out', stream: stream as 1 | 2, data }) } }
      case 'FILE': none(1); return { length: count(a, MAC_MAX_FILE), build: data => ({ type: 'file', data }) }
      case 'READY': { none(3); const protocol = count(a, 1000), sandboxed = count(b, 1) === 1
        return { length: count(c, 4096), build: data => ({ type: 'ready', protocol, sandboxed,
          root: new TextDecoder('utf-8', { fatal: true }).decode(data) }) } }
      default: throw invalid('unknown frame')
    }
  }
}
