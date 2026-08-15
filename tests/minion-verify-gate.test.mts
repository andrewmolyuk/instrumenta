import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hasVerifyScript, runVerify } from '../minion/verify-gate.mts'

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
    writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts: { verify: 'yes x | head -c 5000; exit 1' } }))
    const result = await runVerify(d)
    expect(result.passed).toBe(false)
    expect(result.output.length).toBeLessThan(5000)
    expect(result.output).toContain('truncated')
  })
})
