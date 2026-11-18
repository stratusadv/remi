import { listen } from '@tauri-apps/api/event'
import { documentDir } from '@tauri-apps/api/path'
import { open as dialog_open } from '@tauri-apps/plugin-dialog'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import StepBar from '../../src/components/step_bar.vue'
import StepTranscribe from '../../src/components/step_transcribe.vue'
import { use_dialog } from '../../src/composables/use_dialog'
import { use_endpoints } from '../../src/composables/use_endpoints'
import { use_pipeline } from '../../src/composables/use_pipeline'
import { use_recorder } from '../../src/composables/use_recorder'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import { drop_host, paths_drop } from './drag_drop'
import {
    ATTACH_TO,
    CTRL_KEY,
    TO_FAKE,
    deferred_new,
    job_meta_build,
    mount_auto_unmount,
    transcript_build,
} from './fixtures'
import { microphone_install, stream_new } from './microphone'
import type { UnlistenFn } from '@tauri-apps/api/event'
import type { DOMWrapper, VueWrapper } from '@vue/test-utils'
import type { DragDropListen } from './drag_drop'
import type { Deferred } from './fixtures'
import type {
    APIEndpoint,
    JobID,
    LineCorrection,
    SegmentChunk,
    StreamID,
    Transcript,
    TranscriptionResult,
} from '../../src/types'


const drag_drop_listen: DragDropListen = vi.hoisted(() => vi.fn())
const webview_window_current = vi.hoisted(() => vi.fn())

vi.mock('../../src/lib/ipc')
vi.mock('@tauri-apps/api/event')
vi.mock('@tauri-apps/api/path')
vi.mock('@tauri-apps/plugin-dialog')

vi.mock(
    '@tauri-apps/api/webviewWindow',
    () => Object.fromEntries([['getCurrentWebviewWindow', webview_window_current]]),
)

const ENGINE = 'remote-listen'
const EVENT_SEGMENT = 'transcription_segment'
const FOLDER_DOCUMENTS = '/home/you/Documents'
const INSTRUCTION = 'it is Jon, not John'
const JOB_A = 'job-a'
const JOB_B = 'job-b'
const LABEL_RECORD = 'Record with the microphone'
const LABEL_STOP = 'Stop recording'
const LINE_ASTRAL = 'ab\u{1D11E}cd'
const LINE_FIRST = 'The launch moves to Friday.'
const NOTES_EDITED = '# Weekly sync\n\nJon ships on Friday.'
const NOTES_STORED = '# Weekly sync\n\nJohn ships on Friday.'
const PATH_DROPPED = '/home/you/recordings/standup.m4a'
const PATH_PICKED = '/home/you/recordings/retro.m4a'
const PATH_RECORDING = '/home/you/Music/remi/Recording 2026-11-17 09-30-00.wav'
const SOURCE_PATH = '/home/you/recordings/weekly-sync.wav'
const SOURCE_PATH_B = '/home/you/recordings/planning.m4a'
const SURROGATE_HIGH_TRAILING = /[\uD800-\uDBFF]$/u
const TRANSCRIPT_A = Object.freeze(transcript_build(['We met on Monday.', 'John will ship it.']))
const TRANSCRIPT_A_STORED = Object.freeze(transcript_build(['We met Tuesday.', 'John ships it.']))
const TRANSCRIPT_B = Object.freeze(transcript_build(['Planning starts now.', 'Budget is next.']))

const ENDPOINT_TRANSCRIPTION = Object.freeze<APIEndpoint>({
    id: 'transcription-ep',
    name: 'Transcription',
    purpose: 'transcription',
    host: 'https://api.example.com',
    api_key: '',
    model: 'listen',
    temperature: null,
    output_tokens_max: null,
    api_path_chat: null,
    api_path_transcribe: null,
    transcribe_verbose: null,
    transcribe_chunk_seconds: null,
    has_api_key: true,
})

const ENDPOINT_NOTES = Object.freeze<APIEndpoint>({
    ...ENDPOINT_TRANSCRIPTION,
    id: 'notes-ep',
    name: 'Notes',
    purpose: 'notes',
})

const dialog = use_dialog()
const pipeline = use_pipeline()
const recorder = use_recorder()
const { endpoints } = use_endpoints()

async function button_click(wrapper: VueWrapper, label: string): Promise<void> {
    assert(wrapper.exists())
    assert(label.length > 0)

    const button = button_find(wrapper, label)

    assert(!button.element.disabled, `the ${label} button is disabled`)

    await button.trigger('click')
    await flushPromises()
}

function button_disabled(wrapper: VueWrapper, label: string): boolean {
    assert(wrapper.exists())
    assert(label.length > 0)

    return button_find(wrapper, label).element.disabled
}

function button_find(wrapper: VueWrapper, label: string): DOMWrapper<HTMLButtonElement> {
    assert(wrapper.exists())
    assert(label.length > 0)

    const button = wrapper.findAll('button').find((candidate) => candidate.text() === label)

    assert(button !== undefined, `there is no ${label} button`)
    assert(button.element.isConnected)

    return button
}

function button_labels(wrapper: VueWrapper): string[] {
    assert(wrapper.exists())

    const labels = wrapper.findAll('button').map((button) => button.text())

    assert(labels.length > 0)

    return labels
}

function control_press(key: string): void {
    assert(key.length > 0)
    assert(document.body.childElementCount > 0)

    const init = { key, [CTRL_KEY]: true, bubbles: true, cancelable: true }

    window.dispatchEvent(new KeyboardEvent('keydown', init))
}

async function correction_ask(wrapper: VueWrapper): Promise<void> {
    assert(wrapper.exists())
    assert(pipeline.transcript.value !== null)

    await wrapper.find('.correction-bar input').setValue(INSTRUCTION)

    assert(!button_disabled(wrapper, 'Apply'))

    await wrapper.find('form.correction-bar').trigger('submit')
    await flushPromises()
}

async function job_open_in_place(id: JobID, transcript: Transcript): Promise<void> {
    assert(id.length > 0)
    assert(transcript.segments.length > 0)

    const source_path = id === JOB_A ? SOURCE_PATH : SOURCE_PATH_B

    vi.mocked(ipc.job_transcript_engines_list).mockResolvedValue([ENGINE])
    vi.mocked(ipc.job_transcript_load).mockResolvedValueOnce(transcript)
    vi.mocked(ipc.notes_load).mockResolvedValue(null)
    vi.mocked(ipc.job_waveform_get).mockResolvedValue(null)

    await pipeline.job_open(job_meta_build({ id, source_path }), 'transcribe')
    await flushPromises()
}

function microphone_prepare(): Deferred<unknown> {
    assert(!recorder.recording.value)
    assert(!recorder.starting.value)

    const stream = deferred_new<unknown>()

    microphone_install().mockReturnValue(stream.promise)
    vi.mocked(ipc.recording_start).mockResolvedValue(PATH_RECORDING)
    vi.mocked(ipc.recording_finish).mockResolvedValue(PATH_RECORDING)
    vi.mocked(ipc.recording_discard).mockResolvedValue(undefined)

    return stream
}

async function mount_step(): Promise<{ bar: VueWrapper, step: VueWrapper }> {
    assert(document.body.childElementCount === 0)
    assert(pipeline.source_path.value === SOURCE_PATH)

    const step = mount_auto_unmount(StepTranscribe, { [ATTACH_TO]: document.body })
    const bar = mount_auto_unmount(StepBar, { [ATTACH_TO]: document.body })

    await flushPromises()

    return { bar, step }
}

async function record_through_prompt(step: VueWrapper): Promise<void> {
    assert(step.exists())
    assert(!recorder.recording.value)

    vi.mocked(ipc.transcription_remote).mockReturnValue(deferred_new<TranscriptionResult>().promise)
    vi.mocked(documentDir).mockResolvedValue(FOLDER_DOCUMENTS)
    vi.mocked(dialog_open).mockResolvedValue(PATH_PICKED)

    await button_click(step, LABEL_RECORD)

    paths_drop(drag_drop_listen, [PATH_DROPPED])
    control_press('o')
    await flushPromises()

    control_press('Enter')
    await flushPromises()
}

async function recorder_step_mount(): Promise<VueWrapper> {
    assert(document.body.childElementCount === 0)
    assert(!recorder.recording.value)

    pipeline.job_start_new()

    const step = mount_auto_unmount(StepTranscribe, { [ATTACH_TO]: document.body })

    mount_auto_unmount(drop_host())

    await flushPromises()

    return step
}

function segment_chunk_send(chunk: SegmentChunk): void {
    assert(chunk.stream_id.length > 0)
    assert(chunk.text.length > 0)

    const call = vi.mocked(listen).mock.calls.find(([name]) => name === EVENT_SEGMENT)

    call?.[1]({ event: EVENT_SEGMENT, id: 1, payload: chunk })
}

function segment_send(stream_id: StreamID): void {
    assert(stream_id.length > 0)
    assert(LINE_FIRST.length > 0)

    segment_chunk_send({ stream_id, text: LINE_FIRST, start_seconds: 0, end_seconds: 1 })
}

async function streaming_text_next(wrapper: VueWrapper): Promise<string> {
    assert(wrapper.exists())
    assert(vi.getTimerCount() > 0)

    vi.advanceTimersToNextTimer()

    await nextTick()

    const shown = wrapper.find('.streaming-prose > span').element.textContent

    assert(typeof shown === 'string')

    return shown
}

async function transcribe_click(wrapper: VueWrapper): Promise<void> {
    assert(wrapper.exists())

    const button = wrapper.findAll('button').find((candidate) => candidate.text() === 'Transcribe')

    if (button === undefined) throw new Error('no Transcribe button')

    assert(button.attributes('disabled') === undefined)

    await button.trigger('click')
    await flushPromises()
}

beforeEach(() => {
    onTestFinished(() => {
        dialog.close(false)
        document.body.innerHTML = ''
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    vi.useFakeTimers({ [TO_FAKE]: ['setInterval', 'clearInterval'] })
    vi.resetAllMocks()
    vi.mocked(listen).mockResolvedValue(vi.fn<UnlistenFn>())
    vi.mocked(ipc.job_audio_path_get).mockResolvedValue(null)
    vi.mocked(ipc.notes_load).mockResolvedValue(null)
    drag_drop_listen.mockResolvedValue(vi.fn<UnlistenFn>())

    webview_window_current.mockReturnValue(
        Object.fromEntries([['onDragDropEvent', drag_drop_listen]]),
    )

    endpoints.value = [ENDPOINT_TRANSCRIPTION]

    pipeline.pipeline_reset()
    pipeline.source_path.value = SOURCE_PATH
})

describe('StepTranscribe after a failed upload', () => {
    it('offers Transcribe again and leaves no lines to build notes on', async () => {
        vi.mocked(ipc.transcription_remote).mockImplementation(async (...call) => {
            segment_send(call[2] ?? '')

            return Promise.reject(new Error('the part at 0:48 to 0:56 did not come back'))
        })

        const { bar, step } = await mount_step()

        await transcribe_click(step)

        expect(dialog.current.value).not.toBeNull()

        dialog.close(true)
        await flushPromises()

        expect(button_labels(step)).toContain('Transcribe')
        expect(button_labels(step)).not.toContain('Next')
        expect(pipeline.transcript.value).toBeNull()
        expect(bar.findAll('.step-bar-item')[2]?.attributes('disabled')).toBeDefined()
    })

    it('keeps the later steps locked while the lines are still arriving', async () => {
        const started = deferred_new<StreamID>()
        const unfinished = deferred_new<TranscriptionResult>()

        vi.mocked(ipc.transcription_remote).mockImplementation(async (...call) => {
            started.resolve(call[2] ?? '')

            return unfinished.promise
        })

        const { bar, step } = await mount_step()

        await transcribe_click(step)

        segment_send(await started.promise)
        await flushPromises()

        expect(bar.findAll('.step-bar-item')[1]?.attributes('disabled')).toBeDefined()
        expect(step.text()).toContain('(1 segment received)')
    })
})

describe('StepTranscribe while the lines arrive', () => {
    it('never shows half of a character that takes two code units', async () => {
        const started = deferred_new<StreamID>()

        vi.useFakeTimers({
            [TO_FAKE]: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
        })

        vi.mocked(ipc.transcription_remote).mockImplementation(async (...call) => {
            started.resolve(call[2] ?? '')

            return deferred_new<TranscriptionResult>().promise
        })

        const { step } = await mount_step()

        await transcribe_click(step)

        const stream_id = await started.promise

        segment_chunk_send({ stream_id, text: LINE_ASTRAL, start_seconds: 0, end_seconds: 1 })

        const shown = [await streaming_text_next(step), await streaming_text_next(step)]

        expect(shown.filter((text) => SURROGATE_HIGH_TRAILING.test(text))).toEqual([])
        expect(shown.at(-1)).toBe(LINE_ASTRAL)
    })
})

describe('StepTranscribe while the microphone starts', () => {
    it('stops the recording after a drop, Ctrl+O and Ctrl+Enter during the prompt', async () => {
        const stream = microphone_prepare()
        const track_stop = vi.fn<() => void>()
        const step = await recorder_step_mount()

        await record_through_prompt(step)
        stream.resolve(stream_new(track_stop))
        await flushPromises()
        await button_click(step, LABEL_STOP)

        expect(track_stop).toHaveBeenCalledTimes(1)
        expect(ipc.recording_finish).toHaveBeenCalledTimes(1)
        expect(ipc.transcription_remote).not.toHaveBeenCalled()
        expect(dialog_open).not.toHaveBeenCalled()
        expect(pipeline.source_path.value).toBe(PATH_RECORDING)
        expect(recorder.recording.value).toBe(false)
    })

    it('discards the recording after the same steps', async () => {
        const stream = microphone_prepare()
        const track_stop = vi.fn<() => void>()
        const step = await recorder_step_mount()

        await record_through_prompt(step)
        stream.resolve(stream_new(track_stop))
        await flushPromises()
        await button_click(step, 'Discard')

        expect(track_stop).toHaveBeenCalledTimes(1)
        expect(ipc.recording_discard).toHaveBeenCalledTimes(1)
        expect(ipc.transcription_remote).not.toHaveBeenCalled()
        expect(pipeline.source_path.value).toBeNull()
        expect(recorder.recording.value).toBe(false)
    })

    it('shows the start with nothing enabled that could replace or end the capture', async () => {
        const step = await recorder_step_mount()
        const stream = microphone_prepare()

        await button_click(step, LABEL_RECORD)

        const shown = {
            cancel_disabled: button_disabled(step, 'Cancel'),
            discard_disabled: button_disabled(step, 'Discard'),
            record_offered: button_labels(step).includes(LABEL_RECORD),
            starting_shown: step.text().includes('Starting the microphone'),
            stop_disabled: button_disabled(step, LABEL_STOP),
            transcribe_offered: button_labels(step).includes('Transcribe'),
        }

        stream.resolve(stream_new(vi.fn<() => void>()))
        await flushPromises()
        await button_click(step, 'Discard')

        expect(shown).toEqual({
            cancel_disabled: true,
            discard_disabled: true,
            record_offered: false,
            starting_shown: true,
            stop_disabled: true,
            transcribe_offered: false,
        })

        expect(ipc.recording_discard).toHaveBeenCalledTimes(1)
        expect(recorder.recording.value).toBe(false)
    })
})

describe('StepTranscribe reports', () => {
    it('reports a picked file as an upload, and nothing for a closed picker', async () => {
        vi.mocked(documentDir).mockResolvedValue(FOLDER_DOCUMENTS)
        vi.mocked(dialog_open).mockResolvedValueOnce(null).mockResolvedValueOnce(PATH_PICKED)

        const { step } = await mount_step()

        await button_click(step, 'Replace')

        expect(ipc.account_action_report).not.toHaveBeenCalled()

        await button_click(step, 'Replace')

        expect(pipeline.source_path.value).toBe(PATH_PICKED)
        expect(vi.mocked(ipc.account_action_report).mock.calls).toEqual([['upload-recording']])
    })

    it('reports a recording, and no upload for its file or a refused drop or pick', async () => {
        const stream = microphone_prepare()
        const step = await recorder_step_mount()

        await record_through_prompt(step)
        stream.resolve(stream_new(vi.fn<() => void>()))
        await flushPromises()
        await button_click(step, LABEL_STOP)

        expect(pipeline.source_path.value).toBe(PATH_RECORDING)
        expect(vi.mocked(ipc.account_action_report).mock.calls).toEqual([['in-app-recording']])
    })
})

describe('StepTranscribe while a recording stops', () => {
    it('disables Stop and Discard until the file is finished', async () => {
        const finished = deferred_new<string>()
        const stream = microphone_prepare()

        stream.resolve(stream_new(vi.fn<() => void>()))
        vi.mocked(ipc.recording_finish).mockReturnValue(finished.promise)

        const step = await recorder_step_mount()

        await button_click(step, LABEL_RECORD)
        await button_click(step, LABEL_STOP)

        expect(button_disabled(step, LABEL_STOP)).toBe(true)
        expect(button_disabled(step, 'Discard')).toBe(true)

        finished.resolve(PATH_RECORDING)
        await flushPromises()

        expect(ipc.recording_finish).toHaveBeenCalledTimes(1)
        expect(pipeline.source_path.value).toBe(PATH_RECORDING)
        expect(recorder.recording.value).toBe(false)
    })

    it('keeps a late stop out of the meeting opened meanwhile', async () => {
        const finished = deferred_new<string>()
        const stream = microphone_prepare()

        stream.resolve(stream_new(vi.fn<() => void>()))
        vi.mocked(ipc.recording_finish).mockReturnValue(finished.promise)

        const step = await recorder_step_mount()

        await button_click(step, LABEL_RECORD)
        await button_click(step, LABEL_STOP)
        await job_open_in_place(JOB_B, TRANSCRIPT_B)

        finished.resolve(PATH_RECORDING)
        await flushPromises()

        expect(pipeline.job_id_current.value).toBe(JOB_B)
        expect(pipeline.source_path.value).toBe(SOURCE_PATH_B)
        expect(pipeline.transcript.value).toEqual(TRANSCRIPT_B)
        expect(recorder.recording.value).toBe(false)
    })
})

describe('StepTranscribe when a transcription finishes', () => {
    it('writes the transcript into the recording it was asked for', async () => {
        const unfinished = deferred_new<TranscriptionResult>()
        const meta = job_meta_build({ id: JOB_A, source_path: SOURCE_PATH })

        vi.mocked(ipc.transcription_remote).mockReturnValue(unfinished.promise)
        vi.mocked(ipc.job_meta_get).mockResolvedValue(meta)

        const { step } = await mount_step()

        await transcribe_click(step)

        unfinished.resolve({ job_id: JOB_A, transcript: TRANSCRIPT_A, cached: false })
        await flushPromises()

        expect(pipeline.job_id_current.value).toBe(JOB_A)
        expect(pipeline.transcript.value).toEqual(TRANSCRIPT_A)
        expect(pipeline.meta_current.value).toEqual(meta)
        expect(button_labels(step)).toContain('Next')
    })

    it('keeps a late transcript out of the meeting opened meanwhile', async () => {
        const unfinished = deferred_new<TranscriptionResult>()

        vi.mocked(ipc.transcription_remote).mockReturnValue(unfinished.promise)

        const { step } = await mount_step()

        await transcribe_click(step)
        await job_open_in_place(JOB_B, TRANSCRIPT_B)

        unfinished.resolve({ job_id: JOB_A, transcript: TRANSCRIPT_A, cached: false })
        await flushPromises()

        expect(pipeline.job_id_current.value).toBe(JOB_B)
        expect(pipeline.source_path.value).toBe(SOURCE_PATH_B)
        expect(pipeline.transcript.value).toEqual(TRANSCRIPT_B)
        expect(ipc.job_meta_get).not.toHaveBeenCalled()
    })

    it('keeps a late transcript off a recording dropped meanwhile', async () => {
        const unfinished = deferred_new<TranscriptionResult>()

        vi.mocked(ipc.transcription_remote).mockReturnValue(unfinished.promise)

        const { step } = await mount_step()

        mount_auto_unmount(drop_host())
        await transcribe_click(step)
        paths_drop(drag_drop_listen, [PATH_DROPPED])

        unfinished.resolve({ job_id: JOB_A, transcript: TRANSCRIPT_A, cached: false })
        await flushPromises()

        expect(pipeline.source_path.value).toBe(PATH_DROPPED)
        expect(pipeline.transcript.value).toBeNull()
        expect(pipeline.job_id_current.value).toBeNull()
        expect(button_labels(step)).toContain('Transcribe')
    })
})

describe('StepTranscribe when a transcription returns a stored meeting', () => {
    it('shows the notes stored for a recording transcribed before', async () => {
        const unfinished = deferred_new<TranscriptionResult>()

        vi.mocked(ipc.transcription_remote).mockReturnValue(unfinished.promise)
        vi.mocked(ipc.job_meta_get).mockResolvedValue(job_meta_build({ id: JOB_A }))
        vi.mocked(ipc.notes_load).mockResolvedValue(NOTES_STORED)

        const { step } = await mount_step()

        await transcribe_click(step)

        unfinished.resolve({ job_id: JOB_A, transcript: TRANSCRIPT_A, cached: true })
        await flushPromises()

        expect(ipc.notes_load).toHaveBeenCalledWith(JOB_A)
        expect(pipeline.notes_markdown.value).toBe(NOTES_STORED)
    })

    it('keeps the notes being edited when the open meeting is transcribed again', async () => {
        const unfinished = deferred_new<TranscriptionResult>()

        vi.mocked(ipc.transcription_remote).mockReturnValue(unfinished.promise)
        vi.mocked(ipc.job_meta_get).mockResolvedValue(job_meta_build({ id: JOB_A }))

        await job_open_in_place(JOB_A, TRANSCRIPT_A)

        pipeline.notes_markdown.value = NOTES_EDITED

        await mount_step()

        control_press('Enter')
        await flushPromises()

        unfinished.resolve({ job_id: JOB_A, transcript: TRANSCRIPT_A, cached: true })
        await flushPromises()

        expect(ipc.transcription_remote).toHaveBeenCalledTimes(1)
        expect(ipc.notes_load).toHaveBeenCalledTimes(1)
        expect(pipeline.notes_markdown.value).toBe(NOTES_EDITED)
    })
})

describe('StepTranscribe when the recording is replaced', () => {
    it('starts a new meeting for a file picked over an open one', async () => {
        vi.mocked(documentDir).mockResolvedValue(FOLDER_DOCUMENTS)
        vi.mocked(dialog_open).mockResolvedValue(PATH_PICKED)

        await job_open_in_place(JOB_A, TRANSCRIPT_A)

        pipeline.notes_markdown.value = NOTES_EDITED

        await mount_step()

        control_press('o')
        await flushPromises()

        expect(pipeline.job_id_current.value).toBeNull()
        expect(pipeline.source_path.value).toBe(PATH_PICKED)
        expect(pipeline.transcript.value).toBeNull()
        expect(pipeline.meta_current.value).toBeNull()
        expect(pipeline.notes_markdown.value).toBe('')
    })
})

describe('StepTranscribe when a correction finishes', () => {
    it('applies the correction to the meeting still open and offers Undo', async () => {
        const replied = deferred_new<LineCorrection[]>()

        endpoints.value = [ENDPOINT_TRANSCRIPTION, ENDPOINT_NOTES]
        vi.mocked(ipc.transcript_correct_streaming).mockReturnValue(replied.promise)
        vi.mocked(ipc.job_transcript_save).mockResolvedValue(undefined)

        await job_open_in_place(JOB_A, TRANSCRIPT_A)

        const { step } = await mount_step()

        await correction_ask(step)

        replied.resolve([{ index: 1, text: 'Jon will ship it.' }])
        await flushPromises()

        const corrected = transcript_build(['We met on Monday.', 'Jon will ship it.'])

        expect(ipc.job_transcript_save).toHaveBeenCalledWith(JOB_A, corrected)
        expect(pipeline.transcript.value).toEqual(corrected)
        expect(button_labels(step)).toContain('Undo')
    })

    it('saves a late correction to the stored transcript of its own meeting', async () => {
        const replied = deferred_new<LineCorrection[]>()

        endpoints.value = [ENDPOINT_TRANSCRIPTION, ENDPOINT_NOTES]
        vi.mocked(ipc.transcript_correct_streaming).mockReturnValue(replied.promise)
        vi.mocked(ipc.job_transcript_save).mockResolvedValue(undefined)

        await job_open_in_place(JOB_A, TRANSCRIPT_A)

        const { step } = await mount_step()

        await correction_ask(step)
        await job_open_in_place(JOB_B, TRANSCRIPT_B)
        vi.mocked(ipc.job_transcript_load).mockResolvedValueOnce(TRANSCRIPT_A_STORED)

        replied.resolve([{ index: 1, text: 'Jon will ship it.' }])
        await flushPromises()

        const corrected = transcript_build(['We met Tuesday.', 'Jon will ship it.'])

        expect(ipc.job_transcript_save).toHaveBeenCalledTimes(1)
        expect(ipc.job_transcript_save).toHaveBeenCalledWith(JOB_A, corrected)
        expect(ipc.job_transcript_load).toHaveBeenLastCalledWith(JOB_A, ENGINE)
        expect(pipeline.transcript.value).toEqual(TRANSCRIPT_B)
        expect(button_labels(step)).not.toContain('Undo')
    })
})

describe('StepTranscribe while a correction is on its way', () => {
    it('starts no transcription', async () => {
        const replied = deferred_new<LineCorrection[]>()

        endpoints.value = [ENDPOINT_TRANSCRIPTION, ENDPOINT_NOTES]
        vi.mocked(ipc.transcript_correct_streaming).mockReturnValue(replied.promise)

        await job_open_in_place(JOB_A, TRANSCRIPT_A)

        const { step } = await mount_step()

        await correction_ask(step)
        control_press('Enter')
        await flushPromises()

        expect(ipc.transcription_remote).not.toHaveBeenCalled()

        replied.resolve([])
        await flushPromises()
    })
})
