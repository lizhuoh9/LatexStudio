/** Public GitHub avatar only: no credential, arbitrary URL or account API request. */
export class AccountAvatar {
  private id: number | null = null
  private image: HTMLImageElement | null = null
  private closing = false
  private disposed = false

  constructor(private host: HTMLElement) {}

  update(id: number | null): void {
    if (this.disposed || this.closing) return
    const next = Number.isSafeInteger(id) && id !== null && id > 0 ? id : null
    if (next === this.id) return
    this.clear(); this.id = next
    if (next === null) return
    const image = document.createElement('img')
    this.image = image
    image.alt = ''; image.width = 29; image.height = 29; image.hidden = true
    image.draggable = false; image.decoding = 'async'
    image.crossOrigin = 'anonymous'; image.referrerPolicy = 'no-referrer'
    image.onload = () => {
      if (this.disposed || this.closing || this.image !== image || this.id !== next) return
      image.hidden = false; this.host.classList.toggle('has-image', true)
    }
    image.onerror = () => { if (this.image === image) this.clear() }
    this.host.append(image)
    image.src = `https://avatars.githubusercontent.com/u/${next}?s=64&v=4`
  }

  setClosing(closing: boolean): void {
    this.closing = closing
    if (closing) { this.clear(); this.id = null }
  }

  private clear(): void {
    const image = this.image
    this.image = null
    if (image) {
      image.onload = null; image.onerror = null
      image.removeAttribute('src'); image.remove()
    }
    this.host.classList.toggle('has-image', false)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true; this.clear(); this.id = null
  }
}
