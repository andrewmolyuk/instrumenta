import { describe, expect, it } from 'vitest'
import type { MinionInput } from '../src/minion/types.mts'
import { blockedNoVerifyFilename, blockedNoVerifyNote, givenUpFilename, givenUpNote } from '../minion/notes.mts'

const INPUT: MinionInput = { task_id: 't1', jira_key: 'KAZ-42', attempt_number: 3 }

describe('note filenames', () => {
  it('lowercases the jira_key', () => {
    expect(blockedNoVerifyFilename('KAZ-42')).toBe('kaz-42-blocked-no-verify.md')
    expect(givenUpFilename('KAZ-42')).toBe('kaz-42-given-up.md')
  })
})

describe('blockedNoVerifyNote', () => {
  it('has the docs/todo/ frontmatter convention and mentions the jira_key', () => {
    const note = blockedNoVerifyNote(INPUT)
    expect(note).toMatch(/^---\ntype: bug\nstatus: open\ndate: \d{4}-\d{2}-\d{2}\nsource: minion t1\n---/)
    expect(note).toContain('KAZ-42')
    expect(note).toContain('verify')
  })
})

describe('givenUpNote', () => {
  it('has the docs/todo/ frontmatter convention and mentions the jira_key', () => {
    const note = givenUpNote(INPUT)
    expect(note).toMatch(/^---\ntype: bug\nstatus: open\ndate: \d{4}-\d{2}-\d{2}\nsource: minion t1\n---/)
    expect(note).toContain('KAZ-42')
    expect(note).toContain('3')
  })
})
