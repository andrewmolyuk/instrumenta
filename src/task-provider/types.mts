/**
 * The common backlog-item shape adapters normalize into (architecture.md's
 * "Task Provider" section). Foreman's Pick step only ever deals in this shape —
 * it doesn't need to know which source a task came from.
 */
export interface BacklogItem {
  jira_key: string
  summary: string
  description: string
}

export interface TaskProvider {
  /** The live, ordered backlog — read fresh on every call, never cached (architecture.md). */
  listBacklog(): Promise<BacklogItem[]>
}
