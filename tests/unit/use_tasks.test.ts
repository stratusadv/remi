import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { use_batch_transcribe } from '../../src/composables/use_batch_transcribe'
import { use_endpoints } from '../../src/composables/use_endpoints'
import { use_tasks } from '../../src/composables/use_tasks'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import { deferred_new, transcript_build } from './fixtures'
import type { Deferred } from './fixtures'
import type { APIEndpoint, TranscriptionResult } from '../../src/types'


vi.mock('../../src/lib/ipc')

const JOB_ID = 'job-1'
const LABEL_EXTRA = 'Quarterly review'
const LABEL_LONG = 'Board meeting'
const LABEL_NOTES = 'Notes'
const LABEL_SUMMARY = 'Summary'
const MESSAGE_TASKS_FULL = 'Wait for one to finish'
const QUEUE_LENGTH_MAX = 256
const SOURCE_PATH = '/home/you/recordings/board-meeting.wav'
const TASK_RETENTION_MAX = 8
const TASK_RUNNING_COUNT_MAX = 64

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

const batch = use_batch_transcribe()
const tasks_state = use_tasks()
const { endpoints } = use_endpoints()


interface TaskHeld {
    readonly finish: Deferred<string>
    readonly run: Promise<string>
}

function labels_numbered(count: number): string[] {
    assert(count > 0)
    assert(count <= TASK_RUNNING_COUNT_MAX)

    const labels = Array.from({ length: count }, (unused, index) => {
        assert(unused === undefined)

        return `${LABEL_NOTES} ${String(index + 1)}`
    })

    assert(labels.length === count)

    return labels
}

function labels_of(tasks: readonly { label: string }[]): string[] {
    assert(tasks.length <= TASK_RUNNING_COUNT_MAX)

    const labels = tasks.map((task) => task.label)

    assert(labels.length === tasks.length)

    return labels
}

async function runner_finished(): Promise<string> {
    assert(tasks_state.tasks_running.value.length > 0)
    assert(tasks_state.tasks_running.value.length <= TASK_RUNNING_COUNT_MAX)

    return Promise.resolve(JOB_ID)
}

function task_held(label: string): TaskHeld {
    assert(label.length > 0)
    assert(tasks_state.tasks_running.value.every((task) => task.label !== label))

    const finish = deferred_new<string>()

    const run = tasks_state.task_run({
        kind: 'generate',
        label,
        async runner(): Promise<string> {
            assert(tasks_state.tasks_running.value.some((task) => task.label === label))
            assert(tasks_state.tasks_finished.value.every((task) => task.label !== label))

            return finish.promise
        },
    })

    onTestFinished(() => {
        finish.resolve(JOB_ID)
    })

    return { finish, run }
}

async function tasks_finished_run(labels: readonly string[]): Promise<void> {
    assert(labels.length > 0)
    assert(labels.length <= TASK_RUNNING_COUNT_MAX)

    let chain = Promise.resolve()

    for (const label of labels) {
        chain = chain.then(async () => {
            await tasks_state.task_run({ kind: 'generate', label, runner: runner_finished })
        })
    }

    return chain
}

beforeEach(() => {
    onTestFinished(async () => {
        await flushPromises()
        tasks_state.tasks_clear_finished()
        batch.entries_clear_finished()
    })

    vi.resetAllMocks()
    vi.mocked(ipc.desktop_notification_show).mockResolvedValue(undefined)

    endpoints.value = [ENDPOINT_TRANSCRIPTION]
})

describe('task_run', () => {
    it('keeps a running transcription through eight newer tasks and runs its success', async () => {
        const finish = deferred_new<string>()
        const succeeded: string[] = []

        const run = tasks_state.task_run({
            kind: 'transcribe',
            label: LABEL_LONG,
            async runner(): Promise<string> {
                assert(tasks_state.tasks_running.value.length === 1)
                assert(succeeded.length === 0)

                return finish.promise
            },
            on_success(result: string) {
                assert(result === JOB_ID)

                succeeded.push(result)
            },
        })

        await tasks_finished_run(labels_numbered(TASK_RETENTION_MAX))

        const running = labels_of(tasks_state.tasks_running.value)

        finish.resolve(JOB_ID)
        await run

        expect(running).toEqual([LABEL_LONG])
        expect(succeeded).toEqual([JOB_ID])

        expect(labels_of(tasks_state.tasks.value)).toEqual([
            LABEL_LONG,
            ...labels_numbered(TASK_RETENTION_MAX).slice(1),
        ])
    })

    it('holds every running task past the retention and then keeps the newest eight', async () => {
        const labels = labels_numbered(TASK_RETENTION_MAX + 2)
        const held = labels.map(task_held)
        const running = labels_of(tasks_state.tasks_running.value)

        for (const entry of held) {
            entry.finish.resolve(JOB_ID)
        }

        await Promise.all(held.map(async (entry) => entry.run))
        await tasks_finished_run([LABEL_SUMMARY])

        expect(running).toEqual(labels)
        expect(labels_of(tasks_state.tasks.value)).toEqual([...labels.slice(3), LABEL_SUMMARY])
    })

    it('refuses a task past the running limit and starts nothing for it', async () => {
        const held = labels_numbered(TASK_RUNNING_COUNT_MAX).map(task_held)
        const runner = vi.fn(runner_finished)
        const refused = tasks_state.task_run({ kind: 'generate', label: LABEL_EXTRA, runner })

        await expect(refused).rejects.toThrow(MESSAGE_TASKS_FULL)

        expect(held).toHaveLength(TASK_RUNNING_COUNT_MAX)
        expect(runner).not.toHaveBeenCalled()
        expect(tasks_state.tasks_running.value).toHaveLength(TASK_RUNNING_COUNT_MAX)
        expect(labels_of(tasks_state.tasks.value)).not.toContain(LABEL_EXTRA)
    })
})

describe('use_batch_transcribe', () => {
    it('finishes a file whose transcription outlives eight newer tasks', async () => {
        const transcribed = deferred_new<TranscriptionResult>()

        vi.mocked(ipc.transcription_remote).mockReturnValue(transcribed.promise)

        const drained = batch.enqueue([SOURCE_PATH])

        await tasks_finished_run(labels_numbered(TASK_RETENTION_MAX))

        transcribed.resolve({
            job_id: JOB_ID,
            transcript: transcript_build(['The board approved the budget.']),
            cached: false,
        })

        await drained

        expect(batch.queue.value).toEqual([
            { path: SOURCE_PATH, status: 'succeeded', error_message: null, job_id: JOB_ID },
        ])
    })

    it('takes a new drop after a full queue of files has finished', async () => {
        vi.mocked(ipc.transcription_remote).mockResolvedValue({
            job_id: JOB_ID,
            transcript: transcript_build(['The board approved the budget.']),
            cached: false,
        })

        const paths = Array.from({ length: QUEUE_LENGTH_MAX }, (unused, index) => {
            assert(unused === undefined)

            return `/home/you/recordings/meeting-${String(index + 1)}.wav`
        })

        await batch.enqueue(paths)

        expect(batch.queue.value.filter((entry) => entry.status === 'succeeded'))
            .toHaveLength(QUEUE_LENGTH_MAX)

        await batch.enqueue([SOURCE_PATH])

        expect(batch.error_message_last.value).toBeNull()

        expect(batch.queue.value).toEqual([
            { path: SOURCE_PATH, status: 'succeeded', error_message: null, job_id: JOB_ID },
        ])
    })
})
