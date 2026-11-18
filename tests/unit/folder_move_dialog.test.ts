import { flushPromises } from '@vue/test-utils'
import { h, nextTick, shallowRef } from 'vue'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import AppDialogHost from '../../src/components/app_dialog_host.vue'
import FolderMoveDialog from '../../src/components/folder_move_dialog.vue'
import { use_dialog } from '../../src/composables/use_dialog'
import { use_modal_shown } from '../../src/composables/use_modal'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import { ATTACH_TO, job_meta_build, mount_auto_unmount } from './fixtures'
import { escape_press, pointer_press } from './modal'
import type { ComponentOptions, VNode } from 'vue'
import type { VueWrapper } from '@vue/test-utils'
import type { JobMeta } from '../../src/types'


vi.mock('../../src/lib/ipc')

const KEY_JOB_UPDATE = 'onUpdate:job'
const JOB_FILED = job_meta_build({ id: 'job-filed', project: 'Remi' })

const MOUNT_ANIMATED = Object.freeze({
    [ATTACH_TO]: document.body,
    global: { stubs: { transition: false } },
})

const SELECTOR_MOVER = '[aria-labelledby="folder-move-title"]'
const dialog = use_dialog()
const modal_shown = use_modal_shown()
const target = shallowRef<JobMeta | null>(null)


function button(label: string): HTMLButtonElement {
    assert(label.length > 0)

    const found = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
        .find((candidate) => candidate.textContent.trim() === label)

    assert(found !== undefined, `no button reads ${label}`)

    return found
}

function job_update(shown: JobMeta | null): void {
    assert(shown === null || shown.id.length > 0)
    assert(target.value !== null)

    target.value = shown
}

function mover(): HTMLElement {
    const found = document.body.querySelectorAll<HTMLElement>(SELECTOR_MOVER)

    assert(found.length === 1, 'the move dialog is not the one move dialog on screen')

    const [element] = found

    assert(element !== undefined)

    return element
}

async function mover_mount(job: JobMeta): Promise<VueWrapper> {
    assert(job.id.length > 0)
    assert(target.value === null)

    const harness: ComponentOptions = { render: mover_render }
    const wrapper = mount_auto_unmount(harness, MOUNT_ANIMATED)

    target.value = job
    await flushPromises()

    assert(mover().contains(document.activeElement))

    return wrapper
}

function mover_render(): VNode {
    assert(typeof h === 'function')
    assert(target.value === null || target.value.id.length > 0)

    return h(FolderMoveDialog, { job: target.value, [KEY_JOB_UPDATE]: job_update })
}

beforeEach(() => {
    onTestFinished(() => {
        dialog.close(false)
        target.value = null
        document.body.innerHTML = ''
    })

    vi.resetAllMocks()
    vi.mocked(ipc.jobs_list).mockResolvedValue([])
})

describe('FolderMoveDialog as a modal', () => {
    it('makes the fading dialog inert so a late click cannot move the recording', async () => {
        await mover_mount(JOB_FILED)

        const leaving = mover()

        expect(modal_shown.value).toBe(true)
        expect(leaving.inert).toBe(false)

        button('Cancel').click()
        await nextTick()

        expect(target.value).toBeNull()
        expect(modal_shown.value).toBe(false)
        expect(leaving.isConnected).toBe(true)
        expect(leaving.inert).toBe(true)
        expect(ipc.job_meta_update).not.toHaveBeenCalled()
    })

    it('goes inert under the error a failed move shows and comes back after it', async () => {
        vi.mocked(ipc.job_meta_update).mockRejectedValue(new Error('disk is full'))
        mount_auto_unmount(AppDialogHost, MOUNT_ANIMATED)
        await mover_mount(JOB_FILED)

        button('No folder').click()
        await flushPromises()

        expect(ipc.job_meta_update).toHaveBeenCalledExactlyOnceWith('job-filed', { project: '' })
        expect(dialog.current.value?.message).toContain('disk is full')
        expect(mover().inert).toBe(true)
        expect(document.body.querySelector<HTMLElement>('.app-dialog-host')?.inert).toBe(false)

        dialog.close(true)
        await flushPromises()

        expect(target.value).toBe(JOB_FILED)
        expect(mover().inert).toBe(false)
        expect(modal_shown.value).toBe(true)
    })

    it('closes on Escape after a click on a part of it that takes no focus', async () => {
        await mover_mount(JOB_FILED)

        const title = mover().querySelector('.app-dialog-title')

        assert(title !== null)

        pointer_press(title)
        escape_press()

        expect(target.value).toBeNull()
        expect(ipc.job_meta_update).not.toHaveBeenCalled()
    })
})
