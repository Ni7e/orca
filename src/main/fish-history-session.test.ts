import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deleteFishHistoryFile,
  fishHistorySessionName,
  isSafeFishHistorySession,
  resolveFishHistoryDir,
  sweepOrphanedFishHistoryFiles
} from './fish-history-session'

const HASH_A = 'a1b2c3d4e5f60718'
const HASH_B = '00112233445566ff'
const SESSION_A = fishHistorySessionName(HASH_A)

describe('fish history session naming', () => {
  it('mints a session name that is a valid fish variable value', () => {
    // fish falls back to the shared default for anything that is not a valid
    // variable name, which would silently un-isolate the worktree.
    expect(SESSION_A).toBe('orca_a1b2c3d4e5f60718')
    expect(SESSION_A).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
  })

  it.each([
    ['orca_deadbeef', true],
    ['orca_', false],
    ['fish_history', false],
    ['orca_../../etc/passwd', false],
    ['orca_DEADBEEF', false],
    ['', false],
    [undefined, false],
    [42, false]
  ])('accepts %s as a safe session name: %s', (value, expected) => {
    expect(isSafeFishHistorySession(value)).toBe(expected)
  })
})

describe('fish history directory resolution', () => {
  it('follows XDG_DATA_HOME when it is absolute', () => {
    expect(resolveFishHistoryDir({ XDG_DATA_HOME: '/data', HOME: '/home/me' })).toBe('/data/fish')
  })

  it('ignores a relative XDG_DATA_HOME the way fish does', () => {
    expect(resolveFishHistoryDir({ XDG_DATA_HOME: 'relative', HOME: '/home/me' })).toBe(
      '/home/me/.local/share/fish'
    )
  })

  it('falls back to HOME when XDG_DATA_HOME is unset', () => {
    expect(resolveFishHistoryDir({ HOME: '/home/me' })).toBe('/home/me/.local/share/fish')
  })
})

describe('fish history deletion', () => {
  let root: string
  let fishDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-fish-history-'))
    fishDir = join(root, 'fish')
    mkdirSync(fishDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const historyFile = (session: string): string => join(fishDir, `${session}_history`)

  it('deletes the session file rather than truncating it', () => {
    writeFileSync(historyFile(SESSION_A), '- cmd: ls\n')

    expect(deleteFishHistoryFile(SESSION_A, [fishDir])).toBe(true)
    expect(existsSync(historyFile(SESSION_A))).toBe(false)
  })

  it('tries every candidate directory, since the PTY may not share this env', () => {
    const other = join(root, 'other-xdg', 'fish')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, `${SESSION_A}_history`), '- cmd: ls\n')

    expect(deleteFishHistoryFile(SESSION_A, [fishDir, other])).toBe(true)
    expect(existsSync(join(other, `${SESSION_A}_history`))).toBe(false)
  })

  it('refuses a session name it did not mint', () => {
    const foreign = join(fishDir, 'fish_history')
    writeFileSync(foreign, 'the user’s real history\n')

    expect(deleteFishHistoryFile('fish_history', [fishDir])).toBe(false)
    expect(existsSync(foreign)).toBe(true)
  })

  it('refuses to follow a symlink out of the fish data dir', () => {
    const outside = join(root, 'precious.txt')
    writeFileSync(outside, 'keep me\n')
    symlinkSync(outside, historyFile(SESSION_A))

    expect(deleteFishHistoryFile(SESSION_A, [fishDir])).toBe(false)
    expect(existsSync(outside)).toBe(true)
  })

  it('reports false when there is nothing to delete', () => {
    expect(deleteFishHistoryFile(SESSION_A, [fishDir])).toBe(false)
  })
})

describe('orphaned fish history sweep', () => {
  let root: string
  let fishDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-fish-sweep-'))
    fishDir = join(root, 'fish')
    mkdirSync(fishDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('removes files for dead worktrees and keeps live ones', () => {
    writeFileSync(join(fishDir, `${fishHistorySessionName(HASH_A)}_history`), 'live\n')
    writeFileSync(join(fishDir, `${fishHistorySessionName(HASH_B)}_history`), 'dead\n')

    expect(sweepOrphanedFishHistoryFiles(new Set([HASH_A]), [fishDir])).toBe(1)
    expect(existsSync(join(fishDir, `${fishHistorySessionName(HASH_A)}_history`))).toBe(true)
    expect(existsSync(join(fishDir, `${fishHistorySessionName(HASH_B)}_history`))).toBe(false)
  })

  it("never touches the user's own history files", () => {
    // The whole safety of the sweep rests on the orca_<hex>_ prefix.
    const untouched = ['fish_history', 'work_history', 'orca_history', 'orca_nothex_history']
    for (const name of untouched) {
      writeFileSync(join(fishDir, name), 'mine\n')
    }

    expect(sweepOrphanedFishHistoryFiles(new Set([HASH_A]), [fishDir])).toBe(0)
    for (const name of untouched) {
      expect(existsSync(join(fishDir, name))).toBe(true)
    }
  })

  it('refuses to sweep on an empty live set, which cannot be told from a cold store', () => {
    writeFileSync(join(fishDir, `${fishHistorySessionName(HASH_B)}_history`), 'dead\n')

    expect(sweepOrphanedFishHistoryFiles(new Set(), [fishDir])).toBe(0)
    expect(existsSync(join(fishDir, `${fishHistorySessionName(HASH_B)}_history`))).toBe(true)
  })

  it('spares a file younger than the age guard, since the live set is a snapshot', () => {
    // The reachable race: a worktree created after the snapshot but before the
    // sweep looks dead while it is actively writing the history it owns.
    const fresh = join(fishDir, `${fishHistorySessionName(HASH_B)}_history`)
    writeFileSync(fresh, 'just created\n')

    expect(sweepOrphanedFishHistoryFiles(new Set([HASH_A]), [fishDir], 5 * 60 * 1000)).toBe(0)
    expect(existsSync(fresh)).toBe(true)
  })

  it('sweeps a file older than the age guard', () => {
    const stale = join(fishDir, `${fishHistorySessionName(HASH_B)}_history`)
    writeFileSync(stale, 'long dead\n')
    const wellPast = Date.now() + 60 * 60 * 1000

    expect(
      sweepOrphanedFishHistoryFiles(new Set([HASH_A]), [fishDir], 5 * 60 * 1000, wellPast)
    ).toBe(1)
    expect(existsSync(stale)).toBe(false)
  })

  it('tolerates a directory that does not exist', () => {
    expect(sweepOrphanedFishHistoryFiles(new Set([HASH_A]), [join(root, 'absent')])).toBe(0)
  })

  it('sweeps every candidate directory once', () => {
    const other = join(root, 'other', 'fish')
    mkdirSync(other, { recursive: true })
    for (const dir of [fishDir, other]) {
      writeFileSync(join(dir, `${fishHistorySessionName(HASH_B)}_history`), 'dead\n')
    }

    expect(sweepOrphanedFishHistoryFiles(new Set([HASH_A]), [fishDir, other, fishDir])).toBe(2)
  })
})
