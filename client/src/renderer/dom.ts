import { forgetUiText, textIsLiteral, uiText } from './i18n-dom'

export function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id)
  if (!value) throw new Error(`缺少界面元素：${id}`)
  return value as T
}

export function text(id: string, value: string): void {
  const node = element(id)
  if (textIsLiteral(id)) { forgetUiText(node); node.textContent = value }
  else uiText(node, value)
}

export function button(id: string, handler: () => void): void {
  element<HTMLButtonElement>(id).addEventListener('click', handler)
}

export function listItem(label: string, detail = ''): HTMLLIElement {
  const item = document.createElement('li')
  const name = document.createElement('span')
  name.textContent = label
  item.append(name)
  if (detail) {
    const note = document.createElement('small')
    note.textContent = detail
    item.append(note)
  }
  return item
}

export function appendLog(message: string): void {
  const log = element<HTMLPreElement>('log')
  log.textContent = ((log.textContent ?? '') + message).slice(-160000)
  log.scrollTop = log.scrollHeight
}
