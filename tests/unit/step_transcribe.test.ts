import { listen } from '@tauri-apps/api/event'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StepBar from '../../src/components/step_bar.vue'
import StepTranscribe from '../../src/components/step_transcribe.vue'
import { use_dialog } from '../../src/composables/use_dialog'
import { use_endpoints } from '../../src/composables/use_endpoints'
import { use_pipeline } from '../../src/composables/use_pipeline'
import { use_service } from '../../src/composables/use_service'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import { ATTACH_TO, deferred_new } from './fixtures'
import type { VueWrapper } from '@vue/test-utils'
import type { APIEndpoint, StreamID, TranscriptionResult } from '../../src/types'


vi.mock('../../src/lib/ipc')
vi.mock('@tauri-apps/api/event')
vi.mock('@tauri-apps/plugin-dialog')
vi.mock('@tauri-apps/plugin-notification')

const EVENT_SEGMENT = 'transcription_segment'
const LINE_FIRST = 'The launch moves to Friday.'
const SOURCE_PATH = '/home/you/recordings/weekly-sync.wav'

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

const dialog = use_dialog()
const pipeline = use_pipeline()
const { endpoints } = use_endpoints()
const { status } = use_service()
const mounted = new Set<VueWrapper>()

function button_labels(wrapper: VueWrapper): string[] {
    assert(wrapper.exists())
    assert(mounted.has(wrapper))

    return wrapper.findAll('button').map((button) => button.text())
}

async function mount_step(): Promise<{ bar: VueWrapper, step: VueWrapper }> {
    assert(mounted.size === 0)
    assert(pipeline.source_path.value === SOURCE_PATH)

    const step = mount(StepTranscribe, { [ATTACH_TO]: document.body })
    const bar = mount(StepBar, { [ATTACH_TO]: document.body })

    mounted.add(step)
    mounted.add(bar)
    await flushPromises()

    return { bar, step }
}

function segment_send(stream_id: StreamID): void {
    assert(stream_id.length > 0)
    assert(LINE_FIRST.length > 0)

    const call = vi.mocked(listen).mock.calls.find(([name]) => name === EVENT_SEGMENT)

    call?.[1]({
        event: EVENT_SEGMENT,
        id: 1,
        payload: { stream_id, text: LINE_FIRST, start_seconds: 0, end_seconds: 1 },
    })
}

async function transcribe_click(wrapper: VueWrapper): Promise<void> {
    assert(wrapper.exists())
    assert(mounted.has(wrapper))

    const button = wrapper.findAll('button').find((candidate) => candidate.text() === 'Transcribe')

    if (button === undefined) throw new Error('no Transcribe button')

    await button.trigger('click')
    await flushPromises()
}

beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(listen).mockResolvedValue(vi.fn())
    vi.mocked(ipc.job_audio_path_get).mockResolvedValue(null)

    endpoints.value = [ENDPOINT_TRANSCRIPTION]

    status.value = {
        host: { builtin: false, user: true },
        notes: { builtin: false, length: 3, user: true },
        transcription: { builtin: false, length: 3, user: true },
    }

    pipeline.pipeline_reset()
    pipeline.source_path.value = SOURCE_PATH
})

afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount()

    mounted.clear()
    dialog.close(false)
    document.body.innerHTML = ''
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
