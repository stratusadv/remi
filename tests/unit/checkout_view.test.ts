import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CheckoutView from '../../src/components/checkout_view.vue'
import { use_account } from '../../src/composables/use_account'
import { use_dialog } from '../../src/composables/use_dialog'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import { checkout_preload, stripe_preload } from '../../src/lib/stripe'
import { ATTACH_TO, deferred_new, mount_auto_unmount } from './fixtures'
import type { VueWrapper } from '@vue/test-utils'
import type { Mock } from 'vitest'
import type * as stripe_module from '../../src/lib/stripe'
import type { CheckoutForm, CheckoutPreloaded, TestCard } from '../../src/lib/stripe'
import type { Account, CheckoutStarted } from '../../src/types'
import type { Deferred } from './fixtures'


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
const THANKS = 'Your payment went through. You now have 51.5 hours of transcription.'

const ACCOUNT = Object.freeze<Account>({
    balance_seconds: 5400,
    checkout_hours_max: 1000,
    email: 'avery@example.com',
    name: 'Avery',
    payments: true,
    price_currency: 'cad',
    price_hour_cents: 60,
    publishable_key: KEY,
})

const STARTED = Object.freeze<CheckoutStarted>({
    client_secret: `${SESSION_ID}_secret_eyJ1aSI6MX0`,
    session_id: SESSION_ID,
})

const account_state = use_account()
const dialog_state = use_dialog()


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

    assert(document.body.querySelector('.checkout-view') !== null)
    assert(buttons.length <= 4)

    return [...buttons].map((element) => element.textContent.trim())
}

function dialog_shown(): { kind: string, message: string, title: string } | null {
    const shown = dialog_state.current.value

    if (shown === null) return null

    assert(shown.cancel_label === null)
    assert(shown.message.length > 0)

    return { kind: shown.kind, message: shown.message, title: shown.title }
}

function form_fake_install(): FormFake {
    assert(document.body.querySelector('.checkout-view') === null)
    assert(vi.isMockFunction(checkout_preload))

    const confirm = vi.fn<() => Promise<string | null>>().mockResolvedValue(null)
    const confirm_test = vi.fn<(card: TestCard) => Promise<string | null>>().mockResolvedValue(null)
    const destroy = vi.fn<() => void>()
    const form = { amount: 30, confirm, confirm_test: null, currency: 'cad', destroy }
    const open = vi.fn<(host: HTMLElement) => Promise<CheckoutForm>>().mockResolvedValue(form)

    vi.mocked(checkout_preload).mockImplementation(
        async (key, starting) => preloaded_fake(key, starting, open),
    )

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

async function hours_buy(hours: number): Promise<void> {
    assert(Number.isSafeInteger(hours))
    assert(document.body.querySelector('.checkout-view') !== null)

    await hours_type(String(hours))

    button('Buy hours').click()
    await flushPromises()
}

function hours_input(): HTMLInputElement {
    const input = document.body.querySelector<HTMLInputElement>('.hours-card-input')

    assert(document.body.querySelector('.checkout-view') !== null)
    assert(input !== null)

    return input
}

async function hours_type(text: string): Promise<void> {
    const input = hours_input()

    assert(input.type === 'number')
    assert(text.length <= 8)

    input.value = text
    input.dispatchEvent(new Event('input'))
    await flushPromises()
}

async function page_mount(): Promise<VueWrapper> {
    assert(account_state.status.value.signed_in)
    assert(document.body.querySelector('.checkout-view') === null)

    const wrapper = mount_auto_unmount(CheckoutView, { [ATTACH_TO]: document.body })

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

async function restart_abandoned(): Promise<Deferred<Account | null>> {
    assert(document.body.querySelector('.checkout-view') === null)
    assert(vi.isMockFunction(ipc.account_get))

    const reloaded = deferred_new<Account | null>()

    vi.mocked(ipc.account_checkout_start).mockRejectedValueOnce(new Error('api error: refused'))
    vi.mocked(ipc.account_get).mockReturnValueOnce(reloaded.promise)

    await page_mount()
    await hours_buy(50)

    button('Try again').click()
    await flushPromises()
    button('Change hours').click()
    await flushPromises()

    return reloaded
}

function text_of(selector: string): string {
    assert(selector.length > 0)

    const element = document.body.querySelector(selector)

    assert(document.body.querySelector('.checkout-view') !== null)
    assert(element !== null)

    return element.textContent
}

beforeEach(() => {
    vi.resetAllMocks()
    dialog_state.close(false)
    account_state.account.value = structuredClone(ACCOUNT)
    account_state.status.value = { billing: true, signed_in: true }
    vi.mocked(ipc.account_checkout_start).mockResolvedValue(STARTED)
    vi.mocked(ipc.account_get).mockResolvedValue(ACCOUNT)
})

describe('CheckoutView hours', () => {
    it('lists the hourly price and what the hours are for, and loads Stripe', async () => {
        const fake = form_fake_install()

        await page_mount()

        expect(fake.destroy).not.toHaveBeenCalled()

        const points = [...document.body.querySelectorAll('.checkout-points li')]

        expect(points.map((point) => point.textContent.trim())).toEqual([
            '$0.60 per hour of transcription',
            'Unlimited notes and Ask questions for monthly active users',
            'One-time payment, no subscription',
        ])

        expect(hours_input().value).toBe('10')
        expect(text_of('.hours-card-after')).toBe('11.5 hours')
        expect(text_of('.hours-card-amount')).toContain('$6.00')
        expect(button('Buy hours').disabled).toBe(false)
        expect(stripe_preload).toHaveBeenCalledWith(KEY)
        expect(checkout_preload).not.toHaveBeenCalled()
        expect(ipc.account_checkout_start).not.toHaveBeenCalled()
    })

    it('shows the balance after and the total for the hours typed', async () => {
        await page_mount()

        expect(text_of('.hours-card-lines')).toContain('$0.60')

        await hours_type('50')

        expect(text_of('.hours-card-after')).toBe('51.5 hours')
        expect(text_of('.hours-card-amount')).toContain('$30.00')

        await hours_type('1000')

        expect(text_of('.hours-card-after')).toBe('1001.5 hours')
        expect(text_of('.hours-card-amount')).toContain('$600.00')
        expect(button('Buy hours').disabled).toBe(false)
    })

    it('ignores a second click on Buy hours while the first checkout starts', async () => {
        const fake = form_fake_install()

        await page_mount()

        expect(fake.confirm).not.toHaveBeenCalled()

        await hours_type('50')

        const choice = button('Buy hours')

        choice.click()
        choice.click()
        await flushPromises()

        expect(ipc.account_checkout_start).toHaveBeenCalledTimes(1)
        expect(fake.open).toHaveBeenCalledTimes(1)
    })
})

describe('CheckoutView account', () => {
    it('explains a server that takes no payments and checks again on request', async () => {
        const fake = form_fake_install()

        account_state.account.value = { ...ACCOUNT, payments: false, publishable_key: '' }

        await page_mount()

        expect(fake.destroy).not.toHaveBeenCalled()

        expect(text_of('.checkout-view')).toContain(PAYMENTS_OFF)
        expect(document.body.querySelectorAll('.hours-card')).toHaveLength(0)
        expect(stripe_preload).not.toHaveBeenCalled()

        button('Try again').click()
        await flushPromises()

        expect(ipc.account_get).toHaveBeenCalledTimes(1)
        expect(document.body.querySelectorAll('.hours-card')).toHaveLength(1)
        expect(stripe_preload).toHaveBeenCalledWith(KEY)
        expect(ipc.account_checkout_start).not.toHaveBeenCalled()
    })

    it('opens the checkout with the Stripe key the account answers with now', async () => {
        const fake = form_fake_install()
        const rotated = 'pk_test_51Hrotated'

        await page_mount()

        vi.mocked(checkout_preload).mockImplementation(async (key, starting) => {
            const started = await starting

            assert(key === rotated)

            return { open: fake.open, session_id: started.session_id }
        })

        account_state.account.value = { ...ACCOUNT, publishable_key: rotated }
        await flushPromises()
        await hours_buy(50)

        expect(stripe_preload).toHaveBeenLastCalledWith(rotated)
        expect(checkout_preload).toHaveBeenLastCalledWith(rotated, expect.any(Promise))
        expect(button('Pay $30.00').disabled).toBe(false)
    })
})

describe('CheckoutView hours it does not sell', () => {
    it.each(['0', '-5', '1001', '2.5', ''])('refuses %j and starts no checkout', async (text) => {
        await page_mount()

        const hint = document.body.querySelector('.hours-card-hint')

        await hours_type(text)

        expect(button('Buy hours').disabled).toBe(true)
        expect(hint?.getAttribute('data-invalid')).toBe('true')
        expect(hint?.textContent.trim()).toBe('Choose from 1 to 1000 hours.')
        expect(text_of('.hours-card-after')).toBe('')

        button('Buy hours').click()
        await flushPromises()

        expect(ipc.account_checkout_start).not.toHaveBeenCalled()
        expect(document.body.querySelector('.checkout-pay')).toBeNull()
    })
})

describe('CheckoutView payment', () => {
    it('opens a card form for the hours chosen, pays them, and thanks them', async () => {
        const fake = form_fake_install()
        const credited = { account: { ...ACCOUNT, balance_seconds: 185_400 }, paid: true }

        vi.mocked(ipc.account_checkout_finish).mockResolvedValue(credited)

        await page_mount()
        await hours_buy(50)

        expect(fake.confirm).not.toHaveBeenCalled()

        const host = document.body.querySelector('.checkout-element')

        expect(ipc.account_checkout_start).toHaveBeenCalledWith(50)
        expect(checkout_preload).toHaveBeenCalledWith(KEY, expect.any(Promise))
        expect(fake.open).toHaveBeenCalledWith(host)
        expect(text_of('.checkout-order')).toContain('$30.00')
        expect(text_of('.checkout-order')).toContain('$0.60')
        expect(text_of('.checkout-order')).toContain('51.5 hours')

        button('Pay $30.00').click()
        await flushPromises()

        expect(fake.confirm).toHaveBeenCalledTimes(1)
        expect(ipc.account_checkout_finish).toHaveBeenCalledWith(SESSION_ID)
        expect(fake.destroy).toHaveBeenCalledTimes(1)
        expect(dialog_shown()).toEqual({ kind: 'success', message: THANKS, title: 'Thank you' })
        expect(text_of('.checkout-balance')).toContain('51.5 hours of transcription left')
        expect(document.body.querySelector('.hours-card')).not.toBeNull()
    })

    it('shows the price and the form outline while the card form loads', async () => {
        const fake = form_fake_install()
        const opened = deferred_new<CheckoutForm>()

        fake.open.mockReturnValue(opened.promise)

        await page_mount()
        await hours_buy(200)

        expect(fake.destroy).not.toHaveBeenCalled()

        const fields = document.body.querySelector('.checkout-fields')

        expect(button('Pay $120.00').disabled).toBe(true)
        expect(fields?.getAttribute('data-shown')).toBe('false')
        expect(text_of('.checkout-ghost')).toContain('Card number')

        opened.resolve({ ...fake.form, amount: 120 })
        await flushPromises()

        expect(fields?.getAttribute('data-shown')).toBe('true')
        expect(button('Pay $120.00').disabled).toBe(false)
    })
})

describe('CheckoutView between purchases', () => {
    it('goes back to the hours as typed and starts a fresh checkout for the next', async () => {
        const fake = form_fake_install()

        await page_mount()
        await hours_buy(50)

        button('Change hours').click()
        await flushPromises()

        expect(fake.destroy).toHaveBeenCalledTimes(1)
        expect(hours_input().value).toBe('50')

        await hours_buy(200)

        expect(ipc.account_checkout_start).toHaveBeenLastCalledWith(200)
        expect(fake.open).toHaveBeenCalledTimes(2)
        expect(host_of_call(fake, 1)).not.toBe(host_of_call(fake, 0))
    })

    it('starts a fresh checkout when someone buys more after paying', async () => {
        const fake = form_fake_install()

        vi.mocked(ipc.account_checkout_finish).mockResolvedValue({ account: ACCOUNT, paid: true })

        await page_mount()
        await hours_buy(50)

        expect(fake.confirm).not.toHaveBeenCalled()

        button('Pay $30.00').click()
        await flushPromises()
        dialog_state.close(true)
        await hours_buy(50)

        expect(ipc.account_checkout_start).toHaveBeenCalledTimes(2)
        expect(fake.open).toHaveBeenCalledTimes(2)
        expect(host_of_call(fake, 1)).not.toBe(host_of_call(fake, 0))
        expect(button('Pay $30.00').disabled).toBe(false)
        expect(fake.destroy).toHaveBeenCalledTimes(1)
    })

    it('keeps the form open with the bank message when a card is declined', async () => {
        const fake = form_fake_install()

        fake.confirm.mockResolvedValue(DECLINED)

        await page_mount()
        await hours_buy(50)

        button('Pay $30.00').click()
        await flushPromises()

        expect(text_of('.checkout-panel')).toContain(DECLINED)
        expect(button('Pay $30.00').disabled).toBe(false)
        expect(ipc.account_checkout_finish).not.toHaveBeenCalled()
        expect(fake.destroy).not.toHaveBeenCalled()
        expect(dialog_shown()).toBeNull()
    })
})

describe('CheckoutView test cards', () => {
    it('hides the test cards unless the card form offers them', async () => {
        const fake = form_fake_install()

        await page_mount()
        await hours_buy(50)

        expect(fake.confirm_test).not.toHaveBeenCalled()
        expect(document.body.querySelector('.checkout-test')).toBeNull()
        expect(button('Pay $30.00').disabled).toBe(false)
    })

    it('pays in one click with a test card and credits the hours', async () => {
        const fake = form_fake_install()
        const credited = { account: { ...ACCOUNT, balance_seconds: 185_400 }, paid: true }

        form_fake_testing(fake)
        vi.mocked(ipc.account_checkout_finish).mockResolvedValue(credited)

        await page_mount()
        await hours_buy(50)

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
        expect(dialog_shown()?.message).toBe(THANKS)
    })

    it('shows what a declined test card returns and keeps the form open', async () => {
        const fake = form_fake_install()

        form_fake_testing(fake)
        fake.confirm_test.mockResolvedValue(DECLINED)

        await page_mount()
        await hours_buy(50)

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
        await hours_buy(50)

        button('Pay $30.00').click()
        await flushPromises()

        expect(text_of('.checkout-panel')).toContain('returnUrl')
        expect(button('Pay $30.00').disabled).toBe(false)
        expect(ipc.account_checkout_finish).not.toHaveBeenCalled()
        expect(fake.destroy).not.toHaveBeenCalled()
    })

    it('tells them a taken payment is being confirmed and reloads the balance', async () => {
        const fake = form_fake_install()
        const offline = new Error('network error: offline')

        vi.mocked(ipc.account_checkout_finish).mockRejectedValue(offline)

        await page_mount()
        await hours_buy(50)

        expect(fake.confirm).not.toHaveBeenCalled()

        button('Pay $30.00').click()
        await flushPromises()

        expect(dialog_shown()?.title).toBe('Payment processing')
        expect(dialog_shown()?.message).toContain('Your payment is being confirmed.')
        expect(dialog_shown()?.kind).toBe('info')
        expect(ipc.account_get).toHaveBeenCalledTimes(1)
        expect(fake.destroy).toHaveBeenCalledTimes(1)
    })

    it('reports a checkout the server refused and opens one when tried again', async () => {
        const refused = new Error('api error: Stripe could not start the checkout.')

        form_fake_install()
        vi.mocked(ipc.account_checkout_start).mockRejectedValueOnce(refused)

        await page_mount()
        await hours_buy(50)

        expect(text_of('.checkout-panel')).toContain('Stripe could not start the checkout.')
        expect(text_of('.checkout-ghost')).toContain('Card number')

        button('Try again').click()
        await flushPromises()

        expect(ipc.account_get).toHaveBeenCalledTimes(1)
        expect(ipc.account_checkout_start).toHaveBeenCalledTimes(2)
        expect(text_of('.checkout-panel')).not.toContain('Stripe could not start the checkout.')
        expect(button('Pay $30.00').disabled).toBe(false)
    })
})

describe('CheckoutView when the account reload from Try again lands late', () => {
    it('keeps the card form that is open', async () => {
        const fake = form_fake_install()
        const reloaded = await restart_abandoned()

        await hours_buy(50)

        expect(fake.open).toHaveBeenCalledTimes(1)

        reloaded.resolve(ACCOUNT)
        await flushPromises()

        expect(fake.open).toHaveBeenCalledTimes(1)
        expect(fake.destroy).not.toHaveBeenCalled()
        expect(ipc.account_checkout_start).toHaveBeenCalledTimes(2)
        expect(button('Pay $30.00').disabled).toBe(false)
    })

    it('lets a payment that is confirming finish', async () => {
        const fake = form_fake_install()
        const confirmed = deferred_new<string | null>()
        const credited = { account: { ...ACCOUNT, balance_seconds: 185_400 }, paid: true }

        fake.confirm.mockReturnValue(confirmed.promise)
        vi.mocked(ipc.account_checkout_finish).mockResolvedValue(credited)

        const reloaded = await restart_abandoned()

        await hours_buy(50)

        button('Pay $30.00').click()
        await flushPromises()
        reloaded.resolve(ACCOUNT)
        await flushPromises()
        confirmed.resolve(null)
        await flushPromises()

        expect(fake.open).toHaveBeenCalledTimes(1)
        expect(ipc.account_checkout_start).toHaveBeenCalledTimes(2)
        expect(dialog_shown()?.message).toBe(THANKS)
    })

    it('stays on the hours after a payment', async () => {
        const fake = form_fake_install()
        const credited = { account: { ...ACCOUNT, balance_seconds: 185_400 }, paid: true }

        vi.mocked(ipc.account_checkout_finish).mockResolvedValue(credited)

        const reloaded = await restart_abandoned()

        await hours_buy(50)

        expect(fake.open).toHaveBeenCalledTimes(1)

        button('Pay $30.00').click()
        await flushPromises()
        reloaded.resolve(credited.account)
        await flushPromises()

        expect(dialog_shown()?.title).toBe('Thank you')
        expect(document.body.querySelector('.hours-card')).not.toBeNull()
        expect(fake.open).toHaveBeenCalledTimes(1)
        expect(ipc.account_checkout_start).toHaveBeenCalledTimes(2)
    })
})

describe('CheckoutView when the reload from Try again lands after the payment', () => {
    it('keeps the credited balance rather than the account from before the payment', async () => {
        const fake = form_fake_install()
        const credited = { account: { ...ACCOUNT, balance_seconds: 185_400 }, paid: true }

        vi.mocked(ipc.account_checkout_finish).mockResolvedValue(credited)

        const reloaded = await restart_abandoned()

        await hours_buy(50)

        expect(fake.open).toHaveBeenCalledTimes(1)

        button('Pay $30.00').click()
        await flushPromises()
        reloaded.resolve(ACCOUNT)
        await flushPromises()

        expect(dialog_shown()?.message).toBe(THANKS)
        expect(account_state.balance_text.value).toBe('51.5 hours')
    })
})

describe('CheckoutView when the page closes', () => {
    it('destroys a card form that finishes loading after the page closed', async () => {
        const fake = form_fake_install()
        const opened = deferred_new<CheckoutForm>()

        fake.open.mockReturnValue(opened.promise)

        const wrapper = await page_mount()

        await hours_buy(50)

        wrapper.unmount()
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

        await hours_buy(50)

        button('Pay $30.00').click()
        await flushPromises()
        wrapper.unmount()

        expect(fake.destroy).not.toHaveBeenCalled()

        confirmed.resolve(null)
        await flushPromises()

        expect(ipc.account_checkout_finish).toHaveBeenCalledWith(SESSION_ID)
        expect(fake.destroy).toHaveBeenCalledTimes(1)
        expect(account_state.balance_text.value).toBe('51.5 hours')
        expect(dialog_shown()?.message).toBe(THANKS)
    })
})
