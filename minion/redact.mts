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
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@]+@/gi, '$1***@')
}
