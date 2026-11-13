import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { use_ask } from '../../src/composables/use_ask'
import { use_dialog } from '../../src/composables/use_dialog'
import { use_folders } from '../../src/composables/use_folders'
import { use_jobs } from '../../src/composables/use_jobs'
import { use_pipeline } from '../../src/composables/use_pipeline'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import { job_listing_build } from './fixtures'
import type { JobListing } from '../../src/types'


vi.mock('../../src/lib/ipc')

const FOLDERS_SAVED = Object.freeze(['Acme', 'Board'])

const JOBS = Object.freeze<JobListing[]>([
    job_listing_build({ id: 'alpha', project: 'Acme', has_notes: true }),
    job_listing_build({ id: 'beta', project: 'acme' }),
    job_listing_build({ id: 'gamma', project: 'Hiring' }),
    job_listing_build({ id: 'delta', project: null }),
])

const ask_state = use_ask()
const dialog = use_dialog()
const folders_state = use_folders()
const jobs_state = use_jobs()
const pipeline = use_pipeline()


async function confirm_answer(accepted: boolean): Promise<string> {
    await flushPromises()

    const shown = dialog.current.value

    assert(shown !== null, 'no confirmation is open')
    assert(!shown.input_shown)

    dialog.close(accepted)
    await flushPromises()

    return shown.message
}

async function prompt_answer(text: string | null): Promise<string> {
    assert(text === null || typeof text === 'string')

    await flushPromises()

    const shown = dialog.current.value
    const initial = dialog.input.value

    assert(shown !== null, 'no prompt is open')
    assert(shown.input_shown)

    if (text === null) {
        dialog.close(false)
    } else {
        dialog.input.value = text
        dialog.close(true)
    }

    await flushPromises()

    return initial
}

beforeEach(async () => {
    vi.resetAllMocks()
    vi.mocked(ipc.folders_list).mockResolvedValue([...FOLDERS_SAVED])
    vi.mocked(ipc.jobs_list).mockResolvedValue(JOBS.map((job) => ({ ...job })))
    dialog.close(false)

    await Promise.all([folders_state.refresh(), jobs_state.refresh()])

    folders_state.folder_close()
    ask_state.scope.value = { kind: 'all' }
    pipeline.view_current.value = 'jobs'
})

describe('folders', () => {
    it('lists saved and filed folders once each and counts their meetings ignoring case', () => {
        expect(folders_state.folders.value).toEqual(['Acme', 'Board', 'Hiring'])
        expect(folders_state.folder_count('ACME')).toBe(2)
        expect(folders_state.folder_count('Board')).toBe(0)
        expect(folders_state.folder_jobs('acme').map((job) => job.id)).toEqual(['alpha', 'beta'])

        const filed = folders_state.folders.value
            .map((folder) => folders_state.folder_count(folder))
            .reduce((total, count) => total + count, 0)

        expect(filed).toBe(JOBS.filter((job) => (job.project ?? '').trim().length > 0).length)
    })

    it('keeps the last list and reports a load that fails', async () => {
        vi.mocked(ipc.folders_list).mockRejectedValue(new Error('unreadable'))

        await folders_state.refresh()

        expect(folders_state.error_message.value).toBe('Error: unreadable')
        expect(folders_state.folders.value).toEqual(['Acme', 'Board', 'Hiring'])
    })
})

describe('folder_create', () => {
    it('creates the trimmed name the person typed', async () => {
        vi.mocked(ipc.folders_list).mockResolvedValue(['Acme', 'Board', 'Legal'])

        const created = folders_state.folder_create()
        const initial = await prompt_answer('  Legal  ')
        const name = await created

        expect(initial).toBe('')
        expect(name).toBe('Legal')
        expect(ipc.folder_create).toHaveBeenCalledWith('Legal')
        expect(folders_state.folders.value).toContain('Legal')
    })

    it('explains a repeated name and creates nothing', async () => {
        const created = folders_state.folder_create()

        await prompt_answer('HIRING')

        const text = await confirm_answer(true)
        const name = await created

        expect(text).toContain('already exists')
        expect(name).toBeNull()
        expect(ipc.folder_create).not.toHaveBeenCalled()
    })

    it('creates nothing when the prompt is cancelled', async () => {
        const created = folders_state.folder_create()

        await prompt_answer(null)

        const name = await created

        expect(name).toBeNull()
        expect(ipc.folder_create).not.toHaveBeenCalled()
    })
})

describe('folder menu', () => {
    it('offers Ask only for a folder with notes or a transcript in it', () => {
        const ids_acme = folders_state.folder_menu_items('Acme').map((item) => item.id)
        const ids_hiring = folders_state.folder_menu_items('Hiring').map((item) => item.id)

        expect(ids_acme).toEqual(['ask', 'rename', 'delete'])
        expect(ids_hiring).toEqual(['rename', 'delete'])
    })

    it('asks about a folder in a new chat scoped to it', async () => {
        const chat_before = ask_state.chat_id.value

        await folders_state.folder_menu_select('Acme', 'ask')

        expect(ask_state.scope.value).toEqual({ kind: 'project', project: 'Acme' })
        expect(ask_state.chat_id.value).not.toBe(chat_before)
        expect(pipeline.view_current.value).toBe('ask')
    })

    it('renames a folder and carries the open folder and the Ask scope with it', async () => {
        folders_state.folder_open('Acme')
        ask_state.scope.value = { kind: 'project', project: 'acme' }

        const renamed = folders_state.folder_menu_select('Acme', 'rename')
        const initial = await prompt_answer('Acme Mining')

        await renamed

        expect(initial).toBe('Acme')
        expect(ipc.folder_rename).toHaveBeenCalledWith({ from: 'Acme', to: 'Acme Mining' })
        expect(folders_state.folder_current.value).toBe('Acme Mining')
        expect(ask_state.scope.value).toEqual({ kind: 'project', project: 'Acme Mining' })
    })

    it('leaves a folder alone when the rename keeps its name', async () => {
        const renamed = folders_state.folder_menu_select('Acme', 'rename')

        await prompt_answer('Acme')
        await renamed

        expect(ipc.folder_rename).not.toHaveBeenCalled()
    })

    it('deletes a folder after confirming and keeps its meetings', async () => {
        folders_state.folder_open('Acme')
        ask_state.scope.value = { kind: 'project', project: 'Acme' }

        const removed = folders_state.folder_menu_select('Acme', 'delete')
        const text = await confirm_answer(true)

        await removed

        expect(text).toBe('Delete the folder "Acme"? The 2 recordings in it stay in Home.')
        expect(ipc.folder_remove).toHaveBeenCalledWith('Acme')
        expect(ipc.job_delete).not.toHaveBeenCalled()
        expect(folders_state.folder_current.value).toBeNull()
        expect(ask_state.scope.value).toEqual({ kind: 'all' })
    })

    it('keeps the folder when the delete is declined', async () => {
        const removed = folders_state.folder_menu_select('Board', 'delete')
        const text = await confirm_answer(false)

        await removed

        expect(text).toBe('Delete the folder "Board"?')
        expect(ipc.folder_remove).not.toHaveBeenCalled()
    })
})

describe('folder_move', () => {
    it('files a meeting into a folder and takes it out again', async () => {
        const job = JOBS[3]

        assert(job !== undefined)

        vi.mocked(ipc.job_meta_update).mockResolvedValue(job)

        await folders_state.folder_move(job, 'Board')
        await folders_state.folder_move(job, null)

        expect(vi.mocked(ipc.job_meta_update).mock.calls).toEqual([
            ['delta', { project: 'Board' }],
            ['delta', { project: '' }],
        ])

        expect(ipc.jobs_list).toHaveBeenCalledTimes(3)
    })
})

describe('folder view', () => {
    it('opens a folder on Home and closes it once the folder is gone', async () => {
        pipeline.view_current.value = 'ask'

        folders_state.folder_open('Hiring')

        expect(pipeline.view_current.value).toBe('jobs')
        expect(folders_state.folder_current.value).toBe('Hiring')

        jobs_state.jobs.value = JOBS.filter((job) => job.id !== 'gamma')
        await flushPromises()

        expect(folders_state.folders.value).not.toContain('Hiring')
        expect(folders_state.folder_current.value).toBeNull()
    })
})
