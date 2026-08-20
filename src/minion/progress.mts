/**
 * The live-progress side-channel from Minion to Foreman.
 *
 * Minion's *stdout* is contractually exactly one MinionResult JSON
 * (architecture.md, and ProcessMinionRunner parses it as such), so progress
 * can't go there without corrupting that result. It goes on stderr instead,
 * one marker-prefixed line per event, interleaved with whatever else Minion
 * writes there — the marker is what lets ProcessMinionRunner tell the two
 * apart while the process is still running.
 *
 * Deliberately line-oriented rather than a socket or a shared volume: Foreman
 * already owns Minion's stderr pipe (it spawned the container), so this needs
 * no new port, mount, or failure mode. A dropped or malformed line costs one
 * progress update and nothing else — decodeProgress returns null rather than
 * throwing, since a target project is free to print anything to stderr.
 */
export const PROGRESS_MARKER = '@@minion-progress@@'

export interface MinionProgress {
  /** One human-readable line of what Minion is doing right now. */
  line?: string
  /** Claude Code's running total_cost_usd for this attempt, as of this event. */
  cost_usd?: number
}

export function encodeProgress(progress: MinionProgress): string {
  return `${PROGRESS_MARKER} ${JSON.stringify(progress)}`
}

/** The MinionProgress in `line`, or null if it isn't a well-formed progress line. */
export function decodeProgress(line: string): MinionProgress | null {
  if (!line.startsWith(PROGRESS_MARKER)) return null
  try {
    const parsed = JSON.parse(line.slice(PROGRESS_MARKER.length))
    if (typeof parsed !== 'object' || parsed === null) return null
    const progress: MinionProgress = {}
    if (typeof parsed.line === 'string') progress.line = parsed.line
    if (typeof parsed.cost_usd === 'number') progress.cost_usd = parsed.cost_usd
    return progress
  } catch {
    return null
  }
}
