import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { use_dialog } from '../../src/composables/use_dialog'
import { use_recorder } from '../../src/composables/use_recorder'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import { TO_FAKE, deferred_new } from './fixtures'
import { AudioWorkletNodeStub, microphone_install, stream_new } from './microphone'


vi.mock('../../src/lib/ipc')

const FLUSH_INTERVAL_MS = 1000
const MESSAGE_FINISH_FAILED = 'audio error: recording finalize: no space left on device'
const PATH_SAVED = '/home/you/Music/remi/Recording 2026-11-06 09-30-00.wav'
const SAMPLES_DELIVERED = 1600

const MESSAGE_LIMIT = 'audio error: the recording reached the limit of 6 hours; '
    + 'stop it and start a new one'

const dialog = use_dialog()
const recorder = use_recorder()

async function capture_with_failed_write(): Promise<void> {
    assert(MESSAGE_LIMIT.length > 0)
    assert(!recorder.recording.value)

    vi.mocked(ipc.recording_append).mockRejectedValue(MESSAGE_LIMIT)

    await recorder.start()

    AudioWorkletNodeStub.port_last?.onmessage?.(
        new MessageEvent('message', { data: new Float32Array(SAMPLES_DELIVERED) }),
    )

    vi.advanceTimersByTime(FLUSH_INTERVAL_MS)

    await flushPromises()
}

beforeEach(() => {
    vi.useFakeTimers({ [TO_FAKE]: ['setInterval', 'clearInterval'] })
    vi.resetAllMocks()
    microphone_install().mockResolvedValue(stream_new(vi.fn<() => void>()))
})

afterEach(() => {
    dialog.close(false)
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

describe('use_recorder', () => {
    it('keeps what was captured and says why when a write fails during a recording', async () => {
        vi.mocked(ipc.recording_finish).mockResolvedValue(PATH_SAVED)

        await capture_with_failed_write()

        const stopped = recorder.stop()

        await vi.waitFor(() => {
            expect(dialog.current.value?.message).toContain('limit of 6 hours')
        })

        expect(dialog.current.value?.message).toContain('is saved')
        expect(ipc.recording_discard).not.toHaveBeenCalled()

        dialog.close(true)

        await expect(stopped).resolves.toBe(PATH_SAVED)
        expect(recorder.recording.value).toBe(false)
    })

    it('discards the file only when finishing it fails', async () => {
        vi.mocked(ipc.recording_finish).mockRejectedValue(MESSAGE_FINISH_FAILED)
        vi.mocked(ipc.recording_discard).mockResolvedValue(undefined)

        await capture_with_failed_write()

        await expect(recorder.stop()).rejects.toThrow('limit of 6 hours')
        expect(ipc.recording_discard).toHaveBeenCalledTimes(1)
        expect(recorder.recording.value).toBe(false)
    })
})

describe('use_recorder while the microphone starts', () => {
    it('opens one capture when Record is pressed again during the microphone prompt', async () => {
        const stream = deferred_new<unknown>()
        const track_stop = vi.fn<() => void>()
        const user_media_get = microphone_install().mockReturnValue(stream.promise)

        vi.mocked(ipc.recording_start).mockResolvedValue(PATH_SAVED)
        vi.mocked(ipc.recording_discard).mockResolvedValue(undefined)

        const first = recorder.start()
        const second = recorder.start()

        stream.resolve(stream_new(track_stop))
        await Promise.all([first, second])

        expect(user_media_get).toHaveBeenCalledTimes(1)
        expect(ipc.recording_start).toHaveBeenCalledTimes(1)
        expect(recorder.recording.value).toBe(true)

        await recorder.discard()

        expect(track_stop).toHaveBeenCalledTimes(1)
        expect(ipc.recording_discard).toHaveBeenCalledTimes(1)
        expect(recorder.recording.value).toBe(false)
    })

    it('reports the start until the microphone answers, and clears it on a refusal', async () => {
        const user_media_get = microphone_install()

        user_media_get.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'))
        vi.mocked(ipc.recording_discard).mockResolvedValue(undefined)

        const refused = recorder.start()

        expect(recorder.starting.value).toBe(true)
        expect(recorder.recording.value).toBe(false)
        await expect(refused).rejects.toThrow('not allowed to use the microphone')
        expect(recorder.starting.value).toBe(false)

        user_media_get.mockResolvedValue(stream_new(vi.fn<() => void>()))
        vi.mocked(ipc.recording_start).mockResolvedValue(PATH_SAVED)

        await recorder.start()

        expect(recorder.starting.value).toBe(false)
        expect(recorder.recording.value).toBe(true)

        await recorder.discard()
    })
})

describe('use_recorder after a refused start', () => {
    it('starts nothing new until the refused start has discarded its file', async () => {
        const discarded = deferred_new<undefined>()
        const user_media_get = microphone_install()

        user_media_get.mockResolvedValue(stream_new(vi.fn<() => void>()))
        user_media_get.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'))
        vi.mocked(ipc.recording_start).mockResolvedValue(PATH_SAVED)
        vi.mocked(ipc.recording_discard).mockReturnValueOnce(discarded.promise)

        const refused = recorder.start()

        await flushPromises()
        await recorder.start()
        discarded.resolve(undefined)

        await expect(refused).rejects.toThrow('not allowed to use the microphone')
        expect(user_media_get).toHaveBeenCalledTimes(1)
        expect(ipc.recording_start).not.toHaveBeenCalled()
        expect(recorder.starting.value).toBe(false)
        expect(recorder.recording.value).toBe(false)
    })
})

describe('use_recorder while a recording stops', () => {
    it('finishes once when Stop and Discard follow a Stop still in progress', async () => {
        const finished = deferred_new<string>()

        vi.mocked(ipc.recording_start).mockResolvedValue(PATH_SAVED)
        vi.mocked(ipc.recording_finish).mockReturnValue(finished.promise)
        vi.mocked(ipc.recording_discard).mockResolvedValue(undefined)

        await recorder.start()

        const first = recorder.stop()
        const second = expect(recorder.stop()).rejects.toThrow('No recording is in progress')
        const discarded = recorder.discard()

        finished.resolve(PATH_SAVED)

        await expect(first).resolves.toBe(PATH_SAVED)
        await second
        await discarded

        expect(ipc.recording_finish).toHaveBeenCalledTimes(1)
        expect(ipc.recording_discard).not.toHaveBeenCalled()
        expect(recorder.recording.value).toBe(false)
    })
})
