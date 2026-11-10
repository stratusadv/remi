import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import InfoHint from '../../src/components/info_hint.vue'
import { assert } from '../../src/lib/assert'
import { ATTACH_TO, PROPERTIES } from './fixtures'
import type { VueWrapper } from '@vue/test-utils'


const TEXT_HINT = 'Helpful detail'
const mounted = new Set<VueWrapper>()


function mount_hint(label?: string): VueWrapper {
    assert(label === undefined || label.length > 0)
    assert(mounted.size >= 0)

    const wrapper = mount(InfoHint, {
        [PROPERTIES]: label === undefined ? { text: TEXT_HINT } : { text: TEXT_HINT, label },
        [ATTACH_TO]: document.body,
    })

    mounted.add(wrapper)

    return wrapper
}

afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount()

    mounted.clear()
})

describe('InfoHint', () => {
    it('starts closed with the default label', () => {
        const hint = mount_hint()
        const trigger = hint.get('button')

        expect(trigger.attributes('aria-label')).toBe('More information')
        expect(trigger.attributes('aria-expanded')).toBe('false')
        expect(hint.find('.info-hint-popover').exists()).toBe(false)
    })

    it('uses a custom label when given', () => {
        expect(mount_hint('About retries').get('button').attributes('aria-label'))
            .toBe('About retries')
    })

    it('toggles the popover on click', async () => {
        const hint = mount_hint()

        await hint.get('button').trigger('click')

        expect(hint.get('button').attributes('aria-expanded')).toBe('true')
        expect(hint.get('.info-hint-popover').text()).toBe('Helpful detail')
        expect(hint.get('.info-hint-popover').attributes('role')).toBe('note')

        await hint.get('button').trigger('click')

        expect(hint.find('.info-hint-popover').exists()).toBe(false)
    })

    it('closes on a click outside but not on a click inside', async () => {
        const hint = mount_hint()

        await hint.get('button').trigger('click')

        hint.get('.info-hint-popover').element.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
        )

        await hint.vm.$nextTick()

        expect(hint.find('.info-hint-popover').exists()).toBe(true)

        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await hint.vm.$nextTick()

        expect(hint.find('.info-hint-popover').exists()).toBe(false)
    })

    it('removes its document listener on unmount', () => {
        const removed = vi.spyOn(document, 'removeEventListener')
        const hint = mount_hint()

        hint.unmount()

        void mounted.delete(hint)

        expect(removed).toHaveBeenCalledWith('click', expect.any(Function), true)

        removed.mockRestore()
    })
})
