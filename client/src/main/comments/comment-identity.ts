import { randomBytes } from 'node:crypto'
import { commentAuthor, isCommentDevice, type CommentAuthor, type CommentIdentity } from '../../shared/comment-contracts'
import { PrivateRecord } from './private-record'

export interface VerifiedAccount { login: string; id: number }
interface IdentityRecord { version: 1; device: string; account: VerifiedAccount | null }
export interface CommentSigner { device: string; author: CommentAuthor }

const NAME = 'comment-identity.json', MAX_BYTES = 512

function decode(value: unknown): IdentityRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3) throw new Error('invalid')
  const data = value as Record<string, unknown>
  if (data.version !== 1 || !isCommentDevice(data.device)) throw new Error('invalid')
  if (data.account === null) return { version: 1, device: data.device, account: null }
  const author = commentAuthor({ kind: 'github', ...(data.account as object) })
  if (!author || author.kind !== 'github' || Object.keys(data.account as object).length !== 2) throw new Error('invalid')
  return { version: 1, device: data.device, account: { login: author.login, id: author.id } }
}

const same = (a: VerifiedAccount | null, b: VerifiedAccount | null): boolean => a?.id === b?.id && a?.login === b?.login

/** This device's comment file name and the last GitHub account verified while commenting on it.
 * Offline or signed out, new comments are signed with that account; a device that never had one signs as itself.
 * The device id is random and names only this device's own comment file; it identifies no person.
 */
export class CommentIdentityStore {
  private readonly record: PrivateRecord<IdentityRecord>
  constructor(dataRoot: string) { this.record = new PrivateRecord(dataRoot, { name: NAME, maxBytes: MAX_BYTES, decode }) }

  /** For display only; never writes. An unreadable record previews the live account or an anonymous signature. */
  async preview(account: VerifiedAccount | null): Promise<CommentIdentity> {
    if (account) return { source: 'session', login: account.login, id: account.id }
    const saved = await this.record.read().catch(() => null)
    return saved?.account ? { source: 'device', ...saved.account } : { source: 'anonymous' }
  }

  /** Remembers a verified account as this device's latest one. Failures are reported, never repaired. */
  async remember(account: VerifiedAccount): Promise<void> {
    await this.record.update(current => current && same(current.account, account) ? current
      : { version: 1, device: current?.device ?? randomBytes(16).toString('hex'), account: { login: account.login, id: account.id } })
  }

  /** The signer for a new event: the verified session, else the device's last verified account, else the device. */
  async signer(account: VerifiedAccount | null): Promise<CommentSigner> {
    const saved = await this.record.update(current => {
      if (current && (!account || same(current.account, account))) return current
      return { version: 1, device: current?.device ?? randomBytes(16).toString('hex'), account: account ?? current?.account ?? null }
    })
    const signer = account ?? saved.account
    return { device: saved.device, author: signer ? { kind: 'github', login: signer.login, id: signer.id } : { kind: 'local', device: saved.device } }
  }
}
