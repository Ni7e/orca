import { toast } from 'sonner'
import { useAppStore } from '@/store'
import type { useImmediateMutation } from '@/hooks/useIssueMetadata'
import {
  buildTaskPageGitHubCloseUpdate,
  getTaskPageGitHubDuplicateTargetErrorMessage,
  validateTaskPageGitHubDuplicateTarget,
  type TaskPageGitHubCloseAction
} from '@/components/task-page-github-status-actions'
import { assertTaskPageGitHubDialogStateAuthority } from '@/components/task-page-github-dialog-state-authority'
import { runIssueUpdate } from '@/components/github/github-work-item-edit-mutations'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'
import type { GitHubItemDialogProjectOrigin } from './github-item-dialog-types'

export type GHEditProjectRowPatch = {
  state?: GitHubWorkItem['state']
  labels?: string[]
  assignees?: string[]
}

export type GHEditMutationRun = ReturnType<typeof useImmediateMutation>['run']

type GHEditMutationBase = {
  item: GitHubWorkItem
  repoPath: string | null
  sourceContext?: TaskSourceContext | null
  projectOrigin: GitHubItemDialogProjectOrigin | undefined
  run: GHEditMutationRun
  patchProjectRowIfNeeded: (patch: GHEditProjectRowPatch) => void
  onMutated: () => void
}

export function runGHEditStateChange({
  newState,
  closeAction,
  localState,
  item,
  repoPath,
  sourceContext,
  projectOrigin,
  run,
  onStateChange,
  patchWorkItem,
  patchProjectRowIfNeeded,
  onMutated
}: GHEditMutationBase & {
  newState: 'open' | 'closed'
  closeAction?: TaskPageGitHubCloseAction
  localState: GitHubWorkItem['state']
  onStateChange: (state: GitHubWorkItem['state']) => void
  patchWorkItem: (
    id: string,
    patch: { state: GitHubWorkItem['state'] },
    repoId: string | undefined,
    options: { sourceContext?: TaskSourceContext | null }
  ) => void
}): void {
  if (newState === localState) {
    return
  }
  const prevState = localState
  // Why: without registry authority a search-lagged Tasks refetch silently
  // reverts this row to its pre-mutation state (STA-3343).
  let authority: { revert: () => boolean } | null = null
  void run('state', {
    mutate: () =>
      runIssueUpdate({
        repoId: item.repoId,
        repoPath,
        sourceContext,
        projectOrigin,
        number: item.number,
        updates:
          newState === 'closed' && closeAction
            ? buildTaskPageGitHubCloseUpdate(closeAction)
            : { state: newState }
      }),
    onOptimistic: () => {
      authority = assertTaskPageGitHubDialogStateAuthority({
        repoId: item.repoId,
        itemId: item.id,
        state: newState,
        sourceContext
      })
      onStateChange(newState)
      patchWorkItem(item.id, { state: newState }, item.repoId, { sourceContext })
      patchProjectRowIfNeeded({ state: newState })
    },
    onRevert: () => {
      if (authority?.revert()) {
        onStateChange(prevState)
        patchWorkItem(item.id, { state: prevState }, item.repoId, { sourceContext })
        patchProjectRowIfNeeded({ state: prevState })
      }
    },
    onSuccess: () => {
      useAppStore.getState().recordFeatureInteraction('github-tasks')
      patchWorkItem(item.id, { state: newState }, item.repoId, { sourceContext })
      patchProjectRowIfNeeded({ state: newState })
      onMutated()
    },
    onError: (err) => toast.error(err)
  })
}

export function closeGHEditAsDuplicate({
  targetIssueNumber,
  itemNumber,
  setDuplicateError,
  handleStateChange,
  setStatusPopoverOpen,
  setDuplicatePickerOpen
}: {
  targetIssueNumber: number | string
  itemNumber: number
  setDuplicateError: (value: string | null) => void
  handleStateChange: (newState: 'open' | 'closed', closeAction?: TaskPageGitHubCloseAction) => void
  setStatusPopoverOpen: (value: boolean) => void
  setDuplicatePickerOpen: (value: boolean) => void
}): void {
  const validation = validateTaskPageGitHubDuplicateTarget(String(targetIssueNumber), itemNumber)
  if (!validation.ok) {
    setDuplicateError(getTaskPageGitHubDuplicateTargetErrorMessage(validation, translate))
    return
  }
  setDuplicateError(null)
  handleStateChange('closed', { stateReason: 'duplicate', duplicateOf: validation.duplicateOf })
  setStatusPopoverOpen(false)
  setDuplicatePickerOpen(false)
}

export function runGHEditLabelToggle({
  label,
  localLabels,
  item,
  repoPath,
  sourceContext,
  projectOrigin,
  run,
  onLabelsChange,
  patchWorkItem,
  patchProjectRowIfNeeded,
  onMutated
}: GHEditMutationBase & {
  label: string
  localLabels: string[]
  onLabelsChange: (labels: string[]) => void
  patchWorkItem: (
    id: string,
    patch: { labels: string[] },
    repoId: string | undefined,
    options: { sourceContext?: TaskSourceContext | null }
  ) => void
}): void {
  const isAdding = !localLabels.includes(label)
  const prevLabels = localLabels
  const newLabels = isAdding ? [...prevLabels, label] : prevLabels.filter((l) => l !== label)

  if (isAdding) {
    void run('labels', {
      mutate: () =>
        runIssueUpdate({
          repoId: item.repoId,
          repoPath,
          sourceContext,
          projectOrigin,
          number: item.number,
          updates: { addLabels: [label] }
        }),
      onOptimistic: () => {
        onLabelsChange(newLabels)
        patchWorkItem(item.id, { labels: newLabels }, item.repoId, { sourceContext })
        patchProjectRowIfNeeded({ labels: newLabels })
      },
      onSuccess: () => {
        useAppStore.getState().recordFeatureInteraction('github-tasks')
        onMutated()
      },
      onRevert: () => {
        onLabelsChange(prevLabels)
        patchWorkItem(item.id, { labels: prevLabels }, item.repoId, { sourceContext })
        patchProjectRowIfNeeded({ labels: prevLabels })
      },
      onError: (err) => toast.error(err)
    })
    return
  }
  void run('labels', {
    mutate: () =>
      runIssueUpdate({
        repoId: item.repoId,
        repoPath,
        sourceContext,
        projectOrigin,
        number: item.number,
        updates: { removeLabels: [label] }
      }),
    onOptimistic: () => {
      onLabelsChange(newLabels)
      patchWorkItem(item.id, { labels: newLabels }, item.repoId, { sourceContext })
      patchProjectRowIfNeeded({ labels: newLabels })
    },
    onRevert: () => {
      onLabelsChange(prevLabels)
      patchWorkItem(item.id, { labels: prevLabels }, item.repoId, { sourceContext })
      patchProjectRowIfNeeded({ labels: prevLabels })
    },
    onSuccess: () => {
      useAppStore.getState().recordFeatureInteraction('github-tasks')
      onMutated()
    },
    onError: (err) => toast.error(err)
  })
}

export function runGHEditAssigneeToggle({
  login,
  localAssignees,
  assigneesItemKey,
  editedAssigneesItemKeyRef,
  item,
  repoPath,
  sourceContext,
  projectOrigin,
  run,
  setLocalAssignees,
  patchProjectRowIfNeeded,
  onMutated
}: GHEditMutationBase & {
  login: string
  localAssignees: string[]
  assigneesItemKey: string
  editedAssigneesItemKeyRef: { current: string | null }
  setLocalAssignees: (value: string[]) => void
}): void {
  const isAssigned = localAssignees.includes(login)
  const prevAssignees = localAssignees
  const newAssignees = isAssigned
    ? prevAssignees.filter((l) => l !== login)
    : [...prevAssignees, login]

  // Why: scope the optimistic guard to this repo item so switching items doesn't suppress the next item's assignee sync.
  editedAssigneesItemKeyRef.current = assigneesItemKey
  if (isAssigned) {
    void run('assignees', {
      mutate: () =>
        runIssueUpdate({
          repoId: item.repoId,
          repoPath,
          sourceContext,
          projectOrigin,
          number: item.number,
          updates: { removeAssignees: [login] }
        }),
      onOptimistic: () => {
        setLocalAssignees(newAssignees)
        patchProjectRowIfNeeded({ assignees: newAssignees })
      },
      onRevert: () => {
        setLocalAssignees(prevAssignees)
        patchProjectRowIfNeeded({ assignees: prevAssignees })
      },
      onSuccess: () => {
        useAppStore.getState().recordFeatureInteraction('github-tasks')
        onMutated()
      },
      onError: (err) => toast.error(err)
    })
    return
  }
  void run('assignees', {
    mutate: () =>
      runIssueUpdate({
        repoId: item.repoId,
        repoPath,
        sourceContext,
        projectOrigin,
        number: item.number,
        updates: { addAssignees: [login] }
      }),
    onOptimistic: () => {
      setLocalAssignees(newAssignees)
      patchProjectRowIfNeeded({ assignees: newAssignees })
    },
    onSuccess: () => {
      useAppStore.getState().recordFeatureInteraction('github-tasks')
      onMutated()
    },
    onRevert: () => {
      setLocalAssignees(prevAssignees)
      patchProjectRowIfNeeded({ assignees: prevAssignees })
    },
    onError: (err) => toast.error(err)
  })
}
