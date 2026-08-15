# Split PullRequestPage.tsx under 400 lines

Status: implemented. Source barrel is 4 lines. Largest dest is `files/combined-diff-viewer.tsx` (390).

Hard cap: `src/renderer/src/components/PullRequestPage.tsx` and every dest file `wc -l` <= 400.
No `max-lines` disables. Zero intentional behavior change. Nested domain folders; file names do not repeat the folder name.

## Public barrel (source stays at original path)

`src/renderer/src/components/PullRequestPage.tsx` becomes imports + public API only:

- `export type { ItemDialogTab }`
- `export type { PullRequestPageProjectOrigin }`
- `export { invalidateWorkItemDetailsCacheForKey }`
- `export { default }` from `page/surface.tsx`

## Dest tree

```
src/renderer/src/components/pull-request-page/
  page-types.ts
  mentions/{query.ts,query.test.ts,options.ts,options.test.ts,textarea.tsx}
  presentation/{state-badge.tsx,state-badge.test.ts}
  reviewers/{request-actions.ts,picker-row.tsx,picker.tsx,requested-list.tsx,panel.tsx}
  cache/{work-item-details.ts,file-content.ts,files-diff-view.ts}
  files/{toolbar.tsx,section-state.ts,combined-diff-viewer.tsx}
  conversation/{comment-card.tsx,comment-group.tsx,description.tsx,tab.tsx}
  actions/{panel.tsx,merge-actions.ts}
  comments/{reply-form.tsx,composer.tsx}
  checks/{refresh.ts,rerun.ts,details-request.ts,fix-launch.ts,toolbar.tsx,row.tsx,fix-dialog.tsx,tab.tsx}
  edit/{issue-updates.ts,section.tsx}
  page/{use-details.ts,header.tsx,tabs-shell.tsx,surface.tsx}
```

## Import DAG (no cycles)

`page-types` → mentions, presentation, reviewers, comments, checks, edit, actions, files, conversation, page
`cache` → files, conversation, page
`mentions` → comments, conversation
`presentation` → edit
`reviewers` / `actions` / `checks` / `comments` → conversation, page
`edit` / `files` → page only

## Oversized cuts

| Symbol | Lines | Cut |
|---|---|---|
| PRReviewersPanel | ~700 | request-actions hook + picker-row + picker + requested-list + panel |
| PRFilesCombinedDiffViewer | ~670 | files-diff-view cache + section-state hook + toolbar + viewer |
| ConversationTab | ~651 | comment-card + comment-group + description + tab |
| ChecksTab | ~1023 | refresh/rerun/details-request/fix-launch + toolbar + row + fix-dialog + tab |
| GHEditSection | ~493 | issue-updates hook + section |
| PullRequestPage | ~877 | use-details + header + tabs-shell + surface |
| PRActionsPanel | ~355 + imports | merge-actions hook + panel |

## Host-boundary tests

Update `pull-request-page-host-boundary.test.ts` to read dest files (concatenate a domain when a former function is split). Keep the same string assertions.

Update `github/repro-8784-ghe-avatar-fallback.test.ts` to read `page/header.tsx` (GitHubUserAvatar + authorAvatarUrl).

## Characterization tests (uncovered pure symbols)

- `mentions/query.test.ts` — findMentionQuery
- `mentions/options.test.ts` — buildMentionOptions
- `presentation/state-badge.test.ts` — getStateTone

## Verification

```
pnpm exec vitest run --config config/vitest.config.ts \
  src/renderer/src/components/pull-request-page-host-boundary.test.ts \
  src/renderer/src/components/pull-request-page \
  src/renderer/src/components/github/repro-8784-ghe-avatar-fallback.test.ts
pnpm run typecheck:web
pnpm run check:max-lines-ratchet
# after removing the source max-lines disable:
# prune config/max-lines-baseline.txt entry for PullRequestPage.tsx
wc -l src/renderer/src/components/PullRequestPage.tsx \
  src/renderer/src/components/pull-request-page/**/*.{ts,tsx}
```
