import { loadStripe } from '@stripe/stripe-js/pure'
import { assert } from './assert'
import { error_friendly } from './errors'
import { log_warn } from './log'
import type {
    Appearance,
    CustomFontSource,
    PaymentMethodResult,
    Stripe,
    StripeCheckoutConfirmResult,
    StripeCheckoutElementsSdk,
    StripeCheckoutLoadActionsResult,
    StripeCheckoutLoadActionsSuccess,
    StripePaymentElement,
} from '@stripe/stripe-js'
import type { CheckoutSessionID, CheckoutStarted } from '../types'


export interface CheckoutForm {
    amount: number
    confirm: () => Promise<string | null>
    confirm_test: ((card: TestCard) => Promise<string | null>) | null
    currency: string
    destroy: () => void
}

export interface CheckoutPreloaded {
    open: (host: HTMLElement) => Promise<CheckoutForm>
    session_id: CheckoutSessionID
}

export interface TestCardOption {
    card: TestCard
    label: string
}

interface CheckoutLoaded {
    actions: StripeCheckoutLoadActionsSuccess
    checkout: StripeCheckoutElementsSdk
    stripe: Stripe
    testing: boolean
}

interface StripeLoaded {
    fonts: CustomFontSource[]
    stripe: Stripe
    testing: boolean
}

export type TestCard = 'tok_chargeDeclined' | 'tok_threeDSecure2Required' | 'tok_visa'

type ConfirmOptions = NonNullable<Parameters<StripeCheckoutLoadActionsSuccess['confirm']>[0]>

type ProbeProperty = 'border-top-left-radius' | 'color' | 'font-size'

export const TEST_CARDS: readonly Readonly<TestCardOption>[] = Object.freeze([
    { card: 'tok_visa', label: 'Succeeds (4242)' },
    { card: 'tok_chargeDeclined', label: 'Declined (0002)' },
    { card: 'tok_threeDSecure2Required', label: '3D Secure (3220)' },
])

const COLOR_SENTINEL = '#010203'
const CSS_CLASS_THEME_LIGHT = 'theme-light'
const FONT_FAMILY_FIELDS = '"Geist", system-ui, sans-serif'
const FONT_GEIST_URL = '/fonts/geist-variable.woff2'
const INPUT_PADDING = '10px 12px'
const LABEL_FONT_SIZE = '14px'
const LABEL_MARGIN_BOTTOM = '6px'
const LINE_HEIGHT_FIELDS = '20px'
const MESSAGE_FONT_UNREADABLE = 'the Geist font could not be read as a data address'
const MESSAGE_FORM_FAILED = 'The payment form could not load. Close it and try again.'
const MESSAGE_STRIPE_UNREACHABLE = 'Payments could not load. Check the connection and try again.'
const MESSAGE_TEST_CARD_REFUSED = 'Stripe would not make a payment method from that test card.'
const PUBLISHABLE_KEY_PATTERN = /^pk_(?:live|test)_[A-Za-z0-9]{1,250}$/
const PUBLISHABLE_KEY_TEST_PREFIX = 'pk_test_'
const SPACING_COLUMNS = '12px'
const SPACING_ROWS = '16px'
const STRIPE_LOADS = new Map<string, Promise<StripeLoaded>>()
const TOKEN_COLOR_PREFIX = '--color-'


export async function checkout_preload(
    publishable_key: string,
    starting: Promise<CheckoutStarted>,
): Promise<CheckoutPreloaded> {
    assert(PUBLISHABLE_KEY_PATTERN.test(publishable_key))
    assert(STRIPE_LOADS.size <= 1)

    const loading = Promise.all([stripe_load(publishable_key), starting])

    return loading.then(async ([loaded, started]) => checkout_preload_session(loaded, started))
}

export function stripe_appearance(): Appearance {
    assert(typeof document !== 'undefined')
    assert(document.body.isConnected)

    const probe = document.createElement('span')

    document.body.append(probe)

    const accent = token_color(probe, '--color-accent')
    const border = token_color(probe, '--color-field-border')
    const content_muted = token_color(probe, '--color-content-muted')
    const plane = token_color(probe, '--color-plane')

    const variables = {
        borderRadius: token_computed(probe, 'border-top-left-radius', '--radius-md'),
        colorBackground: token_color(probe, '--color-field'),
        colorDanger: token_color(probe, '--color-danger-text'),
        colorPrimary: accent,
        colorText: token_color(probe, '--color-content'),
        colorTextPlaceholder: token_color(probe, '--color-content-meta'),
        colorTextSecondary: content_muted,
        fontFamily: FONT_FAMILY_FIELDS,
        fontSizeBase: token_computed(probe, 'font-size', '--text-sm'),
        gridColumnSpacing: SPACING_COLUMNS,
        gridRowSpacing: SPACING_ROWS,
    }

    const input = {
        border: `1px solid ${border}`,
        boxShadow: 'none',
        lineHeight: LINE_HEIGHT_FIELDS,
        padding: INPUT_PADDING,
    }

    const label = {
        color: content_muted,
        fontSize: LABEL_FONT_SIZE,
        fontWeight: '500',
        lineHeight: LINE_HEIGHT_FIELDS,
        marginBottom: LABEL_MARGIN_BOTTOM,
    }

    const rules = {
        '.Input': input,
        '.Input:focus': {
            borderColor: accent,
            boxShadow: `0 0 0 1px ${accent}, 3px 3px 0 ${plane}`,
        },
        '.Label': label,
    }

    probe.remove()

    const light = document.documentElement.classList.contains(CSS_CLASS_THEME_LIGHT)

    return { rules, theme: light ? 'stripe' : 'night', variables }
}

export function stripe_preload(publishable_key: string): void {
    assert(PUBLISHABLE_KEY_PATTERN.test(publishable_key))
    assert(STRIPE_LOADS.size <= 1)

    void stripe_load(publishable_key).catch(stripe_preload_failed)
}

async function blob_data_address(blob: Blob): Promise<string> {
    assert(blob.size > 0)

    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader()

        reader.addEventListener('load', () => {
            if (typeof reader.result === 'string') {
                resolve(reader.result)

                return
            }

            reject(new Error(MESSAGE_FONT_UNREADABLE))
        })

        reader.addEventListener('error', () => {
            reject(reader.error ?? new Error(MESSAGE_FONT_UNREADABLE))
        })

        reader.readAsDataURL(blob)
    })
}

function checkout_actions(
    loaded: StripeCheckoutLoadActionsResult,
): StripeCheckoutLoadActionsSuccess {
    assert(['error', 'success'].includes(loaded.type))

    if (loaded.type === 'error') throw new Error(loaded.error.message)

    assert(typeof loaded.actions.confirm === 'function')

    return loaded.actions
}

async function checkout_confirm(actions: StripeCheckoutLoadActionsSuccess): Promise<string | null> {
    assert(typeof actions.confirm === 'function')

    return confirm_settled(actions, { redirect: 'if_required' })
}

async function checkout_confirm_test(
    stripe: Stripe,
    actions: StripeCheckoutLoadActionsSuccess,
    card: TestCard,
): Promise<string | null> {
    assert(TEST_CARDS.some((option) => option.card === card))
    assert(typeof stripe.createPaymentMethod === 'function')
    assert(typeof actions.confirm === 'function')

    const email = actions.getSession().email

    assert(email === null || email.includes('@'))

    const billing = email === null ? {} : { billing_details: { email } }
    const data = { ...billing, card: { token: card }, type: 'card' as const }
    const confirming = test_card_confirm.bind(undefined, actions)

    return stripe.createPaymentMethod(data).then(confirming, (error: unknown) => {
        return error_friendly(error).message
    })
}

function checkout_form_build(
    loaded: CheckoutLoaded,
    element: StripePaymentElement,
): CheckoutForm {
    assert(typeof loaded.actions.getSession === 'function')
    assert(typeof element.destroy === 'function')
    assert(typeof loaded.stripe.createPaymentMethod === 'function')

    const session = loaded.actions.getSession()
    const divisor = session.minorUnitsAmountDivisor
    const tester = checkout_confirm_test.bind(undefined, loaded.stripe, loaded.actions)

    assert(divisor > 0)
    assert(session.currency.length > 0)

    return {
        amount: session.total.total.minorUnitsAmount / divisor,
        confirm: checkout_confirm.bind(undefined, loaded.actions),
        confirm_test: loaded.testing ? tester : null,
        currency: session.currency,
        destroy: element.destroy.bind(element),
    }
}

async function checkout_form_open(
    loaded: CheckoutLoaded,
    host: HTMLElement,
): Promise<CheckoutForm> {
    assert(typeof loaded.checkout.createPaymentElement === 'function')
    assert(host.childElementCount === 0)

    loaded.checkout.changeAppearance(stripe_appearance())

    const element = loaded.checkout.createPaymentElement({
        layout: { type: 'tabs' },
        wallets: { applePay: 'never', googlePay: 'never', link: 'never' },
    })

    const ready = element_ready(element)

    element.mount(host)

    const building = ready.then(() => checkout_form_build(loaded, element))

    return building.catch((error: unknown) => {
        element.destroy()

        throw error
    })
}

async function checkout_preload_session(
    loaded: StripeLoaded,
    started: CheckoutStarted,
): Promise<CheckoutPreloaded> {
    assert(typeof loaded.stripe.initCheckoutElementsSdk === 'function')
    assert(started.session_id.startsWith('cs_'))
    assert(loaded.fonts.length <= 1)

    const secret = started_secret(started)

    const checkout = loaded.stripe.initCheckoutElementsSdk({
        clientSecret: secret,
        elementsOptions: { fonts: loaded.fonts, loader: 'never' },
    })

    const { stripe, testing } = loaded
    const session_id = started.session_id

    return checkout.loadActions().then(checkout_actions).then((actions) => {
        const prepared: CheckoutLoaded = { actions, checkout, stripe, testing }

        return { open: checkout_form_open.bind(undefined, prepared), session_id }
    })
}

function color_srgb(color: string): string {
    assert(color.length > 0)
    assert(!color.includes('var('))

    if (color.startsWith('rgb')) return color

    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })

    if (context === null) return color

    context.fillStyle = COLOR_SENTINEL
    context.fillStyle = color

    if (context.fillStyle === COLOR_SENTINEL) return color

    context.fillRect(0, 0, 1, 1)

    const [red = 0, green = 0, blue = 0, alpha = 0] = context.getImageData(0, 0, 1, 1).data
    const opacity = (alpha / 255).toFixed(3)

    return `rgba(${String(red)}, ${String(green)}, ${String(blue)}, ${opacity})`
}

function confirm_failed(error: unknown): string {
    const message = error_friendly(error).message

    assert(message.length > 0)

    log_warn('[checkout] Stripe could not confirm the payment', error)

    return message
}

function confirm_refusal(confirmed: StripeCheckoutConfirmResult): string | null {
    assert(['error', 'success'].includes(confirmed.type))

    if (confirmed.type === 'error') return confirmed.error.message

    return null
}

async function confirm_settled(
    actions: StripeCheckoutLoadActionsSuccess,
    options: ConfirmOptions,
): Promise<string | null> {
    assert(typeof actions.confirm === 'function')
    assert(options.redirect === 'if_required')

    const confirming = Promise.resolve(options).then(async (chosen) => actions.confirm(chosen))

    return confirming.then(confirm_refusal, confirm_failed)
}

async function element_ready(element: StripePaymentElement): Promise<void> {
    assert(typeof element.on === 'function')
    assert(typeof element.mount === 'function')

    return new Promise<void>((resolve, reject) => {
        element.on('ready', () => {
            resolve()
        })

        element.on('loaderror', (event) => {
            reject(new Error(event.error.message ?? MESSAGE_FORM_FAILED))
        })
    })
}

async function font_blob(response: Response): Promise<Blob> {
    assert(response.type !== 'opaque')
    assert(response.url === '' || response.url.endsWith(FONT_GEIST_URL))

    if (!response.ok) throw new Error(`${FONT_GEIST_URL} answered ${String(response.status)}`)

    return response.blob()
}

function font_fallback(error: unknown): CustomFontSource[] {
    assert(error !== undefined)

    log_warn('[checkout] the card fields fall back to the system font', error)

    return []
}

function font_inline(address: string): CustomFontSource[] {
    assert(address.startsWith('data:'))
    assert(address.includes(';base64,'))

    return [{ family: 'Geist', src: `url(${address})`, weight: '100 900' }]
}

async function font_sources(): Promise<CustomFontSource[]> {
    assert(FONT_GEIST_URL.endsWith('.woff2'))
    assert(typeof fetch === 'function')

    return fetch(FONT_GEIST_URL)
        .then(font_blob)
        .then(blob_data_address)
        .then(font_inline)
        .catch(font_fallback)
}

function started_secret(started: CheckoutStarted): string {
    assert(started.session_id.startsWith('cs_'))
    assert(started.client_secret.startsWith(`${started.session_id}_secret_`))

    return started.client_secret
}

async function stripe_load(publishable_key: string): Promise<StripeLoaded> {
    assert(PUBLISHABLE_KEY_PATTERN.test(publishable_key))
    assert(STRIPE_LOADS.size <= 1)

    const cached = STRIPE_LOADS.get(publishable_key)

    if (cached !== undefined) return cached

    const options = { developerTools: { assistant: { enabled: false } } }
    const testing = stripe_test_cards_allowed(publishable_key)
    const loading = Promise.all([loadStripe(publishable_key, options), font_sources()])
    const loaded = loading.then(stripe_loaded.bind(undefined, testing))

    STRIPE_LOADS.clear()
    STRIPE_LOADS.set(publishable_key, loaded)

    assert(STRIPE_LOADS.size === 1)

    void loaded.catch(() => STRIPE_LOADS.delete(publishable_key))

    return loaded
}

function stripe_loaded(
    testing: boolean,
    [stripe, fonts]: [Stripe | null, CustomFontSource[]],
): StripeLoaded {
    assert(stripe === null || typeof stripe.initCheckoutElementsSdk === 'function')
    assert(fonts.length <= 1)

    if (stripe === null) throw new Error(MESSAGE_STRIPE_UNREACHABLE)

    return { fonts, stripe, testing }
}

function stripe_test_cards_allowed(publishable_key: string): boolean {
    assert(PUBLISHABLE_KEY_PATTERN.test(publishable_key))
    assert(typeof import.meta.env.DEV === 'boolean')

    if (!import.meta.env.DEV) return false

    return publishable_key.startsWith(PUBLISHABLE_KEY_TEST_PREFIX)
}

function stripe_preload_failed(error: unknown): void {
    assert(error !== undefined)

    log_warn('[checkout] Stripe.js could not load ahead of the payment form', error)
}

async function test_card_confirm(
    actions: StripeCheckoutLoadActionsSuccess,
    created: PaymentMethodResult,
): Promise<string | null> {
    assert(typeof actions.confirm === 'function')
    assert(created.error !== undefined || created.paymentMethod.id.startsWith('pm_'))

    if (created.error !== undefined) return created.error.message ?? MESSAGE_TEST_CARD_REFUSED

    const options = { paymentMethod: created.paymentMethod.id, redirect: 'if_required' as const }

    return confirm_settled(actions, options)
}

function token_color(probe: HTMLElement, token: string): string {
    assert(token.startsWith(TOKEN_COLOR_PREFIX))
    assert(probe.isConnected)

    return color_srgb(token_computed(probe, 'color', token))
}

function token_computed(probe: HTMLElement, property: ProbeProperty, token: string): string {
    assert(token.startsWith('--'))
    assert(probe.isConnected)
    assert(property !== 'color' || token.startsWith(TOKEN_COLOR_PREFIX))

    probe.style.setProperty(property, `var(${token})`)

    return getComputedStyle(probe).getPropertyValue(property)
}
