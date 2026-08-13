import { describe, expect, it } from 'vitest'
import { adfToPlainText } from '../src/task-provider/adf.mts'

describe('adfToPlainText', () => {
  it('returns empty string for null/undefined', () => {
    expect(adfToPlainText(null)).toBe('')
    expect(adfToPlainText(undefined)).toBe('')
  })

  it('joins plain text runs within a paragraph', () => {
    const node = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Hello, ' }, { type: 'text', text: 'world.' }],
        },
      ],
    }
    expect(adfToPlainText(node)).toBe('Hello, world.')
  })

  it('separates paragraphs with newlines', () => {
    const node = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First.' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second.' }] },
      ],
    }
    expect(adfToPlainText(node)).toBe('First.\nSecond.')
  })

  it('turns a hardBreak into a newline', () => {
    const node = {
      type: 'paragraph',
      content: [{ type: 'text', text: 'Line one' }, { type: 'hardBreak' }, { type: 'text', text: 'line two' }],
    }
    expect(adfToPlainText(node)).toBe('Line one\nline two')
  })

  it('flattens a bullet list into one line per item', () => {
    const node = {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] },
      ],
    }
    expect(adfToPlainText(node)).toBe('one\ntwo')
  })

  it('recurses through an unknown node type instead of dropping its content', () => {
    const node = {
      type: 'someFutureNodeType',
      content: [{ type: 'text', text: 'still readable' }],
    }
    expect(adfToPlainText(node)).toBe('still readable')
  })
})
