import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { use_pipeline } from '../../src/composables/use_pipeline'
import { use_recorder } from '../../src/composables/use_recorder'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import { drop_host, paths_drop } from './drag_drop'
import { TO_FAKE, deferred_new, job_meta_build, mount_auto_unmount } from './fixtures'
import { microphone_install, stream_new } from './microphone'
import type { UnlistenFn } from '@tauri-apps/api/event'
import type { DragDropListen } from './drag_drop'


const drag_drop_listen: DragDropListen = vi.hoisted(() => vi.fn())
const webview_window_current = vi.hoisted(() => vi.fn())

vi.mock('../../src/lib/ipc')

vi.mock(
    '@tauri-apps/api/webviewWindow',
    () => Object.fromEntries([['getCurrentWebviewWindow', webview_window_current]]),
)

const PATH_DROPPED = '/home/you/recordings/standup.m4a'
const PATH_RECORDING = '/home/you/Music/remi/Recording 2026-11-17 09-30-00.wav'
const pipeline = use_pipeline()
const recorder = use_recorder()


async function host_mount(): Promise<void> {
    assert(!recorder.recording.value)
    assert(pipeline.source_path.value === null)

    mount_auto_unmount(drop_host())

    await flushPromises()
}

beforeEach(() => {
    vi.useFakeTimers({ [TO_FAKE]: ['setInterval', 'clearInterval'] })
    vi.resetAllMocks()

    webview_window_current.mockReturnValue(
        Object.fromEntries([['onDragDropEvent', drag_drop_listen]]),
    )

    drag_drop_listen.mockResolvedValue(vi.fn<UnlistenFn>())
    pipeline.pipeline_reset()
})

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

describe('use_drag_drop', () => {
    it('opens one dropped recording on the transcribe step', async () => {
        await host_mount()

        paths_drop(drag_drop_listen, [PATH_DROPPED])

        expect(pipeline.source_path.value).toBe(PATH_DROPPED)
        expect(pipeline.view_current.value).toBe('transcribe')
    })

    it('starts a new meeting for a recording dropped over an open one', async () => {
        const citation = { number: 2, question: 'Who ships the launch?' }

        await host_mount()

        vi.mocked(ipc.job_transcript_engines_list).mockResolvedValue([])
        vi.mocked(ipc.notes_load).mockResolvedValue('# Weekly sync')
        vi.mocked(ipc.job_waveform_get).mockResolvedValue(null)

        await pipeline.job_open(job_meta_build({ id: 'job-a' }), 'notes', { citation, focus: null })

        paths_drop(drag_drop_listen, [PATH_DROPPED])

        expect(pipeline.job_id_current.value).toBeNull()
        expect(pipeline.source_path.value).toBe(PATH_DROPPED)
        expect(pipeline.meta_current.value).toBeNull()
        expect(pipeline.notes_markdown.value).toBe('')
        expect(pipeline.citation_return.value).toBeNull()
        expect(pipeline.view_current.value).toBe('transcribe')
    })

    it('leaves the recording in place while the microphone starts and records', async () => {
        const stream = deferred_new<unknown>()

        microphone_install().mockReturnValue(stream.promise)
        vi.mocked(ipc.recording_start).mockResolvedValue(PATH_RECORDING)
        vi.mocked(ipc.recording_discard).mockResolvedValue(undefined)

        await host_mount()

        const started = recorder.start()

        paths_drop(drag_drop_listen, [PATH_DROPPED])

        expect(pipeline.source_path.value).toBeNull()

        stream.resolve(stream_new(vi.fn<() => void>()))
        await started
        paths_drop(drag_drop_listen, [PATH_DROPPED])

        expect(recorder.recording.value).toBe(true)
        expect(pipeline.source_path.value).toBeNull()

        await recorder.discard()
    })
})
