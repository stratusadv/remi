import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import StepMeeting from '../../src/components/step_meeting.vue'
import { use_notes_templates } from '../../src/composables/use_notes_templates'
import { use_pipeline } from '../../src/composables/use_pipeline'
import { use_settings } from '../../src/composables/use_settings'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import {
    ATTACH_TO,
    TO_FAKE,
    deferred_new,
    job_meta_build,
    mount_auto_unmount,
} from './fixtures'
import type { DOMWrapper, VueWrapper } from '@vue/test-utils'
import type { JobID, JobMeta, JobMetaPatch } from '../../src/types'


vi.mock('../../src/lib/ipc')

const AUTOSAVE_DEBOUNCE_MS = 800
const TITLE_FIRST = 'Weekly sync'
const TITLE_SECOND = 'Retro'
const pipeline = use_pipeline()
const { templates } = use_notes_templates()
const { settings } = use_settings()


async function meeting_open(meta: JobMeta): Promise<void> {
    assert(meta.id.length > 0)
    assert(!pipeline.job_open_busy.value)

    vi.mocked(ipc.job_transcript_engines_list).mockResolvedValue([])
    vi.mocked(ipc.job_waveform_get).mockResolvedValue(null)
    vi.mocked(ipc.notes_load).mockResolvedValue(null)

    await pipeline.job_open(meta, 'details')
    await flushPromises()

    assert(pipeline.job_id_current.value === meta.id)
}

async function meta_saved(job_id: JobID, patch: JobMetaPatch): Promise<JobMeta> {
    assert(job_id.length > 0)
    assert(vi.isMockFunction(ipc.job_meta_update))

    return Promise.resolve(job_meta_build({ id: job_id, title: title_of(patch) }))
}

function mount_meeting(): VueWrapper {
    assert(document.body.childElementCount === 0)
    assert(pipeline.meta_current.value !== null)

    return mount_auto_unmount(StepMeeting, { [ATTACH_TO]: document.body })
}

function next_button(wrapper: VueWrapper): DOMWrapper<HTMLButtonElement> {
    assert(wrapper.exists())

    const button = wrapper.findAll('button').find((candidate) => candidate.text() === 'Next')

    if (button === undefined) throw new Error('no Next button')

    assert(button.classes('btn-primary'))

    return button
}

async function save_failed(gate: Promise<undefined>): Promise<JobMeta> {
    assert(gate instanceof Promise)
    assert(vi.isMockFunction(ipc.job_meta_update))

    await gate

    throw new Error('disk full')
}

function title_of(patch: JobMetaPatch): string {
    const { title } = patch

    assert(typeof title === 'string', 'every autosave sends the title')
    assert(title === title.trim())

    return title
}

async function title_type(wrapper: VueWrapper, title: string): Promise<void> {
    assert(wrapper.exists())
    assert(title.length > 0)

    await wrapper.get('#details-title').setValue(title)
}

function title_value(wrapper: VueWrapper): string {
    assert(wrapper.exists())

    const input = wrapper.get('#details-title').element

    assert(input instanceof HTMLInputElement)

    return input.value
}

function titles_saved(): string[] {
    const calls = vi.mocked(ipc.job_meta_update).mock.calls

    assert(calls.length <= 4)
    assert(calls.every(([job_id]) => job_id.length > 0))

    return calls.map(([, patch]) => title_of(patch))
}

beforeEach(() => {
    onTestFinished(() => {
        vi.restoreAllMocks()
        vi.useRealTimers()
        document.body.innerHTML = ''
    })

    vi.resetAllMocks()
    vi.mocked(ipc.jobs_list).mockResolvedValue([])
    vi.mocked(ipc.job_meta_get).mockResolvedValue(job_meta_build({ title: TITLE_FIRST }))
    vi.mocked(ipc.job_meta_update).mockImplementation(meta_saved)
    pipeline.pipeline_reset()
    pipeline.job_id_current.value = 'job-1'
    pipeline.meta_current.value = job_meta_build({ title: TITLE_FIRST })
    pipeline.template_id_selected.value = 'meeting'

    templates.value = [
        { id: 'meeting', name: 'Meeting', description: '', instructions: '', edited: false },
    ]

    settings.value = { ...settings.value, notes_template_id_default: 'meeting' }
})

describe('StepMeeting autosave across meetings', () => {
    it('lets another meeting continue once a save for the previous one finishes', async () => {
        const saved = deferred_new<JobMeta>()
        const wrapper = mount_meeting()

        vi.useFakeTimers({ [TO_FAKE]: ['setTimeout', 'clearTimeout'] })
        vi.mocked(ipc.job_meta_update).mockReturnValueOnce(saved.promise)
        await title_type(wrapper, `${TITLE_FIRST} notes`)
        vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS)
        await flushPromises()

        expect(titles_saved()).toEqual([`${TITLE_FIRST} notes`])
        expect(next_button(wrapper).attributes('disabled')).toBeDefined()

        await meeting_open(job_meta_build({ id: 'job-2', title: TITLE_SECOND }))
        saved.resolve(job_meta_build({ title: `${TITLE_FIRST} notes` }))
        await flushPromises()

        expect(title_value(wrapper)).toBe(TITLE_SECOND)
        expect(pipeline.meta_current.value?.title).toBe(TITLE_SECOND)
        expect(next_button(wrapper).attributes('disabled')).toBeUndefined()
    })

    it('saves an edit still waiting to its own meeting when another meeting opens', async () => {
        const wrapper = mount_meeting()

        vi.useFakeTimers({ [TO_FAKE]: ['setTimeout', 'clearTimeout'] })
        await title_type(wrapper, `${TITLE_FIRST} notes`)
        await meeting_open(job_meta_build({ id: 'job-2', title: TITLE_SECOND }))

        expect(ipc.job_meta_update).toHaveBeenCalledOnce()

        expect(ipc.job_meta_update).toHaveBeenCalledWith(
            'job-1',
            expect.objectContaining({ title: `${TITLE_FIRST} notes` }),
        )

        vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS)
        await flushPromises()

        expect(ipc.job_meta_update).toHaveBeenCalledOnce()
        expect(title_value(wrapper)).toBe(TITLE_SECOND)
        expect(next_button(wrapper).attributes('disabled')).toBeUndefined()
    })

    it('saves an edit still waiting when its own meeting opens again', async () => {
        const wrapper = mount_meeting()

        vi.useFakeTimers({ [TO_FAKE]: ['setTimeout', 'clearTimeout'] })
        await title_type(wrapper, `${TITLE_FIRST} notes`)
        await meeting_open(job_meta_build({ title: TITLE_FIRST }))
        vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS)
        await flushPromises()

        expect(titles_saved()).toEqual([`${TITLE_FIRST} notes`])
        expect(title_value(wrapper)).toBe(`${TITLE_FIRST} notes`)
        expect(pipeline.meta_current.value?.title).toBe(`${TITLE_FIRST} notes`)
    })
})

describe('StepMeeting autosave order', () => {
    it('sends a save only after the one before it settles and keeps the newest', async () => {
        const first = deferred_new<JobMeta>()
        const second = deferred_new<JobMeta>()
        const wrapper = mount_meeting()

        vi.useFakeTimers({ [TO_FAKE]: ['setTimeout', 'clearTimeout'] })

        vi.mocked(ipc.job_meta_update)
            .mockReturnValueOnce(first.promise)
            .mockReturnValueOnce(second.promise)

        await title_type(wrapper, `${TITLE_FIRST} A`)
        vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS)
        await flushPromises()
        await title_type(wrapper, `${TITLE_FIRST} B`)
        vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS)
        await flushPromises()

        expect(titles_saved()).toEqual([`${TITLE_FIRST} A`])

        second.resolve(job_meta_build({ title: `${TITLE_FIRST} B` }))
        await flushPromises()
        first.resolve(job_meta_build({ title: `${TITLE_FIRST} A` }))
        await flushPromises()

        expect(titles_saved()).toEqual([`${TITLE_FIRST} A`, `${TITLE_FIRST} B`])
        expect(pipeline.meta_current.value?.title).toBe(`${TITLE_FIRST} B`)
        expect(title_value(wrapper)).toBe(`${TITLE_FIRST} B`)
        expect(next_button(wrapper).attributes('disabled')).toBeUndefined()
    })

    it('keeps an edit made while the save before it fails', async () => {
        const gate = deferred_new<undefined>()
        const wrapper = mount_meeting()

        vi.useFakeTimers({ [TO_FAKE]: ['setTimeout', 'clearTimeout'] })
        vi.mocked(ipc.job_meta_update).mockReturnValueOnce(save_failed(gate.promise))
        await title_type(wrapper, `${TITLE_FIRST} A`)
        vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS)
        await flushPromises()
        await title_type(wrapper, `${TITLE_FIRST} B`)
        gate.resolve(undefined)
        await flushPromises()

        expect(title_value(wrapper)).toBe(`${TITLE_FIRST} B`)
        expect(wrapper.get('.banner').text()).toContain('disk full')

        vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS)
        await flushPromises()

        expect(titles_saved()).toEqual([`${TITLE_FIRST} A`, `${TITLE_FIRST} B`])
        expect(title_value(wrapper)).toBe(`${TITLE_FIRST} B`)
        expect(wrapper.find('.banner').exists()).toBe(false)
    })
})

describe('StepMeeting template', () => {
    beforeEach(() => {
        templates.value = [
            ...templates.value,
            { id: 'standup', name: 'Standup', description: '', instructions: '', edited: false },
        ]
    })

    it('saves the template picked for the meeting with its details', async () => {
        const wrapper = mount_meeting()

        vi.useFakeTimers({ [TO_FAKE]: ['setTimeout', 'clearTimeout'] })
        await wrapper.get('#details-template').setValue('standup')
        vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS)
        await flushPromises()

        expect(ipc.job_meta_update).toHaveBeenCalledExactlyOnceWith(
            'job-1',
            expect.objectContaining({ template_id: 'standup', title: TITLE_FIRST }),
        )
    })

    it('saves nothing when another meeting opens on a template of its own', async () => {
        const meta_second = job_meta_build({
            id: 'job-2',
            template_id: 'standup',
            title: TITLE_SECOND,
        })

        const wrapper = mount_meeting()

        vi.useFakeTimers({ [TO_FAKE]: ['setTimeout', 'clearTimeout'] })
        await meeting_open(meta_second)
        vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS)
        await flushPromises()

        expect(title_value(wrapper)).toBe(TITLE_SECOND)
        expect(pipeline.template_id_selected.value).toBe('standup')
        expect(ipc.job_meta_update).not.toHaveBeenCalled()
    })

    it('saves nothing for a template it only filled in from the default', async () => {
        settings.value = { ...settings.value, notes_template_id_default: 'standup' }
        pipeline.template_id_selected.value = null

        vi.useFakeTimers({ [TO_FAKE]: ['setTimeout', 'clearTimeout'] })
        mount_meeting()
        await flushPromises()
        vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS)
        await flushPromises()

        expect(pipeline.template_id_selected.value).toBe('standup')
        expect(ipc.job_meta_update).not.toHaveBeenCalled()
    })
})
