import { PhysicalPosition } from '@tauri-apps/api/dpi'
import { defineComponent, getCurrentInstance, h } from 'vue'
import { use_drag_drop } from '../../src/composables/use_drag_drop'
import { assert } from '../../src/lib/assert'
import type { EventCallback } from '@tauri-apps/api/event'
import type { DragDropEvent } from '@tauri-apps/api/webviewWindow'
import type { Mock } from 'vitest'
import type { DefineComponent, VNode } from 'vue'


export type DragDropListen = Mock<(handler: EventCallback<DragDropEvent>) => Promise<() => void>>

const EVENT_DRAG_DROP = 'tauri://drag-drop'
const PATHS_DROPPED_MAX = 256


export function drop_host(): DefineComponent {
    assert(typeof use_drag_drop === 'function')
    assert(typeof defineComponent === 'function')

    return defineComponent({
        setup() {
            assert(getCurrentInstance() !== null)

            use_drag_drop()

            return div_render
        },
    })
}

export function paths_drop(listen: DragDropListen, paths: string[]): void {
    assert(listen.mock.calls.length > 0)
    assert(paths.length > 0)
    assert(paths.length <= PATHS_DROPPED_MAX)

    const handler = listen.mock.lastCall?.[0]

    assert(handler !== undefined, 'nothing listens for drag and drop')

    handler({
        event: EVENT_DRAG_DROP,
        id: 1,
        payload: { type: 'drop', paths, position: new PhysicalPosition(0, 0) },
    })
}

function div_render(): VNode {
    assert(typeof h === 'function')
    assert(getCurrentInstance() !== null)

    return h('div')
}
