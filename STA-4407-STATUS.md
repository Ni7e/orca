# STA-4407 status

## Implementation

- Bounded pending-terminal handle recovery to five `session.tabs.list` attempts at 2-second cadence.
- Kept tombstone, browser-focus, and native-chat recovery behavior outside the pending-terminal budget.
- Reset the budget for terminal identity changes, reconnect/subscription epochs, foregrounding, focus, and explicit Retry.
- Replaced the parked spinner with an actionable Retry state using existing mobile theme tokens and styles.
- Before/after simulated-hour measurement: 1,800 requests before; 5 requests after, at 2s, 4s, 6s, 8s, and 10s.

## Validation

- `pnpm exec vitest run --config vitest.config.ts pending-terminal-handle-recovery mobile-session-tabs-stream-health mobile-session-startup-source use-mobile-session-tabs-reconciliation`: 5 files passed, 46 tests passed.
- `pnpm typecheck`: passed (`tsc --noEmit`).
- Targeted `pnpm exec oxlint ...`: passed with no findings.
- Targeted `pnpm exec oxfmt --check ...`: passed; all matched files use the correct format.
- `git diff --check`: passed.

## Review and handoff

- Initial readiness review found missing production route wiring and missing Retry UI; both were fixed before validation.
- Final review loop and push/PR status will be appended below.
- Native mobile emulator QA is deferred to macOS because this worker is on Linux; no substitute QA was attempted.
