import { describe, expect, it } from 'vitest'
import { MAX_SESSION_CHARS } from '../minion/constants.mts'
import { redactCredentials } from '../minion/redact.mts'

describe('redactCredentials', () => {
  it('strips the token out of a Bitbucket clone URL, keeping the rest readable', () => {
    const redacted = redactCredentials(
      'git clone https://x-token-auth:ATATT3xFfGF0secret=1B17@bitbucket.org/CGS/webui.git /tmp/w',
    )

    expect(redacted).not.toContain('ATATT3xFfGF0secret')
    expect(redacted).toBe('git clone https://x-token-auth:***@bitbucket.org/CGS/webui.git /tmp/w')
  })

  it('redacts a password containing slashes and plus signs, as base64 secrets do', () => {
    expect(redactCredentials('https://user:pa/ss+word@example.com/x')).toBe('https://user:***@example.com/x')
  })

  it('leaves a URL with no credentials alone', () => {
    const clean = 'no credentials here https://bitbucket.org/CGS/webui.git'
    expect(redactCredentials(clean)).toBe(clean)
  })

  it('runs in linear time over a full-size session record', () => {
    // Regression: the first spelling of this anchored on the scheme name
    // (`[a-z][a-z0-9+.-]*://`), which backtracks quadratically over a long run
    // of letters — 222ms at 20k characters, tens of seconds at the cap below,
    // with a Minion stalled the whole time. Caught by a test that timed out.
    const started = Date.now()
    redactCredentials('x'.repeat(MAX_SESSION_CHARS))
    expect(Date.now() - started).toBeLessThan(500)
  })
})
