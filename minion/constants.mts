/** ADR-001's give-up threshold — the attempt number at which Minion self-reports given_up. */
export const MAX_ATTEMPTS = 3

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
