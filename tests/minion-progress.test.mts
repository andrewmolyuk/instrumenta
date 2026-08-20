import { describe, expect, it } from 'vitest'
import { decodeProgress, encodeProgress, PROGRESS_MARKER } from '../src/minion/progress.mts'

describe('progress protocol', () => {
  it('round-trips a line and a cost', () => {
    expect(decodeProgress(encodeProgress({ line: 'Read src/foo.ts', cost_usd: 1.5 }))).toEqual({
      line: 'Read src/foo.ts',
      cost_usd: 1.5,
    })
  })

  it('encodes on a single line, so a stream reader can split on newlines', () => {
    expect(encodeProgress({ line: 'first\nsecond' })).not.toContain('\n')
  })

  it('ignores lines that are not progress at all', () => {
    // Everything a target project's own toolchain prints to stderr comes through
    // the same pipe — none of it may be mistaken for a progress update.
    expect(decodeProgress('npm WARN deprecated foo@1.0.0')).toBeNull()
    expect(decodeProgress('{"line":"no marker"}')).toBeNull()
  })

  it('ignores a marker line whose payload is malformed or wrongly typed', () => {
    expect(decodeProgress(PROGRESS_MARKER + ' not json')).toBeNull()
    expect(decodeProgress(PROGRESS_MARKER + ' {"line":42,"cost_usd":"free"}')).toEqual({})
  })
})
