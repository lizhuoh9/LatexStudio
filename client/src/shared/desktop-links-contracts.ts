export interface DesktopLinksApi {
  pending(): Promise<string | null>
  acknowledge(link: string): Promise<void>
  onLink(listener: (link: string) => void): () => void
}

export const DESKTOP_LINKS_CHANNELS = Object.freeze({
  pending: 'desktop-links:pending', acknowledge: 'desktop-links:acknowledge', link: 'desktop-links:link'
})
