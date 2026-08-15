import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalWorktreeParkingDebugVerdict } from './terminal-parking-e2e-overrides'

const harness = vi.hoisted(() => ({
  census: { managers: 0, panes: 0 },
  crumbs: [] as { name: string; data?: Record<string, unknown> }[]
}))

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: (name: string, data?: Record<string, unknown>) => {
    harness.crumbs.push({ name, ...(data ? { data } : {}) })
  }
}))

vi.mock('@/lib/pane-manager/pane-manager-registry', () => ({
  getLivePaneCensus: () => harness.census
}))

import {
  queueTerminalWorktreeParkingPass,
  resetTerminalWorktreeParkingPassTelemetry,
  summarizeTerminalWorktreeParkingPass
} from './terminal-worktree-parking-telemetry'

function verdict(
  overrides: Partial<TerminalWorktreeParkingDebugVerdict> & { worktreeId: string }
): TerminalWorktreeParkingDebugVerdict {
  return {
    forceParked: false,
    hasActivityTerminalPortal: false,
    hasPendingSpawnWork: false,
    hiddenSinceMs: null,
    isVisible: false,
    ordinaryParkingCovers: false,
    parkCooldownUntilMs: null,
    shouldMeasureHiddenWorktree: false,
    ...overrides
  }
}

describe('worktree parking pass telemetry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetTerminalWorktreeParkingPassTelemetry()
    harness.census = { managers: 49, panes: 60 }
    harness.crumbs.length = 0
  })

  afterEach(() => {
    resetTerminalWorktreeParkingPassTelemetry()
    vi.useRealTimers()
  })

  it('summarizes deadline cohorts and vetoes so clock resets and vetoes separate', () => {
    const nowMs = 100 * 60_000
    // Clock-reset shape: hidden but always younger than the 30s park delay.
    const clockReset = summarizeTerminalWorktreeParkingPass({
      verdicts: [
        verdict({ worktreeId: 'a', hiddenSinceMs: nowMs - 10_000 }),
        verdict({ worktreeId: 'b', hiddenSinceMs: nowMs - 25_000 })
      ],
      census: harness.census,
      ordinaryParkedCount: 0,
      parkingEnabled: true,
      retentionBudgetEnabled: true,
      nowMs
    })
    expect(clockReset.hiddenTracked).toBe(2)
    expect(clockReset.hiddenPastParkDelay).toBe(0)
    expect(clockReset.oldestHiddenAgeMs).toBe(25_000)

    // Veto shape: long-hidden but blocked at decision time.
    const vetoed = summarizeTerminalWorktreeParkingPass({
      verdicts: [
        verdict({
          worktreeId: 'a',
          hiddenSinceMs: nowMs - 20 * 60_000,
          hasPendingSpawnWork: true
        }),
        verdict({
          worktreeId: 'b',
          hiddenSinceMs: nowMs - 6 * 60_000,
          parkCooldownUntilMs: nowMs + 1_000
        }),
        verdict({
          worktreeId: 'young',
          hiddenSinceMs: nowMs - 10_000,
          hasPendingSpawnWork: true
        })
      ],
      census: harness.census,
      ordinaryParkedCount: 0,
      parkingEnabled: true,
      retentionBudgetEnabled: false,
      nowMs
    })
    expect(vetoed.hiddenPastParkDelay).toBe(2)
    expect(vetoed.hiddenPastHotRetain).toBe(2)
    expect(vetoed.hiddenPastRetentionTtl).toBe(1)
    expect(vetoed.pastParkDelayPendingSpawnWork).toBe(1)
    expect(vetoed.pastParkDelayCooldown).toBe(1)
    expect(vetoed.managers).toBe(49)
    expect(vetoed.parkingEnabled).toBe(true)
    expect(vetoed.retentionBudgetEnabled).toBe(false)
  })

  it('keeps veto counts inside the aged cohort', () => {
    const nowMs = 20 * 60_000
    const summary = summarizeTerminalWorktreeParkingPass({
      verdicts: [
        verdict({
          worktreeId: 'aged-covered',
          hiddenSinceMs: 0,
          ordinaryParkingCovers: true
        }),
        verdict({
          worktreeId: 'young-pending',
          hiddenSinceMs: nowMs - 10_000,
          hasPendingSpawnWork: true
        })
      ],
      census: harness.census,
      ordinaryParkedCount: 0,
      parkingEnabled: true,
      retentionBudgetEnabled: true,
      nowMs
    })

    expect(summary.hiddenPastParkDelay).toBe(1)
    expect(summary.pastParkDelayOrdinaryParkingCovers).toBe(1)
    expect(summary.pastParkDelayPendingSpawnWork).toBe(0)
  })

  it('queues every pass for main-process coalescing', () => {
    const base = [verdict({ worktreeId: 'a', hiddenSinceMs: 0 })]
    queueTerminalWorktreeParkingPass({
      verdicts: base,
      ordinaryParkedCount: 0,
      parkingEnabled: true,
      retentionBudgetEnabled: true,
      nowMs: 60_000
    })
    vi.runOnlyPendingTimers()
    expect(harness.crumbs).toHaveLength(1)
    expect(harness.crumbs[0]?.name).toBe('terminal_parking_pass')
    expect(harness.crumbs[0]?.data?.hiddenPastParkDelay).toBe(1)

    const shifted = [verdict({ worktreeId: 'a', hiddenSinceMs: 0, hasPendingSpawnWork: true })]
    queueTerminalWorktreeParkingPass({
      verdicts: shifted,
      ordinaryParkedCount: 0,
      parkingEnabled: true,
      retentionBudgetEnabled: true,
      nowMs: 61_000
    })
    vi.runOnlyPendingTimers()
    expect(harness.crumbs).toHaveLength(2)
    expect(harness.crumbs[1]?.data?.pastParkDelayPendingSpawnWork).toBe(1)
  })

  it('samples the manager census after the queued pass', () => {
    queueTerminalWorktreeParkingPass({
      verdicts: [],
      ordinaryParkedCount: 0,
      parkingEnabled: true,
      retentionBudgetEnabled: true,
      nowMs: 60_000
    })
    harness.census = { managers: 7, panes: 9 }
    expect(harness.crumbs).toHaveLength(0)

    vi.runOnlyPendingTimers()
    expect(harness.crumbs[0]?.data?.managers).toBe(7)
    expect(harness.crumbs[0]?.data?.panes).toBe(9)
  })

  it('cancels a queued sample when the terminal surface unmounts', () => {
    queueTerminalWorktreeParkingPass({
      verdicts: [],
      ordinaryParkedCount: 0,
      parkingEnabled: true,
      retentionBudgetEnabled: true,
      nowMs: 60_000
    })

    resetTerminalWorktreeParkingPassTelemetry()
    vi.runOnlyPendingTimers()

    expect(harness.crumbs).toHaveLength(0)
  })
})
