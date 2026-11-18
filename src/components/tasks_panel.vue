<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import { use_batch_transcribe } from '../composables/use_batch_transcribe'
import { use_context_menu } from '../composables/use_context_menu'
import { use_pipeline } from '../composables/use_pipeline'
import { use_tasks } from '../composables/use_tasks'
import { assert } from '../lib/assert'
import { seconds_to_clock, unix_now } from '../lib/duration'
import { error_dialog_show } from '../lib/errors'
import { ipc } from '../lib/ipc'
import { MENU_ITEM_OPEN_MEETING } from '../lib/menu'
import NoticeBanner from './notice_banner.vue'
import type { View } from '../composables/use_pipeline'
import type { Task } from '../composables/use_tasks'
import type { MenuItem } from '../lib/menu'


const TICK_INTERVAL_MS = 1000
const MESSAGE_JOB_GONE = 'That recording is no longer saved on this computer.'
const MENU_ITEM_CANCEL = Object.freeze<MenuItem>({ id: 'cancel', label: 'Cancel', icon: 'close' })

const MENU_ITEM_DISMISS = Object.freeze<MenuItem>({
    id: 'dismiss',
    label: 'Dismiss',
    icon: 'close',
})

const { open: context_menu_open } = use_context_menu()
const { tasks, task_dismiss, task_cancel, tasks_clear_finished } = use_tasks()
const { job_open, job_open_busy } = use_pipeline()

const {
    pending_count: batch_pending,
    error_message_last: batch_error,
    error_dismiss: batch_error_dismiss,
} = use_batch_transcribe()

const tasks_newest_first = computed(() =>
    [...tasks.value].sort((left, right) => right.started_at_unix - left.started_at_unix))

const has_finished = computed(() => tasks.value.some((task) => task.status !== 'running'))
const now_unix = ref(unix_now())
const ticker_id = shallowRef<ReturnType<typeof setInterval> | null>(null)


onMounted(() => {
    ticker_id.value = setInterval(now_tick, TICK_INTERVAL_MS)
})

onUnmounted(() => {
    if (ticker_id.value !== null) {
        clearInterval(ticker_id.value)
        ticker_id.value = null
    }
})

function duration_label(task: Task): string {
    assert(Number.isSafeInteger(task.started_at_unix))
    assert((task.finished_at_unix === null) === (task.status === 'running'))

    const end = task.finished_at_unix ?? now_unix.value

    return seconds_to_clock(Math.max(0, end - task.started_at_unix))
}

function job_open_available(task: Task): boolean {
    assert(task.id.length > 0)
    assert(task.job_id === null || task.job_id.length > 0)

    if (task.status !== 'succeeded') return false

    return task.job_id !== null
}

async function job_open_from_task(task: Task): Promise<void> {
    assert(task.id.length > 0)
    assert(task.status === 'succeeded')

    const job_id = task.job_id

    if (job_id === null) return

    return ipc.job_meta_get(job_id)
        .then(async (meta) => {
            if (meta === null) throw new Error(MESSAGE_JOB_GONE)

            await job_open(meta, job_open_view(task))
        })
        .catch(error_dialog_show)
}

function job_open_view(task: Task): View {
    assert(task.id.length > 0)
    assert(task.status === 'succeeded')

    switch (task.kind) {
        case 'transcribe': return 'details'
        case 'generate': return 'notes'
    }
}

function now_tick(): void {
    assert(ticker_id.value !== null)

    now_unix.value = unix_now()
}

function status_text(task: Task): string {
    assert(task.id.length > 0)
    assert((task.status === 'failed') === (task.error_message !== null))

    if (task.status === 'running') {
        const verb = task.kind === 'transcribe' ? 'Transcribing' : 'Generating notes'

        return `${verb}… ${duration_label(task)}`
    }

    if (task.status === 'succeeded') {
        return task.kind === 'transcribe' ? 'Transcribed' : 'Notes ready'
    }

    if (task.status === 'failed') return 'Failed'

    return 'Cancelled'
}

function task_action(task: Task): void {
    assert(task.id.length > 0)
    assert(task_action_available(task))

    if (task.status === 'running') {
        void task_cancel(task.id)

        return
    }

    task_dismiss(task.id)
}

function task_action_available(task: Task): boolean {
    assert(task.id.length > 0)
    assert(task.stream_id === null || task.stream_id.length > 0)

    if (task.status === 'running') return task.stream_id !== null

    return true
}

function task_context_menu(event: MouseEvent, task: Task): void {
    assert(event.type === 'contextmenu')
    assert(task.id.length > 0)

    context_menu_open(event, task_menu_items(task), task_menu_select.bind(undefined, task))
}

function task_menu_items(task: Task): MenuItem[] {
    assert(task.id.length > 0)

    const items: MenuItem[] = []
    const action = task.status === 'running' ? MENU_ITEM_CANCEL : MENU_ITEM_DISMISS

    if (job_open_available(task)) {
        if (!job_open_busy.value) items.push(MENU_ITEM_OPEN_MEETING)
    }

    if (task_action_available(task)) items.push(action)

    assert(items.length <= 2)

    return items
}

async function task_menu_select(task: Task, id: string): Promise<void> {
    assert(task.id.length > 0)
    assert(id !== MENU_ITEM_OPEN_MEETING.id || job_open_available(task))

    if (id === MENU_ITEM_OPEN_MEETING.id) return job_open_from_task(task)
    if (id === MENU_ITEM_CANCEL.id) return task_cancel(task.id)

    assert(id === MENU_ITEM_DISMISS.id)

    task_dismiss(task.id)
}
</script>

<template>
    <div
        v-if="tasks.length > 0 || batch_pending > 0 || batch_error"
        class="sidebar-tasks"
        role="status"
        aria-live="polite"
    >
        <div class="sidebar-tasks-header">
            <span>Recent</span>
            <button v-if="has_finished" type="button" @click="tasks_clear_finished">Clear</button>
        </div>
        <p v-if="batch_pending > 0" class="sidebar-tasks-note">
            {{ batch_pending }} waiting
        </p>
        <NoticeBanner
            v-if="batch_error"
            class="sidebar-tasks-error"
            @dismiss="batch_error_dismiss"
        >
            {{ batch_error }}
        </NoticeBanner>
        <ul class="sidebar-tasks-list">
            <li
                v-for="task in tasks_newest_first"
                :key="task.id"
                class="sidebar-task"
                @contextmenu="task_context_menu($event, task)"
            >
                <button
                    type="button"
                    class="sidebar-task-main"
                    :disabled="!job_open_available(task) || job_open_busy"
                    :title="job_open_available(task) ? 'Open' : undefined"
                    @click="job_open_from_task(task)"
                >
                    <span class="task-dot" :data-status="task.status" />
                    <span class="sidebar-task-text">
                        <span class="sidebar-task-title">{{ task.label }}</span>
                        <span class="sidebar-task-status">{{ status_text(task) }}</span>
                        <span
                            v-if="task.status === 'failed' && task.error_message"
                            class="sidebar-task-error"
                            :title="task.error_message"
                        >
                            {{ task.error_message }}
                        </span>
                    </span>
                </button>
                <button
                    v-if="task_action_available(task)"
                    type="button"
                    class="sidebar-task-x"
                    :aria-label="task.status === 'running' ? 'Cancel' : 'Dismiss'"
                    :title="task.status === 'running' ? 'Cancel' : 'Dismiss'"
                    @click="task_action(task)"
                >
                    ×
                </button>
            </li>
        </ul>
    </div>
</template>
