/**
 * Chromium switches that would let another local process drive the privileged workspace renderer (its preload API
 * opens, saves and compiles projects) or change V8 behaviour. A packaged build refuses to start with any of them.
 * Node's --inspect family, NODE_OPTIONS and ELECTRON_RUN_AS_NODE are disabled by Electron fuses at package time.
 */
export const FORBIDDEN_SWITCHES = Object.freeze(['remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address',
  'remote-allow-origins', 'js-flags'] as const)

/** The first forbidden switch present on the command line, if any. */
export function forbiddenSwitch(hasSwitch: (name: string) => boolean): string | undefined {
  return FORBIDDEN_SWITCHES.find(name => hasSwitch(name))
}
