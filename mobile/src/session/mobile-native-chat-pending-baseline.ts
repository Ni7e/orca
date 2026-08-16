import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  countUserTextOccurrences,
  normalizeReconcileText
} from './mobile-native-chat-draft-reconcile'
import type { MobileNativeChatPendingMessage } from './mobile-native-chat-pending-echo'

/**
 * Pin the sends issued while the transcript was still hydrating onto the first
 * authoritative read of this session's history.
 *
 * Such a send has no usable baseline at capture time: `messages` was empty, or
 * still the previously active tab's, so both its tail and its occurrence count
 * describe somebody else's transcript. Rebasing them here — rather than marking
 * the send permanently untrustworthy, which stranded it as a queued bubble and
 * as a glue barrier for its neighbours for the rest of the session — leaves it
 * matching exactly the rows that arrive from now on.
 */
export function rebaseMobileNativeChatPendingBaselines(
  messages: readonly NativeChatMessage[],
  current: MobileNativeChatPendingMessage[]
): MobileNativeChatPendingMessage[] {
  if (current.every((item) => item.baselineResolved)) {
    return current
  }
  const baselineTailMessageId = messages.at(-1)?.id ?? null
  const earlierByText = new Map<string, number>()
  let earlierImageEchoes = 0
  return current.map((item) => {
    const normalized = normalizeReconcileText(item.text)
    const earlier = normalized === '' ? earlierImageEchoes : (earlierByText.get(normalized) ?? 0)
    if (normalized === '') {
      earlierImageEchoes += item.images?.length ? 1 : 0
    } else {
      earlierByText.set(normalized, earlier + 1)
    }
    if (item.baselineResolved) {
      return item
    }
    return {
      ...item,
      baselineTailMessageId,
      baselineResolved: true,
      // Ordinals stay relative to the queue: earlier still-pending sends of the
      // same text claim the earlier rows, so this one waits for its own.
      expectedOccurrence:
        normalized === ''
          ? earlier + 1
          : countUserTextOccurrences(messages, normalized) + earlier + 1
    }
  })
}
