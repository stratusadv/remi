import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TasksPanel from '../../src/components/tasks_panel.vue'
import { use_context_menu } from '../../src/composables/use_context_menu'
import { use_pipeline } from '../../src/composables/use_pipeline'
import { use_tasks } from '../../src/composables/use_tasks'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import { ATTACH_TO, deferred_new, job_meta_build, transcript_build } from './fixtures'
import type { VueWrapper } from '@vue/test-utils'
import type { Deferred } from './fixtures'


vi.mock('../../src/lib/ipc')

const ERROR_OFFLINE = 'The service is offline.'
const JOB_ID = 'job-1'
const LABEL_FAILED = 'Notes for the retro'
const LABEL_FINISHED = 'Notes for the sync'
const LABEL_RUNNING = 'Notes for the standup'
const LABEL_STREAMLESS = 'Notes for the planning session'
const STREAM_ID = 'stream-1'
const context_menu = use_context_menu()
const finishers = new Set<Deferred<string>>()
const mounted = new Set<VueWrapper>()
const pipeline = use_pipeline()
const tasks_state = use_tasks()


interface TaskRunning {
    readonly finish: Deferred<string>
    readonly run: Promise<string>
}

function job_id_of(job_id: string): string {
    assert(job_id === JOB_ID)

    return job_id
}

async function mount_panel(): Promise<VueWrapper> {
    assert(mounted.size === 0)

    const wrapper = mount(TasksPanel, { [ATTACH_TO]: document.body })

    mounted.add(wrapper)
    await flushPromises()

    assert(wrapper.findAll('.sidebar-task').length === tasks_state.tasks.value.length)

    return wrapper
}

async function runner_failed(): Promise<string> {
    assert(tasks_state.tasks_running.value.some((task) => task.label === LABEL_FAILED))
    assert(tasks_state.tasks_finished.value.every((task) => task.label !== LABEL_FAILED))

    return Promise.reject(new Error(ERROR_OFFLINE))
}

async function task_finished(label: string): Promise<void> {
    assert(label.length > 0)
    assert(tasks_state.tasks.value.every((task) => task.label !== label))

    await tasks_state.task_run({
        kind: 'generate',
        label,
        async runner(): Promise<string> {
            assert(tasks_state.tasks_running.value.some((task) => task.label === label))
            assert(tasks_state.tasks_finished.value.every((task) => task.label !== label))

            return Promise.resolve(JOB_ID)
        },
        job_id_of,
    })

    assert(tasks_state.tasks_finished.value.some((task) => task.label === label))
}

async function task_menu(wrapper: VueWrapper, label: string): Promise<string[] | null> {
    assert(mounted.has(wrapper))
    assert(label.length > 0)

    const rows = wrapper.findAll('.sidebar-task')
    const row = rows.find((candidate) => candidate.text().includes(label))

    assert(row !== undefined, `the panel has no task labelled ${label}`)

    context_menu.close()
    await row.trigger('contextmenu')

    const shown = context_menu.menu.value

    return shown === null ? null : shown.items.map((item) => item.label)
}

function task_running(label: string, stream_id: string | null): TaskRunning {
    assert(label.length > 0)
    assert(stream_id === null || stream_id.length > 0)
    assert(tasks_state.tasks.value.every((task) => task.label !== label))

    const finish = deferred_new<string>()

    const run = tasks_state.task_run({
        kind: 'generate',
        label,
        async runner(): Promise<string> {
            assert(tasks_state.tasks_running.value.some((task) => task.label === label))
            assert(tasks_state.tasks_finished.value.every((task) => task.label !== label))

            return finish.promise
        },
        stream_id,
    })

    finishers.add(finish)

    return { finish, run }
}

beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(ipc.task_cancel).mockResolvedValue(undefined)
    vi.mocked(ipc.desktop_notification_show).mockResolvedValue(undefined)
    pipeline.pipeline_reset()
    pipeline.job_open_busy.value = false
})

afterEach(async () => {
    for (const wrapper of mounted) wrapper.unmount()

    for (const finish of finishers) finish.resolve(JOB_ID)

    finishers.clear()
    mounted.clear()
    context_menu.close()
    await flushPromises()
    tasks_state.tasks_clear_finished()
    document.body.innerHTML = ''
})

describe('TasksPanel menu', () => {
    it('offers what each task can still do', async () => {
        void task_running(LABEL_RUNNING, STREAM_ID).run
        void task_running(LABEL_STREAMLESS, null).run
        await task_finished(LABEL_FINISHED)

        await expect(tasks_state.task_run({
            kind: 'generate',
            label: LABEL_FAILED,
            runner: runner_failed,
        })).rejects.toThrow(ERROR_OFFLINE)

        const wrapper = await mount_panel()
        const running = await task_menu(wrapper, LABEL_RUNNING)
        const finished = await task_menu(wrapper, LABEL_FINISHED)
        const failed = await task_menu(wrapper, LABEL_FAILED)
        const streamless = await task_menu(wrapper, LABEL_STREAMLESS)

        pipeline.job_open_busy.value = true

        const finished_busy = await task_menu(wrapper, LABEL_FINISHED)

        expect(running).toEqual(['Cancel'])
        expect(finished).toEqual(['Open meeting', 'Dismiss'])
        expect(failed).toEqual(['Dismiss'])
        expect(streamless).toBeNull()
        expect(finished_busy).toEqual(['Dismiss'])
    })

    it('opens the meeting a finished task made, at its notes', async () => {
        vi.mocked(ipc.job_meta_get).mockResolvedValue(job_meta_build({ id: JOB_ID }))
        vi.mocked(ipc.job_transcript_engines_list).mockResolvedValue(['whisper'])
        vi.mocked(ipc.job_transcript_load).mockResolvedValue(transcript_build(['hello']))
        vi.mocked(ipc.job_waveform_get).mockResolvedValue({ peaks: [0.1], duration_seconds: 1 })
        vi.mocked(ipc.notes_load).mockResolvedValue('# Notes')
        await task_finished(LABEL_FINISHED)

        const wrapper = await mount_panel()

        await task_menu(wrapper, LABEL_FINISHED)
        await context_menu.choose('open')
        await flushPromises()

        expect(ipc.job_meta_get).toHaveBeenCalledWith(JOB_ID)
        expect(pipeline.job_id_current.value).toBe(JOB_ID)
        expect(pipeline.view_current.value).toBe('notes')
    })
})

describe('TasksPanel menu', () => {
    it('dismisses a finished task and cancels a running one', async () => {
        void task_running(LABEL_RUNNING, STREAM_ID).run
        await task_finished(LABEL_FINISHED)

        const wrapper = await mount_panel()

        await task_menu(wrapper, LABEL_FINISHED)
        await context_menu.choose('dismiss')

        expect(tasks_state.tasks.value.map((task) => task.label)).toEqual([LABEL_RUNNING])

        await task_menu(wrapper, LABEL_RUNNING)
        await context_menu.choose('cancel')

        expect(ipc.task_cancel).toHaveBeenCalledWith(STREAM_ID)
    })

    it('sends no cancel when the task finished while its menu was open', async () => {
        const { finish, run } = task_running(LABEL_RUNNING, STREAM_ID)
        const wrapper = await mount_panel()
        const before = await task_menu(wrapper, LABEL_RUNNING)

        finish.resolve(JOB_ID)
        await run
        await context_menu.choose('cancel')

        const after = await task_menu(wrapper, LABEL_RUNNING)

        expect(before).toEqual(['Cancel'])
        expect(ipc.task_cancel).not.toHaveBeenCalled()
        expect(after).toEqual(['Dismiss'])
    })
})
