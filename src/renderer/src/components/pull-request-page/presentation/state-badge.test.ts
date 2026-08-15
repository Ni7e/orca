import { describe, expect, it } from 'vitest'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import { getStateTone } from './state-badge'

function item(type: GitHubWorkItem['type'], state: GitHubWorkItem['state']): GitHubWorkItem {
  return { type, state } as GitHubWorkItem
}

describe('getStateTone', () => {
  it('uses purple/slate/rose/emerald for pull request states', () => {
    expect(getStateTone(item('pr', 'merged'))).toContain('purple')
    expect(getStateTone(item('pr', 'draft'))).toContain('slate')
    expect(getStateTone(item('pr', 'closed'))).toContain('rose')
    expect(getStateTone(item('pr', 'open'))).toContain('emerald')
  })

  it('uses rose for a closed issue and emerald otherwise', () => {
    expect(getStateTone(item('issue', 'closed'))).toContain('rose')
    expect(getStateTone(item('issue', 'open'))).toContain('emerald')
  })
})
