import { computed, ref, watch } from 'vue'
import { assert } from '../lib/assert'
import { FOLDERS_LISTED_MAX, folder_key, folder_name_problem, folders_merge } from '../lib/folders'
import { ipc } from '../lib/ipc'
import { MENU_ITEM_ASK_FOLDER, MENU_ITEM_DELETE, MENU_ITEM_RENAME } from '../lib/menu'
import { use_ask } from './use_ask'
import { use_dialog } from './use_dialog'
import { use_jobs } from './use_jobs'
import { use_pipeline } from './use_pipeline'
import type { MenuItem } from '../lib/menu'
import type { FolderName, JobListing, JobMeta } from '../types'


const MENU_ITEMS_FOLDER: readonly MenuItem[] = Object.freeze([MENU_ITEM_RENAME, MENU_ITEM_DELETE])
const PROMPT_NAME = 'Folder name'
const { folder_ask, scope } = use_ask()
const { confirm, message, prompt } = use_dialog()
const { jobs, refresh: jobs_refresh } = use_jobs()
const { view_reopen } = use_pipeline()
const error_message = ref<string | null>(null)
const folder_current = ref<FolderName | null>(null)
const folders_saved = ref<FolderName[]>([])
const folders = computed(() => folders_merge(folders_saved.value, jobs.value))
const folder_counts = computed(() => folder_counts_of(jobs.value))

const api = Object.freeze({
    error_message,
    folder_close,
    folder_count,
    folder_create,
    folder_current,
    folder_jobs,
    folder_menu_items,
    folder_menu_select,
    folder_move,
    folder_open,
    folders,
    refresh,
})


watch(folders, folder_current_check)

export function use_folders(): typeof api {
    assert(Object.isFrozen(api))
    assert(folders_saved.value.every((folder) => folder.length > 0))

    return api
}

function folder_close(): void {
    assert(folder_current.value === null || folder_current.value.length > 0)

    folder_current.value = null
}

function folder_count(name: FolderName): number {
    assert(name.length > 0)

    const count = folder_counts.value.get(folder_key(name)) ?? 0

    assert(count <= jobs.value.length)

    return count
}

function folder_counts_of(listings: readonly JobListing[]): Map<string, number> {
    assert(listings.every((listing) => listing.id.length > 0))

    const counts = new Map<string, number>()

    for (const listing of listings) {
        const key = folder_key(listing.project ?? '')

        if (key.length === 0) continue

        counts.set(key, (counts.get(key) ?? 0) + 1)
    }

    assert(counts.size <= listings.length)

    return counts
}

async function folder_create(): Promise<FolderName | null> {
    const typed = await prompt(PROMPT_NAME, '', { title: 'New folder', ok_label: 'Create' })

    if (typed === null) return null

    const name = typed.trim()
    const problem = folder_name_problem(name, folders.value, null)

    if (problem !== null) {
        await message(problem, { title: 'New folder', kind: 'error' })

        return null
    }

    await ipc.folder_create(name)
    await refresh()

    assert(name.length > 0)
    assert(folders.value.some((folder) => folder_key(folder) === folder_key(name)))

    return name
}

function folder_current_check(listed: readonly FolderName[]): void {
    assert(listed.length <= FOLDERS_LISTED_MAX)

    const shown = folder_current.value

    if (shown === null) return

    const key = folder_key(shown)

    if (listed.some((folder) => folder_key(folder) === key)) return

    folder_current.value = null

    assert(listed.every((folder) => folder_key(folder) !== key))
}

function folder_follow(name: FolderName, renamed: FolderName | null): void {
    assert(name.length > 0)
    assert(renamed === null || renamed.length > 0)

    const key = folder_key(name)

    if (folder_key(folder_current.value ?? '') === key) folder_current.value = renamed

    const chosen = scope.value

    if (chosen.kind !== 'project') return
    if (folder_key(chosen.project) !== key) return

    scope.value = renamed === null ? { kind: 'all' } : { kind: 'project', project: renamed }
}

function folder_jobs(name: FolderName): JobListing[] {
    assert(name.length > 0)

    const key = folder_key(name)
    const inside = jobs.value.filter((job) => folder_key(job.project ?? '') === key)

    assert(inside.length <= jobs.value.length)

    return inside
}

function folder_menu_items(name: FolderName): MenuItem[] {
    assert(name.length > 0)
    assert(MENU_ITEMS_FOLDER.every((item) => item.id !== MENU_ITEM_ASK_FOLDER.id))

    const askable = folder_jobs(name)
        .some((job) => [job.has_notes, job.has_transcript].includes(true))

    return askable ? [MENU_ITEM_ASK_FOLDER, ...MENU_ITEMS_FOLDER] : [...MENU_ITEMS_FOLDER]
}

async function folder_menu_select(name: FolderName, id: string): Promise<void> {
    assert(name.length > 0)
    assert(id.length > 0)

    if (id === MENU_ITEM_ASK_FOLDER.id) return folder_ask(name)
    if (id === MENU_ITEM_RENAME.id) return folder_rename(name)

    assert(id === MENU_ITEM_DELETE.id, `no folder action is named ${id}`)

    return folder_remove(name)
}

async function folder_move(job: JobMeta, name: FolderName | null): Promise<void> {
    assert(job.id.length > 0)
    assert(name === null || name.trim() === name)

    return ipc.job_meta_update(job.id, { project: name ?? '' }).then(jobs_refresh)
}

function folder_open(name: FolderName): void {
    assert(name.length > 0)
    assert(name.trim() === name)

    folder_current.value = name
    view_reopen('jobs')
}

async function folder_remove(name: FolderName): Promise<void> {
    assert(name.length > 0)
    assert(name.trim() === name)

    const text = folder_remove_message(name, folder_count(name))
    const options = { title: 'Delete folder', kind: 'warning', ok_label: 'Delete' } as const

    return confirm(text, options).then(async (accepted) => {
        if (!accepted) return

        await ipc.folder_remove(name)

        folder_follow(name, null)

        await Promise.all([refresh(), jobs_refresh()])
    })
}

function folder_remove_message(name: FolderName, count: number): string {
    assert(name.length > 0)
    assert(Number.isInteger(count))

    const question = `Delete the folder "${name}"?`

    if (count === 0) return question
    if (count === 1) return `${question} The recording in it stays in Home.`

    return `${question} The ${String(count)} recordings in it stay in Home.`
}

async function folder_rename(name: FolderName): Promise<void> {
    assert(name.length > 0)
    assert(name.trim() === name)

    const options = { title: 'Rename folder', ok_label: 'Rename' }

    return prompt(PROMPT_NAME, name, options).then(async (typed) => {
        if (typed === null) return

        const renamed = typed.trim()

        if (renamed === name) return

        const problem = folder_name_problem(renamed, folders.value, name)

        if (problem !== null) return message(problem, { title: 'Rename folder', kind: 'error' })

        await ipc.folder_rename({ from: name, to: renamed })

        folder_follow(name, renamed)

        await Promise.all([refresh(), jobs_refresh()])
    })
}

async function refresh(): Promise<void> {
    error_message.value = null

    try {
        const listed = await ipc.folders_list()

        assert(listed.every((folder) => folder.length > 0))
        assert(listed.every((folder) => folder.trim() === folder))

        folders_saved.value = listed
    } catch (error) {
        error_message.value = String(error)
    }
}
