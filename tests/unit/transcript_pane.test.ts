import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TranscriptPane from '../../src/components/transcript_pane.vue'
import { use_context_menu } from '../../src/composables/use_context_menu'
import { use_pipeline } from '../../src/composables/use_pipeline'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import {
    ATTACH_TO,
    PROPERTIES,
    TO_FAKE,
    WRITE_TEXT,
    transcript_build,
} from './fixtures'
import type { VueWrapper } from '@vue/test-utils'
import type { Transcript } from '../../src/types'


vi.mock('../../src/lib/ipc')
vi.mock('@tauri-apps/api/core', core_mock)

const LINES = Object.freeze([
    'Alright, everyone is here.',
    'The retry work (v2) is close.',
    '   ',
    'Sam is drafting the banner copy.',
])

const TITLE_CLIP_ATTACHED = 'attaches the clip for a line to the audio element '
    + 'only when that line is played'

const LINE_SECOND = 'The retry work (v2) is close.'
const context_menu = use_context_menu()
const mounted = new Set<VueWrapper>()
const pipeline = use_pipeline()


class HighlightStub {
    ranges: Range[]

    constructor(...ranges: Range[]) {
        assert(Array.isArray(ranges))
        assert(ranges.length >= 0)

        this.ranges = ranges
    }
}

function asset_url_of(path: string): string {
    assert(path.length > 0)
    assert(path.startsWith('/'))

    return `asset://${path}`
}

function core_mock(): Record<string, unknown> {
    return Object.fromEntries<unknown>([
        ['convertFileSrc', asset_url_of],
        ['invoke', vi.fn()],
    ])
}

function menu_ids(): string[] {
    const shown = context_menu.menu.value

    assert(shown !== null)
    assert(shown.items.length > 0)

    return shown.items.map((item) => item.id)
}

function mount_pane(
    transcript: Transcript | null = transcript_build([...LINES]),
    segment_indexes_highlighted?: number[],
): VueWrapper {
    assert(transcript === null || Array.isArray(transcript.segments))
    assert(segment_indexes_highlighted === undefined || segment_indexes_highlighted.length >= 0)
    assert(mounted.size >= 0)
    assert(LINES.length > 0)

    const wrapper = mount(TranscriptPane, {
        [PROPERTIES]: segment_indexes_highlighted !== undefined
            ? { transcript, segment_indexes_highlighted }
            : { transcript },
        [ATTACH_TO]: document.body,
    })

    mounted.add(wrapper)

    return wrapper
}

function row_texts(wrapper: VueWrapper): string[] {
    assert(wrapper.exists())
    assert(mounted.has(wrapper))

    return wrapper.findAll('.transcript-pane-row-text').map((row) => row.text())
}

beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(ipc.job_audio_path_get).mockResolvedValue(null)
    pipeline.pipeline_reset()
    pipeline.job_id_current.value = 'job-1'
    pipeline.transcript.value = transcript_build([...LINES])
})

afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount()

    context_menu.close()
    mounted.clear()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
})

describe('TranscriptPane', () => {
    it('labels rows by line number when no segment carries timing', async () => {
        const untimed = transcript_build([...LINES])

        for (const segment of untimed.segments) {
            segment.start_seconds = 0
            segment.end_seconds = 0
        }

        const wrapper = mount_pane(untimed)

        await flushPromises()

        expect(row_texts(wrapper)).toHaveLength(3)

        expect(wrapper.findAll('.transcript-pane-row-time').map((time) => time.text())).toEqual([
            'Line 1',
            'Line 2',
            'Line 4',
        ])
    })

    it('renders one row per non-blank segment with its start time', async () => {
        const wrapper = mount_pane()

        await flushPromises()

        expect(ipc.job_audio_path_get).toHaveBeenCalledWith('job-1')

        expect(row_texts(wrapper)).toEqual([
            'Alright, everyone is here.',
            'The retry work (v2) is close.',
            'Sam is drafting the banner copy.',
        ])

        expect(wrapper.findAll('.transcript-pane-row-time').map((time) => time.text())).toEqual([
            '0:00',
            '0:10',
            '0:30',
        ])
    })

    it('explains when there is no transcript', async () => {
        const wrapper = mount_pane(null)

        await flushPromises()

        expect(wrapper.text()).toContain('There is no transcript yet.')
        expect(wrapper.find('.transcript-pane-list').exists()).toBe(false)
    })

    it('narrows the rows to those matching the filter, ignoring case', async () => {
        const wrapper = mount_pane()

        await flushPromises()
        await wrapper.get('.transcript-pane-filter').setValue('RETRY')

        expect(row_texts(wrapper)).toEqual(['The retry work (v2) is close.'])
    })
})

describe('TranscriptPane', () => {
    it('treats regex characters in the filter literally', async () => {
        const wrapper = mount_pane()

        await flushPromises()
        await wrapper.get('.transcript-pane-filter').setValue('(v2)')

        expect(row_texts(wrapper)).toEqual(['The retry work (v2) is close.'])

        await wrapper.get('.transcript-pane-filter').setValue('.*')

        expect(row_texts(wrapper)).toEqual([])
        expect(wrapper.text()).toContain('No segments match.')
    })

    it('shows every row again when the filter is cleared or blank', async () => {
        const wrapper = mount_pane()

        await flushPromises()
        await wrapper.get('.transcript-pane-filter').setValue('banner')

        expect(row_texts(wrapper)).toHaveLength(1)

        await wrapper.get('.transcript-pane-filter').setValue('   ')

        expect(row_texts(wrapper)).toHaveLength(3)

        await wrapper.get('.transcript-pane-filter').setValue('')

        expect(row_texts(wrapper)).toHaveLength(3)
    })

    it('marks highlighted segments by their original index', async () => {
        const wrapper = mount_pane(transcript_build([...LINES]), [3])

        await flushPromises()

        const rows = wrapper.findAll('.transcript-pane-row')

        expect(rows.map((row) => row.attributes('data-highlighted'))).toEqual([
            'false',
            'false',
            'true',
        ])
    })
})

describe('TranscriptPane', () => {
    it('copies a row to the clipboard and flashes Copied', async () => {
        vi.useFakeTimers({ [TO_FAKE]: ['setTimeout', 'clearTimeout'] })

        const write_text = vi.fn().mockResolvedValue(undefined)

        vi.stubGlobal('navigator', { clipboard: { [WRITE_TEXT]: write_text } })

        const wrapper = mount_pane()

        await flushPromises()
        await wrapper.findAll('.transcript-pane-row')[1]?.trigger('click')
        await flushPromises()

        expect(write_text).toHaveBeenCalledWith('The retry work (v2) is close.')
        expect(wrapper.findAll('.transcript-pane-row')[1]?.attributes('data-copied')).toBe('true')
        expect(wrapper.findAll('.pill-active')[0]?.text()).toBe('Copied')

        vi.advanceTimersByTime(1500)
        await wrapper.vm.$nextTick()

        expect(wrapper.findAll('.transcript-pane-row')[1]?.attributes('data-copied')).toBe('false')
        expect(wrapper.find('.pill-active').exists()).toBe(false)

        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    it('warns instead of flashing when the clipboard write fails', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

        vi.stubGlobal('navigator', {
            clipboard: { [WRITE_TEXT]: vi.fn().mockRejectedValue(new Error('denied')) },
        })

        const wrapper = mount_pane()

        await flushPromises()
        await wrapper.findAll('.transcript-pane-row')[0]?.trigger('click')
        await flushPromises()

        expect(warn).toHaveBeenCalledWith('[transcript] clipboard write failed', expect.any(Error))
        expect(wrapper.find('.pill-active').exists()).toBe(false)

        vi.unstubAllGlobals()
    })

    it('opens a textarea with the row text when the pencil is clicked', async () => {
        const wrapper = mount_pane()

        await flushPromises()
        await wrapper.findAll('.transcript-pane-edit')[1]?.trigger('click')

        const textarea = wrapper.get('textarea')

        expect(textarea.element.value).toBe('The retry work (v2) is close.')
        expect(wrapper.findAll('.transcript-pane-row')[1]?.attributes('data-editing')).toBe('true')
        expect(document.activeElement).toBe(textarea.element)
    })
})

describe('TranscriptPane', () => {
    it('commits an edit through the pipeline with the original segment index', async () => {
        vi.mocked(ipc.job_transcript_save).mockResolvedValue(undefined)

        const wrapper = mount_pane()

        await flushPromises()
        await wrapper.findAll('.transcript-pane-edit')[2]?.trigger('click')
        await wrapper.get('textarea').setValue('  Sam drafts the copy.  ')
        await wrapper.get('textarea').trigger('keydown', { key: 'Enter' })
        await flushPromises()

        expect(pipeline.transcript.value?.segments[3]?.text).toBe('Sam drafts the copy.')

        expect(pipeline.transcript.value?.text).toBe(
            'Alright, everyone is here. The retry work (v2) is close. Sam drafts the copy.',
        )

        expect(ipc.job_transcript_save).toHaveBeenCalledWith('job-1', pipeline.transcript.value)
        expect(wrapper.find('textarea').exists()).toBe(false)
    })

    it('commits on blur and through the pencil a second time', async () => {
        vi.mocked(ipc.job_transcript_save).mockResolvedValue(undefined)

        const wrapper = mount_pane()

        await flushPromises()
        await wrapper.findAll('.transcript-pane-edit')[0]?.trigger('click')
        await wrapper.get('textarea').setValue('Blurred')
        await wrapper.get('textarea').trigger('blur')
        await flushPromises()

        expect(ipc.job_transcript_save).toHaveBeenCalledTimes(1)
        expect(pipeline.transcript.value?.segments[0]?.text).toBe('Blurred')

        await wrapper.findAll('.transcript-pane-edit')[1]?.trigger('click')
        await wrapper.get('textarea').setValue('Penciled')
        await wrapper.findAll('.transcript-pane-edit')[1]?.trigger('click')
        await flushPromises()

        expect(ipc.job_transcript_save).toHaveBeenCalledTimes(2)
        expect(pipeline.transcript.value?.segments[1]?.text).toBe('Penciled')
    })

    it('does not save an unchanged or blank edit', async () => {
        const wrapper = mount_pane()

        await flushPromises()
        await wrapper.findAll('.transcript-pane-edit')[0]?.trigger('click')
        await wrapper.get('textarea').trigger('keydown', { key: 'Enter' })
        await flushPromises()

        expect(ipc.job_transcript_save).not.toHaveBeenCalled()

        await wrapper.findAll('.transcript-pane-edit')[0]?.trigger('click')
        await wrapper.get('textarea').setValue('   ')
        await wrapper.get('textarea').trigger('keydown', { key: 'Enter' })
        await flushPromises()

        expect(ipc.job_transcript_save).not.toHaveBeenCalled()
        expect(pipeline.transcript.value?.segments[0]?.text).toBe('Alright, everyone is here.')
    })
})

describe('TranscriptPane', () => {
    it('discards the edit on escape', async () => {
        const wrapper = mount_pane()

        await flushPromises()
        await wrapper.findAll('.transcript-pane-edit')[0]?.trigger('click')
        await wrapper.get('textarea').setValue('Changed')
        await wrapper.get('textarea').trigger('keydown', { key: 'Escape' })

        expect(wrapper.find('textarea').exists()).toBe(false)
        expect(row_texts(wrapper)[0]).toBe('Alright, everyone is here.')
        expect(ipc.job_transcript_save).not.toHaveBeenCalled()
    })

    it('closes an open editor when the filter changes', async () => {
        const wrapper = mount_pane()

        await flushPromises()
        await wrapper.findAll('.transcript-pane-edit')[0]?.trigger('click')

        expect(wrapper.find('textarea').exists()).toBe(true)

        await wrapper.get('.transcript-pane-filter').setValue('retry')

        expect(wrapper.find('textarea').exists()).toBe(false)
    })

    it('shows an error dialog when the save fails', async () => {
        vi.mocked(ipc.job_transcript_save).mockRejectedValue('api error: locked')

        const { use_dialog } = await import('../../src/composables/use_dialog')
        const dialog = use_dialog()

        expect(dialog.current.value).toBeNull()

        const wrapper = mount_pane()

        await flushPromises()
        await wrapper.findAll('.transcript-pane-edit')[0]?.trigger('click')
        await wrapper.get('textarea').setValue('Broken')
        await wrapper.get('textarea').trigger('keydown', { key: 'Enter' })
        await flushPromises()

        expect(dialog.current.value?.title).toBe('The server rejected the request')
        expect(dialog.current.value?.message).toBe('locked')

        dialog.close(true)
    })

    it('does not throw when CSS.highlights is undefined', async () => {
        vi.stubGlobal('CSS', {})

        const wrapper = mount_pane()

        await flushPromises()
        await wrapper.get('.transcript-pane-filter').setValue('retry')
        await flushPromises()

        expect(row_texts(wrapper)).toEqual(['The retry work (v2) is close.'])

        vi.unstubAllGlobals()
    })
})

describe('TranscriptPane', () => {
    it('registers highlight ranges for filter matches when the registry exists', async () => {
        const registry = new Map<string, HighlightStub>()

        vi.stubGlobal('CSS', { highlights: registry })
        vi.stubGlobal('Highlight', HighlightStub)

        const wrapper = mount_pane()

        await flushPromises()
        await wrapper.get('.transcript-pane-filter').setValue('is')
        await flushPromises()

        const highlight = registry.get('transcript-filter')

        expect(highlight?.ranges.map((range) => range.toString())).toEqual(['is', 'is', 'is'])

        await wrapper.get('.transcript-pane-filter').setValue('')
        await flushPromises()

        expect(registry.has('transcript-filter')).toBe(false)

        vi.unstubAllGlobals()
    })

    it('renders play buttons only when the job has audio', async () => {
        const without = mount_pane()

        await flushPromises()

        expect(without.findAll('.transcript-pane-play')).toHaveLength(0)

        vi.mocked(ipc.job_audio_path_get).mockResolvedValue('/tmp/take.wav')

        const wrapper = mount_pane()

        await flushPromises()

        expect(wrapper.find('audio').exists()).toBe(false)
        expect(wrapper.findAll('.transcript-pane-play')).toHaveLength(3)
    })
})

describe('TranscriptPane', () => {
    it(TITLE_CLIP_ATTACHED, async () => {
        const fetch_mock = vi.fn().mockResolvedValue(new Response(new Blob(['wav'])))
        const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)

        expect(play).not.toHaveBeenCalled()
        expect(revoke).not.toHaveBeenCalled()

        vi.mocked(ipc.job_audio_path_get).mockResolvedValue('/tmp/take.wav')
        vi.mocked(ipc.job_audio_clip_get).mockResolvedValue('/tmp/clip.wav')
        vi.stubGlobal('fetch', fetch_mock)
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:clip')

        const wrapper = mount_pane()

        await flushPromises()

        expect(wrapper.find('audio').exists()).toBe(false)

        await wrapper.get('.transcript-pane-play').trigger('click')
        await flushPromises()

        expect(ipc.job_audio_clip_get).toHaveBeenCalledWith(
            'job-1',
            expect.any(Number),
            expect.any(Number),
        )

        expect(fetch_mock).toHaveBeenCalledWith('asset:///tmp/clip.wav')
        expect(wrapper.get('audio').attributes('src')).toBe('blob:clip')
        expect(play).toHaveBeenCalledOnce()
        expect(wrapper.get('.transcript-pane-row').attributes('data-playing')).toBe('true')

        await wrapper.get('audio').trigger('error')

        expect(wrapper.find('audio').exists()).toBe(false)
        expect(wrapper.get('.transcript-pane-row').attributes('data-playing')).toBe('false')
        expect(revoke).toHaveBeenCalledWith('blob:clip')

        vi.unstubAllGlobals()
    })
})

describe('TranscriptPane focus', () => {
    it('highlights the focused segments and scrolls the first into view', async () => {
        const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView')

        pipeline.segment_focus.value = {
            job_id: 'job-1',
            segment_index_first: 1,
            segment_index_last: 3,
        }

        const wrapper = mount_pane()

        await flushPromises()
        await flushPromises()

        const rows = wrapper.findAll('.transcript-pane-row')

        expect(rows.map((row) => row.attributes('data-highlighted'))).toEqual([
            'false',
            'true',
            'true',
        ])

        expect(scrolled).toHaveBeenCalledOnce()
        expect(scrolled).toHaveBeenCalledWith({ block: 'center' })
        expect(scrolled.mock.contexts[0]).toBe(rows[1]?.element)
    })

    it('clears the filter so a focus that arrives later can be shown', async () => {
        const wrapper = mount_pane()

        await flushPromises()
        await wrapper.get('.transcript-pane-filter').setValue('retry')

        expect(row_texts(wrapper)).toHaveLength(1)

        const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView')

        pipeline.segment_focus.value = {
            job_id: 'job-1',
            segment_index_first: 3,
            segment_index_last: 3,
        }

        await flushPromises()
        await flushPromises()

        expect(scrolled.mock.contexts[0]).toBe(wrapper.findAll('.transcript-pane-row')[2]?.element)
        expect(wrapper.get<HTMLInputElement>('.transcript-pane-filter').element.value).toBe('')
        expect(row_texts(wrapper)).toHaveLength(3)
    })
})

describe('TranscriptPane focus', () => {
    it('ignores a focus left over from another meeting', async () => {
        const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView')

        pipeline.segment_focus.value = {
            job_id: 'job-2',
            segment_index_first: 0,
            segment_index_last: 3,
        }

        const wrapper = mount_pane()

        await flushPromises()
        await flushPromises()

        const highlighted = wrapper.findAll('.transcript-pane-row[data-highlighted="true"]')

        expect(highlighted).toHaveLength(0)
        expect(scrolled).not.toHaveBeenCalled()
    })
})

describe('TranscriptPane row menu', () => {
    it('offers copying, playback, correction, and Ask for the line clicked', async () => {
        vi.mocked(ipc.job_audio_path_get).mockResolvedValue('/tmp/take.wav')

        const wrapper = mount_pane()

        await flushPromises()
        await wrapper.findAll('.transcript-pane-row')[1]?.trigger('contextmenu')

        expect(menu_ids()).toEqual(['line_copy', 'play', 'line_edit', 'ask'])

        context_menu.close()
        pipeline.job_id_current.value = null

        const jobless = mount_pane()

        await flushPromises()
        await jobless.findAll('.transcript-pane-row')[1]?.trigger('contextmenu')

        expect(menu_ids()).toEqual(['line_copy', 'line_edit'])
    })

    it('copies the line and opens its editor from the menu', async () => {
        const write_text = vi.fn().mockResolvedValue(undefined)

        vi.stubGlobal('navigator', { clipboard: { [WRITE_TEXT]: write_text } })

        const wrapper = mount_pane()

        await flushPromises()
        await wrapper.findAll('.transcript-pane-row')[1]?.trigger('contextmenu')
        await context_menu.choose('line_copy')

        expect(write_text).toHaveBeenCalledWith(LINE_SECOND)

        await wrapper.findAll('.transcript-pane-row')[1]?.trigger('contextmenu')
        await context_menu.choose('line_edit')
        await flushPromises()

        expect(wrapper.get('textarea').element.value).toBe(LINE_SECOND)

        vi.unstubAllGlobals()
    })
})

describe('TranscriptPane row menu', () => {
    it('never starts the clip when Pause is chosen after the clip has ended', async () => {
        const fetch_mock = vi.fn()
            .mockResolvedValueOnce(new Response(new Blob(['wav'])))
            .mockResolvedValueOnce(new Response(new Blob(['wav'])))

        vi.mocked(ipc.job_audio_path_get).mockResolvedValue('/tmp/take.wav')
        vi.mocked(ipc.job_audio_clip_get).mockResolvedValue('/tmp/clip.wav')
        vi.stubGlobal('fetch', fetch_mock)
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:clip')

        const wrapper = mount_pane()
        const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()

        await flushPromises()
        await wrapper.get('.transcript-pane-row').trigger('contextmenu')
        await context_menu.choose('play')
        await flushPromises()

        expect(play).toHaveBeenCalledOnce()
        expect(wrapper.get('.transcript-pane-row').attributes('data-playing')).toBe('true')

        await wrapper.get('.transcript-pane-row').trigger('contextmenu')

        expect(menu_ids()).toContain('pause')

        await wrapper.get('audio').trigger('pause')
        await context_menu.choose('pause')
        await flushPromises()

        expect(ipc.job_audio_clip_get).toHaveBeenCalledOnce()
        expect(play).toHaveBeenCalledOnce()
        expect(wrapper.get('.transcript-pane-row').attributes('data-playing')).toBe('false')

        vi.unstubAllGlobals()
    })

    it('never stops the clip when Play is chosen after the clip has started', async () => {
        const fetch_mock = vi.fn().mockResolvedValue(new Response(new Blob(['wav'])))

        vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
        vi.mocked(ipc.job_audio_path_get).mockResolvedValue('/tmp/take.wav')
        vi.mocked(ipc.job_audio_clip_get).mockResolvedValue('/tmp/clip.wav')
        vi.stubGlobal('fetch', fetch_mock)
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:clip')

        const wrapper = mount_pane()

        await flushPromises()
        await wrapper.get('.transcript-pane-row').trigger('contextmenu')

        expect(menu_ids()).toContain('play')

        await wrapper.get('.transcript-pane-play').trigger('click')
        await flushPromises()
        await context_menu.choose('play')
        await flushPromises()

        expect(ipc.job_audio_clip_get).toHaveBeenCalledOnce()
        expect(wrapper.get('.transcript-pane-row').attributes('data-playing')).toBe('true')

        vi.unstubAllGlobals()
    })
})
