import { describe, expect, it } from 'vitest'
import { forbiddenSwitch, FORBIDDEN_SWITCHES } from '../src/main/startup-guard'

const only = (...present: string[]) => (name: string): boolean => present.includes(name)

describe('packaged startup guard', () => {
  it('allows a normal launch', () => {
    expect(forbiddenSwitch(only('user-data-dir', 'lang'))).toBeUndefined()
  })

  it.each(['remote-debugging-port', 'remote-debugging-pipe', 'js-flags'])('refuses %s', name => {
    expect(forbiddenSwitch(only('user-data-dir', name))).toBe(name)
  })

  it('names every remote-control switch Chromium offers', () => {
    expect(FORBIDDEN_SWITCHES).toEqual(expect.arrayContaining(['remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address',
      'remote-allow-origins', 'js-flags']))
  })
})
