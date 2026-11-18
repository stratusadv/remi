import { defineComponent, getCurrentInstance, h } from 'vue'
import { use_modal, use_modal_shown } from '../../src/composables/use_modal'
import { assert } from '../../src/lib/assert'
import { ATTACH_TO, mount_auto_unmount } from './fixtures'
import type { VueWrapper } from '@vue/test-utils'
import type { VNode } from 'vue'


const SELECTOR_FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), '
    + 'select:not(:disabled), textarea:not(:disabled), [tabindex]'


export function escape_press(): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    const target = focus_target()

    assert(target.isConnected)
    assert(target.closest('[inert]') === null)

    target.dispatchEvent(event)

    return event
}

export function modal_mount(): VueWrapper {
    assert(document.body.isConnected)

    const modal = defineComponent({ expose: [], setup: modal_setup, render: div_render })
    const wrapper = mount_auto_unmount(modal, { [ATTACH_TO]: document.body })

    assert(use_modal_shown().value)
    assert(wrapper.exists())

    return wrapper
}

export function pointer_press(target: Element): void {
    assert(target.isConnected)
    assert(target.closest('[inert]') === null)

    const focusable = target.closest<HTMLElement>(SELECTOR_FOCUSABLE)
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })

    target.dispatchEvent(event)

    if (event.defaultPrevented) return

    if (focusable === null) {
        focus_drop()

        return
    }

    focusable.focus()
}

function div_render(): VNode {
    assert(typeof h === 'function')
    assert(getCurrentInstance() !== null)

    return h('div')
}

function focus_drop(): void {
    const active = document.activeElement

    assert(active === null || active.isConnected)

    if (active instanceof HTMLElement) active.blur()

    assert(document.activeElement === null || document.activeElement === document.body)
}

function focus_target(): Element {
    const active = document.activeElement

    assert(active === null || active.isConnected)

    if (active === null) return document.body
    if (active.closest('[inert]') !== null) return document.body

    return active
}

function modal_setup(): void {
    assert(getCurrentInstance() !== null)

    void use_modal('dialog', () => true)

    assert(use_modal_shown().value)
}
