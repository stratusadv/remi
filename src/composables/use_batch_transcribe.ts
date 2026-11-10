import { computed, ref } from 'vue'
import { assert } from '../lib/assert'
import { ipc } from '../lib/ipc'
import { path_file_name_short } from '../lib/paths'
import { use_endpoints } from './use_endpoints'
import { use_service } from './use_service'
import { use_tasks } from './use_tasks'
import type { AudioPath, TranscriptionResult } from '../types'


type QueueStatus = 'pending' | 'running' | 'succeeded' | 'failed'

interface QueueEntry {
    path: string
    status: QueueStatus
    error_message: string | null
    job_id: string | null
}

const MESSAGE_KEY_MISSING = 'Add your transcription key under Settings, then drop the files again.'
const QUEUE_LENGTH_MAX = 256
const MESSAGE_QUEUE_FULL = `Drop at most ${String(QUEUE_LENGTH_MAX)} files at a time.`
const QUEUE_DRAIN_SLOTS = QUEUE_LENGTH_MAX * 16
const queue = ref<QueueEntry[]>([])
const running = ref(false)
const error_message_last = ref<string | null>(null)

const pending_count = computed(
    () => queue.value.filter((entry) => entry.status === 'pending').length,
)

const running_count = computed(
    () => queue.value.filter((entry) => entry.status === 'running').length,
)

const api = Object.freeze({
    queue,
    running,
    pending_count,
    running_count,
    error_message_last,
    enqueue,
    entries_clear_finished,
})


export function use_batch_transcribe(): typeof api {
    assert(Object.isFrozen(api))
    assert(queue.value.length <= QUEUE_LENGTH_MAX)

    return api
}

async function enqueue(paths: string[]): Promise<void> {
    assert(Array.isArray(paths))
    assert(queue.value.length <= QUEUE_LENGTH_MAX)

    error_message_last.value = null

    if (!transcription_configured()) {
        error_message_last.value = MESSAGE_KEY_MISSING

        return
    }

    if (queue.value.length + paths.length > QUEUE_LENGTH_MAX) {
        error_message_last.value = MESSAGE_QUEUE_FULL

        return
    }

    const entries_new: QueueEntry[] = paths.map((path) => ({
        path,
        status: 'pending',
        error_message: null,
        job_id: null,
    }))

    queue.value = [...queue.value, ...entries_new]

    if (running.value) return

    running.value = true

    return queue_drain().finally(() => {
        running.value = false
    })
}

function entries_clear_finished(): void {
    assert(queue.value.length <= QUEUE_LENGTH_MAX)

    const queue_size = queue.value.length

    queue.value = queue.value.filter(
        (entry) => entry.status !== 'succeeded' && entry.status !== 'failed',
    )

    assert(queue.value.length <= queue_size)
}

function entry_pending_next(): QueueEntry | undefined {
    assert(queue.value.length <= QUEUE_LENGTH_MAX)

    const next = queue.value.find((entry) => entry.status === 'pending')

    assert((next?.error_message ?? null) === null)

    return next
}

function entry_replace(path: AudioPath, patch: Partial<QueueEntry>): void {
    assert(typeof path === 'string')
    assert(patch.path === undefined)

    queue.value = queue.value.map((entry) =>
        entry.path === path ? { ...entry, ...patch } : entry)

    assert(queue.value.length <= QUEUE_LENGTH_MAX)
}

async function queue_drain(): Promise<void> {
    assert(running.value)
    assert(queue.value.length <= QUEUE_LENGTH_MAX)

    let chain = Promise.resolve()

    for (let slot = 0; slot < QUEUE_DRAIN_SLOTS; slot += 1) {
        chain = chain.then(transcribe_next)
    }

    return chain
}

async function transcribe_next(): Promise<void> {
    assert(running.value)

    const next = entry_pending_next()

    if (next === undefined) return

    return transcribe_one(next.path)
}

async function transcribe_one(path: AudioPath): Promise<void> {
    assert(typeof path === 'string')
    assert(queue.value.some((entry) => entry.path === path))

    const { endpoints_by_purpose } = use_endpoints()
    const { task_run } = use_tasks()

    entry_replace(path, { status: 'running' })

    const endpoint_id = endpoints_by_purpose('transcription')[0]?.id ?? null

    const finished = task_run({
        kind: 'transcribe',
        label: path_file_name_short(path),
        async runner() {
            assert(typeof path === 'string')

            if (endpoint_id === null) throw new Error(MESSAGE_KEY_MISSING)

            assert(typeof endpoint_id === 'string')

            return ipc.transcription_remote(path, endpoint_id, null, true)
        },
        job_id_of: transcription_job_id,
        on_success(result: TranscriptionResult) {
            assert(typeof result.job_id === 'string')
            assert(typeof path === 'string')

            entry_replace(path, { status: 'succeeded', job_id: result.job_id })
        },
    })

    return finished.then(() => undefined).catch((error: unknown) => {
        entry_replace(path, { status: 'failed', error_message: String(error) })
    })
}

function transcription_configured(): boolean {
    assert(queue.value.length <= QUEUE_LENGTH_MAX)

    const { endpoints_by_purpose } = use_endpoints()
    const { transcription_ready } = use_service()

    assert(typeof transcription_ready.value === 'boolean')

    if (!transcription_ready.value) return false

    return endpoints_by_purpose('transcription').length > 0
}

function transcription_job_id(result: TranscriptionResult): string {
    assert(typeof result.job_id === 'string')
    assert(typeof result.cached === 'boolean')

    return result.job_id
}
