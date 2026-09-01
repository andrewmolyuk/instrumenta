import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runSetup, setupCommand } from '../minion/setup.mts'

let dir: string | undefined

// Cleared before each test too, not only after: Bun loads the repository's own
// .env into process.env, and a deployment value set there (as this repo's is)
// would otherwise leak into the "unset" cases.
beforeEach(() => {
  delete process.env.MINION_SETUP_COMMAND
})

afterEach(() => {
  delete process.env.MINION_SETUP_COMMAND
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function tempDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'minion-setup-'))
  return dir
}

describe('setupCommand', () => {
  it('is null by default — most targets need no setup step', () => {
    expect(setupCommand()).toBeNull()
  })

  it('is null for a blank value, not an empty command', () => {
    process.env.MINION_SETUP_COMMAND = '   '
    expect(setupCommand()).toBeNull()
  })
})

describe('runSetup', () => {
  it('passes vacuously when no setup is configured', async () => {
    expect(await runSetup(tempDir())).toEqual({ passed: true, output: '' })
  })

  it('runs the command through a shell, so steps can be chained', async () => {
    process.env.MINION_SETUP_COMMAND = 'echo installed && echo skills'

    const result = await runSetup(tempDir())

    expect(result.passed).toBe(true)
    expect(result.output).toContain('installed')
    expect(result.output).toContain('skills')
  })

  it('fails, with the output captured, when any chained step fails', async () => {
    process.env.MINION_SETUP_COMMAND = 'echo before-failure 1>&2 && exit 2'

    const result = await runSetup(tempDir())

    expect(result.passed).toBe(false)
    expect(result.output).toContain('before-failure')
  })
})
