import type { CompileRequest, GitHubSettings, TexEngine } from '../../shared/workspace-contracts'

export function requireText(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) {
    throw new Error(`${label}格式不正确。`)
  }
  return value
}

export function requireSettings(value: unknown): GitHubSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请填写仓库和授权信息。')
  const data = value as Record<string, unknown>
  const url = requireText(data.url, '仓库地址', 2048)
  const token = requireText(data.token, '授权信息', 8192)
  if (/\s/.test(token)) throw new Error('授权信息不能包含空格或换行。')
  return { url, token }
}

export function requireCompile(value: unknown): CompileRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('编译设置格式不正确。')
  const data = value as Record<string, unknown>
  const mainFile = requireText(data.mainFile, '主文档')
  const engines: TexEngine[] = ['pdflatex', 'xelatex', 'lualatex']
  if (!engines.includes(data.engine as TexEngine)) throw new Error('请选择受支持的编译引擎。')
  return { mainFile, engine: data.engine as TexEngine }
}

export function safeOperationError(error: unknown, secrets: string[] = []): Error {
  let message = error instanceof Error ? error.message : '操作未完成，请重试。'
  for (const secret of secrets) if (secret) message = message.split(secret).join('[已隐藏]')
  message = message.replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://[已隐藏]@')
  return new Error(message.slice(0, 1200))
}
