import { beforeEach, describe, expect, it } from 'vitest'
import type { CloudProject, CollaborationState } from '../src/shared/collaboration-contracts'
import { CollaborationModel, collaborationDetail, VERIFICATION_URI } from '../src/renderer/collaboration-model'

const account = { id: 7, login: 'fixture-user', name: 'Synthetic user' }
const project: CloudProject = { id: 9, installationId: 3, owner: 'fixture-user', name: 'synthetic-paper', private: true }
const state = (extra: Partial<CollaborationState> = {}): CollaborationState => ({ phase: 'signed-out', message: 'synthetic state',
  account: null, authorization: null, expiresAt: null, sessionOnly: true, ...extra })
const signedIn = () => state({ phase: 'signed-in', account, expiresAt: 100000 })
const authorizing = () => state({ phase: 'authorizing', authorization: { userCode: 'ABCD-EFGH', verificationUri: VERIFICATION_URI, expiresAt: 10000 } })
let now: number
let model: CollaborationModel
beforeEach(() => { now = 1000; model = new CollaborationModel(true, () => now) })

function discover(): void {
  model.receive(signedIn())
  const ticket = model.begin('projects')!
  expect(model.projectResponse([project], ticket)).toBe(true)
  model.finish('projects', ticket)
}

describe('optional collaboration bridge fails closed', () => {
  it('does not expose any action without the optional bridge', () => {
    model = new CollaborationModel(false)
    for (const action of ['status', 'login', 'cancel', 'logout', 'verify', 'projects'] as const) expect(model.allowed(action)).toBe(false)
    expect(model.summary).toContain('本地历史仍可用')
  })
  it('requires configured publisher status before allowing login', () => {
    expect(model.allowed('login')).toBe(false)
    model.receive(state({ phase: 'unconfigured' }))
    expect(model.allowed('login')).toBe(false); expect(model.account).toBeNull()
    expect(model.summary).toContain('此开发版未配置')
  })
  it('accepts an existing current-run account but does not discover projects implicitly', () => {
    model.receive(signedIn()); expect(model.account?.id).toBe(7)
    expect(model.projects).toEqual([]); expect(model.allowed('projects')).toBe(true)
  })
  it('rejects an incomplete signed-in account and a malformed session-retention flag', () => {
    model.receive(state({ phase: 'signed-in' })); expect(model.account).toBeNull()
    model.receive({ ...signedIn(), sessionOnly: 'false' } as unknown as CollaborationState)
    expect(model.account).toBeNull(); expect(model.allowed('login')).toBe(false)
  })
})

describe('recoverable Main errors require an explicit new login', () => {
  it('permits a user retry when the first authoritative snapshot is an error', () => {
    model.receive(state({ phase: 'error' }))
    expect(model.allowed('login')).toBe(true); expect(model.account).toBeNull(); expect(model.prompt).toBeNull()
    const login = model.begin('login')!
    expect(login).not.toBeNull(); expect(model.respond(authorizing(), login)).toBe(true)
  })
  it('rejects unsolicited authorization after an error until a user retries', () => {
    model.receive(state({ phase: 'error' })); model.receive(authorizing()); model.receive(signedIn())
    expect(model.state?.phase).toBe('error'); expect(model.account).toBeNull(); expect(model.prompt).toBeNull()
    expect(model.allowed('login')).toBe(true)
  })
  it('does not enable an unavailable or incompatible bridge from an error snapshot', () => {
    const absent = new CollaborationModel(false, () => now)
    absent.receive(state({ phase: 'error' })); expect(absent.allowed('login')).toBe(false)
    model.receive({ ...state({ phase: 'error' }), sessionOnly: undefined } as unknown as CollaborationState)
    expect(model.state?.phase).toBe('unconfigured'); expect(model.allowed('login')).toBe(false)
  })
})

describe('OS-encrypted session snapshots from Main', () => {
  it.each([true, false])('accepts verified accounts with sessionOnly=%s without discovering projects', sessionOnly => {
    model.receive({ ...signedIn(), sessionOnly })
    expect(model.state?.phase).toBe('signed-in'); expect(model.account).toEqual(account)
    expect(model.allowed('login')).toBe(false); expect(model.allowed('logout')).toBe(true)
    expect(model.allowed('projects')).toBe(true); expect(model.projects).toEqual([])
  })
  it('does not disable an explicit login solely because Main supports retained sessions', () => {
    model.receive(state({ sessionOnly: false }))
    expect(model.state?.phase).toBe('signed-out'); expect(model.allowed('login')).toBe(true)
  })
  it.each([undefined, null, 'true', 'false', 0, 1, {}])('rejects malformed retention flags (%j)', sessionOnly => {
    model.receive({ ...signedIn(), sessionOnly } as unknown as CollaborationState)
    expect(model.state?.phase).toBe('unconfigured'); expect(model.account).toBeNull()
    expect(model.allowed('login')).toBe(false); expect(model.allowed('projects')).toBe(false)
  })
  it('keeps expiry checks for a restored account', () => {
    model.receive({ ...signedIn(), sessionOnly: false }); now = 100001; model.tick()
    expect(model.expired).toBe(true); expect(model.account).toBeNull()
    expect(model.allowed('login')).toBe(true); expect(model.allowed('projects')).toBe(false)
  })
  it('does not let a retained snapshot revive an explicitly logged-out session', () => {
    const saved = { ...signedIn(), sessionOnly: false }
    model.receive(saved); const logout = model.begin('logout')!
    expect(logout).not.toBeNull(); model.receive(saved)
    expect(model.account).toBeNull(); expect(model.respond(state(), logout)).toBe(true)
    model.finish('logout', logout); model.receive(saved)
    expect(model.account).toBeNull(); expect(model.allowed('login')).toBe(true)
    expect(model.allowed('projects')).toBe(false)
  })
})

describe('event and authentication epochs', () => {
  it('never lets an old status reply roll back a newer event', () => {
    const ticket = model.begin('status')!
    model.receive(state({ phase: 'unconfigured' }))
    expect(model.respond(signedIn(), ticket)).toBe(false)
    expect(model.state?.phase).toBe('unconfigured'); expect(model.account).toBeNull()
  })
  it('discards login replies after an unconfigured status event', () => {
    model.receive(state()); const login = model.begin('login')!
    model.receive(state({ phase: 'unconfigured' }))
    expect(model.respond(signedIn(), login)).toBe(false)
    expect(model.account).toBeNull(); expect(model.allowed('login')).toBe(false)
  })
  it('clears a device prompt immediately on cancel and rejects late authorization', () => {
    model.receive(state()); const login = model.begin('login')!
    model.receive(authorizing()); const cancel = model.begin('cancel')!
    expect(model.prompt).toBeNull()
    model.receive(signedIn())
    expect(model.respond(signedIn(), login)).toBe(false); expect(model.account).toBeNull()
    expect(model.respond(state(), cancel)).toBe(true)
    model.finish('cancel', cancel); expect(model.allowed('login')).toBe(true)
  })
  it('keeps main phase on an API failure and never stores raw exception credentials', () => {
    model.receive(state()); const before = model.state
    model.fail('login')
    expect(model.state).toBe(before); expect(model.error).toContain('请求未完成')
    expect(model.account).toBeNull()
  })
})

describe('short-lived authorization and explicit renewal', () => {
  it('accepts only a live prompt for the fixed official verification URI', () => {
    model.receive(authorizing()); expect(model.allowed('verify')).toBe(true)
    model.receive(state({ ...authorizing(), authorization: { ...authorizing().authorization!, verificationUri: 'https://invalid.example/' as typeof VERIFICATION_URI } }))
    expect(model.prompt).toBeNull(); expect(model.allowed('verify')).toBe(false)
  })
  it('clears expired device codes and permits an explicit new login only', () => {
    model.receive(authorizing()); now = 10001; expect(model.tick()).toBe(true)
    expect(model.prompt).toBeNull(); expect(model.state?.authorization).toBeNull()
    expect(model.summary).toContain('到期'); expect(model.allowed('login')).toBe(true)
    model.receive(signedIn()); expect(model.account).toBeNull()
    const login = model.begin('login')!; expect(model.respond(authorizing(), login)).toBe(true)
  })
  it('clears expired accounts and old project metadata without automatic refresh', () => {
    discover(); now = 100001; model.tick()
    expect(model.account).toBeNull(); expect(model.projects).toEqual([])
    expect(model.allowed('projects')).toBe(false); expect(model.allowed('login')).toBe(true)
  })
  it('redacts credential patterns and avoids rendering a user code as generic status', () => {
    const message = collaborationDetail('ABCD-EFGH access_token=synthetic ghp_syntheticfixture')
    expect(message).not.toContain('ABCD-EFGH'); expect(message).not.toContain('ghp_syntheticfixture')
    expect(message).not.toContain('access_token=synthetic')
  })
})

describe('read-only metadata never survives a different authorization', () => {
  it('clears cached projects immediately on logout', () => {
    discover(); const logout = model.begin('logout')!
    expect(model.projects).toEqual([]); expect(model.account).toBeNull()
    expect(model.respond(state(), logout)).toBe(true)
  })
  it('rejects a pending project reply after logout or account change', () => {
    model.receive(signedIn()); const list = model.begin('projects')!
    model.begin('logout'); expect(model.projectResponse([project], list)).toBe(false)
    model.receive(state()); model.begin('login')
    model.receive(state({ phase: 'signed-in', account: { ...account, id: 8 } }))
    expect(model.projectResponse([project], list)).toBe(false); expect(model.projects).toEqual([])
  })
  it('discards project replies if a more recent main event arrived', () => {
    model.receive(signedIn()); const list = model.begin('projects')!
    model.receive(signedIn()); expect(model.projectResponse([project], list)).toBe(false)
  })
  it('clears codes, accounts and projects on disposal', () => {
    discover(); model.dispose()
    expect(model.projects).toEqual([]); expect(model.account).toBeNull(); expect(model.prompt).toBeNull()
  })
})

describe('settled cancellation can reconcile only through a new explicit status', () => {
  it('recovers a just-completed Main session but still rejects old login results and events', () => {
    model.receive(state()); const login = model.begin('login')!
    model.receive(authorizing()); const cancel = model.begin('cancel')!
    expect(model.respond(signedIn(), cancel)).toBe(false); model.finish('cancel', cancel)
    const status = model.begin('status')!
    expect(status.reconcile).toBe(true); expect(model.respond(signedIn(), status)).toBe(true)
    expect(model.account?.id).toBe(7); expect(model.allowed('projects')).toBe(true)
    expect(model.respond(signedIn(), login)).toBe(false)
    model.receive(authorizing()); model.receive(state({ phase: 'signed-in', account: { ...account, id: 8 } }))
    expect(model.account?.id).toBe(7)
  })
  it('does not upgrade a status request that began while cancellation was still pending', () => {
    model.receive(authorizing()); const cancel = model.begin('cancel')!
    const during = model.begin('status')!; expect(during.reconcile).toBe(false)
    model.finish('cancel', cancel); expect(model.respond(signedIn(), during)).toBe(false)
    model.finish('status', during)
    const fresh = model.begin('status')!; expect(model.respond(signedIn(), fresh)).toBe(true)
    expect(model.account?.id).toBe(7)
  })
  it('still rejects recovery if a newer unconfigured event invalidated its ticket', () => {
    model.receive(authorizing()); const cancel = model.begin('cancel')!; model.finish('cancel', cancel)
    const status = model.begin('status')!; model.receive(state({ phase: 'unconfigured' }))
    expect(model.respond(signedIn(), status)).toBe(false); expect(model.account).toBeNull()
  })
})

describe('reconciliation and failures respect the same close and request epochs', () => {
  it('queues a fresh authoritative status during closing until thaw', () => {
    model.receive(authorizing()); const cancel = model.begin('cancel')!; model.finish('cancel', cancel)
    const status = model.begin('status')!; model.setClosing(true)
    expect(model.respond(signedIn(), status)).toBe(true); expect(model.account).toBeNull()
    model.finish('status', status); model.setClosing(false); expect(model.account?.id).toBe(7)
  })
  it('rejects a failed old login request after a fresh status recovered the account', () => {
    model.receive(state()); const login = model.begin('login')!; model.receive(authorizing())
    const cancel = model.begin('cancel')!; model.finish('cancel', cancel)
    const status = model.begin('status')!; model.respond(signedIn(), status)
    expect(model.fail('login', login)).toBe(false); expect(model.error).toBe(''); expect(model.account?.id).toBe(7)
  })
  it('queues current failures while closing and drops them if a newer state arrived', () => {
    model.receive(state()); const login = model.begin('login')!; model.setClosing(true)
    expect(model.fail('login', login)).toBe(true); expect(model.error).toBe('')
    model.receive(state({ phase: 'error', message: 'newest Main fixture state' })); model.setClosing(false)
    expect(model.error).toBe(''); expect(model.state?.message).toBe('newest Main fixture state')
  })
})

describe('close freeze queues publication and revalidates on thaw', () => {
  it('blocks every new action and queues state rather than changing the visible account', () => {
    model.receive(state()); model.setClosing(true)
    model.receive(signedIn()); expect(model.account).toBeNull(); expect(model.state?.phase).toBe('signed-out')
    for (const action of ['status', 'login', 'cancel', 'logout', 'verify', 'projects'] as const) expect(model.begin(action)).toBeNull()
    model.setClosing(false); expect(model.account?.id).toBe(7)
  })
  it('queues metadata while closing, and publishes it only on a valid thaw', () => {
    model.receive(signedIn()); const list = model.begin('projects')!
    model.setClosing(true); expect(model.projectResponse([project], list)).toBe(true)
    expect(model.projects).toEqual([])
    model.setClosing(false); expect(model.projects).toEqual([project])
  })
  it('does not restore queued metadata after a later signed-out event', () => {
    model.receive(signedIn()); const list = model.begin('projects')!
    model.setClosing(true); model.projectResponse([project], list); model.receive(state())
    model.setClosing(false); expect(model.projects).toEqual([]); expect(model.account).toBeNull()
  })
  it('does not reveal a code that expired during the close confirmation', () => {
    model.receive(authorizing()); model.setClosing(true); now = 11000
    expect(model.prompt).toBeNull(); model.setClosing(false)
    expect(model.prompt).toBeNull(); expect(model.state?.authorization).toBeNull(); expect(model.expired).toBe(true)
  })
  it('replays a timely completed authorization before applying current-time expiration', () => {
    model.receive(state()); model.setClosing(true); model.receive(authorizing())
    now = 2000; model.receive(signedIn()); now = 11000
    model.setClosing(false); expect(model.account?.id).toBe(7); expect(model.prompt).toBeNull()
  })
})
