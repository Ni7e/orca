/**
 * Production telemetry for the worktree parking pass.
 *
 * Why: the pass already computes a per-worktree verdict every run and throws
 * it away outside e2e, so a field bundle cannot say WHY hidden worktrees never
 * park — a hiddenSince clock that keeps resetting is indistinguishable from a
 * decision-time veto (pending spawn work, cooldown, coverage). One bounded,
 * coalesced latest-state breadcrumb answers that, alongside the post-commit
 * manager census the same bundles used to infer from crumb multiplicity.
 */
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import { getLivePaneCensus } from '@/lib/pane-manager/pane-manager-registry'
import { TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS } from './terminal-hidden-worktree-retention'
import {
  TERMINAL_WORKTREE_COLD_PARK_DELAY_MS,
  TERMINAL_WORKTREE_HOT_RETAIN_MS
} from './terminal-hidden-view-parking'
import type { TerminalWorktreeParkingDebugVerdict } from './terminal-parking-e2e-overrides'

export const TERMINAL_PARKING_PASS_BREADCRUMB = 'terminal_parking_pass'

export type TerminalWorktreeParkingPassSummary = {
  managers: number
  panes: number
  sampledAtMs: number
  parkingEnabled: boolean
  retentionBudgetEnabled: boolean
  worktrees: number
  hiddenTracked: number
  /** Hidden ages crossing the policy deadlines — the clock-reset discriminator:
   *  a resetting hiddenSince keeps all three at zero forever. */
  hiddenPastParkDelay: number
  hiddenPastHotRetain: number
  hiddenPastRetentionTtl: number
  oldestHiddenAgeMs: number
  visible: number
  pastParkDelayMeasuring: number
  portal: number
  pastParkDelayOrdinaryParkingCovers: number
  pastParkDelayPendingSpawnWork: number
  pastParkDelayCooldown: number
  ordinaryParked: number
  forceParked: number
}

export function summarizeTerminalWorktreeParkingPass(args: {
  verdicts: readonly TerminalWorktreeParkingDebugVerdict[]
  census: { managers: number; panes: number }
  ordinaryParkedCount: number
  parkingEnabled: boolean
  retentionBudgetEnabled: boolean
  nowMs: number
}): TerminalWorktreeParkingPassSummary {
  const summary: TerminalWorktreeParkingPassSummary = {
    managers: args.census.managers,
    panes: args.census.panes,
    sampledAtMs: args.nowMs,
    parkingEnabled: args.parkingEnabled,
    retentionBudgetEnabled: args.retentionBudgetEnabled,
    worktrees: args.verdicts.length,
    hiddenTracked: 0,
    hiddenPastParkDelay: 0,
    hiddenPastHotRetain: 0,
    hiddenPastRetentionTtl: 0,
    oldestHiddenAgeMs: 0,
    visible: 0,
    pastParkDelayMeasuring: 0,
    portal: 0,
    pastParkDelayOrdinaryParkingCovers: 0,
    pastParkDelayPendingSpawnWork: 0,
    pastParkDelayCooldown: 0,
    ordinaryParked: args.ordinaryParkedCount,
    forceParked: 0
  }
  for (const verdict of args.verdicts) {
    if (verdict.isVisible) {
      summary.visible += 1
    }
    if (verdict.hasActivityTerminalPortal) {
      summary.portal += 1
    }
    if (verdict.forceParked) {
      summary.forceParked += 1
    }
    if (verdict.hiddenSinceMs === null || verdict.isVisible) {
      continue
    }
    summary.hiddenTracked += 1
    const ageMs = Math.max(0, args.nowMs - verdict.hiddenSinceMs)
    summary.oldestHiddenAgeMs = Math.max(summary.oldestHiddenAgeMs, ageMs)
    if (ageMs >= TERMINAL_WORKTREE_COLD_PARK_DELAY_MS) {
      summary.hiddenPastParkDelay += 1
      if (verdict.shouldMeasureHiddenWorktree) {
        summary.pastParkDelayMeasuring += 1
      }
      if (verdict.ordinaryParkingCovers) {
        summary.pastParkDelayOrdinaryParkingCovers += 1
      }
      if (verdict.hasPendingSpawnWork) {
        summary.pastParkDelayPendingSpawnWork += 1
      }
      if (verdict.parkCooldownUntilMs != null && args.nowMs < verdict.parkCooldownUntilMs) {
        summary.pastParkDelayCooldown += 1
      }
    }
    if (ageMs >= TERMINAL_WORKTREE_HOT_RETAIN_MS) {
      summary.hiddenPastHotRetain += 1
    }
    if (ageMs >= TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS) {
      summary.hiddenPastRetentionTtl += 1
    }
  }
  return summary
}

let queuedSummary: TerminalWorktreeParkingPassSummary | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null

export function resetTerminalWorktreeParkingPassTelemetry(): void {
  queuedSummary = null
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
}

/** Queues the latest pass so its census observes the resulting pane unmounts. */
export function queueTerminalWorktreeParkingPass(args: {
  verdicts: readonly TerminalWorktreeParkingDebugVerdict[]
  ordinaryParkedCount: number
  parkingEnabled: boolean
  retentionBudgetEnabled: boolean
  nowMs: number
}): void {
  queuedSummary = summarizeTerminalWorktreeParkingPass({
    verdicts: args.verdicts,
    census: { managers: 0, panes: 0 },
    ordinaryParkedCount: args.ordinaryParkedCount,
    parkingEnabled: args.parkingEnabled,
    retentionBudgetEnabled: args.retentionBudgetEnabled,
    nowMs: args.nowMs
  })
  if (flushTimer !== null) {
    return
  }
  flushTimer = setTimeout(() => {
    flushTimer = null
    const summary = queuedSummary
    queuedSummary = null
    if (!summary) {
      return
    }
    recordRendererCrashBreadcrumb(TERMINAL_PARKING_PASS_BREADCRUMB, {
      ...summary,
      ...getLivePaneCensus()
    })
  }, 0)
}
