import { execFile } from 'node:child_process'
import { join } from 'node:path'

/** \\server\share\... (not the \\?\ or \\.\ device namespaces). */
export function isUncPath(path: string): boolean {
  return /^(?:\\\\|\/\/)(?![?.](?:\\|\/|$))[^\\/]+[\\/][^\\/]+/.test(path)
}

type DriveQuery = () => Promise<ReadonlySet<string>>

/** Drive letters mapped to network shares, from `net use` (no shell, bounded time and output). */
export function mappedNetworkDrives(): Promise<ReadonlySet<string>> {
  const net = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'net.exe')
  return new Promise(resolve => {
    execFile(net, ['use'], { timeout: 3000, windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) { resolve(new Set()); return }
      const drives = new Set<string>()
      for (const match of stdout.matchAll(/^\s*\S*\s+([A-Za-z]):\s+\\\\[^\s\\]+\\/gm)) drives.add(match[1]!.toUpperCase())
      resolve(drives)
    })
  })
}

/** Detect Windows network roots so retired NAS paths are rejected before local Git operations. */
export async function isNetworkProject(root: string, platform: NodeJS.Platform = process.platform,
  drives: DriveQuery = mappedNetworkDrives): Promise<boolean> {
  if (platform !== 'win32') return false
  if (isUncPath(root)) return true
  const letter = /^([A-Za-z]):[\\/]/.exec(root)?.[1]?.toUpperCase()
  return letter ? (await drives()).has(letter) : false
}
