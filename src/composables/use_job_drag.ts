import { ref, shallowRef } from 'vue'
import { assert } from '../lib/assert'
import { error_dialog_show } from '../lib/errors'
import { folder_key } from '../lib/folders'
import { use_folders } from './use_folders'
import type { FolderName, JobListing } from '../types'


interface DragPoint {
    x_px: number
    y_px: number
}

interface DragPress {
    job: JobListing
    origin: DragPoint
    pointer_id: number
}

const ATTRIBUTE_FOLDER = 'data-folder-drop'
const BUTTON_MAIN = 0
const BUTTONS_MAIN = 1
const DISTANCE_DRAG_PX = 4
const SELECTOR_CONTROL = 'button'
const SELECTOR_FOLDER = `[${ATTRIBUTE_FOLDER}]`
const { folder_move } = use_folders()
const drag_job = shallowRef<JobListing | null>(null)
const drag_point = shallowRef<DragPoint>({ x_px: 0, y_px: 0 })
const drag_target = ref<FolderName | null>(null)
const press = shallowRef<DragPress | null>(null)
const api = Object.freeze({ drag_job, drag_point, drag_press, drag_target, drop_blocked })


export function use_job_drag(): typeof api {
    assert(Object.isFrozen(api))
    assert(drag_job.value === null || press.value !== null)

    return api
}

function click_swallow(event: MouseEvent): void {
    assert(event.type === 'click')
    assert(drag_job.value === null, 'a click arrived in the middle of a drag')

    event.preventDefault()
    event.stopPropagation()
}

function click_swallow_arm(): void {
    assert(press.value === null)
    assert(drag_job.value === null)

    window.addEventListener('click', click_swallow, { capture: true, once: true })
    setTimeout(click_swallow_release, 0)
}

function click_swallow_release(): void {
    window.removeEventListener('click', click_swallow, true)
}

function drag_end(): void {
    assert(press.value !== null || drag_job.value === null)
    assert(drag_target.value === null || drag_job.value !== null)

    window.removeEventListener('pointercancel', drag_end)
    window.removeEventListener('pointermove', pointer_move)
    window.removeEventListener('pointerup', pointer_up)

    press.value = null
    drag_job.value = null
    drag_target.value = null
}

function drag_press(event: PointerEvent, job: JobListing): void {
    assert(event.type === 'pointerdown')
    assert(job.id.length > 0)

    const { target } = event

    if (event.button !== BUTTON_MAIN) return
    if (!event.isPrimary) return
    if (!(target instanceof Element)) return
    if (target.closest(SELECTOR_CONTROL) !== null) return

    drag_end()

    press.value = {
        job,
        origin: { x_px: event.clientX, y_px: event.clientY },
        pointer_id: event.pointerId,
    }

    window.addEventListener('pointercancel', drag_end)
    window.addEventListener('pointermove', pointer_move)
    window.addEventListener('pointerup', pointer_up)
}

function drop_blocked(name: FolderName): boolean {
    assert(name.length > 0)
    assert(name.trim() === name)

    const job = drag_job.value

    if (job === null) return false

    return folder_key(job.project ?? '') === folder_key(name)
}

function folder_at(point: DragPoint): FolderName | null {
    assert(Number.isFinite(point.x_px))
    assert(Number.isFinite(point.y_px))
    assert(drag_job.value !== null, 'a folder was looked up with no drag held')

    const element = document.elementFromPoint(point.x_px, point.y_px)
    const name = element?.closest(SELECTOR_FOLDER)?.getAttribute(ATTRIBUTE_FOLDER) ?? ''

    if (name.length === 0) return null
    if (drop_blocked(name)) return null

    return name
}

function pointer_move(event: PointerEvent): void {
    const pressed = press.value

    assert(event.type === 'pointermove')
    assert(pressed !== null, 'a pointer moved with no press held')

    if (event.pointerId !== pressed.pointer_id) return

    if ((event.buttons & BUTTONS_MAIN) === 0) {
        drag_end()

        return
    }

    const point = { x_px: event.clientX, y_px: event.clientY }

    if (drag_job.value === null) {
        const distance = Math.hypot(
            point.x_px - pressed.origin.x_px,
            point.y_px - pressed.origin.y_px,
        )

        if (distance < DISTANCE_DRAG_PX) return

        drag_job.value = pressed.job
    }

    drag_point.value = point
    drag_target.value = folder_at(point)
}

function pointer_up(event: PointerEvent): void {
    const pressed = press.value

    assert(event.type === 'pointerup')
    assert(pressed !== null, 'a pointer rose with no press held')

    if (event.pointerId !== pressed.pointer_id) return

    const job = drag_job.value
    const target = drag_target.value

    assert(job === null || job.id === pressed.job.id, 'the dragged job is not the pressed one')

    drag_end()

    if (job === null) return

    click_swallow_arm()

    if (target === null) return

    void folder_move(job, target).catch(error_dialog_show)
}
