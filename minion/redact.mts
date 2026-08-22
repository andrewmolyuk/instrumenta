/**
 * Strips the password out of any `scheme://user:password@host` URL in `text`.
 *
 * Anything Minion reports outward gets run through this. Every git command it
 * runs is handed the clone URL with BITBUCKET_TOKEN embedded in it
 * (buildCloneUrl), and a session transcript records the commands the agent ran
 * — so without this, a live write-scoped credential lands in a `tasks.output`
 * row, the Cockpit's Recent Attempts table, and now a pull request description,
 * permanently and to anyone who can see any of them.
 */
export function redactCredentials(text: string): string {
  return text.replace(CREDENTIAL_IN_URL, '$1:***@')
}

/**
 * Anchored on `//` rather than on the scheme name.
 *
 * The obvious spelling — `[a-z][a-z0-9+.-]*:\/\/...` — backtracks quadratically:
 * at every position in a long run of letters the engine consumes the whole run
 * looking for `://`, fails, and restarts one character along. Measured at 222ms
 * over 20k characters and rising with the square, which against a 200k-character
 * session record (MAX_SESSION_CHARS) is tens of seconds of a Minion doing
 * nothing. `//` is a literal the engine can scan for directly, and neither
 * character class can run away, so this is linear.
 */
const CREDENTIAL_IN_URL = /(\/\/[^\s/@:]+):[^\s@]+@/g
