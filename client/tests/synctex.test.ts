import { describe, expect, it } from 'vitest'
import { forwardSync, inverseSync, normalizeSyncTexPath, parseSyncTex } from '../src/shared/synctex'

const SAMPLE_SYNCTEX = [
  'SyncTeX Version:1',
  'Input:1:C:\\build\\source\\.\\main.tex',
  'Input:2:C:\\build\\source\\sections/intro.tex',
  'Input:3:C:\\texlive\\texmf-dist\\tex\\latex\\base\\article.cls',
  'Magnification:1000',
  'Unit:1',
  'X Offset:0',
  'Y Offset:0',
  'Content:',
  '!663',
  '{1',
  '[1,5:4736286,4736286:30000000,40000000,0',
  '(1,12:4736286,9472572:20000000,786432,196608',
  'h1,12:4736286,9472572:6578176,786432,196608',
  'x1,12:9000000,9472572',
  ')',
  '(2,3:4736286,15000000:22000000,786432,196608',
  'h2,3:5200000,15000000:8000000,786432,196608',
  ')',
  '(3,80:4736286,20000000:10000000,500000,0',
  ')',
  ']',
  '}',
  '{2',
  '[2,19:4736286,6578176:30000000,10000000,0',
  '(2,20:4736286,7893811:24000000,786432,196608',
  'x2,20:10000000,7893811',
  ')',
  ']',
  '}',
  'Postamble:'
].join('\n')

describe('SyncTeX normalization, forward search and inverse search', () => {
  it('normalizes project-relative input paths while dropping external runtime files and traversal', () => {
    expect(normalizeSyncTexPath('C:\\build\\source\\.\\main.tex', 'C:\\build\\source')).toBe('main.tex')
    expect(normalizeSyncTexPath('C:/build/source/sections/./intro.tex', 'C:\\build\\source\\')).toBe('sections/intro.tex')
    expect(normalizeSyncTexPath('./chapters/ch1.tex')).toBe('chapters/ch1.tex')
    expect(normalizeSyncTexPath('C:\\texlive\\texmf-dist\\tex\\latex\\base\\article.cls', 'C:\\build\\source')).toBeNull()
    expect(normalizeSyncTexPath('../secret.tex', 'C:\\build\\source')).toBeNull()
  })

  it('parses only project files and resolves exact and nearby forwardSync targets in PDF big points', () => {
    const data = parseSyncTex(SAMPLE_SYNCTEX, 'C:\\build\\source')
    expect(data).not.toBeNull()
    expect(data!.files).toEqual(['main.tex', 'sections/intro.tex'])

    const hit = forwardSync(data!, 'main.tex', 12, 0.1)
    expect(hit).not.toBeNull()
    expect(hit!.page).toBe(1)
    expect(hit!.x).toBeCloseTo(4736286 / 65781.76, 2)
    expect(hit!.width).toBeLessThanOrEqual(72)
    expect(hit!.y).toBeLessThan(9472572 / 65781.76)

    const rightHit = forwardSync(data!, 'main.tex', 12, 0.9)
    expect(rightHit!.x).toBeGreaterThan(hit!.x)

    // Falls back to nearest available synced line when clicking an adjacent blank/comment line.
    const nearby = forwardSync(data!, 'sections/intro.tex', 19)
    expect(nearby).not.toBeNull()
    expect(nearby!.page).toBe(2)

    expect(forwardSync(data!, 'missing.tex', 1)).toBeNull()
  })

  it('prefers the innermost matching leaf/hbox over enclosing page vboxes on inverseSync', () => {
    const data = parseSyncTex(SAMPLE_SYNCTEX, 'C:\\build\\source')!
    const page1Hit = inverseSync(data, 1, 5200000 / 65781.76 + 10, 15000000 / 65781.76 - 2)
    expect(page1Hit).toEqual({ file: 'sections/intro.tex', line: 3 })

    const page2Hit = inverseSync(data, 2, 10000000 / 65781.76 + 2, 7893811 / 65781.76 - 2)
    expect(page2Hit).toEqual({ file: 'sections/intro.tex', line: 20 })

    expect(inverseSync(data, 99, 100, 100)).toBeNull()
  })
})
