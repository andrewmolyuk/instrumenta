/**
 * The common backlog-item shape adapters normalize into (architecture.md's
 * "Task Provider" section). Foreman's Pick step only ever deals in this shape —
 * it doesn't need to know which source a task came from.
 */
export interface BacklogItem {
  jira_key: string
  /**
   * The ticket's one-line title. Foreman shows this and picks by it; it does
   * not carry the ticket's body. Minion reads the full ticket — description and
   * attachments included — from Jira itself at the start of an attempt, so
   * there is one source for what a task actually says, and it is the live one
   * rather than whatever Foreman happened to read when it built the queue.
   */
  summary: string
}

export interface TaskProvider {
  /** The live, ordered backlog — read fresh on every call, never cached (architecture.md). */
  listBacklog(): Promise<BacklogItem[]>
  /**
   * How many tasks match the source's query in total, which `listBacklog` does
   * not say: it returns one page, so counting its result reports the page size.
   * Optional — a source that cannot answer cheaply should leave it out rather
   * than paginate the whole backlog to produce a number for a dashboard.
   */
  backlogCount?(): Promise<number>
}
