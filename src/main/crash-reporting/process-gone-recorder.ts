import os from 'node:os'
import { app } from 'electron'
import {
  isCrashReportReason,
  sanitizeCrashReportDetails,
  sanitizeCrashReportString,
  type CrashReportBreadcrumbData
} from '../../shared/crash-reporting'
import type { CrashReportStore } from './crash-report-store'
import { getCrashBreadcrumbSnapshot } from './crash-breadcrumb-store'
import {
  recordCoalescedDurableCrashBreadcrumb,
  recordDurableCrashBreadcrumb
} from './durable-crash-breadcrumb'
import {
  shouldRecordProcessGoneCrash,
  type ExpectedTeardownScope,
  type ProcessGoneSource
} from './process-gone-classification'
import {
  buildProcessGoneCrashDetails,
  buildSuppressedProcessGoneBreadcrumbData
} from './process-gone-diagnostics'
import {
  getProcessGoneDedupeKey,
  processGoneDedupe,
  type ProcessGoneDedupe
} from './process-gone-dedupe'
import {
  countSiblingProcessTreeKills,
  observeProcessGoneKill,
  PROCESS_TREE_KILL_SETTLE_MS
} from './process-tree-kill-window'
import { getMainProcessLifecycleIdentity } from './main-process-lifecycle-identity'
import {
  captureMinidumpSignature,
  scheduleCrashpadDumpPrune,
  type CapturedMinidump
} from './crashpad-capture'
import { minidumpSignatureDetails } from './minidump-crash-signature'
import { flushActiveSink, startSpan } from '../observability/tracer'

export type ProcessGoneCrashEvent = {
  source: ProcessGoneSource
  processType: string
  reason: string
  exitCode: number | null
  expectedTeardown: ExpectedTeardownScope
  details: Record<string, unknown>
}

type CrashReportRecorderStore = Pick<CrashReportStore, 'record' | 'attachDetails'>

/** Injectable so tests can drive the pairing without a Crashpad handler. */
export type MinidumpCapture = (
  crashedAtMs: number,
  expectedProcessType: string
) => Promise<CapturedMinidump | null>

const CHILD_CRASHPAD_PROCESS_TYPES: Readonly<Record<string, string>> = {
  gpu: 'gpu-process',
  utility: 'utility',
  zygote: 'zygote'
}

function expectedCrashpadProcessType(event: ProcessGoneCrashEvent): string | null {
  return event.source === 'renderer'
    ? 'renderer'
    : (CHILD_CRASHPAD_PROCESS_TYPES[event.processType.trim().toLowerCase()] ?? null)
}

const captureProcessMinidump: MinidumpCapture = (crashedAtMs, expectedProcessType) =>
  captureMinidumpSignature(crashedAtMs, { expectedProcessType })

// Why: the coalesce map prunes every key against the calling window, so a shorter
// one here would weaken the other 30s coalescers. Stay uniform with them.
const SUPPRESSED_PROCESS_GONE_COALESCE_MS = 30_000

function processGoneBreadcrumbData(event: ProcessGoneCrashEvent) {
  return buildSuppressedProcessGoneBreadcrumbData(event)
}

// Why: key off the emitted breadcrumb, not the crash-report dedupe key, so two
// different recoverable services can never suppress each other's evidence.
function suppressedProcessGoneCoalesceKey(data: CrashReportBreadcrumbData): string {
  return JSON.stringify([
    data.source,
    data.processType,
    data.reason,
    data.exitCode,
    data.expectedTeardown,
    data.serviceName ?? null,
    data.name ?? null,
    data.type ?? null
  ])
}

function persistFailureData(event: ProcessGoneCrashEvent, error: unknown) {
  const errorCode =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined
  return {
    ...processGoneBreadcrumbData(event),
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: sanitizeCrashReportString(error instanceof Error ? error.message : String(error)),
    ...(errorCode ? { errorCode } : {})
  }
}

/**
 * Folds the Crashpad signature into a report that is already on disk.
 *
 * Why separate from the record write: an exit code of 0x80000003 only says "a
 * CHECK fired"; the name, file and line live in the dump, which Crashpad is
 * still writing when process-gone fires. Waiting inline would stall recovery.
 */
async function attachMinidumpSignature(
  store: CrashReportRecorderStore,
  reportId: string,
  crashedAtMs: number,
  expectedProcessType: string | null,
  capture: MinidumpCapture
): Promise<void> {
  const captured = expectedProcessType ? await capture(crashedAtMs, expectedProcessType) : null
  if (!captured) {
    await store.attachDetails(reportId, { minidumpStatus: 'absent' })
    return
  }
  const signatureDetails = sanitizeCrashReportDetails(minidumpSignatureDetails(captured.signature))
  await store.attachDetails(reportId, {
    ...signatureDetails,
    minidumpStatus: 'captured',
    minidumpPath: captured.filePath,
    minidumpBytes: captured.sizeBytes
  })
  // Why: the crash-report record is capped at 5 entries and is user-facing;
  // the span is what makes the signature countable in the diagnostics bundle.
  const span = startSpan('electron.minidump_signature', {
    attributes: {
      'crash.report_id': reportId,
      'crash.minidump_bytes': captured.sizeBytes,
      ...signatureDetails
    }
  })
  span.end()
  flushActiveSink()
}

function recordSuppressedProcessGone(event: ProcessGoneCrashEvent, siblingKills: number): void {
  // Why: Chromium can crash-loop a recoverable child (network service seen at
  // 1459/min) and each suppressed event costs a span plus a forced disk flush,
  // which both floods the 30-entry ring and evicts the real pre-crash trail.
  const suppressedData = processGoneBreadcrumbData(event)
  recordCoalescedDurableCrashBreadcrumb({
    name: 'process_gone_suppressed',
    data: siblingKills > 0 ? { ...suppressedData, siblingKills } : suppressedData,
    coalesceKey: suppressedProcessGoneCoalesceKey(suppressedData),
    minIntervalMs: SUPPRESSED_PROCESS_GONE_COALESCE_MS
  })
}

function siblingProcessTreeKillCount(event: ProcessGoneCrashEvent): number {
  return countSiblingProcessTreeKills({ reason: event.reason, exitCode: event.exitCode })
}

export function recordProcessGoneCrash(
  store: CrashReportRecorderStore | null,
  event: ProcessGoneCrashEvent,
  dedupe: ProcessGoneDedupe = processGoneDedupe,
  capture: MinidumpCapture = captureProcessMinidump
): void {
  if (!isCrashReportReason(event.reason)) {
    return
  }
  // Crashpad captures suppressed service crashes too; keep a crash loop from
  // filling the disk even when no user-facing report is created.
  scheduleCrashpadDumpPrune()
  // Count before observing so an event is never its own sibling: a lone child
  // kill must classify and breadcrumb with zero siblings, not one.
  const siblingKills = siblingProcessTreeKillCount(event)
  if (event.reason === 'killed') {
    observeProcessGoneKill({
      at: Date.now(),
      source: event.source,
      reason: event.reason,
      exitCode: event.exitCode
    })
  }
  if (
    !shouldRecordProcessGoneCrash({
      source: event.source,
      processType: event.processType,
      serviceName:
        typeof event.details.serviceName === 'string' ? event.details.serviceName : undefined,
      reason: event.reason,
      exitCode: event.exitCode,
      expectedTeardown: event.expectedTeardown,
      siblingChildKills: siblingKills
    })
  ) {
    recordSuppressedProcessGone(event, siblingKills)
    return
  }
  if (event.source === 'renderer' && event.reason === 'killed') {
    // Why: a tree kill can reach the renderer ~100ms before its children, so
    // let the sibling window settle rather than persisting a report the next
    // child event would have retracted. If the main process dies inside the
    // settle, the lost report is the tree-kill report we meant to drop — but
    // flush durable evidence now so even that case leaves a trace.
    // Coalesced: a kill-reload loop must not pay a span plus forced disk flush
    // per event; the first event in a window still flushes synchronously and
    // repeats fold into suppressedSinceLast. Window stays uniform at 30s — the
    // coalesce map prunes every key with the calling window, so a shorter one
    // here would evict the suppressed path's state early. The key is
    // name-prefixed so the settle's suppressed crumb is never folded into this
    // deferral marker.
    const deferredData = processGoneBreadcrumbData(event)
    recordCoalescedDurableCrashBreadcrumb({
      name: 'process_gone_deferred',
      data: deferredData,
      coalesceKey: `process_gone_deferred:${suppressedProcessGoneCoalesceKey(deferredData)}`,
      minIntervalMs: SUPPRESSED_PROCESS_GONE_COALESCE_MS,
      failureCause: `renderer killed (${event.exitCode ?? 'unknown'}); deferred ${PROCESS_TREE_KILL_SETTLE_MS}ms for sibling recount`
    })
    const settleTimer = setTimeout(() => {
      const settledSiblingKills = siblingProcessTreeKillCount(event)
      if (settledSiblingKills > 0) {
        recordSuppressedProcessGone(event, settledSiblingKills)
        return
      }
      persistProcessGoneCrash(store, event, dedupe, capture)
    }, PROCESS_TREE_KILL_SETTLE_MS)
    settleTimer.unref?.()
    return
  }
  persistProcessGoneCrash(store, event, dedupe, capture)
}

function persistProcessGoneCrash(
  store: CrashReportRecorderStore | null,
  event: ProcessGoneCrashEvent,
  dedupe: ProcessGoneDedupe,
  capture: MinidumpCapture
): void {
  if (!store) {
    recordDurableCrashBreadcrumb(
      'crash_report_store_unavailable',
      processGoneBreadcrumbData(event),
      'Crash report store unavailable'
    )
    return
  }

  const key = getProcessGoneDedupeKey(event.source, event.processType, event.reason, event.exitCode)
  const claim = dedupe.tryClaim(key)
  if (!claim) {
    return
  }
  const mainProcessLifecycle = getMainProcessLifecycleIdentity()
  const crashDetails = buildProcessGoneCrashDetails({
    ...event.details,
    ...mainProcessLifecycle
  })
  const breadcrumbs = getCrashBreadcrumbSnapshot()
  const span = startSpan('electron.process_gone', {
    attributes: {
      'crash.source': event.source,
      'crash.process_type': event.processType,
      'crash.reason': event.reason,
      ...(event.exitCode !== null ? { 'crash.exit_code': event.exitCode } : {}),
      'app.version': app.getVersion(),
      platform: process.platform,
      osRelease: os.release(),
      arch: process.arch,
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
      'app.main_process.pid': mainProcessLifecycle.mainProcessPid,
      'app.main_process.launch_id': mainProcessLifecycle.mainProcessLaunchId,
      'app.main_process.started_at': mainProcessLifecycle.mainProcessStartedAt,
      details: crashDetails,
      breadcrumbs
    }
  })
  // Why: a renderer crash can be followed by another process exit before the
  // trace batch window closes, so make the primary signal durable immediately.
  span.fail(
    `${event.source} process gone: ${event.processType} ${event.reason} (${event.exitCode ?? 'unknown'})`
  )
  flushActiveSink()

  const crashedAtMs = Date.now()
  const expectedProcessType = expectedCrashpadProcessType(event)
  void store
    .record({
      source: event.source,
      processType: event.processType,
      reason: event.reason,
      exitCode: event.exitCode,
      appVersion: app.getVersion(),
      platform: process.platform,
      osRelease: os.release(),
      arch: process.arch,
      electronVersion: process.versions.electron ?? 'unknown',
      chromeVersion: process.versions.chrome ?? 'unknown',
      details: crashDetails,
      breadcrumbs
    })
    .then((report) => {
      // Why: kept off the returned chain so a minidump failure can never reach
      // the persist-failure handler below and release a claim that did persist.
      void attachMinidumpSignature(
        store,
        report.id,
        crashedAtMs,
        expectedProcessType,
        capture
      ).catch((error) => {
        console.error('[crash-reporting] Failed to attach minidump signature:', error)
        recordDurableCrashBreadcrumb(
          'minidump_signature_attach_failed',
          processGoneBreadcrumbData(event),
          error instanceof Error ? error.message : String(error)
        )
      })
    })
    .catch((error) => {
      dedupe.release(claim)
      console.error('[crash-reporting] Failed to persist crash report:', error)
      const data = persistFailureData(event, error)
      recordDurableCrashBreadcrumb(
        'crash_report_persist_failed',
        data,
        `${String(data.errorName)}: ${String(data.errorMessage)}`
      )
    })
}
