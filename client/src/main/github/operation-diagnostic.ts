/** Closed local codes only. Provider bodies, causes, tokens and URLs are never displayed. */
export type OperationDiagnostic = 'unauthorized' | 'forbidden' | 'create-forbidden' | 'invalid-repository' | 'network' | 'response' | 'git-fetch' | 'git-network' | 'git-response'
const codes = new WeakMap<object, OperationDiagnostic>()
const messages: Record<OperationDiagnostic, string> = {
  unauthorized: 'GitHub 登录已失效，请重新登录后核对远端状态。',
  forbidden: 'GitHub 拒绝访问（403）。请检查账号对该仓库的权限或重新登录授权；限流也可能导致此响应。',
  'create-forbidden': 'GitHub 拒绝创建仓库（403）。请确认已完成登录授权，并检查账号或组织的仓库创建限制；限流也可能阻止创建。',
  'invalid-repository': 'GitHub 未接受仓库名称或创建参数（422）。请先核对账号下是否已有同名仓库，并检查名称和账号仓库限制。',
  network: 'GitHub 请求或响应未完成，请检查网络；若已提交创建请求，请先核对 GitHub 上是否已有仓库。',
  response: 'GitHub 返回的信息未通过验证。若已提交创建请求，请先核对远端仓库，不要重复创建。',
  'git-fetch': '读取 GitHub 远端历史失败；本地快照仍保留，尚未进入上传步骤。',
  'git-network': 'GitHub 文件传输连接未完成；请检查网络后核对远端状态。',
  'git-response': 'GitHub 文件传输响应未通过长度或格式检查；本地文件仍保留。'
}
export function rememberOperationDiagnostic(error: object, code: OperationDiagnostic): void { codes.set(error, code) }
export function readOperationDiagnostic(error: unknown): OperationDiagnostic | undefined {
  return error !== null && (typeof error === 'object' || typeof error === 'function') ? codes.get(error) : undefined
}
export function operationDiagnosticMessage(code: OperationDiagnostic): string { return messages[code] }
