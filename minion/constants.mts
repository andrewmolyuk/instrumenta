/**
 * The give-up threshold: the attempt number at which Minion self-reports
 * given_up. Lowered from ADR-001's 3 to 1 by ADR-015 — an attempt costs real
 * money and the same model rereading the same code tends to fail the same way,
 * so a retry mostly buys a second bill.
 *
 * Must stay equal to GIVE_UP_THRESHOLD in src/foreman/pick.mts, which enforces
 * the same rule independently; a test asserts they agree.
 */
export const MAX_ATTEMPTS = 1

/** Cap on captured verify output stored per attempt — keeps the tail, where failures are summarized. */
export const MAX_VERIFY_OUTPUT_CHARS = 16000

/** Cap on captured Claude Code output from implementTask — keeps the tail, same reasoning as verify. */
export const MAX_IMPLEMENT_OUTPUT_CHARS = 16000

/**
 * Cap on the session transcript stored per attempt (`tasks.session`). Generous
 * — the whole point is to be able to reconstruct what an agent actually did —
 * but bounded, since an agent that loops can generate steps indefinitely, and
 * this crosses a stdout pipe as JSON before it reaches the database.
 */
export const MAX_SESSION_CHARS = 200_000

/** Bitbucket's cap on a pull request description. */
export const MAX_PR_DESCRIPTION_CHARS = 32_768

/**
 * Cap on one step in the session transcript.
 *
 * Was effectively 100 characters, sized for a ten-line hover tooltip that no
 * longer exists — it cut every `Bash:` line mid-command, which is exactly the
 * part you read the log for. The transcript now opens in a near-fullscreen
 * modal, so this only needs to stop a single step from swallowing the whole
 * record; MAX_SESSION_CHARS bounds the total either way.
 */
export const MAX_STEP_CHARS = 600

/**
 * Screenshots the agent leaves for Minion to attach to the ticket (ADR-016).
 * Fixed names so orchestrate knows what to look for without the agent having to
 * report anything back, and a directory beside the work tree rather than inside
 * it, for the same reason attachments live there: `git add -A` would otherwise
 * commit them into the pull request.
 */
export const SHOT_NAMES = ['before.png', 'after.png'] as const
