import type { ProjectFile } from '../shared/workspace-contracts'
import { element } from './dom'
import { createFileIcon } from './file-icons'
import { uiText } from './i18n-dom'

interface FileNode { name: string; path: string; children: Map<string, FileNode>; file?: ProjectFile }
interface ExpansionState { projectKey: string; active: string; collapsed: Set<string> }
const expansions = new WeakMap<HTMLElement, ExpansionState>()
let childListId = 0

export function renderFiles(files: ProjectFile[], active: string, open: (path: string) => void, projectKey = ''): void {
  const tree = element('file-tree'), state = expansionState(tree, projectKey, active)
  const root: FileNode = { name: '', path: '', children: new Map() }
  for (const file of files) addFile(root, file)
  const directories = new Set<string>()
  tree.replaceChildren(...renderChildren(root, state, open, directories))
  if (!root.children.size) {
    const empty = document.createElement('li'); empty.className = 'empty'; uiText(empty, '项目中暂无可见文件。')
    tree.append(empty)
  }
  for (const path of state.collapsed) if (!directories.has(path)) state.collapsed.delete(path)
  const count = files.filter(file => file.kind !== 'directory').length
  uiText(element('file-count'), `${count} 个文件${directories.size ? ` · ${directories.size} 个文件夹` : ''}`)
}

function expansionState(tree: HTMLElement, projectKey: string, active: string): ExpansionState {
  let state = expansions.get(tree)
  if (!state || state.projectKey !== projectKey) {
    state = { projectKey, active: '', collapsed: new Set() }; expansions.set(tree, state)
  }
  if (active !== state.active) {
    const parts = active.split('/')
    for (let i = 1; i < parts.length; i += 1) state.collapsed.delete(parts.slice(0, i).join('/'))
    state.active = active
  }
  return state
}

function addFile(root: FileNode, file: ProjectFile): void {
  let parent = root
  for (const name of file.path.split('/')) {
    const path = parent.path ? `${parent.path}/${name}` : name
    let node = parent.children.get(name)
    if (!node) { node = { name, path, children: new Map() }; parent.children.set(name, node) }
    parent = node
  }
  if (file.kind !== 'directory') parent.file = file
}

function renderChildren(parent: FileNode, state: ExpansionState, open: (path: string) => void, directories: Set<string>): HTMLLIElement[] {
  return [...parent.children.values()]
    .sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name, 'zh-CN'))
    .map(node => {
      const item = document.createElement('li'); item.className = node.file ? 'file-tree-file' : 'file-tree-directory'
      if (node.file) item.append(fileButton(node, state.active, open))
      else item.append(...directoryContents(node, state, open, directories))
      return item
    })
}

function fileButton(node: FileNode, active: string, open: (path: string) => void): HTMLButtonElement {
  const button = baseButton(node, 'file-entry')
  button.setAttribute('aria-current', node.path === active ? 'page' : 'false')
  const size = document.createElement('small'), bytes = node.file?.size ?? 0
  size.textContent = bytes < 1024 ? `${bytes} B` : `${Math.ceil(bytes / 1024)} KB`
  button.append(size); button.addEventListener('click', () => open(node.path))
  return button
}

function directoryContents(node: FileNode, state: ExpansionState, open: (path: string) => void, directories: Set<string>): HTMLElement[] {
  directories.add(node.path)
  const button = baseButton(node, 'directory-entry'), children = document.createElement('ul')
  children.className = 'file-tree-children'; children.id = `file-tree-children-${++childListId}`
  children.hidden = state.collapsed.has(node.path)
  button.setAttribute('aria-controls', children.id); button.setAttribute('aria-expanded', String(!children.hidden))
  children.append(...renderChildren(node, state, open, directories))
  if (!node.children.size) {
    const empty = document.createElement('li'); empty.className = 'file-tree-empty'; uiText(empty, '空文件夹')
    children.append(empty)
  }
  button.addEventListener('click', () => {
    children.hidden = !children.hidden
    if (children.hidden) state.collapsed.add(node.path); else state.collapsed.delete(node.path)
    button.setAttribute('aria-expanded', String(!children.hidden))
  })
  return [button, children]
}

function baseButton(node: FileNode, className: string): HTMLButtonElement {
  const button = document.createElement('button'), label = document.createElement('span')
  button.type = 'button'; button.className = className; button.dataset.lock = ''; button.title = node.path
  label.className = 'file-label'; label.textContent = node.name
  button.append(createFileIcon(node.name, className === 'directory-entry'), label)
  return button
}
