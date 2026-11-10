import { computed, ref } from 'vue'
import {
    isPermissionGranted,
    requestPermission,
    sendNotification,
} from '@tauri-apps/plugin-notification'
import { assert } from '../lib/assert'
import { unix_now } from '../lib/duration'
import { ipc } from '../lib/ipc'
import { log_warn } from '../lib/log'


export type TaskKind = 'transcribe' | 'generate'
export type TaskStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'
type PermissionState = 'unknown' | 'granted' | 'denied'

export interface Task {
    id: string
    kind: TaskKind
    label: string
    started_at_unix: number
    finished_at_unix: number | null
    status: TaskStatus
    error_message: string | null
    job_id: string | null
    stream_id: string | null
}

interface TaskRunOptions<Result> {
    kind: TaskKind
    label: string
    runner: () => Promise<Result>
    on_success?: (result: Result) => void | Promise<void>
    job_id_of?: (result: Result) => string | null
    stream_id?: string | null
}

const CANCELLED_PATTERN = /cancelled/i
const TASK_RETENTION_MAX = 8
const tasks_all = ref<Task[]>([])
const tasks = computed(() => tasks_all.value)
const tasks_running = computed(() => tasks_all.value.filter((task) => task.status === 'running'))
const tasks_finished = computed(() => tasks_all.value.filter((task) => task.status !== 'running'))
const permission_state = ref<PermissionState>('unknown')


export function is_cancelled_error(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)

    assert(typeof message === 'string')
    assert(CANCELLED_PATTERN.flags.includes('i'))

    return CANCELLED_PATTERN.test(message)
}

export function use_tasks(): typeof api {
    assert(Object.isFrozen(api))
    assert(tasks_all.value.length <= TASK_RETENTION_MAX)

    return api
}

async function notification_permission_ask(): Promise<PermissionState> {
    const granted_already = await isPermissionGranted()

    if (granted_already) return 'granted'

    const result = await requestPermission()

    assert(typeof result === 'string')
    assert(result.length > 0)

    return result === 'granted' ? 'granted' : 'denied'
}

async function notification_permission_ensure(): Promise<boolean> {
    if (permission_state.value === 'granted') return true
    if (permission_state.value === 'denied') return false

    const state = await notification_permission_ask().catch((): PermissionState => 'denied')

    permission_state_set(state)

    assert(state !== 'unknown')

    return state === 'granted'
}

function notification_send(task: Task): void {
    assert(task.id.length > 0)
    assert(task.status !== 'running')

    try {
        const title = task_notification_title(task)
        const detail = task.error_message ?? ''
        const body = task.status === 'failed' && detail.length > 0 ? detail : task.label

        sendNotification({ title, body })
    } catch (error) {
        log_warn('[tasks] notification not sent', error)
    }
}

async function notification_send_if_appropriate(task: Task): Promise<void> {
    assert(task.id.length > 0)
    assert(typeof task.label === 'string')

    if (task.status === 'running') return

    if (task.status === 'succeeded') {
        if (window_is_visible()) return
    }

    return notification_permission_ensure().then((granted) => {
        if (granted) notification_send(task)
    })
}

function permission_state_set(state: PermissionState): void {
    assert(state.length > 0)

    permission_state.value = state

    assert(permission_state.value === state)
}

async function task_cancel(id: string): Promise<void> {
    assert(id.length > 0)

    const task = task_find(id)

    if (task === undefined) return
    if (task.status !== 'running') return
    if (task.stream_id === null) return

    assert(task.stream_id.length > 0)

    return ipc.task_cancel(task.stream_id).catch((error: unknown) => {
        log_warn('[tasks] cancel not delivered', error)
    })
}

function task_dismiss(id: string): void {
    assert(id.length > 0)

    tasks_all.value = tasks_all.value.filter((task) => task.id !== id)

    assert(tasks_all.value.every((task) => task.id !== id))
}

function task_find(id: string): Task | undefined {
    assert(id.length > 0)

    const found = tasks_all.value.find((task) => task.id === id)

    assert(found === undefined || found.id === id)

    return found
}

async function task_finish_failure(id: string, error: unknown): Promise<void> {
    assert(id.length > 0)

    const cancelled = is_cancelled_error(error)

    task_replace(id, {
        status: cancelled ? 'cancelled' : 'failed',
        finished_at_unix: unix_now(),
        error_message: cancelled ? null : String(error),
    })

    assert(typeof cancelled === 'boolean')

    if (cancelled) return

    return task_notify(id)
}

function task_notification_title(task: Task): string {
    assert(task.id.length > 0)
    assert(task.status !== 'running')

    if (task.status === 'failed') {
        switch (task.kind) {
            case 'transcribe': return 'Transcription failed'
            case 'generate': return 'Notes generation failed'
        }
    }

    if (task.status === 'cancelled') return 'Cancelled'

    switch (task.kind) {
        case 'transcribe': return 'Transcription finished'
        case 'generate': return 'Notes ready'
    }
}

async function task_notify(id: string): Promise<void> {
    assert(id.length > 0)

    const task = task_find(id)

    if (task === undefined) return

    assert(task.id === id)

    return notification_send_if_appropriate(task)
}

function task_prune(): void {
    assert(tasks_all.value.length <= TASK_RETENTION_MAX + 1)

    if (tasks_all.value.length <= TASK_RETENTION_MAX) return

    tasks_all.value = tasks_all.value.slice(-TASK_RETENTION_MAX)

    assert(tasks_all.value.length === TASK_RETENTION_MAX)
}

function task_replace(id: string, patch: Partial<Task>): void {
    assert(id.length > 0)
    assert(patch.id === undefined)

    tasks_all.value = tasks_all.value.map((task) => (task.id === id ? { ...task, ...patch } : task))

    assert(tasks_all.value.length <= TASK_RETENTION_MAX)
}

async function task_run<Result>(options: TaskRunOptions<Result>): Promise<Result> {
    assert(typeof options.label === 'string')
    assert(typeof options.runner === 'function')

    const id = crypto.randomUUID()

    const task_initial: Task = {
        id,
        kind: options.kind,
        label: options.label,
        started_at_unix: unix_now(),
        finished_at_unix: null,
        status: 'running',
        error_message: null,
        job_id: null,
        stream_id: options.stream_id ?? null,
    }

    tasks_all.value = [...tasks_all.value, task_initial]

    task_prune()

    return options.runner()
        .then(async (result) => {
            task_replace(id, {
                status: 'succeeded',
                finished_at_unix: unix_now(),
                job_id: options.job_id_of?.(result) ?? null,
            })

            if (task_find(id) !== undefined) await options.on_success?.(result)

            await task_notify(id)

            return result
        })
        .catch(async (error: unknown) => {
            await task_finish_failure(id, error)

            throw error
        })
}

function tasks_clear_finished(): void {
    assert(tasks_all.value.length <= TASK_RETENTION_MAX)

    tasks_all.value = tasks_all.value.filter((task) => task.status === 'running')

    assert(tasks_all.value.every((task) => task.finished_at_unix === null))
}

const api = Object.freeze({
    tasks,
    tasks_running,
    tasks_finished,
    task_run,
    task_dismiss,
    task_cancel,
    tasks_clear_finished,
})

function window_is_visible(): boolean {
    if (typeof document === 'undefined') return true

    assert(typeof document.visibilityState === 'string')
    assert(typeof document.hasFocus === 'function')

    return document.visibilityState === 'visible' && document.hasFocus()
}
