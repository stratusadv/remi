import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import JobsManager from '../../src/components/jobs_manager.vue'
import { use_ask } from '../../src/composables/use_ask'
import { use_dialog } from '../../src/composables/use_dialog'
import { use_folders } from '../../src/composables/use_folders'
import { use_jobs } from '../../src/composables/use_jobs'
import { use_people } from '../../src/composables/use_people'
import { use_pipeline } from '../../src/composables/use_pipeline'
import { use_settings } from '../../src/composables/use_settings'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import {
    ATTACH_TO,
    TO_FAKE,
    deferred_new,
    job_listing_build,
    person_build,
    search_hit_build,
    transcript_build,
} from './fixtures'
import type { DOMWrapper, VueWrapper } from '@vue/test-utils'
import type { JobListing, JobSearchHit } from '../../src/types'


vi.mock('../../src/lib/ipc')

const JOBS = Object.freeze<JobListing[]>([
    job_listing_build({
        id: 'alpha',
        title: 'Alpha review',
        created_at_unix: 1_000,
        duration_seconds: 300,
        has_transcript: true,
        person_ids: ['zoe', 'adam'],
    }),
    job_listing_build({
        id: 'beta',
        title: 'beta planning',
        created_at_unix: 3_000,
        duration_seconds: 100,
        has_notes: true,
        favourite: true,
        attendees: ['Mia', 'Ben'],
    }),
    job_listing_build({
        id: 'gamma',
        title: null,
        label: null,
        source_path: '/tmp/Gamma call.wav',
        created_at_unix: 2_000,
        duration_seconds: null,
    }),
    job_listing_build({
        id: 'delta',
        title: 'Delta sync',
        created_at_unix: 4_000,
        duration_seconds: 300,
        has_transcript: true,
        project: 'Apollo',
        tags: ['finance'],
    }),
])

const mounted = new Set<VueWrapper>()
const folders_state = use_folders()
const jobs_state = use_jobs()
const people_state = use_people()
const settings_state = use_settings()
const pipeline = use_pipeline()
const dialog = use_dialog()


function aria_sort(wrapper: VueWrapper, label: string): string | null {
    assert(wrapper.exists())
    assert(label.length > 0)

    return header(wrapper, label).element.closest('th')?.getAttribute('aria-sort') ?? null
}

function header(wrapper: VueWrapper, label: string): DOMWrapper<Element> {
    assert(wrapper.exists())
    assert(label.length > 0)

    const button = wrapper.findAll('.recording-table-sort').find((candidate) =>
        candidate.text().startsWith(label))

    if (button === undefined) throw new Error(`no sort header labelled ${label}`)

    return button
}

function menu_item_click(label: string): void {
    assert(label.length > 0)

    const item = [...document.body.querySelectorAll('[role="menuitem"]')]
        .find((candidate) => candidate.textContent.trim() === label)

    assert(item !== undefined, `no menu item reads ${label}`)

    item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

async function mount_manager(view: 'grid' | 'list' = 'list'): Promise<VueWrapper> {
    assert(view.length > 0)
    assert(mounted.size >= 0)

    settings_state.settings.value = { ...settings_state.settings.value, jobs_view: view }

    const wrapper = mount(JobsManager, { [ATTACH_TO]: document.body })

    mounted.add(wrapper)
    await flushPromises()

    return wrapper
}

async function sort_by(wrapper: VueWrapper, label: string): Promise<void> {
    assert(wrapper.exists())
    assert(label.length > 0)

    await header(wrapper, label).trigger('click')
}

function titles(wrapper: VueWrapper): string[] {
    assert(wrapper.exists())
    assert(mounted.has(wrapper))

    return wrapper.findAll('.recording-table-title').map((cell) => cell.text())
}

beforeEach(async () => {
    vi.useFakeTimers({ [TO_FAKE]: ['setTimeout', 'clearTimeout'] })
    vi.resetAllMocks()
    vi.mocked(ipc.folders_list).mockResolvedValue([])
    vi.mocked(ipc.jobs_list).mockResolvedValue([...JOBS])
    vi.mocked(ipc.job_waveform_get).mockResolvedValue(null)
    vi.mocked(ipc.settings_update).mockResolvedValue(undefined)
    jobs_state.jobs.value = []
    jobs_state.error_message.value = null

    people_state.people.value = [
        person_build({ id: 'zoe', name_first: 'Zoe', name_last: 'Young' }),
        person_build({ id: 'adam', name_first: 'adam', name_last: 'Brown' }),
    ]

    pipeline.pipeline_reset()
    folders_state.folder_close()

    await folders_state.refresh()
})

afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount()

    mounted.clear()
    dialog.close(false)
    vi.useRealTimers()
    document.body.innerHTML = ''
})

describe('JobsManager list ordering', () => {
    it('loads the jobs on mount and shows favourites first, then newest', async () => {
        const wrapper = await mount_manager()

        expect(ipc.jobs_list).toHaveBeenCalledTimes(1)

        expect(titles(wrapper)).toEqual([
            'beta planning',
            'Delta sync',
            'Gamma call',
            'Alpha review',
        ])

        expect(aria_sort(wrapper, 'Title')).toBe('none')
    })

    it('sorts by title ascending then descending, ignoring case', async () => {
        const wrapper = await mount_manager()

        await sort_by(wrapper, 'Title')

        expect(titles(wrapper)).toEqual([
            'Alpha review',
            'beta planning',
            'Delta sync',
            'Gamma call',
        ])

        expect(aria_sort(wrapper, 'Title')).toBe('ascending')
        expect(header(wrapper, 'Title').attributes('data-active')).toBe('true')

        await sort_by(wrapper, 'Title')

        expect(titles(wrapper)).toEqual([
            'Gamma call',
            'Delta sync',
            'beta planning',
            'Alpha review',
        ])

        expect(aria_sort(wrapper, 'Title')).toBe('descending')
    })

    it('sorts by date descending first, then ascending', async () => {
        const wrapper = await mount_manager()

        await sort_by(wrapper, 'Date')

        expect(titles(wrapper)).toEqual([
            'Delta sync',
            'beta planning',
            'Gamma call',
            'Alpha review',
        ])

        expect(aria_sort(wrapper, 'Date')).toBe('descending')

        await sort_by(wrapper, 'Date')

        expect(titles(wrapper)).toEqual([
            'Alpha review',
            'Gamma call',
            'beta planning',
            'Delta sync',
        ])
    })
})

describe('JobsManager list ordering', () => {
    it('sorts by duration descending first with unknown durations last', async () => {
        const wrapper = await mount_manager()

        await sort_by(wrapper, 'Duration')

        expect(titles(wrapper)).toEqual([
            'Delta sync',
            'Alpha review',
            'beta planning',
            'Gamma call',
        ])

        await sort_by(wrapper, 'Duration')

        expect(titles(wrapper)).toEqual([
            'Gamma call',
            'beta planning',
            'Delta sync',
            'Alpha review',
        ])
    })

    it('breaks duration ties by newest regardless of direction', async () => {
        const wrapper = await mount_manager()

        await sort_by(wrapper, 'Duration')

        expect(titles(wrapper).slice(0, 2)).toEqual(['Delta sync', 'Alpha review'])

        await sort_by(wrapper, 'Duration')

        expect(titles(wrapper).slice(2)).toEqual(['Delta sync', 'Alpha review'])
    })
})

describe('JobsManager list ordering', () => {
    it('sorts by participants text with jobs lacking people first', async () => {
        const wrapper = await mount_manager()

        await sort_by(wrapper, 'Participants')

        expect(titles(wrapper)).toEqual([
            'Delta sync',
            'Gamma call',
            'Alpha review',
            'beta planning',
        ])

        await sort_by(wrapper, 'Participants')

        expect(titles(wrapper)).toEqual([
            'beta planning',
            'Alpha review',
            'Delta sync',
            'Gamma call',
        ])
    })

    it('switching columns starts from that column default direction', async () => {
        const wrapper = await mount_manager()

        await sort_by(wrapper, 'Title')
        await sort_by(wrapper, 'Title')
        await sort_by(wrapper, 'Date')

        expect(aria_sort(wrapper, 'Title')).toBe('none')
        expect(aria_sort(wrapper, 'Date')).toBe('descending')
    })
})

describe('JobsManager cells', () => {
    it('lists participants alphabetically ignoring case, from people or attendees', async () => {
        const wrapper = await mount_manager()
        const cells = wrapper.findAll('.recording-table-row td:nth-child(2)')

        expect(cells.map((cell) => cell.text())).toEqual([
            'Ben, Mia',
            'No participants',
            'No participants',
            'adam Brown, Zoe Young',
        ])
    })

    it('shows the duration per row and no status column', async () => {
        const wrapper = await mount_manager()
        const rows = wrapper.findAll('.recording-table-row')
        const labels = wrapper.findAll('.recording-table-sort').map((button) => button.text())

        expect(rows[0]?.findAll('td')[3]?.text()).toBe('1:40')
        expect(rows[2]?.findAll('td')[3]?.text()).toBe('-:--')
        expect(rows[0]?.findAll('td')).toHaveLength(5)
        expect(labels).toEqual(['Title', 'Participants', 'Date', 'Duration'])
        expect(wrapper.find('.recording-tile-status').exists()).toBe(false)
    })

    it('falls back to the file stem when a job has no title or label', async () => {
        const wrapper = await mount_manager()

        expect(titles(wrapper)).toContain('Gamma call')
    })
})

describe('JobsManager search', () => {
    it('filters locally on title, project and tags before the backend answers', async () => {
        vi.mocked(ipc.jobs_search).mockResolvedValue([])

        const wrapper = await mount_manager()

        await wrapper.get('input[type="search"]').setValue('apollo')

        expect(titles(wrapper)).toEqual(['Delta sync'])

        await wrapper.get('input[type="search"]').setValue('finance')

        expect(titles(wrapper)).toEqual(['Delta sync'])

        await wrapper.get('input[type="search"]').setValue('alpha')

        expect(titles(wrapper)).toEqual(['Alpha review'])
    })

    it('debounces the backend search and shows its snippets in the participants cell', async () => {
        vi.mocked(ipc.jobs_search).mockResolvedValue([
            search_hit_build({ job_id: 'gamma', source: 'notes', snippet: 'retry policy' }),
        ])

        const wrapper = await mount_manager()

        await wrapper.get('input[type="search"]').setValue('re')
        await wrapper.get('input[type="search"]').setValue('retry')

        expect(ipc.jobs_search).not.toHaveBeenCalled()

        vi.advanceTimersByTime(250)
        await flushPromises()

        expect(ipc.jobs_search).toHaveBeenCalledTimes(1)
        expect(ipc.jobs_search).toHaveBeenCalledWith('retry')
        expect(titles(wrapper)).toEqual(['Gamma call'])

        expect(wrapper.get('.recording-table-row td:nth-child(2)').text())
            .toBe('In notes: retry policy')
    })

    it('does not search the backend for a single character', async () => {
        const wrapper = await mount_manager()

        await wrapper.get('input[type="search"]').setValue('a')
        vi.advanceTimersByTime(250)
        await flushPromises()

        expect(ipc.jobs_search).not.toHaveBeenCalled()

        expect(titles(wrapper)).toEqual([
            'beta planning',
            'Delta sync',
            'Gamma call',
            'Alpha review',
        ])
    })
})

describe('JobsManager search', () => {
    it('shows an empty state when nothing matches', async () => {
        vi.mocked(ipc.jobs_search).mockResolvedValue([])

        const wrapper = await mount_manager()

        await wrapper.get('input[type="search"]').setValue('zzz')
        vi.advanceTimersByTime(250)
        await flushPromises()

        expect(wrapper.get('.empty-state').text()).toContain('Nothing matches “zzz”.')
    })

    it('drops a stale backend answer when the query has changed', async () => {
        const search = deferred_new<JobSearchHit[]>()

        vi.mocked(ipc.jobs_search).mockReturnValueOnce(search.promise)

        vi.mocked(ipc.jobs_search).mockResolvedValue([
            search_hit_build({ job_id: 'alpha', source: 'transcript', snippet: 'late' }),
        ])

        const wrapper = await mount_manager()

        await wrapper.get('input[type="search"]').setValue('first')
        vi.advanceTimersByTime(250)
        await wrapper.get('input[type="search"]').setValue('second')
        vi.advanceTimersByTime(250)
        await flushPromises()
        search.resolve([])
        await flushPromises()

        expect(ipc.jobs_search).toHaveBeenCalledTimes(2)
        expect(titles(wrapper)).toEqual(['Alpha review'])
    })
})

describe('JobsManager actions', () => {
    it('opens a job through the pipeline on row click', async () => {
        vi.mocked(ipc.job_transcript_engines_list).mockResolvedValue(['engine'])
        vi.mocked(ipc.job_transcript_load).mockResolvedValue(transcript_build(['hi']))
        vi.mocked(ipc.notes_load).mockResolvedValue(null)

        const wrapper = await mount_manager()

        await wrapper.findAll('.recording-table-row')[1]?.trigger('click')
        await flushPromises()

        expect(pipeline.job_id_current.value).toBe('delta')
        expect(pipeline.view_current.value).toBe('details')
    })

    it('toggles a favourite without opening the row', async () => {
        vi.mocked(ipc.job_meta_update).mockResolvedValue(JOBS[0] ?? job_listing_build())

        const wrapper = await mount_manager()

        const row = wrapper.findAll('.recording-table-row')[1]

        await row?.get('.recording-tile-star').trigger('click')
        await flushPromises()

        expect(ipc.job_meta_update).toHaveBeenCalledWith('delta', { favourite: true })
        expect(ipc.jobs_list).toHaveBeenCalledTimes(2)
        expect(pipeline.job_id_current.value).toBeNull()
    })

    it('persists the layout choice from the view switch', async () => {
        const wrapper = await mount_manager('grid')

        expect(wrapper.find('.recording-grid').exists()).toBe(true)
        expect(wrapper.findAll('.recording-tile').length).toBeGreaterThan(0)

        await wrapper.get('[title="List"]').trigger('click')

        expect(ipc.settings_update).toHaveBeenCalledWith(
            expect.objectContaining({ jobs_view: 'list' }),
        )
    })

    it('starts a new recording from the header button', async () => {
        const wrapper = await mount_manager()

        await wrapper.get('.btn-primary').trigger('click')

        expect(pipeline.view_current.value).toBe('transcribe')
    })
})

describe('JobsManager actions', () => {
    it('renames through the row menu and saves the new title', async () => {
        vi.mocked(ipc.job_meta_update).mockResolvedValue(JOBS[0] ?? job_listing_build())

        const wrapper = await mount_manager()

        await wrapper.findAll('.recording-table-row')[3]?.get('.menu-icon-btn').trigger('click')

        menu_item_click('Rename')

        await flushPromises()

        const input = document.body.querySelector<HTMLInputElement>('.app-dialog input')

        if (input === null) throw new Error('rename dialog missing')

        expect(input.value).toBe('Alpha review')

        input.value = '  Alpha retro  '
        input.dispatchEvent(new Event('input'))
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
        await flushPromises()

        expect(ipc.job_meta_update).toHaveBeenCalledWith('alpha', { title: 'Alpha retro' })
        expect(document.body.querySelector('.app-dialog')).toBeNull()
    })

    it('refuses an empty rename and closes without saving an unchanged one', async () => {
        const wrapper = await mount_manager()

        await wrapper.findAll('.recording-table-row')[3]?.get('.menu-icon-btn').trigger('click')

        menu_item_click('Rename')

        await flushPromises()

        const input = document.body.querySelector<HTMLInputElement>('.app-dialog input')

        if (input === null) throw new Error('rename dialog missing')

        input.value = '   '
        input.dispatchEvent(new Event('input'))
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
        await flushPromises()

        expect(document.body.querySelector('.app-dialog .error')?.textContent.trim())
            .toBe('Title cannot be empty.')

        expect(ipc.job_meta_update).not.toHaveBeenCalled()

        input.value = 'Alpha review'
        input.dispatchEvent(new Event('input'))
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
        await flushPromises()

        expect(ipc.job_meta_update).not.toHaveBeenCalled()
        expect(document.body.querySelector('.app-dialog')).toBeNull()
    })
})

describe('JobsManager actions', () => {
    it('asks for confirmation before deleting and deletes on yes', async () => {
        vi.mocked(ipc.job_delete).mockResolvedValue(undefined)

        const wrapper = await mount_manager()

        await wrapper.findAll('.recording-table-row')[0]?.get('.menu-icon-btn').trigger('click')

        menu_item_click('Delete')

        await flushPromises()

        expect(dialog.current.value?.title).toBe('Delete recording')
        expect(dialog.current.value?.message).toContain('Delete "beta planning"?')
        expect(ipc.job_delete).not.toHaveBeenCalled()

        dialog.close(true)
        await flushPromises()

        expect(ipc.job_delete).toHaveBeenCalledWith('beta')
    })

    it('does not delete when the confirmation is declined', async () => {
        const wrapper = await mount_manager()

        await wrapper.findAll('.recording-table-row')[0]?.get('.menu-icon-btn').trigger('click')

        menu_item_click('Delete')

        await flushPromises()
        dialog.close(false)
        await flushPromises()

        expect(ipc.job_delete).not.toHaveBeenCalled()
    })

    it('shows and dismisses the error banner', async () => {
        vi.mocked(ipc.jobs_list).mockRejectedValue(new Error('no index'))

        const wrapper = await mount_manager()

        expect(wrapper.get('.banner').text()).toContain('Error: no index')

        await wrapper.get('.banner-close').trigger('click')

        expect(wrapper.find('.banner').exists()).toBe(false)
        expect(jobs_state.error_message.value).toBeNull()
    })
})

describe('JobsManager search hits', () => {
    it('labels a transcript hit with its moment and opens the meeting there', async () => {
        vi.mocked(ipc.job_transcript_engines_list).mockResolvedValue(['engine'])
        vi.mocked(ipc.job_transcript_load).mockResolvedValue(transcript_build(['hi']))
        vi.mocked(ipc.notes_load).mockResolvedValue('# Notes')

        vi.mocked(ipc.jobs_search).mockResolvedValue([
            search_hit_build({
                job_id: 'alpha',
                segment_index_first: 4,
                segment_index_last: 5,
                snippet: 'ship it',
                source: 'transcript',
                start_seconds: 65,
            }),
        ])

        const wrapper = await mount_manager()

        await wrapper.get('input[type="search"]').setValue('ship')
        vi.advanceTimersByTime(250)
        await flushPromises()

        expect(wrapper.get('.recording-table-row td:nth-child(2)').text())
            .toBe('In transcript: 1:05 · ship it')

        await wrapper.get('.recording-table-row').trigger('click')
        await flushPromises()

        expect(pipeline.view_current.value).toBe('transcribe')

        expect(pipeline.segment_focus.value).toEqual({
            job_id: 'alpha',
            segment_index_first: 4,
            segment_index_last: 5,
        })
    })

    it('finds a meeting by the people in it or mentioned in it', async () => {
        vi.mocked(ipc.jobs_search).mockResolvedValue([])

        const wrapper = await mount_manager()

        await wrapper.get('input[type="search"]').setValue('young')

        expect(titles(wrapper)).toEqual(['Alpha review'])

        await wrapper.get('input[type="search"]').setValue('mia')

        expect(titles(wrapper)).toEqual(['beta planning'])
    })
})

describe('JobsManager wording', () => {
    it('tells the person the original file stays when a recording is deleted', async () => {
        const wrapper = await mount_manager()

        await wrapper.findAll('.recording-table-row')[0]?.get('.menu-icon-btn').trigger('click')

        menu_item_click('Delete')

        await flushPromises()

        expect(dialog.current.value?.message).toContain('original file')
        expect(dialog.current.value?.message).toContain('stays where it is')
        expect(dialog.current.value?.message).not.toContain('removed from this computer')
    })

    it('does not call a match in the title a match in the transcript', async () => {
        vi.mocked(ipc.jobs_search).mockResolvedValue([])

        const wrapper = await mount_manager()

        await wrapper.get('input[type="search"]').setValue('alpha')
        vi.advanceTimersByTime(250)
        await flushPromises()

        expect(titles(wrapper)).toEqual(['Alpha review'])

        expect(wrapper.get('.recording-table-row td:nth-child(2)').text())
            .toBe('adam Brown, Zoe Young')
    })
})

describe('JobsManager folders', () => {
    it('shows only the open folder and leaves New recording to Home', async () => {
        folders_state.folder_open('Apollo')

        const wrapper = await mount_manager()

        expect(titles(wrapper)).toEqual(['Delta sync'])
        expect(wrapper.get('.folder-heading-title').text()).toBe('Apollo')
        expect(wrapper.get('.btn-primary').text()).toBe('Ask about this folder')

        await wrapper.get('.folder-crumb').trigger('click')

        expect(folders_state.folder_current.value).toBeNull()
        expect(titles(wrapper)).toHaveLength(JOBS.length)
        expect(wrapper.get('.btn-primary').text()).toBe('New recording')
    })

    it('hides the New recording tile inside a folder', async () => {
        folders_state.folder_open('Apollo')

        const wrapper = await mount_manager('grid')

        expect(wrapper.findAll('.recording-tile')).toHaveLength(1)
        expect(wrapper.find('.recording-tile-new').exists()).toBe(false)
    })
})

describe('JobsManager folders', () => {
    it('explains how to fill an empty folder', async () => {
        vi.mocked(ipc.folders_list).mockResolvedValue(['Board'])

        await folders_state.refresh()

        folders_state.folder_open('Board')

        const wrapper = await mount_manager()

        expect(wrapper.text()).toContain('This folder is empty')
        expect(wrapper.text()).toContain('Move to folder')
        expect(wrapper.find('input[type="search"]').exists()).toBe(false)
    })

    it('moves a recording into a folder from its menu', async () => {
        vi.mocked(ipc.job_meta_update).mockResolvedValue(JOBS[0] ?? job_listing_build())

        const wrapper = await mount_manager()

        await wrapper.findAll('.recording-table-row')[3]?.get('.menu-icon-btn').trigger('click')

        menu_item_click('Move to folder')

        await flushPromises()

        const options = [
            ...document.body.querySelectorAll<HTMLButtonElement>('.folder-move-option'),
        ]

        expect(options.map((option) => option.textContent.trim())).toEqual(['No folder', 'Apollo'])
        expect(options[0]?.getAttribute('aria-current')).toBe('true')

        options[1]?.click()
        await flushPromises()

        expect(ipc.job_meta_update).toHaveBeenCalledWith('alpha', { project: 'Apollo' })
        expect(document.body.querySelector('.folder-move-option')).toBeNull()
    })

    it('still offers New recording on an empty Home in the list layout', async () => {
        vi.mocked(ipc.jobs_list).mockResolvedValue([])

        const wrapper = await mount_manager('list')

        expect(wrapper.find('.recording-table').exists()).toBe(false)
        expect(wrapper.get('.recording-tile-new').text()).toBe('New recording')
    })
})

describe('JobsManager ask', () => {
    it('asks about a row from its speech bubble and offers none before transcription', async () => {
        const wrapper = await mount_manager()
        const rows = wrapper.findAll('.recording-table-row')
        const delta = rows.find((row) => row.text().includes('Delta sync'))

        const offered = Object.fromEntries(rows.map((row) => [
            row.get('.recording-table-title').text(),
            row.find('.recording-tile-ask').exists(),
        ]))

        expect(offered).toEqual({
            'Alpha review': true,
            'beta planning': true,
            'Gamma call': false,
            'Delta sync': true,
        })

        await delta?.get('.recording-tile-ask').trigger('click')
        await flushPromises()

        expect(pipeline.view_current.value).toBe('ask')
        expect(use_ask().scope.value).toEqual({ kind: 'meeting', job_id: 'delta' })
    })

    it('asks about a folder from its header and offers none before transcription', async () => {
        vi.mocked(ipc.jobs_list).mockResolvedValue([
            ...JOBS,
            job_listing_build({ id: 'omega', title: 'Omega intro', project: 'Board' }),
        ])

        folders_state.folder_open('Board')

        const wrapper = await mount_manager()

        expect(titles(wrapper)).toEqual(['Omega intro'])
        expect(wrapper.find('.btn-primary').exists()).toBe(false)

        folders_state.folder_open('Apollo')
        await flushPromises()

        await wrapper.get('.btn-primary').trigger('click')
        await flushPromises()

        expect(pipeline.view_current.value).toBe('ask')
        expect(use_ask().scope.value).toEqual({ kind: 'project', project: 'Apollo' })
    })
})
