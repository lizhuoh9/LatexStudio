export function isTrustedSettingsSender(
  senderId: number, expectedId: number, isMainFrame: boolean,
  actualUrl: string, expectedUrl: string
): boolean {
  return senderId === expectedId && isMainFrame && actualUrl === expectedUrl
}
