import { vi } from 'vitest'
import { assert } from '../../src/lib/assert'
import type { Mock } from 'vitest'


interface ProcessorPort {
    close: () => void
    onmessage: ((event: MessageEvent) => void) | null
}

const KEY_ADD_MODULE = 'addModule'
const KEY_AUDIO_WORKLET = 'audioWorklet'
const KEY_CREATE_SOURCE = 'createMediaStreamSource'
const KEY_GET_TRACKS = 'getTracks'
const KEY_GET_USER_MEDIA = 'getUserMedia'
const KEY_MEDIA_DEVICES = 'mediaDevices'
const KEY_SAMPLE_RATE = 'sampleRate'
const SAMPLE_RATE = 16000


export class AudioContextStub {
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

export class AudioWorkletNodeStub {
    static port_last: ProcessorPort | null = null

    connect = vi.fn()
    disconnect = vi.fn()
    port: ProcessorPort = { close: vi.fn<ProcessorPort['close']>(), onmessage: null }

    constructor() {
        assert(this.port.onmessage === null)
        assert(typeof this.connect === 'function')

        AudioWorkletNodeStub.port_last = this.port
    }
}

export function microphone_install(): Mock {
    assert(KEY_GET_USER_MEDIA.length > 0)
    assert(KEY_MEDIA_DEVICES.length > 0)

    const user_media_get = vi.fn()

    vi.stubGlobal('AudioContext', AudioContextStub)
    vi.stubGlobal('AudioWorkletNode', AudioWorkletNodeStub)
    vi.stubGlobal('navigator', { [KEY_MEDIA_DEVICES]: { [KEY_GET_USER_MEDIA]: user_media_get } })

    return user_media_get
}

export function stream_new(track_stop: () => void): unknown {
    assert(typeof track_stop === 'function')
    assert(KEY_GET_TRACKS.length > 0)

    return { [KEY_GET_TRACKS]: vi.fn().mockReturnValue([{ stop: track_stop }]) }
}
