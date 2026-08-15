/** ADR-001's give-up threshold — the attempt number at which Minion self-reports given_up. */
export const MAX_ATTEMPTS = 3

/** Cap on captured verify output stored per attempt — keeps the tail, where failures are summarized. */
export const MAX_VERIFY_OUTPUT_CHARS = 16000

/** Cap on captured Claude Code output from implementTask — keeps the tail, same reasoning as verify. */
export const MAX_IMPLEMENT_OUTPUT_CHARS = 16000
