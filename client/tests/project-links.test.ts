import { describe, expect, it } from 'vitest'
import { parseProjectLink } from '../src/shared/project-links'

const message = '项目分享链接无效。请使用 LatexStudio 加入链接或 HTTPS GitHub 仓库地址。'

describe('closed, secret-free project sharing addresses', () => {
  it.each(['https://github.com/Alice/paper', 'https://github.com/Alice/paper/',
    'latexstudio://join/Alice/paper', 'latexstudio://join/Alice/paper/', 'HTTPS://GITHUB.COM/Alice/paper'])('normalizes %s', input => {
    expect(parseProjectLink(input)).toEqual({ owner: 'Alice', name: 'paper',
      githubUrl: 'https://github.com/Alice/paper', appUrl: 'latexstudio://join/Alice/paper' })
  })

  it.each(['paper.git', 'paper.git.git', 'paper.GIT', 'paper.v2', '.paper', 'my-paper_1'])('preserves literal repository %s', name => {
    const expected = { owner: 'alice', name, githubUrl: `https://github.com/alice/${name}`, appUrl: `latexstudio://join/alice/${name}` }
    expect(parseProjectLink(expected.githubUrl)).toEqual(expected)
    expect(parseProjectLink(expected.appUrl)).toEqual(expected)
  })

  it('accepts only the bounded owner/repository alphabet, without changing case', () => {
    const owner = 'A'.repeat(39), name = 'r'.repeat(100)
    expect(parseProjectLink(`latexstudio://join/${owner}/${name}`).name).toBe(name)
    expect(parseProjectLink('https://github.com/a-b/repo')).toMatchObject({ owner: 'a-b' })
  })

  it.each([
    null, undefined, 42, {}, ['latexstudio://join/alice/paper'], '', ' '.repeat(257),
    'latexstudio://join/alice/paper?token=PRIVATE', 'latexstudio://join/alice/paper#PRIVATE',
    'latexstudio://join/alice/paper?', 'latexstudio://join/alice/paper#', 'latexstudio://join:443/alice/paper',
    'latexstudio://user:PRIVATE@join/alice/paper', 'latexstudio://join@evil/alice/paper',
    'latexstudio://open/alice/paper', 'latexstudio:join/alice/paper', 'latexstudio:///join/alice/paper',
    'latexstudio://join/alice/paper/extra', 'latexstudio://join/alice/paper//',
    'latexstudio://join/alice/%70aper', 'latexstudio://join/alice/%2e%2e',
    'latexstudio://join/alice/paper\\other', 'latexstudio://join/alice/../other',
    'latexstudio://join/alice/.', 'latexstudio://join/alice/..', 'latexstudio://join/-alice/paper',
    'latexstudio://join/alice-/paper', 'latexstudio://join/a--b/paper', 'latexstudio://join/ali_ce/paper',
    `latexstudio://join/${'a'.repeat(40)}/paper`, `latexstudio://join/alice/${'p'.repeat(101)}`,
    'https://github.com:443/alice/paper', 'https://github.com/alice/paper?x=1',
    'https://github.com/alice/paper#x', 'https://PRIVATE@github.com/alice/paper',
    'https://github.com.evil/alice/paper', 'https://github.com/alice/paper/tree/main',
    'https://github.com/alice/%70aper', 'https://github.com\\alice/paper', 'https://github.com/alice//paper',
    'http://github.com/alice/paper', 'file:///alice/paper', 'javascript:alert(1)',
    'C:\\papers\\mine', '--user-data-dir=PRIVATE', ' https://github.com/alice/paper',
    'https://github.com/alice/paper ', 'https://github.com/alice/paper\n',
    'latexstudio://join/alice/论文', 'latexstudio://join/alice/pa\u0000per',
    'latexstudio://join/alice/pa\tper', 'latexstudio://join/alice/pa\rper'
  ].map(input => ({ input })))('rejects untrusted input $input without echoing its contents', ({ input }) => {
    expect(() => parseProjectLink(input)).toThrow(message)
    try { parseProjectLink(input) } catch (error) { expect((error as Error).message).toBe(message) }
  })

  it('does not coerce arbitrary input objects or invoke their accessors', () => {
    const hostile = { toString: () => { throw new Error('unexpected conversion') },
      get appUrl(): never { throw new Error('unexpected read') } }
    expect(() => parseProjectLink(hostile)).toThrow(message)
  })
})
