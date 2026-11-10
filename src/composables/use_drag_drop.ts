import { onMounted, onUnmounted, ref, shallowRef } from 'vue'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { assert, unreachable } from '../lib/assert'
import { path_is_media } from '../lib/media'
import { use_batch_transcribe } from './use_batch_transcribe'
import { use_pipeline } from './use_pipeline'
import type { Ref } from 'vue'
import type { Event, UnlistenFn } from '@tauri-apps/api/event'
import type { DragDropEvent } from '@tauri-apps/api/webviewWindow'


const dragging_over = ref(false)
const listener = shallowRef<UnlistenFn | null>(null)
const registration_count = ref(0)


export function use_drag_drop(): { dragging_over: Ref<boolean> } {
    assert(registration_count.value >= 0)
    assert(typeof dragging_over.value === 'boolean')

    onMounted(listener_register)
    onUnmounted(listener_release)

    return { dragging_over }
}

function drag_drop_event_apply(event: Event<DragDropEvent>): void {
    assert(event.payload.type.length > 0)
    assert(typeof dragging_over.value === 'boolean')

    const { payload } = event

    switch (payload.type) {
        case 'enter':
        case 'over':
            dragging_over.value = true

            return
        case 'leave':
            dragging_over.value = false

            return
        case 'drop':
            dragging_over.value = false

            paths_dropped(payload.paths)

            return
        default:
            unreachable(payload)
    }
}

async function listener_register(): Promise<void> {
    assert(registration_count.value >= 0)
    assert(listener.value === null || registration_count.value > 0)

    if (listener.value !== null) {
        registration_count.value += 1

        return
    }

    const window = getCurrentWebviewWindow()

    return window.onDragDropEvent(drag_drop_event_apply).then((unlisten) => {
        listener.value = unlisten
        registration_count.value += 1
    })
}

function listener_release(): void {
    assert(registration_count.value >= 0)
    assert(listener.value === null || registration_count.value > 0)

    registration_count.value -= 1

    if (registration_count.value > 0) return

    registration_count.value = 0

    if (listener.value === null) return

    listener.value()
    listener.value = null
}

function paths_dropped(paths: string[]): void {
    assert(Array.isArray(paths))

    const { source_path, transcript, job_id_current, view_set } = use_pipeline()
    const { enqueue } = use_batch_transcribe()
    const media_paths = paths.filter(path_is_media)

    assert(media_paths.length <= paths.length)

    if (media_paths.length === 0) return

    if (media_paths.length === 1) {
        source_path.value = media_paths[0] ?? null
        transcript.value = null
        job_id_current.value = null

        view_set('transcribe')

        return
    }

    void enqueue(media_paths)
}
