import { assert } from './assert'
import type { FolderName, JobMeta } from '../types'


export const FOLDER_NAME_CHARS_MAX = 120
export const FOLDERS_SAVED_MAX = 512
export const JOBS_MAX = 4096
export const FOLDERS_LISTED_MAX = FOLDERS_SAVED_MAX + JOBS_MAX

const PATTERN_CONTROL = /\p{Cc}/u


export function folder_compare(left: FolderName, right: FolderName): number {
    assert(left.length > 0)
    assert(right.length > 0)

    return left.localeCompare(right, undefined, { sensitivity: 'base' })
}

export function folder_key(name: string): string {
    assert(typeof name === 'string')

    const key = name.trim().toLowerCase()

    assert(key === key.trim())

    return key
}

export function folder_name_problem(
    name: string,
    folders: readonly FolderName[],
    renamed: FolderName | null,
): string | null {
    assert(typeof name === 'string')
    assert(folders.length <= FOLDERS_LISTED_MAX)
    assert(renamed === null || renamed.trim().length > 0)

    const trimmed = name.trim()
    const key = folder_key(trimmed)
    const key_renamed = renamed === null ? null : folder_key(renamed)
    const others = folders.map(folder_key).filter((folder) => folder !== key_renamed)

    if (trimmed.length === 0) return 'A folder needs a name.'
    if (PATTERN_CONTROL.test(trimmed)) return 'A folder name is one line of plain text.'
    if (others.includes(key)) return `A folder named "${trimmed}" already exists.`

    if (Array.from(trimmed).length > FOLDER_NAME_CHARS_MAX) {
        return `A folder name is at most ${String(FOLDER_NAME_CHARS_MAX)} characters.`
    }

    return null
}

export function folders_merge(
    saved: readonly FolderName[],
    jobs: readonly Pick<JobMeta, 'project'>[],
): FolderName[] {
    assert(saved.length <= FOLDERS_SAVED_MAX)
    assert(jobs.length <= JOBS_MAX)

    const named = new Map<string, FolderName>()
    const candidates = [...saved, ...jobs.map((job) => job.project ?? '')]

    for (const candidate of candidates) {
        const folder = candidate.trim()
        const key = folder_key(folder)

        if (key.length === 0) continue
        if (named.has(key)) continue

        named.set(key, folder)
    }

    const merged = [...named.values()].sort(folder_compare)

    assert(merged.length <= candidates.length)
    assert(merged.every((folder) => folder.length > 0))

    return merged
}
