import type { MinionInput } from '../src/minion/types.mts'
import { MAX_ATTEMPTS } from './constants.mts'

/** Matches docs/todo/_template.md's frontmatter convention (CONTEXT.md's Notes path). */
function frontmatter(taskId: string): string {
  const date = new Date().toISOString().slice(0, 10)
  return `---\ntype: bug\nstatus: open\ndate: ${date}\nsource: minion ${taskId}\n---\n`
}

export function blockedNoVerifyFilename(jiraKey: string): string {
  return `${jiraKey.toLowerCase()}-blocked-no-verify.md`
}

export function givenUpFilename(jiraKey: string): string {
  return `${jiraKey.toLowerCase()}-given-up.md`
}

export function blockedNoVerifyNote(input: MinionInput): string {
  return `${frontmatter(input.task_id)}
# No verify gate found for ${input.jira_key}

Minion looked for a \`verify\` script in \`package.json\` before implementing this task
and didn't find one. Nothing was implemented or committed beyond this note —
instrumenta doesn't invent its own definition of "done" when a target project hasn't
defined one (see vision.md's Scope). Add a \`"verify"\` script under \`scripts\` in
\`package.json\` to unblock this and future tasks.
`
}

export function givenUpNote(input: MinionInput): string {
  return `${frontmatter(input.task_id)}
# Gave up on ${input.jira_key} after ${MAX_ATTEMPTS} attempts

Minion attempted this task ${MAX_ATTEMPTS} times without a passing \`verify\` run. See
the attempt history in Foreman for what happened on each try. Needs a human to look at
${input.jira_key} directly.
`
}
