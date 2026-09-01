import { capture, type VerifyResult } from './verify-gate.mts'

/**
 * The deployment's one-time setup for a fresh checkout, as a shell command —
 * `MINION_SETUP_COMMAND`, in the same spirit as `MINION_VERIFY_COMMAND`. Null
 * when unset, which is the default: most targets need nothing between the
 * clone and the agent.
 *
 * Exists because a target can need its checkout prepared before the agent is
 * *spawned*, not merely before it finishes: CGS/webui's setup installs its
 * external Claude Code skills from its skills-lock.json, and Claude Code
 * discovers skills when its session starts — installed mid-session they are
 * invisible to it. So this cannot be a prompt instruction; it has to be
 * Minion's own step, run ahead of implementTask. Run through `sh -c`, so a
 * setup can be several steps chained with `&&`.
 */
export function setupCommand(): string | null {
  return process.env.MINION_SETUP_COMMAND?.trim() || null
}

/**
 * Runs the setup command in the checkout, capturing output the way the gate
 * does; passes vacuously when no setup is configured. The output only matters
 * on failure — orchestrate.mts puts it in the crashed result, and on success
 * discards it (an `npm install` log is long and says nothing).
 */
export async function runSetup(workDir: string): Promise<VerifyResult> {
  const command = setupCommand()
  if (!command) return { passed: true, output: '' }
  return await capture(['sh', '-c', command], workDir)
}
