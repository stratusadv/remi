<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { use_batch_transcribe } from '../composables/use_batch_transcribe'
import { use_pipeline } from '../composables/use_pipeline'
import { use_tasks } from '../composables/use_tasks'
import { seconds_to_clock, unix_now } from '../lib/duration'
import { error_dialog_show } from '../lib/errors'
import { ipc } from '../lib/ipc'
import type { View } from '../composables/use_pipeline'
import type { Task } from '../composables/use_tasks'


const TICK_INTERVAL_MS = 1000
const MESSAGE_JOB_GONE = 'That recording is no longer saved on this computer.'
const { tasks, task_dismiss, task_cancel, tasks_clear_finished } = use_tasks()
const { job_open, job_open_busy } = use_pipeline()

const {
    pending_count: batch_pending,
    error_message_last: batch_error,
    entries_clear_finished: batch_clear,
} = use_batch_transcribe()

const tasks_newest_first = computed(() =>
    [...tasks.value].sort((left, right) => right.started_at_unix - left.started_at_unix))

const has_finished = computed(() => tasks.value.some((task) => task.status !== 'running'))
const now_unix = ref(unix_now())
let ticker_id: ReturnType<typeof setInterval> | null = null


onMounted(() => {
    ticker_id = setInterval(() => {
        now_unix.value = unix_now()
    }, TICK_INTERVAL_MS)
})

onUnmounted(() => {
    if (ticker_id !== null) {
        clearInterval(ticker_id)
        ticker_id = null
    }
})

function duration_label(task: Task): string {
    const end = task.finished_at_unix ?? now_unix.value

    return seconds_to_clock(Math.max(0, end - task.started_at_unix))
}

function job_open_available(task: Task): boolean {
    if (task.status !== 'succeeded') return false

    return task.job_id !== null
}

async function job_open_from_task(task: Task): Promise<void> {
    const job_id = task.job_id

    if (job_id === null) return

    try {
        const meta = await ipc.job_meta_get(job_id)

        if (meta === null) throw new Error(MESSAGE_JOB_GONE)

        await job_open(meta, job_open_view(task))
    } catch (error) {
        await error_dialog_show(error)
    }
}

function job_open_view(task: Task): View {
    switch (task.kind) {
        case 'transcribe': return 'details'
        case 'generate': return 'notes'
    }
}

function status_text(task: Task): string {
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
    if (task.status === 'running') {
        void task_cancel(task.id)

        return
    }

    task_dismiss(task.id)
}

function task_action_available(task: Task): boolean {
    if (task.status === 'running') return task.stream_id !== null

    return true
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
        <p v-if="batch_error" class="sidebar-tasks-note error">
            {{ batch_error }}
            <button type="button" @click="batch_clear">Dismiss</button>
        </p>
        <ul class="sidebar-tasks-list">
            <li v-for="task in tasks_newest_first" :key="task.id" class="sidebar-task">
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
