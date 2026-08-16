import type { MinionInput, MinionResult } from '../src/minion/types.mts'
import { MAX_ATTEMPTS } from './constants.mts'
import { blockedNoVerifyFilename, blockedNoVerifyNote, givenUpFilename, givenUpNote } from './notes.mts'
import type { VerifyResult } from './verify-gate.mts'

export interface MinionDeps {
  cloneAndBranch(repoUrl: string, branch: string, workDir: string, reuseExisting: boolean): Promise<void>
  hasOpenPrForBranch(branch: string): Promise<boolean>
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
 *
 * Commit messages are prefixed `fix:`/`chore:` (Conventional Commits) — found
 * live that a target repo with a Husky commit-msg hook (commitlint) rejects
 * anything else outright, turning what should be a clean `blocked_no_verify`
 * or `failed_verify` report into a crash instead. `fix:` for the real
 * implementation commit, `chore:` for the note-only commits (no code change).
 * The subject text itself also has to avoid sentence-case (commitlint's
 * `subject-case` rule, part of the conventional-commit preset most target
 * repos use) — Jira descriptions are free text and often start capitalized,
 * so the first character is lowercased before it goes into the subject.
 *
 * Even with that, a target repo's commit-msg hook can still reject a commit
 * for reasons this file can't predict (a different lint rule, max length,
 * scope format, ...), and `createPullRequest` can fail for reasons entirely
 * outside the commit itself (e.g. a misconfigured base branch — Bitbucket
 * rejects a PR whose destination branch doesn't exist). Both are caught here
 * rather than left to crash the process uncaught, so either case still ends
 * in the one structured MinionResult this contract promises instead of an
 * uncaught exception ProcessMinionRunner has to guess at from raw
 * stdout/stderr. `status: 'crashed'` still fits ADR-001's definition ("Minion
 * exited without reporting a structured result at all") in spirit — this is
 * that same fatal, unplanned outcome, just reported directly instead of
 * inferred. Note that by the time createPullRequest can fail, commitAndPush
 * has already succeeded — the branch is pushed even though this attempt
 * reports `crashed`; a human fixing the underlying cause can open the PR
 * from that branch by hand rather than needing a full re-run.
 *
 * Before cloning, checks whether this jira_key's branch already has an open
 * PR — if not (the common retry-after-crash case), cloneAndBranch reuses an
 * existing remote branch of the same name instead of always branching fresh
 * from the base tip (see its own comment for why: a plain re-branch-and-push
 * collides non-fast-forward against a branch an earlier, partially-successful
 * attempt already pushed). This lets a retry resume and re-verify whatever's
 * already on that branch — implementTask and runVerify run against it exactly
 * as they would a fresh clone — rather than redoing the work or getting stuck
 * behind a stale push every attempt. Foreman's own pick() (ADR-007) already
 * skips a jira_key with an open PR before ever dispatching it, so this mostly
 * matters for retries within the give-up window, not fresh dispatches — but
 * checking here too means Minion's own contract doesn't depend on Foreman
 * having done it first.
 */
function lowercaseFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
}

/** Runs commitAndPush; returns the error message instead of throwing on failure. */
async function tryCommitAndPush(
  deps: MinionDeps,
  workDir: string,
  branch: string,
  message: string,
): Promise<string | null> {
  try {
    await deps.commitAndPush(workDir, branch, message)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

export async function runMinion(
  input: MinionInput,
  repoUrl: string,
  workDir: string,
  notesPath: string,
  deps: MinionDeps,
): Promise<MinionResult> {
  const isFinalAttempt = input.attempt_number >= MAX_ATTEMPTS

  const hasOpenPr = await deps.hasOpenPrForBranch(input.jira_key)
  await deps.cloneAndBranch(repoUrl, input.jira_key, workDir, !hasOpenPr)
  const implementOutput = await deps.implementTask(workDir, input)

  if (!(await deps.hasVerifyScript(workDir))) {
    await deps.writeNote(workDir, notesPath, blockedNoVerifyFilename(input.jira_key), blockedNoVerifyNote(input))
    const commitError = await tryCommitAndPush(
      deps,
      workDir,
      input.jira_key,
      `chore: ${input.jira_key}: no verify gate found`,
    )
    if (commitError) {
      return { status: 'crashed', pr_url: null, output: combineOutputs(implementOutput, commitError) }
    }
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
    const commitError = await tryCommitAndPush(
      deps,
      workDir,
      input.jira_key,
      `chore: ${input.jira_key}: giving up after ${MAX_ATTEMPTS} attempts`,
    )
    if (commitError) {
      return { status: 'crashed', pr_url: null, output: combineOutputs(output, commitError) }
    }
    return { status: 'given_up', pr_url: null, output }
  }

  const commitError = await tryCommitAndPush(
    deps,
    workDir,
    input.jira_key,
    `fix: ${input.jira_key}: ${lowercaseFirst(input.description.slice(0, 72))}`,
  )
  if (commitError) {
    return { status: 'crashed', pr_url: null, output: combineOutputs(implementOutput, commitError) }
  }
  try {
    const prUrl = await deps.createPullRequest(input.jira_key, input)
    return { status: 'success', pr_url: prUrl, output: null }
  } catch (err) {
    const prError = err instanceof Error ? err.message : String(err)
    return { status: 'crashed', pr_url: null, output: combineOutputs(implementOutput, prError) }
  }
}
