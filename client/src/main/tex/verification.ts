/** Bounded I/O only: all bytes are still checked; result order never changes a pinned catalog.
 * A failed/aborted batch drains its siblings before rejecting, so no hidden file reads outlive the caller.
 */
export const VERIFICATION_CONCURRENCY = 4
export async function mapVerification<T, R>(items: readonly T[], operation: (item: T) => Promise<R>,
  signal?: AbortSignal): Promise<R[]> {
  const values: R[] = []
  for (let offset = 0; offset < items.length; offset += VERIFICATION_CONCURRENCY) {
    signal?.throwIfAborted()
    const batch = await Promise.allSettled(items.slice(offset, offset + VERIFICATION_CONCURRENCY).map(item => Promise.resolve().then(() => operation(item))))
    signal?.throwIfAborted()
    for (const result of batch) {
      if (result.status === 'rejected') throw result.reason
      values.push(result.value)
    }
  }
  signal?.throwIfAborted()
  return values
}
