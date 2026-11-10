import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { use_notes_templates } from '../../src/composables/use_notes_templates'
import { use_pipeline } from '../../src/composables/use_pipeline'
import { use_settings } from '../../src/composables/use_settings'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import { deferred_new, job_meta_build, transcript_build } from './fixtures'
import type { TemplateID, Waveform } from '../../src/types'


vi.mock('../../src/lib/ipc')

const WAVEFORM = Object.freeze<Waveform>({ peaks: [0.1, 0.5], duration_seconds: 20 })
const output = globalThis.console
const pipeline = use_pipeline()


function job_open_mocks(engines: string[], notes: string | null): void {
    assert(Array.isArray(engines))
    assert(notes === null || typeof notes === 'string')

    vi.mocked(ipc.job_transcript_engines_list).mockResolvedValue(engines)
    vi.mocked(ipc.job_transcript_load).mockResolvedValue(transcript_build(['hello', 'world']))
    vi.mocked(ipc.notes_load).mockResolvedValue(notes)
    vi.mocked(ipc.job_waveform_get).mockResolvedValue(WAVEFORM)
}

async function settle(): Promise<void> {
    assert(typeof nextTick === 'function')
    assert(typeof pipeline.view_current.value === 'string')

    await nextTick()
    await Promise.resolve()
}

function template_select(id: TemplateID): void {
    assert(id.length > 0)

    pipeline.template_id_selected.value = id

    assert(pipeline.template_id_selected.value === id)
}

beforeEach(() => {
    vi.resetAllMocks()
    pipeline.pipeline_reset()
    pipeline.view_set('transcribe')
    pipeline.view_set('jobs')
    vi.spyOn(output, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('view_set', () => {
    it('changes the current view', () => {
        pipeline.view_set('settings')

        expect(pipeline.view_current.value).toBe('settings')
    })
})

describe('view_reopen', () => {
    it('counts reopen requests for the view already shown', () => {
        pipeline.view_set('people')
        pipeline.view_reopen('people')
        pipeline.view_reopen('people')

        expect(pipeline.view_reopen_count.value).toBe(2)
    })

    it('switches the view and resets the count when another view is requested', async () => {
        pipeline.view_set('people')
        pipeline.view_reopen('people')
        pipeline.view_reopen('templates')

        await nextTick()

        expect(pipeline.view_current.value).toBe('templates')
        expect(pipeline.view_reopen_count.value).toBe(0)
    })
})

describe('job_open', () => {
    it('loads the first engine transcript and the notes, then shows notes', async () => {
        job_open_mocks(['stratus.listen', 'whisper'], '# Notes')

        const meta = job_meta_build({ id: 'job-9', source_path: '/tmp/nine.wav' })

        await pipeline.job_open(meta, null)
        await settle()

        expect(ipc.job_transcript_engines_list).toHaveBeenCalledWith('job-9')
        expect(ipc.job_transcript_load).toHaveBeenCalledWith('job-9', 'stratus.listen')
        expect(ipc.notes_load).toHaveBeenCalledWith('job-9')
        expect(ipc.job_waveform_get).toHaveBeenCalledWith('job-9', 360)
        expect(pipeline.job_id_current.value).toBe('job-9')
        expect(pipeline.source_path.value).toBe('/tmp/nine.wav')
        expect(pipeline.meta_current.value).toEqual(meta)
        expect(pipeline.transcript.value?.text).toBe('hello world')
        expect(pipeline.notes_markdown.value).toBe('# Notes')
        expect(pipeline.waveform_current.value).toEqual(WAVEFORM)
        expect(pipeline.view_current.value).toBe('notes')
    })

    it('shows the details view when a transcript exists but notes do not', async () => {
        job_open_mocks(['stratus.listen'], null)

        await pipeline.job_open(job_meta_build(), null)

        expect(pipeline.notes_markdown.value).toBe('')
        expect(pipeline.view_current.value).toBe('details')
    })

    it('shows the transcribe view and skips the transcript load without engines', async () => {
        job_open_mocks([], null)

        await pipeline.job_open(job_meta_build(), null)

        expect(ipc.job_transcript_load).not.toHaveBeenCalled()
        expect(pipeline.transcript.value).toBeNull()
        expect(pipeline.view_current.value).toBe('transcribe')
    })

    it('prefers an explicit target view over the job state', async () => {
        job_open_mocks(['stratus.listen'], '# Notes')

        await pipeline.job_open(job_meta_build(), 'details')

        expect(pipeline.view_current.value).toBe('details')
    })
})

describe('job_open', () => {
    it('ignores a second open while the first is still loading', async () => {
        const engines = deferred_new<string[]>()

        vi.mocked(ipc.job_transcript_engines_list).mockReturnValue(engines.promise)

        vi.mocked(ipc.notes_load).mockResolvedValue(null)
        vi.mocked(ipc.job_waveform_get).mockResolvedValue(null)

        const first = pipeline.job_open(job_meta_build({ id: 'first' }), null)

        expect(pipeline.job_open_busy.value).toBe(true)

        await pipeline.job_open(job_meta_build({ id: 'second' }), null)

        expect(ipc.job_transcript_engines_list).toHaveBeenCalledTimes(1)

        engines.resolve([])
        await first

        expect(pipeline.job_id_current.value).toBe('first')
        expect(pipeline.job_open_busy.value).toBe(false)
    })

    it('releases the busy flag and rethrows when loading fails', async () => {
        vi.mocked(ipc.job_transcript_engines_list).mockRejectedValue(new Error('disk gone'))

        await expect(pipeline.job_open(job_meta_build(), null)).rejects.toThrow('disk gone')
        expect(pipeline.job_open_busy.value).toBe(false)
        expect(pipeline.job_id_current.value).toBeNull()
    })

    it('leaves the waveform null and warns when the waveform call fails', async () => {
        job_open_mocks(['stratus.listen'], null)
        vi.mocked(ipc.job_waveform_get).mockRejectedValue(new Error('no peaks'))

        await pipeline.job_open(job_meta_build(), null)
        await settle()

        expect(pipeline.waveform_current.value).toBeNull()

        expect(output.warn).toHaveBeenCalledWith(
            '[pipeline] waveform unavailable',
            'job-1',
            expect.any(Error),
        )
    })
})

describe('pipeline_reset', () => {
    it('clears every job field and returns to the jobs view', async () => {
        job_open_mocks(['stratus.listen'], '# Notes')

        await pipeline.job_open(job_meta_build(), null)
        await settle()

        template_select('tpl')
        pipeline.pipeline_reset()

        expect(pipeline.job_id_current.value).toBeNull()
        expect(pipeline.source_path.value).toBeNull()
        expect(pipeline.transcript.value).toBeNull()
        expect(pipeline.notes_markdown.value).toBe('')
        expect(pipeline.template_id_selected.value).toBeNull()
        expect(pipeline.meta_current.value).toBeNull()
        expect(pipeline.waveform_current.value).toBeNull()
        expect(pipeline.view_current.value).toBe('jobs')
    })
})

describe('job_start_new', () => {
    it('resets the pipeline and opens the transcribe view', async () => {
        job_open_mocks(['stratus.listen'], '# Notes')

        await pipeline.job_open(job_meta_build(), null)

        pipeline.job_start_new()

        expect(pipeline.job_id_current.value).toBeNull()
        expect(pipeline.view_current.value).toBe('transcribe')
    })
})

describe('transcript_segments_text_set', () => {
    it('replaces the corrected segments, rebuilds the text and saves', async () => {
        job_open_mocks(['stratus.listen'], null)

        await pipeline.job_open(job_meta_build({ id: 'job-3' }), null)
        vi.mocked(ipc.job_transcript_save).mockResolvedValue(undefined)

        await pipeline.transcript_segments_text_set([{ index: 1, text: '  there  ' }])

        const expected = {
            text: 'hello there',
            segments: [
                { text: 'hello', start_seconds: 0, end_seconds: 10 },
                { text: '  there  ', start_seconds: 10, end_seconds: 20 },
            ],
        }

        expect(pipeline.transcript.value).toEqual(expected)
        expect(ipc.job_transcript_save).toHaveBeenCalledWith('job-3', expected)
    })

    it('drops segments that become blank from the joined text', async () => {
        job_open_mocks(['stratus.listen'], null)

        await pipeline.job_open(job_meta_build(), null)
        vi.mocked(ipc.job_transcript_save).mockResolvedValue(undefined)

        await pipeline.transcript_segments_text_set([{ index: 0, text: '   ' }])

        expect(pipeline.transcript.value?.text).toBe('world')
        expect(pipeline.transcript.value?.segments).toHaveLength(2)
    })

    it('does nothing without a transcript or without corrections', async () => {
        await pipeline.transcript_segments_text_set([{ index: 0, text: 'x' }])

        expect(ipc.job_transcript_save).not.toHaveBeenCalled()

        job_open_mocks(['stratus.listen'], null)

        await pipeline.job_open(job_meta_build(), null)
        await pipeline.transcript_segments_text_set([])

        expect(ipc.job_transcript_save).not.toHaveBeenCalled()
        expect(pipeline.transcript.value?.text).toBe('hello world')
    })

    it('updates the transcript without saving when no job is open', async () => {
        pipeline.transcript.value = transcript_build(['a', 'b'])

        await pipeline.transcript_segments_text_set([{ index: 0, text: 'c' }])

        expect(pipeline.transcript.value.text).toBe('c b')
        expect(ipc.job_transcript_save).not.toHaveBeenCalled()
    })
})

describe('template_id_ensure', () => {
    const { templates } = use_notes_templates()
    const { settings } = use_settings()

    beforeEach(() => {
        templates.value = [
            { id: 'meeting', name: 'Meeting', description: '', instructions: '', edited: false },
            { id: 'standup', name: 'Standup', description: '', instructions: '', edited: false },
        ]

        settings.value = { ...settings.value, notes_template_id_default: 'standup' }
    })

    it('keeps a selected template that exists', () => {
        pipeline.template_id_selected.value = 'meeting'
        pipeline.template_id_ensure()

        expect(pipeline.template_id_selected.value).toBe('meeting')
    })

    it('falls back to the default template when nothing is selected', () => {
        pipeline.template_id_selected.value = null
        pipeline.template_id_ensure()

        expect(pipeline.template_id_selected.value).toBe('standup')
    })

    it('clears a selection that no longer matches a template', () => {
        pipeline.template_id_selected.value = 'deleted'
        pipeline.template_id_ensure()

        expect(pipeline.template_id_selected.value).toBeNull()
    })

    it('clears the selection when the default is unknown too', () => {
        settings.value = { ...settings.value, notes_template_id_default: 'missing' }
        pipeline.template_id_selected.value = null
        pipeline.template_id_ensure()

        expect(pipeline.template_id_selected.value).toBeNull()
    })
})

describe('meta_refresh', () => {
    it('does nothing when no job is open', async () => {
        await pipeline.meta_refresh()

        expect(ipc.job_meta_get).not.toHaveBeenCalled()
    })

    it('replaces the current meta with the fresh copy', async () => {
        job_open_mocks(['stratus.listen'], null)

        await pipeline.job_open(job_meta_build({ id: 'job-5' }), null)

        const fresh = job_meta_build({ id: 'job-5', title: 'Renamed' })

        vi.mocked(ipc.job_meta_get).mockResolvedValue(fresh)

        await pipeline.meta_refresh()

        expect(ipc.job_meta_get).toHaveBeenCalledWith('job-5')
        expect(pipeline.meta_current.value).toEqual(fresh)
    })

    it('keeps the current meta when the backend returns null', async () => {
        job_open_mocks(['stratus.listen'], null)

        const meta = job_meta_build()

        await pipeline.job_open(meta, null)
        vi.mocked(ipc.job_meta_get).mockResolvedValue(null)

        await pipeline.meta_refresh()

        expect(pipeline.meta_current.value).toEqual(meta)
    })

    it('warns and keeps the current meta when the call fails', async () => {
        job_open_mocks(['stratus.listen'], null)

        const meta = job_meta_build()

        await pipeline.job_open(meta, null)
        vi.mocked(ipc.job_meta_get).mockRejectedValue(new Error('offline'))

        await pipeline.meta_refresh()

        expect(pipeline.meta_current.value).toEqual(meta)

        expect(output.warn).toHaveBeenCalledWith(
            '[pipeline] meta refresh failed',
            'job-1',
            expect.any(Error),
        )
    })
})

describe('waveform_refresh', () => {
    it('clears the waveform when no job is open', async () => {
        pipeline.waveform_current.value = WAVEFORM

        await pipeline.waveform_refresh()

        expect(pipeline.waveform_current.value).toBeNull()
        expect(ipc.job_waveform_get).not.toHaveBeenCalled()
    })
})
