import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assert } from '../../src/lib/assert'
import { checkout_preload, stripe_appearance, stripe_preload } from '../../src/lib/stripe'
import type { Appearance } from '@stripe/stripe-js'
import type { Mock } from 'vitest'
import type { CheckoutForm } from '../../src/lib/stripe'
import type { CheckoutStarted } from '../../src/types'


const load_stripe = vi.hoisted(() => vi.fn())

vi.mock('@stripe/stripe-js/pure', () => ({ loadStripe: load_stripe }))
vi.mock('../../src/lib/log')

type ElementOutcome = 'loaderror' | 'ready'

interface StripeFake {
    change_appearance: Mock<(appearance: Appearance) => void>
    confirm: Mock
    create_element: Mock
    create_payment_method: Mock
    destroy: Mock
    init: Mock<(options: unknown) => unknown>
    load_actions: Mock
    mount: Mock
}

interface ElementEvent {
    error: { message: string }
}

const DECLINED = 'Your card was declined.'
const EMAIL = 'avery@example.com'
const FONT_BYTES = Object.freeze([119, 79, 70, 50, 0, 1, 0, 0])
const KEY_INVALID = 'Invalid API Key provided.'
const MESSAGE_RETURN_URL = 'You must provide a `returnUrl` on confirm().'
const PAYMENT_METHOD_ID = 'pm_1Hscribe'
const SESSION_ID = 'cs_test_a1B2c3'

const STARTED = Object.freeze<CheckoutStarted>({
    client_secret: `${SESSION_ID}_secret_eyJ1aSI6MX0`,
    session_id: SESSION_ID,
})

const THEME_TOKENS = Object.freeze<Record<string, string>>({
    '--color-accent': 'rgb(10, 20, 30)',
    '--color-content': 'rgb(230, 230, 230)',
    '--color-content-meta': 'rgb(138, 138, 138)',
    '--color-content-muted': 'rgb(160, 160, 160)',
    '--color-danger-text': 'rgb(248, 113, 113)',
    '--color-field': 'rgb(16, 16, 16)',
    '--color-field-border': 'rgba(255, 255, 255, 0.14)',
    '--color-plane': 'rgb(40, 50, 60)',
    '--radius-md': '8px',
    '--text-sm': '15px',
})


function font_response(status: number): Response {
    assert(Number.isSafeInteger(status))
    assert(FONT_BYTES.length > 0)

    const blob = new Blob([new Uint8Array(FONT_BYTES)], { type: 'font/woff2' })

    return new Response(status === 200 ? blob : null, { status })
}

async function form_open(
    key: string,
    starting: Promise<CheckoutStarted>,
    host: HTMLElement,
): Promise<CheckoutForm> {
    assert(key.startsWith('pk_'))
    assert(host.isConnected)

    const preloaded = await checkout_preload(key, starting)

    return preloaded.open(host)
}

function host_new(): HTMLElement {
    const host = document.createElement('div')

    document.body.append(host)

    assert(host.isConnected)
    assert(host.childElementCount === 0)

    return host
}

function init_options(fake: StripeFake, index: number): unknown {
    assert(Number.isSafeInteger(index))
    assert(index < fake.init.mock.calls.length)

    const [options] = fake.init.mock.calls[index] ?? []

    return options
}

function key_new(): string {
    const key = `pk_test_${crypto.randomUUID().replaceAll('-', '')}`

    assert(key.length > 'pk_test_'.length)
    assert(!key.includes('-'))

    return key
}

async function started_now(): Promise<CheckoutStarted> {
    assert(Object.isFrozen(STARTED))
    assert(STARTED.client_secret.startsWith(STARTED.session_id))

    return Promise.resolve({ ...STARTED })
}

function stripe_fake_install(outcome: ElementOutcome): StripeFake {
    assert(['loaderror', 'ready'].includes(outcome))
    assert(vi.isMockFunction(load_stripe))

    const handlers = new Map<string, (event: ElementEvent) => void>()
    const confirm = vi.fn().mockResolvedValue({ type: 'success' })
    const destroy = vi.fn()
    const total = { amount: 'CA$10.00', minorUnitsAmount: 1000 }

    const session = {
        currency: 'cad',
        email: EMAIL,
        minorUnitsAmountDivisor: 100,
        total: { total },
    }

    const actions = { confirm, getSession: vi.fn().mockReturnValue(session) }
    const load_actions = vi.fn().mockResolvedValue({ type: 'success', actions })

    const mount = vi.fn(() => {
        handlers.get(outcome)?.({ error: { message: KEY_INVALID } })
    })

    const on = vi.fn((event: string, handler: (detail: ElementEvent) => void) => {
        handlers.set(event, handler)
    })

    const element = { destroy, mount, on }
    const create_element = vi.fn().mockReturnValue(element)
    const change_appearance = vi.fn<(appearance: Appearance) => void>()

    const checkout = {
        changeAppearance: change_appearance,
        createPaymentElement: create_element,
        loadActions: load_actions,
    }

    const init = vi.fn<(options: unknown) => unknown>().mockReturnValue(checkout)
    const created = { paymentMethod: { id: PAYMENT_METHOD_ID } }
    const create_payment_method = vi.fn().mockResolvedValue(created)

    load_stripe.mockResolvedValue({
        createPaymentMethod: create_payment_method,
        initCheckoutElementsSdk: init,
    })

    return {
        change_appearance,
        confirm,
        create_element,
        create_payment_method,
        destroy,
        init,
        load_actions,
        mount,
    }
}

beforeEach(() => {
    vi.resetAllMocks()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(font_response(200)))

    for (const [token, value] of Object.entries(THEME_TOKENS)) {
        document.documentElement.style.setProperty(token, value)
    }
})

afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    document.body.replaceChildren()
    document.documentElement.classList.remove('theme-dark', 'theme-light')
    document.documentElement.removeAttribute('style')
})

describe('checkout_preload', () => {
    it('loads Stripe without its test-mode assistant or its own loading skeleton', async () => {
        const fake = stripe_fake_install('ready')
        const key = key_new()
        const wallets = { applePay: 'never', googlePay: 'never', link: 'never' }

        await form_open(key, started_now(), host_new())

        expect(load_stripe).toHaveBeenCalledWith(key, {
            developerTools: { assistant: { enabled: false } },
        })

        expect(init_options(fake, 0)).toMatchObject({ elementsOptions: { loader: 'never' } })
        expect(fake.create_element).toHaveBeenCalledWith({ layout: { type: 'tabs' }, wallets })
    })

    it('hands Stripe the Geist font inline and falls back when it cannot be read', async () => {
        const fake = stripe_fake_install('ready')

        await form_open(key_new(), started_now(), host_new())
        vi.mocked(fetch).mockResolvedValue(font_response(404))
        await form_open(key_new(), started_now(), host_new())

        const base64 = btoa(String.fromCharCode(...FONT_BYTES))
        const font = { family: 'Geist', src: `url(data:font/woff2;base64,${base64})` }

        expect(init_options(fake, 0)).toMatchObject({ elementsOptions: { fonts: [font] } })
        expect(init_options(fake, 1)).toMatchObject({ elementsOptions: { fonts: [] } })
    })

    it('mounts the card form for the session that started and reports its total', async () => {
        const fake = stripe_fake_install('ready')
        const host = host_new()
        const form = await form_open(key_new(), started_now(), host)

        expect(init_options(fake, 0)).toMatchObject({ clientSecret: STARTED.client_secret })
        expect(fake.mount).toHaveBeenCalledWith(host)
        expect(form.amount).toBe(10)
        expect(form.currency).toBe('cad')

        await expect(form.confirm()).resolves.toBeNull()

        expect(fake.confirm).toHaveBeenCalledWith({ redirect: 'if_required' })
        expect(fake.destroy).not.toHaveBeenCalled()

        form.destroy()

        expect(fake.destroy).toHaveBeenCalledTimes(1)
    })
})

describe('checkout_preload before the form opens', () => {
    it('takes the theme the page shows when the form opens, not when it was prepared', async () => {
        const fake = stripe_fake_install('ready')

        document.documentElement.classList.add('theme-light')

        const preloaded = await checkout_preload(key_new(), started_now())

        document.documentElement.classList.replace('theme-light', 'theme-dark')
        await preloaded.open(host_new())

        const [appearance] = fake.change_appearance.mock.calls[0] ?? []
        const [applied] = fake.change_appearance.mock.invocationCallOrder
        const [mounted] = fake.mount.mock.invocationCallOrder

        expect(appearance).toMatchObject({ theme: 'night' })
        expect(applied).toBeLessThan(mounted ?? 0)
    })

    it('loads the session before any card form exists and is not loaded again', async () => {
        const fake = stripe_fake_install('ready')
        const host = host_new()
        const preloaded = await checkout_preload(key_new(), started_now())

        expect(preloaded.session_id).toBe(SESSION_ID)
        expect(fake.init).toHaveBeenCalledTimes(1)
        expect(fake.load_actions).toHaveBeenCalledTimes(1)
        expect(fake.create_element).not.toHaveBeenCalled()

        const form = await preloaded.open(host)

        expect(form.amount).toBe(10)
        expect(fake.mount).toHaveBeenCalledWith(host)
        expect(fake.init).toHaveBeenCalledTimes(1)
        expect(fake.load_actions).toHaveBeenCalledTimes(1)
    })
})

describe('checkout_preload test cards', () => {
    it('offers test cards only to a development build holding a test key', async () => {
        const fake = stripe_fake_install('ready')
        const live = `pk_live_${crypto.randomUUID().replaceAll('-', '')}`
        const testing = await form_open(key_new(), started_now(), host_new())

        expect(fake.mount).toHaveBeenCalledTimes(1)

        const living = await form_open(live, started_now(), host_new())

        vi.stubEnv('DEV', false)

        const released = await form_open(key_new(), started_now(), host_new())

        expect(typeof testing.confirm_test).toBe('function')
        expect(living.confirm_test).toBeNull()
        expect(released.confirm_test).toBeNull()
    })

    it('pays with a payment method made from the test card token', async () => {
        const fake = stripe_fake_install('ready')
        const form = await form_open(key_new(), started_now(), host_new())
        const confirm_test = form.confirm_test

        assert(confirm_test !== null)

        await expect(confirm_test('tok_visa')).resolves.toBeNull()

        expect(fake.create_payment_method).toHaveBeenCalledWith({
            billing_details: { email: EMAIL },
            card: { token: 'tok_visa' },
            type: 'card',
        })

        expect(fake.confirm).toHaveBeenCalledWith({
            paymentMethod: PAYMENT_METHOD_ID,
            redirect: 'if_required',
        })
    })

    it('reports a test card Stripe declines or will not turn into a payment method', async () => {
        const fake = stripe_fake_install('ready')
        const form = await form_open(key_new(), started_now(), host_new())
        const confirm_test = form.confirm_test
        const declined = { type: 'error', error: { code: 'paymentFailed', message: DECLINED } }

        assert(confirm_test !== null)

        fake.confirm.mockResolvedValueOnce(declined)

        await expect(confirm_test('tok_chargeDeclined')).resolves.toBe(DECLINED)

        fake.create_payment_method.mockResolvedValueOnce({ error: { message: 'No such token.' } })

        await expect(confirm_test('tok_visa')).resolves.toBe('No such token.')

        expect(fake.confirm).toHaveBeenCalledTimes(1)
    })
})

describe('stripe_preload', () => {
    it('loads Stripe once for the page and the form that follows it', async () => {
        const fake = stripe_fake_install('ready')
        const key = key_new()

        stripe_preload(key)
        await form_open(key, started_now(), host_new())

        expect(fake.mount).toHaveBeenCalledTimes(1)

        await form_open(key, started_now(), host_new())

        expect(load_stripe).toHaveBeenCalledTimes(1)
        expect(fetch).toHaveBeenCalledTimes(1)
        expect(fake.mount).toHaveBeenCalledTimes(2)
    })

    it('loads Stripe again after a load that failed', async () => {
        const key = key_new()

        load_stripe.mockResolvedValueOnce(null)
        stripe_preload(key)

        await vi.waitFor(() => {
            expect(load_stripe).toHaveBeenCalledTimes(1)
        })

        await expect(form_open(key, started_now(), host_new())).rejects.toThrow(
            'could not load',
        )

        const fake = stripe_fake_install('ready')

        await expect(form_open(key, started_now(), host_new())).resolves.toMatchObject({
            amount: 10,
        })

        expect(load_stripe.mock.calls.length).toBeGreaterThanOrEqual(2)
        expect(fake.mount).toHaveBeenCalledTimes(1)
    })
})

describe('checkout_preload when Stripe refuses a payment', () => {
    it('turns a declined card and a confirmation that threw into messages to show', async () => {
        const fake = stripe_fake_install('ready')
        const declined = { type: 'error', error: { code: 'paymentFailed', message: DECLINED } }
        const form = await form_open(key_new(), started_now(), host_new())

        fake.confirm.mockResolvedValueOnce(declined)
        fake.confirm.mockRejectedValueOnce(new Error('network error: offline'))

        await expect(form.confirm()).resolves.toBe(DECLINED)
        await expect(form.confirm()).resolves.toContain('could not be reached')
    })

    it('turns a confirmation that throws before it returns into a message', async () => {
        const fake = stripe_fake_install('ready')
        const form = await form_open(key_new(), started_now(), host_new())
        const confirm_test = form.confirm_test

        assert(confirm_test !== null)

        fake.confirm.mockImplementation(() => {
            throw new Error(MESSAGE_RETURN_URL)
        })

        await expect(form.confirm()).resolves.toContain('returnUrl')
        await expect(confirm_test('tok_visa')).resolves.toContain('returnUrl')

        expect(fake.confirm).toHaveBeenCalledTimes(2)
    })
})

describe('checkout_preload when Stripe refuses a form', () => {
    it('destroys a card form that failed to load and reports why', async () => {
        const fake = stripe_fake_install('loaderror')

        await expect(form_open(key_new(), started_now(), host_new())).rejects.toThrow(
            KEY_INVALID,
        )

        expect(fake.destroy).toHaveBeenCalledTimes(1)
    })

    it('mounts no card form for a session the server would not start', async () => {
        const fake = stripe_fake_install('ready')
        const refused = new Error('api error: Stripe could not start the checkout.')
        const starting = Promise.reject(refused)

        await expect(form_open(key_new(), starting, host_new())).rejects.toThrow(
            'Stripe could not start the checkout.',
        )

        expect(fake.create_element).not.toHaveBeenCalled()
        expect(fake.mount).not.toHaveBeenCalled()
    })

    it('mounts no card form for a secret that belongs to another session', async () => {
        const fake = stripe_fake_install('ready')
        const stray = Promise.resolve({ ...STARTED, client_secret: 'cs_test_other_secret_x' })

        await expect(form_open(key_new(), stray, host_new())).rejects.toThrow(
            'an assertion failed',
        )

        expect(fake.init).not.toHaveBeenCalled()
        expect(fake.mount).not.toHaveBeenCalled()
    })

    it('makes no card form for a session Stripe will not load', async () => {
        const fake = stripe_fake_install('ready')
        const refused = { type: 'error', error: { code: null, message: 'No such session.' } }

        fake.load_actions.mockResolvedValue(refused)

        await expect(form_open(key_new(), started_now(), host_new())).rejects.toThrow(
            'No such session.',
        )

        expect(fake.create_element).not.toHaveBeenCalled()
        expect(fake.mount).not.toHaveBeenCalled()
    })

    it('reports a Stripe.js that could not be loaded', async () => {
        load_stripe.mockResolvedValue(null)

        await expect(form_open(key_new(), started_now(), host_new())).rejects.toThrow(
            'could not load',
        )
    })
})

describe('stripe_appearance', () => {
    it('follows the light or dark theme remi is showing', () => {
        document.documentElement.classList.add('theme-light')

        expect(stripe_appearance().theme).toBe('stripe')

        document.documentElement.classList.replace('theme-light', 'theme-dark')

        expect(stripe_appearance().theme).toBe('night')
    })

    it('takes its colors and sizes from the theme tokens and keeps the remi font first', () => {
        const appearance = stripe_appearance()

        expect(appearance.variables).toMatchObject({
            borderRadius: '8px',
            colorBackground: 'rgb(16, 16, 16)',
            colorDanger: 'rgb(248, 113, 113)',
            colorPrimary: 'rgb(10, 20, 30)',
            colorText: 'rgb(230, 230, 230)',
            fontSizeBase: '15px',
        })

        const focus = appearance.rules?.['.Input:focus'] ?? {}

        expect(focus['boxShadow']).toBe('0 0 0 1px rgb(10, 20, 30), 3px 3px 0 rgb(40, 50, 60)')
        expect(appearance.variables?.fontFamily?.startsWith('"Geist"')).toBe(true)
        expect(document.body.childElementCount).toBe(0)
    })
})
