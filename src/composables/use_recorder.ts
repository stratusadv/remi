import { ref } from 'vue'
import { assert } from '../lib/assert'
import { ipc } from '../lib/ipc'
import { log_warn } from '../lib/log'
import { use_dialog } from './use_dialog'


interface Capture {
    stream: MediaStream | null
    context: AudioContext | null
    processor: AudioWorkletNode | null
    chunks_pending: Int16Array[]
    samples_pending: number
    samples_total: number
    append_chain: Promise<void>
    append_error: unknown
    flushes_in_flight: number
    flush_timer_id: ReturnType<typeof setInterval> | null
}

const CHUNK_BYTES_MAX = 1 << 20
const FLUSH_BACKLOG_MAX = 30
const FLUSH_INTERVAL_MS = 1000
const KEY_SAMPLE_RATE = 'sampleRate'
const MESSAGE_BACKLOG = 'The recording could not be saved as fast as it was captured.'
const MESSAGE_ENDED_EARLY = 'The recording ended early, and what was captured up to then is saved.'
const MESSAGE_NOT_ALLOWED = 'scribe was not allowed to use the microphone. Allow it and try again.'
const MESSAGE_NOT_FOUND = 'No microphone was found. Plug one in and try again.'
const MESSAGE_NOT_READABLE = 'The microphone is in use by another program.'
const MESSAGE_NOT_RECORDING = 'No recording is in progress.'
const MESSAGE_UNAVAILABLE = 'Microphone recording is not available on this computer.'
const PCM16_SAMPLE_BYTES = 2
const PCM16_SAMPLE_MAX = 0x7fff
const SAMPLE_RATE_PREFERRED = 16000
const TITLE_ENDED_EARLY = 'Recording ended early'
const WORKLET_NAME = 'scribe-recorder'

const WORKLET_SOURCE = `
class ScribeRecorderProcessor extends AudioWorkletProcessor {
    process(inputs) {
        const channel = inputs[0] && inputs[0][0]
        if (channel) this.port.postMessage(channel.slice())
        return true
    }
}
registerProcessor('${WORKLET_NAME}', ScribeRecorderProcessor)
`

const recording = ref(false)
const elapsed_seconds = ref(0)
const capture = capture_new()


export function use_recorder(): typeof api {
    assert(Object.isFrozen(api))

    capture_assert()

    return api
}

function audio_process(event: MessageEvent): void {
    assert(event instanceof MessageEvent)

    if (!(event.data instanceof Float32Array)) return

    const converted = samples_to_pcm16(event.data)

    assert(converted.length === event.data.length)

    capture.chunks_pending.push(converted)
    capture.samples_pending += converted.length
    capture.samples_total += converted.length

    assert(capture.samples_total >= capture.samples_pending)
}

function capture_assert(): void {
    assert(capture.samples_pending >= 0)
    assert(capture.samples_total >= capture.samples_pending)
    assert(Number.isSafeInteger(capture.samples_total))
    assert(capture.flushes_in_flight >= 0)
    assert(capture.flushes_in_flight <= FLUSH_BACKLOG_MAX)
}

function capture_new(): Capture {
    assert(WORKLET_NAME.length > 0)
    assert(CHUNK_BYTES_MAX % PCM16_SAMPLE_BYTES === 0)

    return {
        stream: null,
        context: null,
        processor: null,
        chunks_pending: [],
        samples_pending: 0,
        samples_total: 0,
        append_chain: Promise.resolve(),
        append_error: null,
        flushes_in_flight: 0,
        flush_timer_id: null,
    }
}

async function capture_open(): Promise<void> {
    assert(capture.stream === null)
    assert(capture.processor === null)

    return navigator.mediaDevices.getUserMedia({ audio: true }).then(capture_stream_attach)
}

function capture_started(): void {
    assert(Number.isInteger(FLUSH_INTERVAL_MS))
    assert(typeof flush_tick === 'function')

    capture.flush_timer_id = setInterval(flush_tick, FLUSH_INTERVAL_MS)
    recording.value = true
}

async function capture_stream_attach(stream: MediaStream): Promise<void> {
    capture.stream = stream
    capture.context = context_create()

    await ipc.recording_start(capture.context.sampleRate)
    await capture.context.audioWorklet.addModule(worklet_url_create())

    const source = capture.context.createMediaStreamSource(capture.stream)

    capture.processor = new AudioWorkletNode(capture.context, WORKLET_NAME)
    capture.processor.port.onmessage = audio_process

    source.connect(capture.processor)
    capture.processor.connect(capture.context.destination)

    assert(capture.flushes_in_flight === 0)
    assert(capture.samples_total >= 0)
}

function capture_teardown(): void {
    capture_assert()

    if (capture.flush_timer_id !== null) {
        clearInterval(capture.flush_timer_id)
        capture.flush_timer_id = null
    }

    if (capture.processor !== null) {
        capture.processor.port.onmessage = null
        capture.processor.port.close()
        capture.processor.disconnect()
        capture.processor = null
    }

    if (capture.stream !== null) {
        for (const track of capture.stream.getTracks()) track.stop()

        capture.stream = null
    }

    if (capture.context !== null) {
        void capture.context.close().catch((error: unknown) => {
            log_warn('[recorder] audio context close failed', error)
        })

        capture.context = null
    }

    assert(capture.samples_pending >= 0)
    assert(capture.flushes_in_flight >= 0)
}

function chunk_append(chunk: Uint8Array): void {
    assert(chunk.length > 0)
    assert(chunk.length <= CHUNK_BYTES_MAX)

    if (capture.flushes_in_flight >= FLUSH_BACKLOG_MAX) {
        capture.append_error ??= new Error(MESSAGE_BACKLOG)

        capture_teardown()

        return
    }

    capture.flushes_in_flight += 1

    capture.append_chain = capture.append_chain
        .then(async () => ipc.recording_append(chunk))
        .catch((error: unknown) => {
            capture.append_error ??= error
        })
        .finally(() => {
            capture.flushes_in_flight -= 1
        })
}

function context_create(): AudioContext {
    assert(typeof AudioContext === 'function')
    assert(Number.isInteger(SAMPLE_RATE_PREFERRED))

    try {
        return new AudioContext({ [KEY_SAMPLE_RATE]: SAMPLE_RATE_PREFERRED })
    } catch {
        return new AudioContext()
    }
}

async function discard(): Promise<void> {
    if (!recording.value) return

    capture_teardown()

    await capture.append_chain

    assert(capture.flush_timer_id === null)
    assert(capture.samples_total >= 0)

    return ipc.recording_discard().finally(state_reset)
}

async function discard_quietly(): Promise<void> {
    assert(capture.samples_pending >= 0)
    assert(capture.flushes_in_flight >= 0)

    return ipc.recording_discard().catch((error: unknown) => {
        log_warn('[recorder] discard after failure', error)
    })
}

function error_friendly(error: unknown): Error {
    const name = error instanceof DOMException ? error.name : ''

    if (name === 'NotAllowedError') return new Error(MESSAGE_NOT_ALLOWED)
    if (name === 'SecurityError') return new Error(MESSAGE_NOT_ALLOWED)
    if (name === 'NotFoundError') return new Error(MESSAGE_NOT_FOUND)
    if (name === 'OverconstrainedError') return new Error(MESSAGE_NOT_FOUND)
    if (name === 'NotReadableError') return new Error(MESSAGE_NOT_READABLE)

    assert(MESSAGE_NOT_READABLE.length > 0)
    assert(typeof name === 'string')

    return error instanceof Error ? error : new Error(String(error))
}

function flush_tick(): void {
    pending_flush()

    const rate = capture.context?.sampleRate ?? SAMPLE_RATE_PREFERRED

    assert(typeof rate === 'number')

    elapsed_seconds.value = Math.floor(capture.samples_total / rate)

    assert(Number.isInteger(capture.samples_total))
}

function pending_bytes_take(): Uint8Array {
    assert(capture.samples_pending > 0)

    const bytes = new Uint8Array(capture.samples_pending * PCM16_SAMPLE_BYTES)
    const view = new DataView(bytes.buffer)
    let offset = 0

    for (const chunk of capture.chunks_pending) {
        for (const sample of chunk) {
            view.setInt16(offset, sample, true)
            offset += PCM16_SAMPLE_BYTES
        }
    }

    capture.chunks_pending = []
    capture.samples_pending = 0

    assert(offset === bytes.length)

    return bytes
}

function pending_flush(): void {
    capture_assert()

    if (capture.samples_pending === 0) return

    const bytes = pending_bytes_take()

    assert(bytes.length % PCM16_SAMPLE_BYTES === 0)

    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES_MAX) {
        chunk_append(bytes.slice(offset, offset + CHUNK_BYTES_MAX))
    }
}

function samples_to_pcm16(input: Float32Array): Int16Array {
    assert(input instanceof Float32Array)
    assert(Number.isInteger(input.length))

    const output = new Int16Array(input.length)

    for (let index = 0; index < input.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, input[index] ?? 0))

        output[index] = Math.round(sample * PCM16_SAMPLE_MAX)
    }

    return output
}

async function start(): Promise<void> {
    if (recording.value) return
    if (!('mediaDevices' in navigator)) throw new Error(MESSAGE_UNAVAILABLE)

    state_reset()

    try {
        await capture_open()
    } catch (error) {
        capture_teardown()

        await discard_quietly()

        throw error_friendly(error)
    }

    capture_started()
}

function state_reset(): void {
    Object.assign(capture, capture_new())

    elapsed_seconds.value = 0
    recording.value = false

    assert(capture.chunks_pending.length === 0)
    assert(capture.samples_total === 0)
}

async function stop(): Promise<string> {
    if (!recording.value) throw new Error(MESSAGE_NOT_RECORDING)

    capture_teardown()
    pending_flush()

    await capture.append_chain

    assert(capture.flush_timer_id === null)
    assert(capture.samples_total >= 0)

    if (capture.append_error !== null) {
        return stop_after_failure(error_friendly(capture.append_error)).finally(state_reset)
    }

    return ipc.recording_finish().finally(state_reset)
}

async function stop_after_failure(failure: Error): Promise<string> {
    assert(failure.message.length > 0)
    assert(capture.flush_timer_id === null)

    const { message } = use_dialog()

    return ipc.recording_finish()
        .catch(async (error: unknown) => {
            log_warn('[recorder] finish after failure', error)

            await discard_quietly()

            throw failure
        })
        .then(async (path_saved) => {
            await message(`${MESSAGE_ENDED_EARLY} (${failure.message})`, {
                title: TITLE_ENDED_EARLY,
                kind: 'warning',
            })

            return path_saved
        })
}

const api = Object.freeze({ recording, elapsed_seconds, start, stop, discard })

function worklet_url_create(): string {
    assert(WORKLET_SOURCE.includes(WORKLET_NAME))

    const blob = new Blob([WORKLET_SOURCE], { type: 'text/javascript' })

    assert(blob.size > 0)

    return URL.createObjectURL(blob)
}
