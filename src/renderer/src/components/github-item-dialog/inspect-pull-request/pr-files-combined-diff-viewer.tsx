import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { editor as monacoEditor } from 'monaco-editor'
import type { DecoratedDiffComment } from '@/components/diff-comments/decorated-diff-comment'
import {
  createCombinedDiffSectionIndexMap,
  handleCombinedDiffFileTreeNavigation
} from '@/components/editor/CombinedDiffFileTree'
import {
  getDiffSectionEstimatedHeight,
  isIntrinsicHeightImageDiff
} from '@/components/editor/diff-section-layout'
import type { DiffSection } from '@/components/editor/diff-section-types'
import {
  getCombinedDiffBranchEntriesInTreeOrder,
  type CombinedDiffFileTreeEntry
} from '@/components/editor/combined-diff-file-tree-model'
import { useAppStore } from '@/store'
import { githubRepoIdentityKey } from '../../../../../shared/github/repository-identity-key'
import type { GitBranchChangeEntry } from '../../../../../shared/git-diff-compare-types'
import { isPRFileViewed } from '@/components/github/pr-file-content-size'
import {
  PR_DIFF_OVERSCAN,
  getPRFileSectionKey,
  gitHubPRFileToBranchEntry,
  type PRFilesCombinedDiffViewerProps
} from '@/components/github/pr-file-diff-mapping'
import { formatRelativeTime } from '@/components/github/work-item-state-presentation'
import { PRViewedCheckbox } from '@/components/github/PRViewedCheckbox'
import { PRFilesCombinedDiffBody } from './pr-files-combined-diff-body'
import {
  addPRFilesCombinedDiffLineComment,
  loadPRFilesCombinedDiffSection,
  retryPRFilesCombinedDiffSection,
  setAllPRFilesCombinedDiffSectionsCollapsed,
  togglePRFilesCombinedDiffSection
} from './pr-files-combined-diff-load'

export function PRFilesCombinedDiffViewer({
  files,
  comments,
  repoPath,
  repoId,
  sourceContext,
  prNumber,
  prRepo,
  prUrl,
  headSha,
  baseSha,
  pendingViewedPaths,
  onCommentAdded,
  onViewedChange
}: PRFilesCombinedDiffViewerProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const isDark =
    settings?.theme === 'dark' ||
    (settings?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const entriesCacheRef = useRef<{
    signature: string
    entries: GitBranchChangeEntry[]
  } | null>(null)
  const diffEntrySignature = useMemo(
    () =>
      JSON.stringify(
        files.map((file) => ({
          path: file.path,
          oldPath: file.oldPath ?? null,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          isBinary: file.isBinary
        }))
      ),
    [files]
  )
  const entries = useMemo(() => {
    if (entriesCacheRef.current?.signature === diffEntrySignature) {
      return entriesCacheRef.current.entries
    }
    const nextEntries = getCombinedDiffBranchEntriesInTreeOrder(
      'commit',
      files.map(gitHubPRFileToBranchEntry)
    )
    entriesCacheRef.current = {
      signature: diffEntrySignature,
      entries: nextEntries
    }
    return nextEntries
  }, [diffEntrySignature, files])
  const fileByPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files])
  const inlineReviewComments = useMemo<DecoratedDiffComment[]>(
    () =>
      comments.flatMap((comment): DecoratedDiffComment[] => {
        // Why: outdated threads' line number can attach the comment to unrelated current code, so skip them inline.
        if (comment.isOutdated || !comment.path || typeof comment.line !== 'number') {
          return []
        }
        const createdAtMs = new Date(comment.createdAt).getTime()
        return [
          {
            id: `github-pr-comment:${comment.id}`,
            worktreeId: `github-pr:${repoId}:${prNumber}`,
            filePath: comment.path,
            source: 'diff',
            startLine: comment.startLine,
            lineNumber: comment.line,
            body: comment.body,
            createdAt: Number.isFinite(createdAtMs) ? createdAtMs : Date.now(),
            side: 'modified',
            author: comment.author,
            authorAvatarUrl: comment.authorAvatarUrl,
            createdAtLabel: formatRelativeTime(comment.createdAt),
            url: comment.url,
            canDelete: false,
            canEdit: false
          }
        ]
      }),
    [comments, prNumber, repoId]
  )
  const entrySignature = useMemo(
    () =>
      JSON.stringify({
        repoId,
        prNumber,
        prRepo: prRepo ? githubRepoIdentityKey(prRepo) : null,
        headSha: headSha ?? null,
        baseSha: baseSha ?? null,
        files: diffEntrySignature
      }),
    [baseSha, diffEntrySignature, headSha, prNumber, prRepo, repoId]
  )
  const [sections, setSections] = useState<DiffSection[]>([])
  const [sideBySide, setSideBySide] = useState(false)
  const [fileTreeCollapsed, setFileTreeCollapsed] = useState(false)
  const [sectionHeights, setSectionHeights] = useState<Record<number, number>>({})
  const [activeTreeSectionKey, setActiveTreeSectionKey] = useState<string | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const loadedIndicesRef = useRef<Set<number>>(new Set())
  const loadingIndicesRef = useRef<Set<number>>(new Set())
  const sectionsRef = useRef<DiffSection[]>([])
  const generationRef = useRef(0)
  const modifiedEditorsRef = useRef<Map<number, monacoEditor.IStandaloneCodeEditor>>(new Map())
  const handleSectionSaveRef = useRef<(index: number) => Promise<void>>(async () => {})
  sectionsRef.current = sections

  useEffect(() => {
    generationRef.current += 1
    loadedIndicesRef.current.clear()
    loadingIndicesRef.current.clear()
    setSectionHeights({})
    setActiveTreeSectionKey(null)
    setSections(
      entries.map((entry) => ({
        key: getPRFileSectionKey(entry.path),
        path: entry.path,
        oldPath: entry.oldPath,
        status: entry.status,
        added: entry.added,
        removed: entry.removed,
        originalContent: '',
        modifiedContent: '',
        collapsed: false,
        loading: true,
        error: undefined,
        dirty: false,
        diffResult: null,
        largeDiffRenderLimit: null
      }))
    )
  }, [entries, entrySignature])

  const loadSection = useCallback(
    (index: number) => {
      loadPRFilesCombinedDiffSection({
        index,
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
        setSections
      })
    },
    [baseSha, fileByPath, headSha, prNumber, prRepo, repoId, repoPath, sourceContext]
  )

  const retrySection = useCallback(
    (index: number) => {
      retryPRFilesCombinedDiffSection({
        index,
        loadedIndicesRef,
        loadingIndicesRef,
        setSectionHeights,
        setSections,
        loadSection
      })
    },
    [loadSection]
  )

  const toggleSection = useCallback(
    (index: number) => {
      togglePRFilesCombinedDiffSection({
        index,
        sectionsRef,
        setSections,
        loadSection
      })
    },
    [loadSection]
  )

  const setAllSectionsCollapsed = useCallback(
    (collapsed: boolean) => {
      setAllPRFilesCombinedDiffSectionsCollapsed({
        collapsed,
        setSections,
        sectionsRef,
        loadSection
      })
    },
    [loadSection]
  )

  const allSectionsCollapsed = sections.length > 0 && sections.every((section) => section.collapsed)
  const sectionIndexByKey = useMemo(() => createCombinedDiffSectionIndexMap(sections), [sections])
  const viewedSectionKeys = useMemo(
    () => new Set(files.filter(isPRFileViewed).map((file) => getPRFileSectionKey(file.path))),
    [files]
  )

  const virtualizer = useVirtualizer({
    count: sections.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) => {
      const section = sections[index]
      if (!section) {
        return 88
      }
      return getDiffSectionEstimatedHeight({
        collapsed: section.collapsed,
        measuredContentHeight: sectionHeights[index],
        originalContent: section.originalContent,
        modifiedContent: section.modifiedContent,
        changedLineCount:
          section.added === undefined && section.removed === undefined
            ? undefined
            : (section.added ?? 0) + (section.removed ?? 0),
        useIntrinsicImageHeight: isIntrinsicHeightImageDiff(section.diffResult),
        isLargeDiffLimited: section.largeDiffRenderLimit?.limited === true,
        lineCounts: section.largeDiffRenderLimit?.lineCounts ?? undefined
      })
    },
    overscan: PR_DIFF_OVERSCAN,
    getItemKey: (index) => {
      const section = sections[index]
      return section
        ? `${section.key}:${section.collapsed ? 'collapsed' : 'expanded'}:${entrySignature}`
        : `${index}:${entrySignature}`
    }
  })

  useLayoutEffect(() => {
    virtualizer.measure()
  }, [sideBySide, virtualizer])

  const handleTreeNavigate = useCallback(
    (entry: CombinedDiffFileTreeEntry) => {
      const navigatedIndex = handleCombinedDiffFileTreeNavigation({
        mode: 'commit',
        entry,
        sections: sectionsRef.current,
        sectionIndexByKey,
        toggleSection,
        scrollToIndex: (index) => virtualizer.scrollToIndex(index, { align: 'start' })
      })
      if (navigatedIndex !== null) {
        setActiveTreeSectionKey(sectionsRef.current[navigatedIndex]?.key ?? null)
      }
    },
    [sectionIndexByKey, toggleSection, virtualizer]
  )

  const openFilesOnGitHub = useCallback(() => {
    void window.api.shell.openUrl(`${prUrl.replace(/\/$/, '')}/files`)
  }, [prUrl])

  const handleAddLineComment = useCallback(
    async (
      section: DiffSection,
      {
        lineNumber,
        startLine,
        body
      }: {
        lineNumber: number
        startLine?: number
        body: string
      }
    ) =>
      addPRFilesCombinedDiffLineComment({
        section,
        lineNumber,
        startLine,
        body,
        headSha,
        repoPath,
        repoId,
        sourceContext,
        prNumber,
        prRepo,
        onCommentAdded
      }),
    [headSha, onCommentAdded, prNumber, prRepo, repoId, repoPath, sourceContext]
  )

  const renderViewedCheckbox = useCallback(
    (section: DiffSection) => {
      const file = fileByPath.get(section.path)
      if (!file) {
        return null
      }
      const viewed = isPRFileViewed(file)
      const pending = pendingViewedPaths.has(file.path)
      return (
        <PRViewedCheckbox
          checked={viewed}
          pending={pending}
          filePath={file.path}
          onToggle={() => {
            if (!pending) {
              void onViewedChange(file.path, !viewed)
            }
          }}
        />
      )
    },
    [fileByPath, onViewedChange, pendingViewedPaths]
  )

  return (
    <PRFilesCombinedDiffBody
      files={files}
      repoPath={repoPath}
      repoId={repoId}
      prNumber={prNumber}
      fileTreeCollapsed={fileTreeCollapsed}
      allSectionsCollapsed={allSectionsCollapsed}
      sideBySide={sideBySide}
      setFileTreeCollapsed={setFileTreeCollapsed}
      setAllSectionsCollapsed={setAllSectionsCollapsed}
      setSideBySide={setSideBySide}
      entries={entries}
      sectionIndexByKey={sectionIndexByKey}
      activeTreeSectionKey={activeTreeSectionKey}
      viewedSectionKeys={viewedSectionKeys}
      handleTreeNavigate={handleTreeNavigate}
      scrollContainerRef={scrollContainerRef}
      virtualizer={virtualizer}
      sections={sections}
      isDark={isDark}
      settings={settings}
      sectionHeights={sectionHeights}
      inlineReviewComments={inlineReviewComments}
      loadSection={loadSection}
      retrySection={retrySection}
      toggleSection={toggleSection}
      openFilesOnGitHub={openFilesOnGitHub}
      renderViewedCheckbox={renderViewedCheckbox}
      handleAddLineComment={handleAddLineComment}
      fileByPath={fileByPath}
      setSectionHeights={setSectionHeights}
      setSections={setSections}
      modifiedEditorsRef={modifiedEditorsRef}
      handleSectionSaveRef={handleSectionSaveRef}
    />
  )
}
