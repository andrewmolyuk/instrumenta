import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hasVerifyScript, runPreCommitHook, runVerify } from '../minion/verify-gate.mts'

let dir: string

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'minion-verify-gate-'))
  return dir
}

describe('hasVerifyScript', () => {
  it('is false when there is no package.json', async () => {
    expect(await hasVerifyScript(tempDir())).toBe(false)
  })

  it('is false when package.json has no verify script', async () => {
    const d = tempDir()
    writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts: { test: 'echo hi' } }))
    expect(await hasVerifyScript(d)).toBe(false)
  })

  it('is true when package.json has a verify script', async () => {
    const d = tempDir()
    writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts: { verify: 'exit 0' } }))
    expect(await hasVerifyScript(d)).toBe(true)
  })

  it('is false for malformed json rather than throwing', async () => {
    const d = tempDir()
    writeFileSync(join(d, 'package.json'), '{ not valid json')
    expect(await hasVerifyScript(d)).toBe(false)
  })
})

describe('runVerify', () => {
  it('passes when the verify script exits 0', async () => {
    const d = tempDir()
    writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts: { verify: 'exit 0' } }))
    expect((await runVerify(d)).passed).toBe(true)
  })

  it('fails when the verify script exits non-zero', async () => {
    const d = tempDir()
    writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts: { verify: 'exit 1' } }))
    expect((await runVerify(d)).passed).toBe(false)
  })

  it('captures combined stdout and stderr in output', async () => {
    const d = tempDir()
    writeFileSync(
      join(d, 'package.json'),
      JSON.stringify({ scripts: { verify: 'echo out-line; echo err-line 1>&2; exit 1' } }),
    )
    const result = await runVerify(d)
    expect(result.output).toContain('out-line')
    expect(result.output).toContain('err-line')
  })

  it('truncates output over the cap, keeping the tail', async () => {
    const d = tempDir()
    writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts: { verify: 'yes x | head -c 20000; exit 1' } }))
    const result = await runVerify(d)
    expect(result.passed).toBe(false)
    expect(result.output.length).toBeLessThan(20000)
    expect(result.output).toContain('truncated')
  })
})

/** A git repo with a `pre-commit` hook at `hookPath`, executable, running `body`. */
function repoWithHook(hookPath: string | null, body = 'exit 0'): string {
  const d = tempDir()
  execFileSync('git', ['init', '-q', '.'], { cwd: d })
  if (hookPath) {
    const full = join(d, hookPath)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, `#!/bin/sh\n${body}\n`)
    chmodSync(full, 0o755)
  }
  return d
}

describe('runPreCommitHook', () => {
  it('reports nothing to run, and passes, when the repo has no pre-commit hook', async () => {
    expect(await runPreCommitHook(repoWithHook(null))).toEqual({ ran: false, passed: true, output: '' })
  })

  it('passes without running anything when the directory is not a git repo at all', async () => {
    expect((await runPreCommitHook(tempDir())).ran).toBe(false)
  })

  it('runs the default .git/hooks/pre-commit and passes when it exits 0', async () => {
    const result = await runPreCommitHook(repoWithHook('.git/hooks/pre-commit'))
    expect(result).toEqual({ ran: true, passed: true, output: '' })
  })

  it('fails, with the hook output captured, when the hook exits non-zero', async () => {
    const d = repoWithHook('.git/hooks/pre-commit', 'echo "2 problems (2 errors, 0 warnings)" 1>&2; exit 1')
    const result = await runPreCommitHook(d)
    expect(result.ran).toBe(true)
    expect(result.passed).toBe(false)
    expect(result.output).toContain('2 problems')
  })

  it('finds the hook through core.hooksPath, the way Husky installs it', async () => {
    const d = repoWithHook('.husky/_/pre-commit', 'echo husky-ran; exit 1')
    execFileSync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: d })

    const result = await runPreCommitHook(d)
    expect(result.passed).toBe(false)
    expect(result.output).toContain('husky-ran')
  })

  it('ignores a hook file without the executable bit, the same way git does', async () => {
    const d = repoWithHook('.git/hooks/pre-commit', 'exit 1')
    chmodSync(join(d, '.git/hooks/pre-commit'), 0o644)

    expect((await runPreCommitHook(d)).ran).toBe(false)
  })

  it('truncates hook output over the cap, keeping the tail', async () => {
    const d = repoWithHook('.git/hooks/pre-commit', 'yes x | head -c 20000; exit 1')
    const result = await runPreCommitHook(d)
    expect(result.passed).toBe(false)
    expect(result.output.length).toBeLessThan(20000)
    expect(result.output).toContain('truncated')
  })
})
