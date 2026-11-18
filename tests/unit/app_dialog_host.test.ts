import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import AppDialogHost from '../../src/components/app_dialog_host.vue'
import ContextMenu from '../../src/components/context_menu.vue'
import { use_context_menu } from '../../src/composables/use_context_menu'
import { use_dialog } from '../../src/composables/use_dialog'
import { use_modal_shown } from '../../src/composables/use_modal'
import { assert } from '../../src/lib/assert'
import { MENU_ITEM_COPY } from '../../src/lib/menu'
import { ATTACH_TO, IS_COMPOSING, mount_auto_unmount } from './fixtures'
import type { VueWrapper } from '@vue/test-utils'


const context_menu = use_context_menu()
const dialog = use_dialog()
const modal_shown = use_modal_shown()


function dialog_element(): Element | null {
    assert(document.body.isConnected)
    assert(document.body.querySelectorAll('.app-dialog').length <= 1)

    return document.body.querySelector('.app-dialog')
}

function host_mount(animated = false): VueWrapper {
    assert(dialog.current.value === null)
    assert(document.body.style.overflow === '')
    assert(typeof animated === 'boolean')

    const host = mount_auto_unmount(AppDialogHost, {
        [ATTACH_TO]: document.body,
        global: { stubs: { transition: !animated } },
    })

    return host
}

function key_event(key: string, composing: boolean): KeyboardEvent {
    assert(key.length > 0)
    assert(typeof composing === 'boolean')

    return new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        [IS_COMPOSING]: composing,
        key,
    })
}

function key_press(key: string): KeyboardEvent {
    assert(key.length > 0)

    const event = new KeyboardEvent('keydown', { key, cancelable: true })

    window.dispatchEvent(event)

    assert(event.type === 'keydown')

    return event
}

function menu_escape_press(): KeyboardEvent {
    assert(context_menu.menu.value === null)
    assert(dialog.current.value !== null)

    menu_show()

    const escape = key_press('Escape')

    context_menu.close()

    return escape
}

async function menu_select(id: string): Promise<void> {
    assert(id.length > 0)
    assert(id !== MENU_ITEM_COPY.id)

    return Promise.resolve()
}

function menu_show(): void {
    assert(context_menu.menu.value === null)

    context_menu.menu.value = {
        items: [{ id: 'copy', label: 'Copy', icon: 'copy' }],
        point: { x_px: 10, y_px: 10 },
        select: menu_select,
        selection: '',
    }

    assert(context_menu.menu.value.items.length === 1)
}

function page_listener(underneath: string[], event: KeyboardEvent): void {
    assert(underneath.every((key) => key.length > 0))
    assert(event.type === 'keydown')

    underneath.push(event.key)
}

beforeEach(() => {
    onTestFinished(() => {
        document.body.style.overflow = ''
    })
})

afterEach(() => {
    context_menu.close()
    dialog.close(false)
})

describe('AppDialogHost', () => {
    it('renders nothing while no dialog is open', () => {
        void host_mount()

        expect(dialog_element()).toBeNull()
        expect(document.body.style.overflow).toBe('')
    })

    it('renders a confirm dialog with both buttons and locks scrolling', async () => {
        const host = host_mount()

        void dialog.confirm('Delete it?', { title: 'Delete recording', kind: 'warning' })
        await host.vm.$nextTick()

        const element = dialog_element()

        expect(element?.getAttribute('data-kind')).toBe('warning')
        expect(element?.querySelector('.app-dialog-title')?.textContent).toBe('Delete recording')
        expect(element?.querySelector('.app-dialog-message')?.textContent).toBe('Delete it?')
        expect(element?.querySelector('.btn-default')?.textContent.trim()).toBe('Cancel')
        expect(element?.querySelector('.btn-danger')?.textContent.trim()).toBe('OK')
        expect(document.body.style.overflow).toBe('hidden')
    })

    it('renders a message dialog with only a primary button', async () => {
        const host = host_mount()

        void dialog.message('Saved.', { kind: 'info' })
        await host.vm.$nextTick()

        const element = dialog_element()

        expect(element?.getAttribute('data-kind')).toBe('info')
        expect(element?.querySelector('.btn-default')).toBeNull()
        expect(element?.querySelector('.btn-primary')?.textContent.trim()).toBe('OK')
    })

    it('resolves true from the ok button and unlocks scrolling', async () => {
        const host = host_mount()
        const pending = dialog.confirm('Go?')

        await host.vm.$nextTick()

        dialog_element()?.querySelector('.btn-danger')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
        )

        const answer = await pending

        expect(answer).toBe(true)

        await host.vm.$nextTick()

        expect(dialog_element()).toBeNull()
        expect(document.body.style.overflow).toBe('')
    })
})

describe('AppDialogHost', () => {
    it('resolves false from cancel, the close button and the backdrop', async () => {
        const host = host_mount()
        const first = dialog.confirm('One')

        await host.vm.$nextTick()

        dialog_element()?.querySelector('.btn-default')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
        )

        const answer_first = await first

        expect(answer_first).toBe(false)

        const second = dialog.confirm('Two')

        await host.vm.$nextTick()

        dialog_element()?.querySelector('.app-dialog-close')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
        )

        const answer_second = await second

        expect(answer_second).toBe(false)

        const third = dialog.confirm('Three')

        await host.vm.$nextTick()

        document.body.querySelector('.app-dialog-backdrop')?.dispatchEvent(
            new MouseEvent('mousedown', { bubbles: true }),
        )

        const answer_third = await third

        expect(answer_third).toBe(false)
    })

    it('does not close when a drag only ends on the backdrop', async () => {
        const host = host_mount()

        void dialog.confirm('Stay')

        await host.vm.$nextTick()

        document.body.querySelector('.app-dialog-backdrop')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
        )

        await host.vm.$nextTick()

        expect(dialog.current.value).not.toBeNull()

        dialog.close(false)
    })

    it('does not close when the dialog body itself is clicked', async () => {
        const host = host_mount()

        void dialog.confirm('Stay')

        await host.vm.$nextTick()
        dialog_element()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await host.vm.$nextTick()

        expect(dialog_element()).not.toBeNull()
    })
})

describe('AppDialogHost', () => {
    it('answers escape with false and enter with true', async () => {
        const host = host_mount()
        const first = dialog.confirm('Escape me')

        await host.vm.$nextTick()

        const escape = key_press('Escape')

        const answer_first = await first

        expect(answer_first).toBe(false)
        expect(escape.defaultPrevented).toBe(true)

        const second = dialog.confirm('Enter me')

        await host.vm.$nextTick()

        const enter = key_press('Enter')

        const answer_second = await second

        expect(answer_second).toBe(true)
        expect(enter.defaultPrevented).toBe(true)
    })

    it('focuses the prompt field with its text selected so typing replaces it', async () => {
        void host_mount()
        void dialog.prompt('Folder name', 'Acme', { title: 'Rename folder' })

        await flushPromises()

        const field = document.body.querySelector<HTMLInputElement>('.app-dialog-input')

        expect(field).not.toBeNull()
        expect(document.activeElement).toBe(field)
        expect(field?.selectionStart).toBe(0)
        expect(field?.selectionEnd).toBe('Acme'.length)

        key_press('Escape')

        expect(dialog.current.value).toBeNull()
    })

    it('ignores keys while no dialog is open', () => {
        void host_mount()

        expect(key_press('Escape').defaultPrevented).toBe(false)
        expect(key_press('Enter').defaultPrevented).toBe(false)
    })

    it('stops handling keys after unmount', async () => {
        host_mount().unmount()

        const pending = dialog.confirm('Orphan')

        expect(key_press('Enter').defaultPrevented).toBe(false)

        dialog.close(false)

        const answer = await pending

        expect(answer).toBe(false)
    })
})

describe('AppDialogHost over other layers', () => {
    it('takes Escape and Enter before a modal underneath can act on them', async () => {
        const host = host_mount()
        const underneath: string[] = []
        const listener = page_listener.bind(null, underneath)

        document.body.addEventListener('keydown', listener)

        const pending = dialog.confirm('On top')

        await host.vm.$nextTick()

        const escape = key_event('Escape', false)

        document.body.dispatchEvent(escape)

        const answer = await pending

        document.body.dispatchEvent(key_event('Escape', false))
        document.body.removeEventListener('keydown', listener)

        expect(answer).toBe(false)
        expect(escape.defaultPrevented).toBe(true)
        expect(underneath).toEqual(['Escape'])
    })

    it('leaves keys to a context menu open above it and to a word being composed', async () => {
        const host = host_mount()
        const pending = dialog.confirm('Under a menu')

        await host.vm.$nextTick()

        const menu_escape = menu_escape_press()
        const composing = key_event('Enter', true)

        window.dispatchEvent(composing)

        expect([menu_escape.defaultPrevented, composing.defaultPrevented]).toEqual([false, false])
        expect(dialog.current.value).not.toBeNull()

        key_press('Enter')

        const answer = await pending

        expect(answer).toBe(true)
    })
})

describe('AppDialogHost as a modal', () => {
    it('makes the fading dialog inert so a late click cannot answer it again', async () => {
        const host = host_mount(true)

        void dialog.confirm('Fade out')
        await host.vm.$nextTick()

        const leaving = document.body.querySelector<HTMLElement>('.app-dialog-host')

        assert(leaving !== null)

        expect(modal_shown.value).toBe(true)
        expect(leaving.inert).toBe(false)

        dialog.close(true)
        await nextTick()

        expect(modal_shown.value).toBe(false)
        expect(leaving.isConnected).toBe(true)
        expect(leaving.inert).toBe(true)

        await vi.waitFor(() => {
            assert(!leaving.isConnected)
        })
    })

    it('gives focus back to the element that had it once the dialog closes', async () => {
        const invoker = document.createElement('button')

        onTestFinished(() => {
            invoker.remove()
        })

        document.body.append(invoker)
        invoker.focus()

        const host = host_mount()

        void dialog.confirm('Return focus')
        await host.vm.$nextTick()
        invoker.blur()
        dialog.close(true)
        await flushPromises()

        expect(document.activeElement).toBe(invoker)
    })

    it('closes a context menu that is open when it opens', async () => {
        const host = host_mount()

        void mount_auto_unmount(ContextMenu, { [ATTACH_TO]: document.body })
        menu_show()
        await host.vm.$nextTick()

        expect(document.body.querySelector('.menu-popover-context')).not.toBeNull()

        void dialog.confirm('Over a menu')
        await host.vm.$nextTick()

        expect(context_menu.menu.value).toBeNull()
        expect(document.body.querySelector('.menu-popover-context')).toBeNull()
        expect(dialog_element()).not.toBeNull()
    })
})
