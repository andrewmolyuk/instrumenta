/**
 * Minimal Atlassian Document Format -> plain text converter. Jira returns
 * `description` as ADF (a nested JSON tree), not a string. This only needs to
 * produce something readable for a task description fed to Minion — not a
 * faithful re-render — so unknown node types just recurse into `content`.
 */

export interface AdfNode {
  type?: string
  text?: string
  content?: AdfNode[]
}

const BLOCK_TYPES = new Set(['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote'])

export function adfToPlainText(node: AdfNode | null | undefined): string {
  if (!node) return ''
  // Block types can nest (e.g. paragraph inside listItem) and each adds its own
  // trailing newline — collapse the resulting runs down to one line break.
  return walk(node).trim().replace(/\n{2,}/g, '\n')
}

function walk(node: AdfNode): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'

  const children = (node.content ?? []).map(walk).join('')
  if (node.type && BLOCK_TYPES.has(node.type)) return `${children}\n`
  return children
}
