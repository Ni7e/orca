import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { rebaseMobileNativeChatPendingBaselines } from './mobile-native-chat-pending-baseline'
import type { MobileNativeChatPendingMessage } from './mobile-native-chat-pending-echo'

function userTurn(id: string, text: string, timestamp: number): NativeChatMessage {
  return { id, role: 'user', blocks: [{ type: 'text', text }], timestamp, source: 'transcript' }
}

function assistantTurn(id: string, text: string, timestamp: number): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp,
    source: 'transcript'
  }
}

function unresolved(
  id: string,
  text: string,
  expectedOccurrence = 1
): MobileNativeChatPendingMessage {
  return { id, text, expectedOccurrence, baselineTailMessageId: null, baselineResolved: false }
}

describe('rebaseMobileNativeChatPendingBaselines', () => {
  const history = [userTurn('m1', 'run the tests', 1000), assistantTurn('m2', 'passed', 1100)]

  it('returns the same array when every baseline is already resolved', () => {
    const pending: MobileNativeChatPendingMessage[] = [
      {
        id: 'p1',
        text: 'hi',
        expectedOccurrence: 1,
        baselineTailMessageId: 'm2',
        baselineResolved: true
      }
    ]
    expect(rebaseMobileNativeChatPendingBaselines(history, pending)).toBe(pending)
  })

  it('pins an unresolved send to the loaded tail and past the rows it never saw', () => {
    expect(
      rebaseMobileNativeChatPendingBaselines(history, [unresolved('p1', 'run the tests')])
    ).toEqual([
      {
        id: 'p1',
        text: 'run the tests',
        // The one row already in history is not this send's echo; it waits for the second.
        expectedOccurrence: 2,
        baselineTailMessageId: 'm2',
        baselineResolved: true
      }
    ])
  })

  it('pins to null when the authoritative transcript is empty', () => {
    expect(rebaseMobileNativeChatPendingBaselines([], [unresolved('p1', 'hi')])).toEqual([
      {
        id: 'p1',
        text: 'hi',
        expectedOccurrence: 1,
        baselineTailMessageId: null,
        baselineResolved: true
      }
    ])
  })

  it('gives identical queued sends consecutive ordinals', () => {
    expect(
      rebaseMobileNativeChatPendingBaselines(history, [
        unresolved('p1', 'run the tests'),
        unresolved('p2', 'run the tests')
      ]).map((item) => item.expectedOccurrence)
    ).toEqual([2, 3])
  })

  it('normalizes whitespace when counting a send against the loaded rows', () => {
    expect(
      rebaseMobileNativeChatPendingBaselines(history, [unresolved('p1', '  run   the tests \n')])[0]
        ?.expectedOccurrence
    ).toBe(2)
  })

  it('leaves already-resolved neighbours untouched but still counts them', () => {
    const resolved: MobileNativeChatPendingMessage = {
      id: 'p1',
      text: 'run the tests',
      expectedOccurrence: 9,
      baselineTailMessageId: 'm1',
      baselineResolved: true
    }
    const rebased = rebaseMobileNativeChatPendingBaselines(history, [
      resolved,
      unresolved('p2', 'run the tests')
    ])
    expect(rebased[0]).toBe(resolved)
    expect(rebased[1]?.expectedOccurrence).toBe(3)
  })

  it('ordinals caption-less image echoes among themselves, not against text rows', () => {
    const images = { ...unresolved('p1', ''), images: ['file:///a.png'] }
    const rebased = rebaseMobileNativeChatPendingBaselines(history, [
      images,
      { ...unresolved('p2', ''), images: ['file:///b.png'] }
    ])
    expect(rebased.map((item) => item.expectedOccurrence)).toEqual([1, 2])
    expect(rebased.map((item) => item.baselineTailMessageId)).toEqual(['m2', 'm2'])
  })
})
