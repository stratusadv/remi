import { ref } from 'vue'
import { assert } from '../lib/assert'
import { error_dialog_show } from '../lib/errors'
import { MENU_ITEM_COPY } from '../lib/menu'
import type { MenuItem } from '../lib/menu'


export type MenuSelect = (id: string) => Promise<void>

export interface MenuPoint {
    x_px: number
    y_px: number
}

export interface MenuShown {
    items: readonly MenuItem[]
    point: MenuPoint
    select: MenuSelect
    selection: string
}

const ITEMS_MAX = 12
const menu = ref<MenuShown | null>(null)
const api = Object.freeze({ menu, choose, close, open })


export function context_menu_listen(): void {
    assert(typeof window.addEventListener === 'function')
    assert(menu.value === null)

    window.addEventListener('contextmenu', context_menu_fallback)
}

export function use_context_menu(): typeof api {
    assert(Object.isFrozen(api))
    assert(menu.value === null || menu.value.items.length > 0)

    return api
}

async function choose(id: string): Promise<void> {
    assert(id.length > 0)

    const shown = menu.value

    if (shown === null) return

    assert(shown.items.some((item) => item.id === id))

    menu.value = null

    const chosen = id === MENU_ITEM_COPY.id
        ? navigator.clipboard.writeText(shown.selection)
        : shown.select(id)

    return chosen.catch(error_dialog_show)
}

function close(): void {
    assert(menu.value === null || menu.value.items.length > 0)

    menu.value = null
}

function context_menu_fallback(event: MouseEvent): void {
    assert(event.type === 'contextmenu')
    assert(event.target !== null)

    if (event.defaultPrevented) return

    open(event, [], select_none)
}

function field_targeted(event: MouseEvent): boolean {
    assert(event.type === 'contextmenu')
    assert(event.target !== null)

    const { target } = event

    if (target instanceof HTMLInputElement) return true
    if (target instanceof HTMLTextAreaElement) return true
    if (target instanceof HTMLElement) return target.isContentEditable

    return false
}

function native_requested(event: MouseEvent): boolean {
    assert(event.type === 'contextmenu')

    if (!import.meta.env.DEV) return false

    return event.shiftKey
}

function open(event: MouseEvent, items: readonly MenuItem[], select: MenuSelect): void {
    assert(event.type === 'contextmenu')
    assert(items.length <= ITEMS_MAX)
    assert(typeof select === 'function')

    if (event.defaultPrevented) return
    if (field_targeted(event)) return
    if (native_requested(event)) return

    event.preventDefault()

    assert(event.defaultPrevented, 'a context menu event the browser cannot cancel')

    const selection = window.getSelection()?.toString().trim() ?? ''
    const shown = selection.length > 0 ? [MENU_ITEM_COPY, ...items] : items

    if (shown.length === 0) {
        menu.value = null

        return
    }

    menu.value = { items: shown, point: point_of(event), select, selection }
}

function point_of(event: MouseEvent): MenuPoint {
    assert(Number.isFinite(event.clientX))
    assert(Number.isFinite(event.clientY))

    const pointed = { x_px: event.clientX, y_px: event.clientY }
    const { target } = event

    if (event.clientX !== 0) return pointed
    if (event.clientY !== 0) return pointed
    if (!(target instanceof Element)) return pointed

    const rect = target.getBoundingClientRect()

    return { x_px: rect.left, y_px: rect.bottom }
}

async function select_none(id: string): Promise<void> {
    assert(id.length > 0)
    assert(id !== MENU_ITEM_COPY.id)

    return Promise.reject(new Error(`No action is set for the menu item ${id}.`))
}
