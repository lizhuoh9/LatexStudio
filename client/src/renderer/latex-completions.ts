import { snippetCompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { environments } from '../vendor/ayakaleaf/environments'
import { translate } from '../shared/i18n'

/** Adapt upstream $1 placeholders for the standard CM6 snippet API. */
export function adaptSnippet(source: string): string {
  return source.replace(/\$(\d+)/g, (_match, position: string) => `\${${position}}`)
}

export function latexCompletions(context: CompletionContext): CompletionResult | null {
  const environment = context.matchBefore(/\\begin\{[a-zA-Z*]*/)
  if (!environment && !context.explicit) return null
  const from = environment?.from ?? context.pos
  return {
    from,
    options: [...environments].map(([name, source]) => snippetCompletion(adaptSnippet(source), {
      label: `\\begin{${name}}`, detail: translate('LaTeX 环境 · AyakaLeaf'), type: 'keyword'
    })),
    validFor: /^\\begin\{[a-zA-Z*]*$/
  }
}
