import type { MinionInput, MinionResult } from '../src/minion/types.mts'
import { MAX_ATTEMPTS } from './constants.mts'
import { blockedNoVerifyFilename, blockedNoVerifyNote, givenUpFilename, givenUpNote } from './notes.mts'
import type { VerifyResult } from './verify-gate.mts'

export interface MinionDeps {
  cloneAndBranch(repoUrl: string, branch: string, workDir: string): Promise<void>
  implementTask(workDir: string, input: MinionInput): Promise<string>
  hasVerifyScript(workDir: string): Promise<boolean>
  runVerify(workDir: string): Promise<VerifyResult>
  writeNote(workDir: string, notesPath: string, filename: string, content: string): Promise<void>
  commitAndPush(workDir: string, branch: string, message: string): Promise<void>
  createPullRequest(branch: string, input: MinionInput): Promise<string>
}

/** Joins whichever of these sections are non-empty; null if none are. */
function combineOutputs(...parts: (string | null | undefined)[]): string | null {
  const nonEmpty = parts.filter((p): p is string => Boolean(p))
  return nonEmpty.length > 0 ? nonEmpty.join('\n\n---\n\n') : null
}

/**
 * Minion's contract, end to end (architecture.md): checkout -> implement ->
 * look for a verify gate -> commit/PR or note, one structured MinionResult at
 * the end. `input.attempt_number >= MAX_ATTEMPTS` is Minion's own final-attempt
 * check (architecture.md: "If this was the final allowed attempt and it still
 * didn't succeed, Minion itself writes a give-up note... before reporting
 * given_up") — duplicating ADR-001's threshold here rather than adding an
 * "isFinalAttempt" field to MinionInput, since Foreman already enforces the
 * same threshold independently (giveUpAttemptCount) and this only needs to
 * agree with it, not be the source of truth for it.
 */
export async function runMinion(
  input: MinionInput,
  repoUrl: string,
  workDir: string,
  notesPath: string,
  deps: MinionDeps,
): Promise<MinionResult> {
  const isFinalAttempt = input.attempt_number >= MAX_ATTEMPTS

  await deps.cloneAndBranch(repoUrl, input.jira_key, workDir)
  const implementOutput = await deps.implementTask(workDir, input)

  if (!(await deps.hasVerifyScript(workDir))) {
    await deps.writeNote(workDir, notesPath, blockedNoVerifyFilename(input.jira_key), blockedNoVerifyNote(input))
    await deps.commitAndPush(workDir, input.jira_key, `${input.jira_key}: no verify gate found`)
    return {
      status: isFinalAttempt ? 'given_up' : 'blocked_no_verify',
      pr_url: null,
      output: combineOutputs(implementOutput),
    }
  }

  const verify = await deps.runVerify(workDir)
  if (!verify.passed) {
    const output = combineOutputs(implementOutput, verify.output)
    if (!isFinalAttempt) {
      return { status: 'failed_verify', pr_url: null, output }
    }
    await deps.writeNote(workDir, notesPath, givenUpFilename(input.jira_key), givenUpNote(input))
    await deps.commitAndPush(workDir, input.jira_key, `${input.jira_key}: giving up after ${MAX_ATTEMPTS} attempts`)
    return { status: 'given_up', pr_url: null, output }
  }

  await deps.commitAndPush(workDir, input.jira_key, `${input.jira_key}: ${input.description.slice(0, 72)}`)
  const prUrl = await deps.createPullRequest(input.jira_key, input)
  return { status: 'success', pr_url: prUrl, output: null }
}
