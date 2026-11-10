import { createApp, shallowRef } from 'vue'
import App from './app.vue'
import { assert } from './lib/assert'
import { ipc } from './lib/ipc'
import { theme_apply_to_html, theme_resolve, theme_storage_read } from './lib/theme'
import './styles.css'


const FIELDS = 'input, textarea, [contenteditable]'
const USER_SELECT = '-webkit-user-select'


theme_apply_to_html(theme_resolve(theme_storage_read()))

if (import.meta.env.DEV) {
    if (!('__TAURI_INTERNALS__' in window)) {
        const { tauri_browser_mock_install } = await import('./lib/tauri_browser_mock')

        tauri_browser_mock_install()
    }
}

const resize_frame = shallowRef(0)
const selection_pressed = shallowRef<string | undefined>()

createApp(App).mount('#app')

window.addEventListener('click', main_selection_clear)
window.addEventListener('mousedown', main_press_note)
window.addEventListener('resize', main_resize_note)

if (!import.meta.env.DEV) {
    window.addEventListener('contextmenu', main_context_menu_limit)
}

function main_context_menu_limit(event: MouseEvent): void {
    assert(event.type === 'contextmenu')
    assert(event.cancelable)

    const { target } = event

    if (target instanceof HTMLInputElement) return
    if (target instanceof HTMLTextAreaElement) return

    if (target instanceof HTMLElement) {
        if (target.isContentEditable) return
    }

    event.preventDefault()
}

function main_press_note(event: MouseEvent): void {
    assert(event.type === 'mousedown')
    assert(event.cancelable)

    const { target } = event

    const unselectable = target instanceof Element
        && getComputedStyle(target).getPropertyValue(USER_SELECT) === 'none'

    selection_pressed.value = unselectable ? window.getSelection()?.toString() : undefined
}

function main_resize_note(event: UIEvent): void {
    assert(event.type === 'resize')
    assert(!event.cancelable)

    cancelAnimationFrame(resize_frame.value)
    resize_frame.value = requestAnimationFrame(main_resize_painted)
}

function main_resize_painted(time: DOMHighResTimeStamp): void {
    assert(Number.isFinite(time))
    assert(resize_frame.value !== 0)

    resize_frame.value = requestAnimationFrame(main_resize_rendered)
}

function main_resize_rendered(time: DOMHighResTimeStamp): void {
    assert(Number.isFinite(time))
    assert(resize_frame.value !== 0)

    resize_frame.value = 0
    const size = { height: window.innerHeight, width: window.innerWidth }

    void ipc.window_resize_rendered(size).catch(() => null)
}

function main_selection_clear(event: MouseEvent): void {
    assert(event.type === 'click')
    assert(event.cancelable)

    const selection = window.getSelection()

    if (selection?.toString() !== selection_pressed.value) return
    if (document.activeElement?.matches(FIELDS) === true) return

    selection?.removeAllRanges()
}
