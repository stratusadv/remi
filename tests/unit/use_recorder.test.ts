import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { use_dialog } from '../../src/composables/use_dialog'
import { use_recorder } from '../../src/composables/use_recorder'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import { TO_FAKE } from './fixtures'


vi.mock('../../src/lib/ipc')

interface ProcessorPort {
    close: () => void
    onmessage: ((event: MessageEvent) => void) | null
}

const FLUSH_INTERVAL_MS = 1000
const KEY_ADD_MODULE = 'addModule'
const KEY_AUDIO_WORKLET = 'audioWorklet'
const KEY_CREATE_SOURCE = 'createMediaStreamSource'
const KEY_GET_TRACKS = 'getTracks'
const KEY_GET_USER_MEDIA = 'getUserMedia'
const KEY_MEDIA_DEVICES = 'mediaDevices'
const KEY_SAMPLE_RATE = 'sampleRate'
const MESSAGE_FINISH_FAILED = 'audio error: recording finalize: no space left on device'
const PATH_SAVED = '/home/you/Music/scribe/Recording 2026-11-06 09-30-00.wav'
const SAMPLE_RATE = 16000
const SAMPLES_DELIVERED = 1600

const MESSAGE_LIMIT = 'audio error: the recording reached the limit of 6 hours; '
    + 'stop it and start a new one'

const dialog = use_dialog()
const recorder = use_recorder()

class AudioContextStub {
    close = vi.fn().mockResolvedValue(undefined)
    destination = {}

    constructor() {
        assert(KEY_CREATE_SOURCE.length > 0)
        assert(KEY_SAMPLE_RATE.length > 0)

        Object.assign(this, {
            [KEY_AUDIO_WORKLET]: { [KEY_ADD_MODULE]: vi.fn().mockResolvedValue(undefined) },
            [KEY_CREATE_SOURCE]: vi.fn().mockReturnValue({ connect: vi.fn() }),
            [KEY_SAMPLE_RATE]: SAMPLE_RATE,
        })
    }
}

class AudioWorkletNodeStub {
    static port_last: ProcessorPort | null = null

    connect = vi.fn()
    disconnect = vi.fn()
    port: ProcessorPort = { close: vi.fn(), onmessage: null }

    constructor() {
        assert(this.port.onmessage === null)
        assert(typeof this.connect === 'function')

        AudioWorkletNodeStub.port_last = this.port
    }
}

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
    vi.stubGlobal('AudioContext', AudioContextStub)
    vi.stubGlobal('AudioWorkletNode', AudioWorkletNodeStub)

    vi.stubGlobal('navigator', {
        [KEY_MEDIA_DEVICES]: {
            [KEY_GET_USER_MEDIA]: vi.fn().mockResolvedValue({
                [KEY_GET_TRACKS]: vi.fn().mockReturnValue([]),
            }),
        },
    })
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
