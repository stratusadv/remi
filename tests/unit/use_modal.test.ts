import { defineComponent, h, nextTick, shallowRef } from 'vue'
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import { use_modal, use_modal_shown } from '../../src/composables/use_modal'
import { assert } from '../../src/lib/assert'
import { ATTACH_TO, mount_auto_unmount } from './fixtures'
import type { DefineComponent, Ref, VNode } from 'vue'
import type { VueWrapper } from '@vue/test-utils'
import type { ModalLayer } from '../../src/composables/use_modal'


interface ModalProbe {
    layer: ModalLayer
    shown: Ref<boolean>
}

const modal_shown = use_modal_shown()


function covered(wrapper: VueWrapper): boolean {
    assert(!wrapper.vm.$.isUnmounted)

    const value = wrapper.get('div').attributes('data-covered')

    assert(value === 'true' || value === 'false')

    return value === 'true'
}

function probe_component(probe: ModalProbe): DefineComponent {
    assert(typeof probe.shown.value === 'boolean')
    assert(probe.layer.length > 0)

    return defineComponent({
        setup() {
            const modal_covered = use_modal(probe.layer, () => probe.shown.value)

            assert(typeof modal_covered.value === 'boolean')

            return (): VNode => h('div', { 'data-covered': String(modal_covered.value) })
        },
    })
}

function probe_mount(layer: ModalLayer, shown: boolean): ModalProbe & { wrapper: VueWrapper } {
    assert(layer.length > 0)
    assert(typeof shown === 'boolean')

    const probe = { layer, shown: shallowRef(shown) }
    const wrapper = mount_auto_unmount(probe_component(probe), { [ATTACH_TO]: document.body })

    assert(wrapper.vm.$.isMounted)

    return { ...probe, wrapper }
}

beforeEach(() => {
    onTestFinished(() => {
        document.body.innerHTML = ''
    })

    assert(!modal_shown.value)
})

describe('use_modal', () => {
    it('stacks dialogs in the order they open and keeps the host above every dialog', async () => {
        const first = probe_mount('dialog', true)
        const host = probe_mount('host', false)
        const second = probe_mount('dialog', false)

        host.shown.value = true
        second.shown.value = true
        await nextTick()

        expect([covered(first.wrapper), covered(second.wrapper), covered(host.wrapper)])
            .toEqual([true, true, false])

        host.shown.value = false
        await nextTick()

        expect([covered(first.wrapper), covered(second.wrapper)]).toEqual([true, false])

        second.shown.value = false
        await nextTick()

        expect(covered(first.wrapper)).toBe(false)
        expect(modal_shown.value).toBe(true)

        first.shown.value = false
        await nextTick()

        expect(modal_shown.value).toBe(false)
    })

    it('uncovers the dialog below when the one above it unmounts while open', async () => {
        const below = probe_mount('dialog', true)
        const above = probe_mount('dialog', true)

        await nextTick()

        expect(covered(below.wrapper)).toBe(true)

        above.wrapper.unmount()
        await nextTick()

        expect(covered(below.wrapper)).toBe(false)
        expect(modal_shown.value).toBe(true)
    })

    it('refuses a fourth modal open at once', async () => {
        const opened = [probe_mount('dialog', true), probe_mount('dialog', true)]
        const host = probe_mount('host', true)

        expect(() => probe_mount('dialog', true)).toThrow('more modals are open than the app')

        await nextTick()

        expect(opened.map((probe) => covered(probe.wrapper))).toEqual([true, true])
        expect(covered(host.wrapper)).toBe(false)
    })
})
