import { describe, expect, it } from 'vitest'
import { ENCODED_CANCEL, ENCODED_CLOSE, encodeGet, encodeMkdir, encodeProbe, encodePut, encodeRun, MacFrameReader,
  relativePath } from '../src/main/sandbox/macos-protocol'

// Pure wire-format checks. They prove the app's side of protocol 1, not the native helper or any macOS behaviour.
describe('requests to the Mac compile helper', () => {
  it('frames a directory, a file, a run, an output request and a probe with exact byte lengths', () => {
    expect(encodeMkdir('figures/sub').toString()).toBe('MKDIR 11\nfigures/sub')
    expect(encodePut('a.tex', Buffer.from('hello')).toString()).toBe('PUT 5 5\na.texhello')
    expect(encodePut('中文.tex', Buffer.alloc(0)).subarray(0, 9).toString()).toBe('PUT 10 0\n')
    expect(encodeRun('pdflatex', ['-fmt=pdflatex', './main.tex'])).toEqual(Buffer.from('RUN pdflatex 25\n-fmt=pdflatex\0./main.tex\0'))
    expect(encodeRun('bibtex', []).toString()).toBe('RUN bibtex 0\n')
    expect(encodeGet('paperstudio.pdf').toString()).toBe('GET 15\npaperstudio.pdf')
    expect(encodeProbe('connect', '49152').toString()).toBe('PROBE connect 5\n49152')
    expect(ENCODED_CANCEL.toString()).toBe('CANCEL\n'); expect(ENCODED_CLOSE.toString()).toBe('CLOSE\n')
  })

  it.each(['', '/etc/passwd', '../x', 'a/../b', 'a//b', './a', 'a/.', 'a\\b', 'a\nb', 'a\0b', 'x'.repeat(1025)])(
    'refuses the snapshot path %j', path => { expect(() => relativePath(path)).toThrow() })

  it('refuses unknown tools, oversized or NUL arguments, output paths and unknown probes', () => {
    expect(() => encodeRun('latexmk' as never, [])).toThrow()
    expect(() => encodeRun('pdflatex', ['a\0b'])).toThrow()
    expect(() => encodeRun('pdflatex', ['x'.repeat(2049)])).toThrow()
    expect(() => encodeRun('pdflatex', Array.from({ length: 65 }, () => 'x'))).toThrow()
    for (const name of ['../paperstudio.pdf', 'a/b', '.hidden', '', 'x'.repeat(129)]) expect(() => encodeGet(name)).toThrow()
    expect(() => encodeProbe('delete' as never, '/x')).toThrow()
    expect(() => encodeProbe('read', '')).toThrow()
  })
})

describe('replies from the Mac compile helper', () => {
  it('decodes every frame kind, including payloads split across chunks', () => {
    const reader = new MacFrameReader()
    const stream = Buffer.concat([Buffer.from('READY 1 1 12\n/work/source'), Buffer.from('OK\nSTARTED 4321\nOUT 2 5\nhello'),
      Buffer.from('EXIT 0\nFILE 4\n%PDFNONE\nPROBE denied 1\nPROBE allowed 0\nERR bad-path\nCLOSED 1\n')])
    const frames = [...reader.push(stream.subarray(0, 17)), ...reader.push(stream.subarray(17, 40)), ...reader.push(stream.subarray(40))]
    expect(frames).toEqual([
      { type: 'ready', protocol: 1, sandboxed: true, root: '/work/source' }, { type: 'ok' }, { type: 'started', pgid: 4321 },
      { type: 'out', stream: 2, data: Buffer.from('hello') }, { type: 'exit', code: 0 }, { type: 'file', data: Buffer.from('%PDF') },
      { type: 'none' }, { type: 'probe', allowed: false, errno: 1 }, { type: 'probe', allowed: true, errno: 0 },
      { type: 'err', code: 'bad-path' }, { type: 'closed', clean: true }])
    expect(reader.idle).toBe(true)
  })

  it('reports an unsandboxed helper and an unconfirmed cleanup as such', () => {
    const reader = new MacFrameReader()
    expect(reader.push(Buffer.from('READY 1 0 1\n/CLOSED 0\n'))).toEqual([
      { type: 'ready', protocol: 1, sandboxed: false, root: '/' }, { type: 'closed', clean: false }])
  })

  it('is not idle while a frame is incomplete', () => {
    const reader = new MacFrameReader()
    expect(reader.push(Buffer.from('FILE 10\nabc'))).toEqual([])
    expect(reader.idle).toBe(false)
  })

  it('assembles a large payload that arrives in many small chunks, followed by the next frame', () => {
    const reader = new MacFrameReader(), payload = Buffer.alloc(1_000_000, 0x61), frames = []
    const stream = Buffer.concat([Buffer.from(`FILE ${payload.length}\n`), payload, Buffer.from('EXIT 3\n')])
    for (let offset = 0; offset < stream.length; offset += 4096) frames.push(...reader.push(stream.subarray(offset, offset + 4096)))
    expect(frames).toHaveLength(2)
    expect(frames[0]).toMatchObject({ type: 'file' }); expect((frames[0] as { data: Buffer }).data.equals(payload)).toBe(true)
    expect(frames[1]).toEqual({ type: 'exit', code: 3 }); expect(reader.idle).toBe(true)
  })

  it.each(['HELLO\n', 'OK 1\n', 'STARTED 0\n', 'STARTED 1\n', 'EXIT\n', 'EXIT 256\n', 'EXIT -1\n', 'EXIT 01\n', 'OUT 3 1\nx', 'OUT 1 4097\n', 'FILE 67108865\n',
    'PROBE maybe 0\n', 'CLOSED 2\n', 'ERR Bad\n', 'READY 1 2 0\n', 'OK\u0001\n', `${'x'.repeat(300)}\n`, 'x'.repeat(300)])(
    'abandons the malformed reply %j', text => { expect(() => new MacFrameReader().push(Buffer.from(text, 'latin1'))).toThrow() })

  it('rejects a snapshot root that is not valid UTF-8', () => {
    expect(() => new MacFrameReader().push(Buffer.concat([Buffer.from('READY 1 1 2\n'), Buffer.from([0xc3, 0x28])]))).toThrow()
  })
})
