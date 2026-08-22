import type { MinionInput, MinionResult } from '../src/minion/types.mts'
import { MAX_ATTEMPTS } from './constants.mts'
import { extractReport, type ImplementResult } from './implement-task.mts'
import type { JiraTicket } from './jira.mts'
import { buildSessionRecord } from './session.mts'
import { attempts, blockedNoVerifyFilename, blockedNoVerifyNote, givenUpFilename, givenUpNote } from './notes.mts'
import type { PreCommitResult, VerifyResult } from './verify-gate.mts'

export interface MinionDeps {
  cloneAndBranch(repoUrl: string, branch: string, workDir: string, reuseExisting: boolean): Promise<void>
  hasOpenPrForBranch(branch: string): Promise<boolean>
  /** Reads the ticket from Jira, downloading its attachments into `attachmentDir`. */
  fetchTicket(jiraKey: string, attachmentDir: string): Promise<JiraTicket>
  implementTask(workDir: string, input: MinionInput, ticket: JiraTicket): Promise<ImplementResult>
  hasVerifyScript(workDir: string): Promise<boolean>
  runVerify(workDir: string): Promise<VerifyResult>
  runPreCommitChecks(workDir: string): Promise<PreCommitResult>
  /** True if the work tree has anything to commit — false means the agent changed nothing (ADR-014). */
  hasChanges(workDir: string): Promise<boolean>
  /** Best-effort Jira comment; returns false if it could not be posted. */
  commentOnTicket(jiraKey: string, text: string): Promise<boolean>
  writeNote(workDir: string, notesPath: string, filename: string, content: string): Promise<void>
  commitAndPush(workDir: string, branch: string, message: string): Promise<void>
  createPullRequest(branch: string, input: MinionInput, ticket: JiraTicket, agentReport: string | null): Promise<string>
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
 * so the first character is lowercased before it goes into the subject. Free
 * text also means embedded newlines: a raw description turned `git commit -m`'s
 * argument into a subject plus a body, so KAZ-8390's whole subject was
 * `fix: KAZ-8390: steps:` (its description's first line) with the rest of the
 * ticket dumped into the body without the blank line commitlint's
 * `body-leading-blank` wants — see commitSubject.
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
 * The gate has two parts (ADR-009): the target project's own `verify` script,
 * and — since a passing `verify` doesn't mean the commit will be allowed — the
 * `pre-commit` hook that same project would run at commit time, executed here
 * *before* committing. Either one failing takes the same path: `failed_verify`
 * (or `given_up` plus a note on the final attempt), nothing committed, the
 * captured output kept for the human or the next attempt. `commitAndPush` then
 * commits with `--no-verify`, so those checks run exactly once per attempt
 * rather than a second time inside a commit that can only crash the run.
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
/**
 * Cap on the description text in a commit subject: keeps the whole header
 * (`fix: KAZ-1234: ` plus this) inside the 100 characters commitlint's
 * conventional preset allows by default.
 */
const MAX_SUBJECT_DESCRIPTION_CHARS = 72

/**
 * A Jira description turned into one commit-subject line: all whitespace
 * (newlines included) collapsed to single spaces, first character lowercased
 * for commitlint's `subject-case`, then truncated. Collapsing first rather
 * than truncating first matters — the truncation then spends its budget on
 * ticket text instead of stopping at the description's first line break.
 */
function commitSubject(description: string): string {
  const oneLine = description.replace(/\s+/g, ' ').trim()
  const lowercased = oneLine.charAt(0).toLowerCase() + oneLine.slice(1)
  return lowercased.slice(0, MAX_SUBJECT_DESCRIPTION_CHARS).trimEnd()
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

/**
 * A failing gate, either part of it (see runMinion): report `failed_verify` and
 * commit nothing, or — on the final allowed attempt — write the give-up note
 * and push that, per architecture.md's step 4.
 */
async function reportFailedGate(
  deps: MinionDeps,
  input: MinionInput,
  workDir: string,
  notesPath: string,
  attempt: { isFinalAttempt: boolean; costUsd: number | null; output: string | null; session: string },
): Promise<MinionResult> {
  const { isFinalAttempt, costUsd, output, session } = attempt
  if (!isFinalAttempt) {
    return { status: 'failed_verify', pr_url: null, output, cost_usd: costUsd, session }
  }
  await deps.writeNote(workDir, notesPath, givenUpFilename(input.jira_key), givenUpNote(input))
  const commitError = await tryCommitAndPush(
    deps,
    workDir,
    input.jira_key,
    `chore: ${input.jira_key}: giving up after ${attempts(MAX_ATTEMPTS)}`,
  )
  if (commitError) {
    return { status: 'crashed', pr_url: null, output: combineOutputs(output, commitError), cost_usd: costUsd, session }
  }
  return { status: 'given_up', pr_url: null, output, cost_usd: costUsd, session }
}

/**
 * What Minion tells a human on Jira when it changed nothing. Deliberately
 * states that the checks passed *unmodified* and that this is the agent's
 * conclusion, not a verified fact — a reader deciding whether to close the
 * ticket needs to know which of those they are being handed.
 */
function noChangeComment(input: MinionInput, agentAccount: string): string {
  const report = extractReport(agentAccount) ?? agentAccount
  return [
    `instrumenta made no change for ${input.jira_key} (attempt ${input.attempt_number}).`,
    "The project's own checks pass against an unmodified working tree, and the agent",
    'produced no edits. Its account of why follows — this is the agent\'s conclusion, not',
    'a verified one. No pull request was opened, and this ticket will not be attempted',
    'again automatically.',
    '',
    report.trim().length > 0 ? report : '(the agent gave no account)',
  ].join('\n')
}

export async function runMinion(
  input: MinionInput,
  repoUrl: string,
  workDir: string,
  notesPath: string,
  deps: MinionDeps,
): Promise<MinionResult> {
  const isFinalAttempt = input.attempt_number >= MAX_ATTEMPTS

  // Attachments land beside the work tree, never inside it: commitAndPush runs
  // `git add -A`, so a screenshot written into the clone would be committed and
  // shipped in the pull request.
  const attachmentDir = `${workDir}-attachments`

  // Before the clone, and fatal if it fails: an attempt that cannot read its
  // own ticket has nothing to work from, and running anyway is precisely what
  // produced RPG-5427's empty-brief pull request. Better to crash and retry.
  const ticket = await deps.fetchTicket(input.jira_key, attachmentDir)

  const hasOpenPr = await deps.hasOpenPrForBranch(input.jira_key)
  await deps.cloneAndBranch(repoUrl, input.jira_key, workDir, !hasOpenPr)
  const { output: implementOutput, costUsd, transcript } = await deps.implementTask(workDir, input, ticket)
  // Built once, here, so every exit below reports the same record — including
  // the `success` path, which is the one that had no diagnostic at all before.
  const session = buildSessionRecord({ input, ticket, transcript, agentSummary: implementOutput, costUsd })

  if (!(await deps.hasVerifyScript(workDir))) {
    await deps.writeNote(workDir, notesPath, blockedNoVerifyFilename(input.jira_key), blockedNoVerifyNote(input))
    const commitError = await tryCommitAndPush(
      deps,
      workDir,
      input.jira_key,
      `chore: ${input.jira_key}: no verify gate found`,
    )
    if (commitError) {
      return {
        status: 'crashed',
        pr_url: null,
        output: combineOutputs(implementOutput, commitError),
        cost_usd: costUsd,
        session,
      }
    }
    return {
      status: isFinalAttempt ? 'given_up' : 'blocked_no_verify',
      pr_url: null,
      output: combineOutputs(implementOutput),
      cost_usd: costUsd,
      session,
    }
  }

  const verify = await deps.runVerify(workDir)
  if (!verify.passed) {
    return await reportFailedGate(deps, input, workDir, notesPath, {
      isFinalAttempt,
      costUsd,
      session,
      output: combineOutputs(implementOutput, verify.output),
    })
  }

  const preCommit = await deps.runPreCommitChecks(workDir)
  if (!preCommit.passed) {
    return await reportFailedGate(deps, input, workDir, notesPath, {
      isFinalAttempt,
      costUsd,
      session,
      output: combineOutputs(implementOutput, preCommit.output),
    })
  }

  // The gate passed and there is nothing to commit: the agent concluded the
  // ticket needs no change (ADR-014). Before this, `git commit` failed with
  // "nothing to commit" and the attempt was recorded as `crashed` — the best
  // possible outcome reported as the worst, then retried twice more at full
  // cost to reach the same conclusion, and finally `given_up`.
  //
  // What is *observed* here is narrow: the checks pass and the diff is empty.
  // Whether that means "already fixed" or "the agent achieved nothing" is the
  // agent's account, not something this can verify — so the account goes to
  // Jira for a human, and the status says only what was seen.
  if (!(await deps.hasChanges(workDir))) {
    await deps.commentOnTicket(input.jira_key, noChangeComment(input, implementOutput))
    return { status: 'no_change', pr_url: null, output: implementOutput, cost_usd: costUsd, session }
  }

  const commitError = await tryCommitAndPush(
    deps,
    workDir,
    input.jira_key,
    `fix: ${input.jira_key}: ${commitSubject(ticket.summary)}`,
  )
  if (commitError) {
    return {
      status: 'crashed',
      pr_url: null,
      output: combineOutputs(implementOutput, commitError),
      cost_usd: costUsd,
      session,
    }
  }
  try {
    const prUrl = await deps.createPullRequest(input.jira_key, input, ticket, extractReport(implementOutput))
    return { status: 'success', pr_url: prUrl, output: null, cost_usd: costUsd, session }
  } catch (err) {
    const prError = err instanceof Error ? err.message : String(err)
    return {
      status: 'crashed',
      pr_url: null,
      output: combineOutputs(implementOutput, prError),
      cost_usd: costUsd,
      session,
    }
  }
}
