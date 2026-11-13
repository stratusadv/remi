import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CheckoutOffers from '../../src/components/checkout_offers.vue'
import { assert } from '../../src/lib/assert'
import { ATTACH_TO, PROPERTIES, TO_FAKE } from './fixtures'
import type { DOMWrapper, VueWrapper } from '@vue/test-utils'
import type { AccountOffer } from '../../src/types'


const BALANCE_SECONDS = 5400
const CONSIDER_DELAY_MS = 200

const OFFERS = Object.freeze<AccountOffer[]>([
    { currency: 'cad', hours: 10, price_cents: 300 },
    { currency: 'cad', hours: 50, price_cents: 1000 },
    { currency: 'cad', hours: 200, price_cents: 3000 },
])

const mounted = new Set<VueWrapper>()


function card_at(wrapper: VueWrapper, index: number): DOMWrapper<Element> {
    assert(mounted.has(wrapper))
    assert(Number.isSafeInteger(index))
    assert(index < OFFERS.length)

    const card = wrapper.findAll('.offer')[index]

    if (card === undefined) throw new Error(`the page has no pack card at ${String(index)}`)

    return card
}

function offers_mount(): VueWrapper {
    assert(mounted.size === 0)
    assert(OFFERS.length === 3)

    const wrapper = mount(CheckoutOffers, {
        [PROPERTIES]: { balance_seconds: BALANCE_SECONDS, offers: OFFERS },
        [ATTACH_TO]: document.body,
    })

    mounted.add(wrapper)

    return wrapper
}

beforeEach(() => {
    vi.useFakeTimers({ [TO_FAKE]: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount()

    mounted.clear()
    vi.useRealTimers()
})

describe('CheckoutOffers considering a pack', () => {
    it('names a pack the pointer rests on, once, and not one it only crosses', async () => {
        const wrapper = offers_mount()
        const crossed = card_at(wrapper, 0)
        const rested = card_at(wrapper, 1)

        await crossed.trigger('pointerenter')
        vi.advanceTimersByTime(CONSIDER_DELAY_MS - 1)
        await crossed.trigger('pointerleave')
        await rested.trigger('pointerenter')
        vi.advanceTimersByTime(CONSIDER_DELAY_MS - 1)

        expect(wrapper.emitted('consider')).toBeUndefined()

        vi.advanceTimersByTime(1)
        await rested.trigger('focusin')
        vi.advanceTimersByTime(CONSIDER_DELAY_MS * 4)

        expect(wrapper.emitted('consider')).toEqual([[OFFERS[1]]])
    })

    it('names a pack whose Buy button holds keyboard focus', async () => {
        const wrapper = offers_mount()
        const focused = card_at(wrapper, 2)

        await focused.find('button').trigger('focusin')
        vi.advanceTimersByTime(CONSIDER_DELAY_MS)

        expect(wrapper.emitted('consider')).toEqual([[OFFERS[2]]])
    })

    it('names nothing for a pack chosen before the pointer settles', async () => {
        const wrapper = offers_mount()
        const chosen = card_at(wrapper, 1)

        await chosen.trigger('pointerenter')
        await chosen.find('button').trigger('click')
        vi.advanceTimersByTime(CONSIDER_DELAY_MS * 4)

        expect(wrapper.emitted('choose')).toEqual([[OFFERS[1]]])
        expect(wrapper.emitted('consider')).toBeUndefined()
    })
})
