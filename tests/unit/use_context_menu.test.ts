import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { context_menu_listen, use_context_menu } from '../../src/composables/use_context_menu'
import { use_dialog } from '../../src/composables/use_dialog'
import { assert } from '../../src/lib/assert'
import { MENU_ITEM_ASK, MENU_ITEM_COPY, MENU_ITEM_DELETE } from '../../src/lib/menu'
import { WRITE_TEXT } from './fixtures'
import type { MenuItem } from '../../src/lib/menu'


const CLIENT_X = 'clientX'
const CLIENT_Y = 'clientY'
const POINT_X_PX = 120
const POINT_Y_PX = 80
const SELECTED = 'ship the retry work'
const SHIFT_KEY = 'shiftKey'
const dialog = use_dialog()
const menu_state = use_context_menu()
const select = vi.fn<(id: string) => Promise<void>>()
const write_text = vi.fn<(text: string) => Promise<void>>()


function host_build(tag: string, items: readonly MenuItem[]): HTMLElement {
    assert(tag.length > 0)
    assert(items.length > 0)

    const host = document.createElement(tag)

    host.textContent = `${SELECTED} this week`
    host.addEventListener('contextmenu', menu_open.bind(undefined, items))
    document.body.append(host)

    return host
}

function menu_open(items: readonly MenuItem[], event: MouseEvent): void {
    assert(event.type === 'contextmenu')
    assert(items.length > 0)

    menu_state.open(event, items, select)
}

function right_click(target: Element, init: MouseEventInit = {}): MouseEvent {
    assert(target.isConnected)
    assert(init.bubbles === undefined)
    assert(menu_state.menu.value === null)

    const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        [CLIENT_X]: POINT_X_PX,
        [CLIENT_Y]: POINT_Y_PX,
        ...init,
    })

    target.dispatchEvent(event)

    return event
}

function selection_set(host: HTMLElement): void {
    assert(host.firstChild !== null)
    assert(host.textContent.startsWith(SELECTED))

    const range = document.createRange()

    range.setStart(host.firstChild, 0)
    range.setEnd(host.firstChild, SELECTED.length)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
}

beforeAll(() => {
    context_menu_listen()
})

beforeEach(() => {
    vi.resetAllMocks()
    select.mockResolvedValue(undefined)
    write_text.mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { [WRITE_TEXT]: write_text } })
})

afterEach(() => {
    menu_state.close()
    dialog.close(false)
    window.getSelection()?.removeAllRanges()
    document.body.replaceChildren()
    vi.unstubAllGlobals()
})

describe('the context menu', () => {
    it('replaces the native menu with the items for what was clicked', () => {
        const event = right_click(host_build('p', [MENU_ITEM_ASK]))

        expect(event.defaultPrevented).toBe(true)
        expect(menu_state.menu.value?.items).toEqual([MENU_ITEM_ASK])
        expect(menu_state.menu.value?.point).toEqual({ x_px: POINT_X_PX, y_px: POINT_Y_PX })
    })

    it('runs the chosen item once and closes', async () => {
        void right_click(host_build('p', [MENU_ITEM_ASK]))

        await menu_state.choose(MENU_ITEM_ASK.id)

        expect(select).toHaveBeenCalledTimes(1)
        expect(select).toHaveBeenCalledWith(MENU_ITEM_ASK.id)
        expect(write_text).not.toHaveBeenCalled()
        expect(menu_state.menu.value).toBeNull()
    })

    it('offers Copy first when text is selected and copies only the selection', async () => {
        const host = host_build('p', [MENU_ITEM_ASK])

        selection_set(host)
        void right_click(host)

        expect(menu_state.menu.value?.items).toEqual([MENU_ITEM_COPY, MENU_ITEM_ASK])

        await menu_state.choose(MENU_ITEM_COPY.id)

        expect(write_text).toHaveBeenCalledWith(SELECTED)
        expect(select).not.toHaveBeenCalled()
    })

    it('tells the person when the chosen item fails', async () => {
        select.mockRejectedValue(new Error('config error: this chat was deleted'))
        void right_click(host_build('p', [MENU_ITEM_ASK]))

        const chosen = menu_state.choose(MENU_ITEM_ASK.id)

        await flushPromises()

        expect(dialog.current.value?.message).toContain('this chat was deleted')

        dialog.close(false)
        await chosen
    })

    it('opens under the element when the keyboard asks for the menu', () => {
        const host = host_build('button', [MENU_ITEM_ASK])

        vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 20, 100, 30))
        void right_click(host, { [CLIENT_X]: 0, [CLIENT_Y]: 0 })

        expect(menu_state.menu.value?.point).toEqual({ x_px: 40, y_px: 50 })
    })
})

describe('the context menu', () => {
    it('keeps the menu of the innermost host when the event bubbles through an outer one', () => {
        const outer = host_build('section', [MENU_ITEM_DELETE])
        const inner = host_build('p', [MENU_ITEM_ASK])

        outer.append(inner)

        const event = right_click(inner)

        expect(event.defaultPrevented).toBe(true)
        expect(menu_state.menu.value?.items).toEqual([MENU_ITEM_ASK])

        menu_state.close()
        void right_click(outer)

        expect(menu_state.menu.value?.items).toEqual([MENU_ITEM_DELETE])
    })
})

describe('the native menu', () => {
    it('stays in text fields so paste and spelling suggestions keep working', () => {
        const editable = host_build('div', [MENU_ITEM_ASK])

        editable.contentEditable = 'true'

        const input = host_build('input', [MENU_ITEM_ASK])
        const textarea = host_build('textarea', [MENU_ITEM_ASK])
        const events = [input, textarea, editable].map((field) => right_click(field))

        expect(events.map((event) => event.defaultPrevented)).toEqual([false, false, false])
        expect(menu_state.menu.value).toBeNull()
    })

    it('stays on Shift+right-click in development for Inspect Element', () => {
        const event = right_click(host_build('p', [MENU_ITEM_ASK]), { [SHIFT_KEY]: true })

        expect(import.meta.env.DEV).toBe(true)
        expect(event.defaultPrevented).toBe(false)
        expect(menu_state.menu.value).toBeNull()
    })

    it('is suppressed everywhere else without showing an empty menu', () => {
        const plain = document.createElement('section')

        document.body.append(plain)

        const event = right_click(plain)

        expect(event.defaultPrevented).toBe(true)
        expect(menu_state.menu.value).toBeNull()
    })
})
