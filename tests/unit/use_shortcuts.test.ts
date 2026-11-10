import { KeepAlive, defineComponent, h, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { use_shortcuts } from '../../src/composables/use_shortcuts'
import { assert } from '../../src/lib/assert'
import { ALT_KEY, ATTACH_TO, CTRL_KEY, META_KEY, SHIFT_KEY } from './fixtures'
import type { ComponentOptions, DefineComponent, Ref, VNode } from 'vue'
import type { VueWrapper } from '@vue/test-utils'


const KEY_S = 's'
const mounted = new Set<VueWrapper>()


type Handler = (event: KeyboardEvent) => void

function div_render(): VNode {
    assert(typeof h === 'function')
    assert(mounted.size >= 0)

    return h('div')
}

function element_attach<Target extends HTMLElement>(element: Target): Target {
    assert(element instanceof HTMLElement)

    document.body.appendChild(element)

    assert(element.isConnected)

    return element
}

function keep_alive_host(child: DefineComponent, shown: Ref<boolean>): ComponentOptions {
    assert(typeof child === 'object')
    assert(typeof shown.value === 'boolean')

    return {
        render() {
            assert(typeof shown.value === 'boolean')
            assert(typeof child === 'object')

            return h(KeepAlive, null, () => (shown.value ? h(child) : null))
        },
    }
}

function key_press(
    key: string,
    modifiers: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>> = {},
    target: EventTarget = window,
): KeyboardEvent {
    assert(key.length > 0)
    assert(typeof modifiers === 'object')
    assert(typeof target.dispatchEvent === 'function')

    const init = { key, bubbles: true, cancelable: true, ...modifiers }
    const event = new KeyboardEvent('keydown', init)

    target.dispatchEvent(event)

    return event
}

function mount_shortcuts(shortcuts: Record<string, Handler>): VueWrapper {
    assert(typeof shortcuts === 'object')
    assert(mounted.size >= 0)

    const wrapper = mount(shortcut_component(shortcuts), { [ATTACH_TO]: document.body })

    mounted.add(wrapper)

    return wrapper
}

function shortcut_component(shortcuts: Record<string, Handler>): DefineComponent {
    assert(typeof shortcuts === 'object')
    assert(Object.keys(shortcuts).length > 0)

    return defineComponent({
        setup() {
            assert(typeof shortcuts === 'object')
            assert(Object.keys(shortcuts).length > 0)

            use_shortcuts(shortcuts)
        },
        render: div_render,
    })
}

afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount()

    mounted.clear()
    document.body.innerHTML = ''
})

describe('use_shortcuts', () => {
    it('runs the handler for a plain key and prevents the default', () => {
        const handler = vi.fn()

        mount_shortcuts({ [KEY_S]: handler })

        const event = key_press('S')

        expect(handler).toHaveBeenCalledWith(event)
        expect(event.defaultPrevented).toBe(true)
    })

    it('builds the combo as ctrl, shift, alt then the key', () => {
        const handler = vi.fn()

        mount_shortcuts({ 'ctrl+shift+alt+k': handler })
        key_press('k', { [CTRL_KEY]: true, [SHIFT_KEY]: true, [ALT_KEY]: true })

        expect(handler).toHaveBeenCalledTimes(1)
    })

    it('treats the meta key as ctrl', () => {
        const handler = vi.fn()

        mount_shortcuts({ 'ctrl+n': handler })
        key_press('n', { [META_KEY]: true })

        expect(handler).toHaveBeenCalledTimes(1)
    })

    it('names the space bar space', () => {
        const handler = vi.fn()

        mount_shortcuts({ space: handler })
        key_press(' ')

        expect(handler).toHaveBeenCalledTimes(1)
    })

    it('leaves an unregistered key untouched', () => {
        void mount_shortcuts({ [KEY_S]: vi.fn() })

        const event = key_press('x')

        expect(event.defaultPrevented).toBe(false)
    })

    it('ignores plain keys typed into text inputs, textareas and editable elements', () => {
        const handler = vi.fn()

        mount_shortcuts({ [KEY_S]: handler })

        const input = element_attach(document.createElement('input'))
        const textarea = element_attach(document.createElement('textarea'))
        const editable = element_attach(document.createElement('div'))

        editable.contentEditable = 'true'

        key_press('s', {}, input)
        key_press('s', {}, textarea)
        key_press('s', {}, editable)

        expect(handler).not.toHaveBeenCalled()
    })
})

describe('use_shortcuts', () => {
    it('still fires a ctrl combo from inside a text input', () => {
        const handler = vi.fn()

        mount_shortcuts({ 'ctrl+s': handler })

        const input = element_attach(document.createElement('input'))

        key_press('s', { [CTRL_KEY]: true }, input)

        expect(handler).toHaveBeenCalledTimes(1)
    })

    it('fires a plain key from a non-text input such as a checkbox', () => {
        const handler = vi.fn()

        mount_shortcuts({ [KEY_S]: handler })

        const checkbox = element_attach(document.createElement('input'))

        checkbox.type = 'checkbox'
        key_press('s', {}, checkbox)

        expect(handler).toHaveBeenCalledTimes(1)
    })

    it('gives the most recently mounted registration priority and restores on unmount', () => {
        const first = vi.fn()
        const second = vi.fn()

        mount_shortcuts({ [KEY_S]: first })

        const wrapper_second = mount_shortcuts({ [KEY_S]: second })

        key_press('s')

        expect(first).not.toHaveBeenCalled()
        expect(second).toHaveBeenCalledTimes(1)

        wrapper_second.unmount()

        void mounted.delete(wrapper_second)

        key_press('s')

        expect(first).toHaveBeenCalledTimes(1)
        expect(second).toHaveBeenCalledTimes(1)
    })
})

describe('use_shortcuts', () => {
    it('unregisters while deactivated in KeepAlive and re-registers on activation', async () => {
        const handler = vi.fn()
        const shown = ref(true)
        const child = shortcut_component({ [KEY_S]: handler })

        mounted.add(mount(keep_alive_host(child, shown), { [ATTACH_TO]: document.body }))
        key_press('s')

        expect(handler).toHaveBeenCalledTimes(1)

        shown.value = false
        await nextTick()
        key_press('s')

        expect(handler).toHaveBeenCalledTimes(1)

        shown.value = true
        await nextTick()
        key_press('s')

        expect(handler).toHaveBeenCalledTimes(2)
    })
})
