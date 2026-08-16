import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { translate } from '@/i18n/i18n'
import { removeDiffSectionMeasuredHeight } from '@/components/editor/diff-section-height-cache'
import {
  getPRFileContentsRenderLimit,
  getPRFileDiffResult
} from '@/components/github/pr-file-diff-mapping'
import {
  getStoredTextDiffContent,
  getStoredTextDiffResult
} from '@/components/editor/large-diff-section-content'
import type { DiffSection } from '@/components/editor/diff-section-types'
import type { GitDiffResult } from '../../../../../shared/git-diff-compare-types'
import type {
  GitHubOwnerRepo,
  GitHubPRFile,
  GitHubPRFileContents
} from '../../../../../shared/github/pull-request-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import { loadPRFileContents } from '../cache/file-content'

export function usePRFileSectionLoader(args: {
  sectionsRef: MutableRefObject<DiffSection[]>
  loadedIndicesRef: MutableRefObject<Set<number>>
  loadingIndicesRef: MutableRefObject<Set<number>>
  generationRef: MutableRefObject<number>
  fileByPath: Map<string, GitHubPRFile>
  repoPath: string
  repoId: string
  sourceContext?: TaskSourceContext | null
  prNumber: number
  prRepo?: GitHubOwnerRepo | null
  headSha: string | undefined
  baseSha: string | undefined
  setSections: Dispatch<SetStateAction<DiffSection[]>>
  setSectionHeights: Dispatch<SetStateAction<Record<number, number>>>
}): {
  loadSection: (index: number) => void
  retrySection: (index: number) => void
  toggleSection: (index: number) => void
  setAllSectionsCollapsed: (collapsed: boolean) => void
} {
  const {
    sectionsRef,
    loadedIndicesRef,
    loadingIndicesRef,
    generationRef,
    fileByPath,
    repoPath,
    repoId,
    sourceContext,
    prNumber,
    prRepo,
    headSha,
    baseSha,
    setSections,
    setSectionHeights
  } = args
  const loadSection = useCallback(
    (index: number) => {
      const section = sectionsRef.current[index]
      if (!section || section.collapsed) {
        return
      }
      if (loadedIndicesRef.current.has(index) || loadingIndicesRef.current.has(index)) {
        return
      }
      const file = fileByPath.get(section.path)
      if (!file) {
        return
      }
      const generation = generationRef.current
      loadingIndicesRef.current.add(index)

      const load = async (): Promise<{
        result: GitDiffResult
        resultContents?: GitHubPRFileContents
        error?: string
      }> => {
        if (file.isBinary) {
          return {
            result: {
              kind: 'binary',
              originalContent: '',
              modifiedContent: '',
              originalIsBinary: true,
              modifiedIsBinary: true
            }
          }
        }
        if (!headSha || !baseSha) {
          return {
            result: {
              kind: 'text',
              originalContent: '',
              modifiedContent: '',
              originalIsBinary: false,
              modifiedIsBinary: false
            },
            error: translate(
              'auto.components.PullRequestPage.74660bd80b',
              'Diff unavailable because the PR commit SHAs are missing.'
            )
          }
        }
        const contents = await loadPRFileContents({
          repoPath,
          repoId,
          sourceContext,
          prNumber,
          prRepo,
          file,
          headSha,
          baseSha
        })
        return { result: getPRFileDiffResult(contents), resultContents: contents }
      }

      load()
        .catch((error) => ({
          result: {
            kind: 'text',
            originalContent: '',
            modifiedContent: '',
            originalIsBinary: false,
            modifiedIsBinary: false
          } as GitDiffResult,
          resultContents: undefined,
          error: error instanceof Error ? error.message : 'Failed to load diff.'
        }))
        .then(({ result, resultContents, error }) => {
          loadingIndicesRef.current.delete(index)
          if (generationRef.current !== generation) {
            return
          }
          const largeDiffRenderLimit =
            !error && result.kind === 'text' && resultContents
              ? getPRFileContentsRenderLimit(resultContents)
              : null
          const storedContent = getStoredTextDiffContent(result, largeDiffRenderLimit)
          const storedResult = getStoredTextDiffResult(result, largeDiffRenderLimit)
          loadedIndicesRef.current.add(index)
          setSections((prev) =>
            prev.map((current, currentIndex) =>
              currentIndex === index
                ? {
                    ...current,
                    diffResult: storedResult,
                    originalContent: storedContent.originalContent,
                    modifiedContent: storedContent.modifiedContent,
                    loading: false,
                    error,
                    largeDiffRenderLimit
                  }
                : current
            )
          )
        })
    },
    [
      baseSha,
      fileByPath,
      headSha,
      prNumber,
      prRepo,
      repoId,
      repoPath,
      sourceContext,
      generationRef,
      loadedIndicesRef,
      loadingIndicesRef,
      sectionsRef,
      setSections
    ]
  )

  const retrySection = useCallback(
    (index: number) => {
      loadedIndicesRef.current.delete(index)
      loadingIndicesRef.current.delete(index)
      setSectionHeights((prev) => removeDiffSectionMeasuredHeight(prev, index))
      setSections((prev) =>
        prev.map((section, sectionIndex) =>
          sectionIndex === index
            ? {
                ...section,
                diffResult: null,
                originalContent: '',
                modifiedContent: '',
                loading: true,
                error: undefined,
                largeDiffRenderLimit: null
              }
            : section
        )
      )
      loadSection(index)
    },
    [loadSection, loadedIndicesRef, loadingIndicesRef, setSectionHeights, setSections]
  )

  const toggleSection = useCallback(
    (index: number) => {
      const shouldLoadAfterExpand = sectionsRef.current[index]?.collapsed ?? false
      setSections((prev) =>
        prev.map((section, sectionIndex) =>
          sectionIndex === index ? { ...section, collapsed: !section.collapsed } : section
        )
      )
      if (shouldLoadAfterExpand) {
        window.requestAnimationFrame(() => loadSection(index))
      }
    },
    [loadSection, sectionsRef, setSections]
  )

  const setAllSectionsCollapsed = useCallback(
    (collapsed: boolean) => {
      setSections((prev) => prev.map((section) => ({ ...section, collapsed })))
      if (!collapsed) {
        window.requestAnimationFrame(() => {
          sectionsRef.current.forEach((_, index) => loadSection(index))
        })
      }
    },
    [loadSection, sectionsRef, setSections]
  )

  return { loadSection, retrySection, toggleSection, setAllSectionsCollapsed }
}
