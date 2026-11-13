import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CheckoutView from '../../src/components/checkout_view.vue'
import { use_account } from '../../src/composables/use_account'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import { log_warn } from '../../src/lib/log'
import { checkout_preload, stripe_preload } from '../../src/lib/stripe'
import { ATTACH_TO, TO_FAKE, deferred_new } from './fixtures'
import type { VueWrapper } from '@vue/test-utils'
import type { Mock } from 'vitest'
import type * as stripe_module from '../../src/lib/stripe'
import type { CheckoutForm, CheckoutPreloaded, TestCard } from '../../src/lib/stripe'
import type { Account, CheckoutStarted } from '../../src/types'


vi.mock('../../src/lib/ipc')
vi.mock('../../src/lib/log')

vi.mock('../../src/lib/stripe', async (import_original) => {
    const actual = await import_original<typeof stripe_module>()

    return { ...actual, checkout_preload: vi.fn(), stripe_preload: vi.fn() }
})

interface FormFake {
    confirm: Mock<() => Promise<string | null>>
    confirm_test: Mock<(card: TestCard) => Promise<string | null>>
    destroy: Mock<() => void>
    form: CheckoutForm
    open: Mock<(host: HTMLElement) => Promise<CheckoutForm>>
}

const DECLINED = 'Your card was declined.'
const KEY = 'pk_test_51Hscribe'
const PAYMENTS_OFF = 'This server is not set up to take payments yet.'
const SESSION_ID = 'cs_test_a1B2c3'

const ACCOUNT = Object.freeze<Account>({
    balance_seconds: 5400,
    email: 'avery@example.com',
    name: 'Avery',
    offers: [
        { currency: 'cad', hours: 10, price_cents: 300 },
        { currency: 'cad', hours: 50, price_cents: 1000 },
        { currency: 'cad', hours: 200, price_cents: 3000 },
    ],
    payments: true,
    publishable_key: KEY,
})

const STARTED = Object.freeze<CheckoutStarted>({
    client_secret: `${SESSION_ID}_secret_eyJ1aSI6MX0`,
    session_id: SESSION_ID,
})

const account_state = use_account()
const mounted = new Set<VueWrapper>()


function button(label: string): HTMLButtonElement {
    assert(label.length > 0)

    const buttons = document.body.querySelectorAll<HTMLButtonElement>('.checkout-view button')
    const found = [...buttons].find((candidate) => candidate.textContent.trim() === label)

    if (found === undefined) throw new Error(`the page has no ${label} button`)

    assert(found.isConnected)

    return found
}

function button_labels(selector: string): string[] {
    assert(selector.length > 0)

    const buttons = document.body.querySelectorAll(`${selector} button`)

    assert(mounted.size > 0)
    assert(buttons.length <= 4)

    return [...buttons].map((element) => element.textContent.trim())
}

function form_fake_install(): FormFake {
    assert(mounted.size === 0)
    assert(vi.isMockFunction(checkout_preload))

    const confirm = vi.fn<() => Promise<string | null>>().mockResolvedValue(null)
    const confirm_test = vi.fn<(card: TestCard) => Promise<string | null>>().mockResolvedValue(null)
    const destroy = vi.fn<() => void>()
    const form = { amount: 10, confirm, confirm_test: null, currency: 'cad', destroy }
    const open = vi.fn<(host: HTMLElement) => Promise<CheckoutForm>>().mockResolvedValue(form)

    vi.mocked(checkout_preload).mockImplementation(async (key, starting) => {
        return preloaded_fake(key, starting, open)
    })

    return { confirm, confirm_test, destroy, form, open }
}

function form_fake_testing(fake: FormFake): void {
    assert(fake.form.confirm_test === null)
    assert(vi.isMockFunction(fake.confirm_test))

    const form = { ...fake.form, confirm_test: fake.confirm_test }

    fake.open.mockResolvedValue(form)
}

function host_of_call(fake: FormFake, index: number): unknown {
    assert(Number.isSafeInteger(index))
    assert(index < fake.open.mock.calls.length)

    return fake.open.mock.calls[index]?.[0]
}

async function pack_choose(hours: number): Promise<void> {
    assert(Number.isSafeInteger(hours))
    assert(mounted.size > 0)

    button(`Buy ${String(hours)} hours`).click()
    await flushPromises()
}

async function pack_consider(hours: number): Promise<void> {
    assert(Number.isSafeInteger(hours))
    assert(mounted.size > 0)

    const focused = new FocusEvent('focusin', { bubbles: true })

    vi.useFakeTimers({ [TO_FAKE]: ['setTimeout', 'clearTimeout'] })
    button(`Buy ${String(hours)} hours`).dispatchEvent(focused)
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    await flushPromises()
}

async function page_mount(): Promise<VueWrapper> {
    assert(account_state.status.value.signed_in)
    assert(mounted.size === 0)

    const wrapper = mount(CheckoutView, { [ATTACH_TO]: document.body })

    mounted.add(wrapper)

    await flushPromises()

    return wrapper
}

async function preloaded_fake(
    key: string,
    starting: Promise<CheckoutStarted>,
    open: CheckoutPreloaded['open'],
): Promise<CheckoutPreloaded> {
    assert(key === KEY)
    assert(vi.isMockFunction(open))

    const started = await starting

    return { open, session_id: started.session_id }
}

function text_of(selector: string): string {
    assert(selector.length > 0)

    const element = document.body.querySelector(selector)

    assert(mounted.size > 0)
    assert(element !== null)

    return element.textContent
}

beforeEach(() => {
    vi.resetAllMocks()
    account_state.account.value = structuredClone(ACCOUNT)
    account_state.status.value = { billing: true, signed_in: true }
    vi.mocked(ipc.account_checkout_start).mockResolvedValue(STARTED)
    vi.mocked(ipc.account_get).mockResolvedValue(ACCOUNT)
})

afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount()

    mounted.clear()
    vi.useRealTimers()
})

describe('CheckoutView packs', () => {
    it('shows each pack with its rate and saving, marks the best, and loads Stripe', async () => {
        const fake = form_fake_install()

        await page_mount()

        expect(fake.destroy).not.toHaveBeenCalled()

        const offers = document.body.querySelectorAll('.offer')
        const best = text_of('.offer[data-best="true"]')

        expect(offers).toHaveLength(3)
        expect(offers[1]?.textContent).toContain('$0.20 per hour')
        expect(offers[1]?.textContent).toContain('Save 33%')
        expect(offers[1]?.textContent).toContain('51.5 hours')
        expect(best).toContain('Best value')
        expect(best).toContain('200')
        expect(best).toContain('Save 50%')
        expect(stripe_preload).toHaveBeenCalledWith(KEY)
        expect(checkout_preload).not.toHaveBeenCalled()
        expect(ipc.account_checkout_start).not.toHaveBeenCalled()
    })

    it('ignores a second click on a pack while the first checkout starts', async () => {
        const fake = form_fake_install()

        await page_mount()

        expect(fake.confirm).not.toHaveBeenCalled()

        const choice = button('Buy 50 hours')

        choice.click()
        choice.click()
        await flushPromises()

        expect(ipc.account_checkout_start).toHaveBeenCalledTimes(1)
        expect(fake.open).toHaveBeenCalledTimes(1)
    })

    it('explains a server that takes no payments and checks again on request', async () => {
        const fake = form_fake_install()

        account_state.account.value = { ...ACCOUNT, payments: false, publishable_key: '' }

        await page_mount()

        expect(fake.destroy).not.toHaveBeenCalled()

        expect(text_of('.checkout-view')).toContain(PAYMENTS_OFF)
        expect(document.body.querySelectorAll('.offer')).toHaveLength(0)
        expect(stripe_preload).not.toHaveBeenCalled()

        button('Try again').click()
        await flushPromises()

        expect(ipc.account_get).toHaveBeenCalledTimes(1)
        expect(document.body.querySelectorAll('.offer')).toHaveLength(3)
        expect(stripe_preload).toHaveBeenCalledWith(KEY)
        expect(ipc.account_checkout_start).not.toHaveBeenCalled()
    })
})

describe('CheckoutView payment', () => {
    it('opens a card form for the chosen pack and pays it', async () => {
        const fake = form_fake_install()
        const credited = { account: { ...ACCOUNT, balance_seconds: 185_400 }, paid: true }

        vi.mocked(ipc.account_checkout_finish).mockResolvedValue(credited)

        await page_mount()
        await pack_choose(50)

        expect(fake.confirm).not.toHaveBeenCalled()

        const host = document.body.querySelector('.checkout-element')

        expect(ipc.account_checkout_start).toHaveBeenCalledWith(50)
        expect(checkout_preload).toHaveBeenCalledWith(KEY, expect.any(Promise))
        expect(fake.open).toHaveBeenCalledWith(host)
        expect(text_of('.checkout-order')).toContain('$10.00')
        expect(text_of('.checkout-order')).toContain('51.5 hours')

        button('Pay $10.00').click()
        await flushPromises()

        expect(fake.confirm).toHaveBeenCalledTimes(1)
        expect(ipc.account_checkout_finish).toHaveBeenCalledWith(SESSION_ID)
        expect(fake.destroy).toHaveBeenCalledTimes(1)
        expect(text_of('.checkout-settled')).toContain('You now have 51.5 hours of transcription.')
        expect(button_labels('.checkout-settled')).toEqual(['Buy more hours'])
    })

    it('shows the pack price and the form outline while the card form loads', async () => {
        const fake = form_fake_install()
        const opened = deferred_new<CheckoutForm>()

        fake.open.mockReturnValue(opened.promise)

        await page_mount()
        await pack_choose(200)

        expect(fake.destroy).not.toHaveBeenCalled()

        const fields = document.body.querySelector('.checkout-fields')

        expect(button('Pay $30.00').disabled).toBe(true)
        expect(fields?.getAttribute('data-shown')).toBe('false')
        expect(text_of('.checkout-ghost')).toContain('Card number')

        opened.resolve({ ...fake.form, amount: 30 })
        await flushPromises()

        expect(fields?.getAttribute('data-shown')).toBe('true')
        expect(button('Pay $30.00').disabled).toBe(false)
    })
})

describe('CheckoutView between packs', () => {
    it('goes back to every pack and starts a fresh checkout for the next one', async () => {
        const fake = form_fake_install()

        await page_mount()
        await pack_choose(50)

        button('All packs').click()
        await flushPromises()

        expect(fake.destroy).toHaveBeenCalledTimes(1)
        expect(document.body.querySelectorAll('.offer')).toHaveLength(3)

        await pack_choose(200)

        expect(ipc.account_checkout_start).toHaveBeenLastCalledWith(200)
        expect(fake.open).toHaveBeenCalledTimes(2)
        expect(host_of_call(fake, 1)).not.toBe(host_of_call(fake, 0))
    })

    it('starts a fresh checkout when someone buys more after paying', async () => {
        const fake = form_fake_install()

        vi.mocked(ipc.account_checkout_finish).mockResolvedValue({ account: ACCOUNT, paid: true })

        await page_mount()
        await pack_choose(50)

        expect(fake.confirm).not.toHaveBeenCalled()

        button('Pay $10.00').click()
        await flushPromises()
        button('Buy more hours').click()
        await flushPromises()
        await pack_choose(50)

        expect(ipc.account_checkout_start).toHaveBeenCalledTimes(2)
        expect(fake.open).toHaveBeenCalledTimes(2)
        expect(host_of_call(fake, 1)).not.toBe(host_of_call(fake, 0))
        expect(button('Pay $10.00').disabled).toBe(false)
        expect(fake.destroy).toHaveBeenCalledTimes(1)
    })

    it('keeps the form open with the bank message when a card is declined', async () => {
        const fake = form_fake_install()

        fake.confirm.mockResolvedValue(DECLINED)

        await page_mount()
        await pack_choose(50)

        button('Pay $10.00').click()
        await flushPromises()

        expect(text_of('.checkout-panel')).toContain(DECLINED)
        expect(button('Pay $10.00').disabled).toBe(false)
        expect(ipc.account_checkout_finish).not.toHaveBeenCalled()
        expect(fake.destroy).not.toHaveBeenCalled()
    })
})

describe('CheckoutView preparing a pack before it is chosen', () => {
    it('opens the checkout it prepared for a considered pack and pays it', async () => {
        const fake = form_fake_install()
        const credited = { account: { ...ACCOUNT, balance_seconds: 185_400 }, paid: true }

        vi.mocked(ipc.account_checkout_finish).mockResolvedValue(credited)

        await page_mount()
        await pack_consider(50)

        expect(ipc.account_checkout_start).toHaveBeenCalledWith(50)
        expect(fake.open).not.toHaveBeenCalled()

        await pack_consider(50)
        await pack_choose(50)

        expect(ipc.account_checkout_start).toHaveBeenCalledTimes(1)
        expect(fake.open).toHaveBeenCalledTimes(1)

        button('Pay $10.00').click()
        await flushPromises()

        expect(ipc.account_checkout_finish).toHaveBeenCalledWith(SESSION_ID)
        expect(text_of('.checkout-settled')).toContain('You now have 51.5 hours of transcription.')
    })

    it('prepares each pack once and keeps the rest for a later choice', async () => {
        const fake = form_fake_install()

        await page_mount()
        await pack_consider(10)
        await pack_consider(50)
        await pack_consider(200)

        expect(fake.open).not.toHaveBeenCalled()

        await pack_consider(10)

        expect(vi.mocked(ipc.account_checkout_start).mock.calls).toEqual([[10], [50], [200]])

        await pack_choose(50)
        button('All packs').click()
        await flushPromises()
        await pack_choose(200)

        const fields = document.body.querySelector('.checkout-fields')

        expect(ipc.account_checkout_start).toHaveBeenCalledTimes(3)
        expect(fake.open).toHaveBeenCalledTimes(2)
        expect(fields?.getAttribute('data-shown')).toBe('true')
    })

    it('starts a fresh checkout for a pack whose preparation failed', async () => {
        const refused = new Error('api error: Stripe could not start the checkout.')

        form_fake_install()
        vi.mocked(ipc.account_checkout_start).mockRejectedValueOnce(refused)

        await page_mount()
        await pack_consider(50)

        expect(log_warn).toHaveBeenCalledWith(expect.stringContaining('prepared'), refused)

        await pack_choose(50)

        expect(ipc.account_checkout_start).toHaveBeenCalledTimes(2)
        expect(text_of('.checkout-panel')).not.toContain('Stripe could not start the checkout.')
        expect(button('Pay $10.00').disabled).toBe(false)
    })
})

describe('CheckoutView keeping prepared packs', () => {
    it('keeps a checkout that loaded after going back for its next choice', async () => {
        const fake = form_fake_install()
        const preloading = deferred_new<CheckoutPreloaded>()

        vi.mocked(checkout_preload).mockReturnValueOnce(preloading.promise)

        await page_mount()
        await pack_choose(50)

        expect(fake.open).not.toHaveBeenCalled()

        button('All packs').click()
        await flushPromises()
        preloading.resolve({ open: fake.open, session_id: SESSION_ID })
        await flushPromises()
        await pack_choose(50)

        expect(checkout_preload).toHaveBeenCalledTimes(1)
        expect(ipc.account_checkout_start).toHaveBeenCalledTimes(1)
        expect(fake.open).toHaveBeenCalledTimes(1)
        expect(button('Pay $10.00').disabled).toBe(false)
    })

    it('prepares a pack again once the account answers with another Stripe key', async () => {
        const fake = form_fake_install()
        const rotated = 'pk_test_51Hrotated'

        await page_mount()
        await pack_consider(50)

        vi.mocked(checkout_preload).mockImplementation(async (key, starting) => {
            const started = await starting

            assert(key === rotated)

            return { open: fake.open, session_id: started.session_id }
        })

        account_state.account.value = { ...ACCOUNT, publishable_key: rotated }
        await flushPromises()
        await pack_choose(50)

        expect(stripe_preload).toHaveBeenLastCalledWith(rotated)
        expect(checkout_preload).toHaveBeenLastCalledWith(rotated, expect.any(Promise))
        expect(ipc.account_checkout_start).toHaveBeenCalledTimes(2)
        expect(button('Pay $10.00').disabled).toBe(false)
    })
})

describe('CheckoutView test cards', () => {
    it('hides the test cards unless the card form offers them', async () => {
        const fake = form_fake_install()

        await page_mount()
        await pack_choose(50)

        expect(fake.confirm_test).not.toHaveBeenCalled()
        expect(document.body.querySelector('.checkout-test')).toBeNull()
        expect(button('Pay $10.00').disabled).toBe(false)
    })

    it('pays in one click with a test card and credits the hours', async () => {
        const fake = form_fake_install()
        const credited = { account: { ...ACCOUNT, balance_seconds: 185_400 }, paid: true }

        form_fake_testing(fake)
        vi.mocked(ipc.account_checkout_finish).mockResolvedValue(credited)

        await page_mount()
        await pack_choose(50)

        expect(button_labels('.checkout-test')).toEqual([
            'Succeeds (4242)',
            'Declined (0002)',
            '3D Secure (3220)',
        ])

        button('Succeeds (4242)').click()
        await flushPromises()

        expect(fake.confirm_test).toHaveBeenCalledWith('tok_visa')
        expect(fake.confirm).not.toHaveBeenCalled()
        expect(ipc.account_checkout_finish).toHaveBeenCalledWith(SESSION_ID)
        expect(text_of('.checkout-settled')).toContain('You now have 51.5 hours of transcription.')
    })

    it('shows what a declined test card returns and keeps the form open', async () => {
        const fake = form_fake_install()

        form_fake_testing(fake)
        fake.confirm_test.mockResolvedValue(DECLINED)

        await page_mount()
        await pack_choose(50)

        button('Declined (0002)').click()
        await flushPromises()

        expect(fake.confirm_test).toHaveBeenCalledWith('tok_chargeDeclined')
        expect(text_of('.checkout-panel')).toContain(DECLINED)
        expect(button('Declined (0002)').disabled).toBe(false)
        expect(ipc.account_checkout_finish).not.toHaveBeenCalled()
        expect(fake.destroy).not.toHaveBeenCalled()
    })
})

describe('CheckoutView when something fails', () => {
    it('leaves Paying with a message when the confirmation itself fails', async () => {
        const fake = form_fake_install()
        const failed = new Error('IntegrationError: You must provide a `returnUrl` on confirm().')

        fake.confirm.mockRejectedValue(failed)

        await page_mount()
        await pack_choose(50)

        button('Pay $10.00').click()
        await flushPromises()

        expect(text_of('.checkout-panel')).toContain('returnUrl')
        expect(button('Pay $10.00').disabled).toBe(false)
        expect(ipc.account_checkout_finish).not.toHaveBeenCalled()
        expect(fake.destroy).not.toHaveBeenCalled()
    })

    it('shows a taken payment as confirming and offers no second payment', async () => {
        const fake = form_fake_install()
        const offline = new Error('network error: offline')

        vi.mocked(ipc.account_checkout_finish).mockRejectedValue(offline)

        await page_mount()
        await pack_choose(50)

        expect(fake.confirm).not.toHaveBeenCalled()

        button('Pay $10.00').click()
        await flushPromises()

        expect(text_of('.checkout-settled')).toContain('Your payment is being confirmed.')
        expect(button_labels('.checkout-settled')).toEqual([])
        expect(fake.destroy).toHaveBeenCalledTimes(1)
    })

    it('reports a checkout the server refused and opens one when tried again', async () => {
        const refused = new Error('api error: Stripe could not start the checkout.')

        form_fake_install()
        vi.mocked(ipc.account_checkout_start).mockRejectedValueOnce(refused)

        await page_mount()
        await pack_choose(50)

        expect(text_of('.checkout-panel')).toContain('Stripe could not start the checkout.')
        expect(text_of('.checkout-ghost')).toContain('Card number')

        button('Try again').click()
        await flushPromises()

        expect(ipc.account_get).toHaveBeenCalledTimes(1)
        expect(ipc.account_checkout_start).toHaveBeenCalledTimes(2)
        expect(text_of('.checkout-panel')).not.toContain('Stripe could not start the checkout.')
        expect(button('Pay $10.00').disabled).toBe(false)
    })
})

describe('CheckoutView when the page closes', () => {
    it('destroys a card form that finishes loading after the page closed', async () => {
        const fake = form_fake_install()
        const opened = deferred_new<CheckoutForm>()

        fake.open.mockReturnValue(opened.promise)

        const wrapper = await page_mount()

        await pack_choose(50)

        wrapper.unmount()
        mounted.delete(wrapper)
        opened.resolve(fake.form)
        await flushPromises()

        expect(fake.destroy).toHaveBeenCalledTimes(1)
        expect(ipc.account_checkout_finish).not.toHaveBeenCalled()
    })

    it('still credits a payment that was confirming when the page closed', async () => {
        const fake = form_fake_install()
        const confirmed = deferred_new<string | null>()
        const credited = { account: { ...ACCOUNT, balance_seconds: 185_400 }, paid: true }

        fake.confirm.mockReturnValue(confirmed.promise)
        vi.mocked(ipc.account_checkout_finish).mockResolvedValue(credited)

        const wrapper = await page_mount()

        await pack_choose(50)

        button('Pay $10.00').click()
        await flushPromises()
        wrapper.unmount()
        mounted.delete(wrapper)

        expect(fake.destroy).not.toHaveBeenCalled()

        confirmed.resolve(null)
        await flushPromises()

        expect(ipc.account_checkout_finish).toHaveBeenCalledWith(SESSION_ID)
        expect(fake.destroy).toHaveBeenCalledTimes(1)
        expect(account_state.balance_text.value).toBe('51.5 hours')
    })
})
