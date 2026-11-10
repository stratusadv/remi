import { shallowRef } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import AppDialogHost from '../../src/components/app_dialog_host.vue'
import { use_dialog } from '../../src/composables/use_dialog'
import { assert } from '../../src/lib/assert'
import { ATTACH_TO } from './fixtures'
import type { VueWrapper } from '@vue/test-utils'


const dialog = use_dialog()
const host = shallowRef<VueWrapper | null>(null)


function dialog_element(): Element | null {
    assert(document.body.isConnected)
    assert(document.body.childElementCount >= 0)

    return document.body.querySelector('.app-dialog')
}

function key_press(key: string): KeyboardEvent {
    assert(key.length > 0)

    const event = new KeyboardEvent('keydown', { key, cancelable: true })

    window.dispatchEvent(event)

    assert(event.type === 'keydown')

    return event
}

beforeEach(() => {
    host.value = mount(AppDialogHost, { [ATTACH_TO]: document.body })
})

afterEach(() => {
    dialog.close(false)
    host.value?.unmount()
    host.value = null
    document.body.style.overflow = ''
})

describe('AppDialogHost', () => {
    it('renders nothing while no dialog is open', () => {
        expect(dialog_element()).toBeNull()
        expect(document.body.style.overflow).toBe('')
    })

    it('renders a confirm dialog with both buttons and locks scrolling', async () => {
        void dialog.confirm('Delete it?', { title: 'Delete recording', kind: 'warning' })
        await host.value?.vm.$nextTick()

        const element = dialog_element()

        expect(element?.getAttribute('data-kind')).toBe('warning')
        expect(element?.querySelector('.app-dialog-title')?.textContent).toBe('Delete recording')
        expect(element?.querySelector('.app-dialog-message')?.textContent).toBe('Delete it?')
        expect(element?.querySelector('.btn-default')?.textContent.trim()).toBe('Cancel')
        expect(element?.querySelector('.btn-danger')?.textContent.trim()).toBe('OK')
        expect(document.body.style.overflow).toBe('hidden')
    })

    it('renders a message dialog with only a primary button', async () => {
        void dialog.message('Saved.', { kind: 'info' })
        await host.value?.vm.$nextTick()

        const element = dialog_element()

        expect(element?.getAttribute('data-kind')).toBe('info')
        expect(element?.querySelector('.btn-default')).toBeNull()
        expect(element?.querySelector('.btn-primary')?.textContent.trim()).toBe('OK')
    })

    it('resolves true from the ok button and unlocks scrolling', async () => {
        const pending = dialog.confirm('Go?')

        await host.value?.vm.$nextTick()

        dialog_element()?.querySelector('.btn-danger')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
        )

        const answer = await pending


        expect(answer).toBe(true)

        await host.value?.vm.$nextTick()

        expect(dialog_element()).toBeNull()
        expect(document.body.style.overflow).toBe('')
    })
})

describe('AppDialogHost', () => {
    it('resolves false from cancel, the close button and the backdrop', async () => {
        const first = dialog.confirm('One')

        await host.value?.vm.$nextTick()

        dialog_element()?.querySelector('.btn-default')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
        )

        const answer_first = await first


        expect(answer_first).toBe(false)

        const second = dialog.confirm('Two')

        await host.value?.vm.$nextTick()

        dialog_element()?.querySelector('.app-dialog-close')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
        )

        const answer_second = await second


        expect(answer_second).toBe(false)

        const third = dialog.confirm('Three')

        await host.value?.vm.$nextTick()

        document.body.querySelector('.app-dialog-backdrop')?.dispatchEvent(
            new MouseEvent('mousedown', { bubbles: true }),
        )

        const answer_third = await third


        expect(answer_third).toBe(false)
    })

    it('does not close when a drag only ends on the backdrop', async () => {
        void dialog.confirm('Stay')

        await host.value?.vm.$nextTick()

        document.body.querySelector('.app-dialog-backdrop')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
        )

        await host.value?.vm.$nextTick()

        expect(dialog.current.value).not.toBeNull()

        dialog.close(false)
    })

    it('does not close when the dialog body itself is clicked', async () => {
        void dialog.confirm('Stay')

        await host.value?.vm.$nextTick()
        dialog_element()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await host.value?.vm.$nextTick()

        expect(dialog_element()).not.toBeNull()
    })
})

describe('AppDialogHost', () => {
    it('answers escape with false and enter with true', async () => {
        const first = dialog.confirm('Escape me')

        await host.value?.vm.$nextTick()

        const escape = key_press('Escape')

        const answer_first = await first


        expect(answer_first).toBe(false)
        expect(escape.defaultPrevented).toBe(true)

        const second = dialog.confirm('Enter me')

        await host.value?.vm.$nextTick()

        const enter = key_press('Enter')

        const answer_second = await second


        expect(answer_second).toBe(true)
        expect(enter.defaultPrevented).toBe(true)
    })

    it('ignores keys while no dialog is open', () => {
        expect(key_press('Escape').defaultPrevented).toBe(false)
        expect(key_press('Enter').defaultPrevented).toBe(false)
    })

    it('stops handling keys after unmount', async () => {
        host.value?.unmount()
        host.value = null

        const pending = dialog.confirm('Orphan')

        expect(key_press('Enter').defaultPrevented).toBe(false)

        dialog.close(false)

        const answer = await pending


        expect(answer).toBe(false)
    })
})
