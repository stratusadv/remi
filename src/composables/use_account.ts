import { computed, ref } from 'vue'
import { assert } from '../lib/assert'
import { SECONDS_PER_HOUR, seconds_to_balance } from '../lib/duration'
import { error_friendly } from '../lib/errors'
import { ipc } from '../lib/ipc'
import type {
    Account,
    AccountOffer,
    AccountSignUp,
    AccountStatus,
    CheckoutFinished,
    CheckoutSessionID,
    CheckoutStarted,
    PromoCode,
    SignInCode,
} from '../types'


export interface OfferCard {
    balance_after_text: string
    best: boolean
    offer: AccountOffer
    price_text: string
    rate_text: string
    regular_text: string
    saving_percent: number
    saving_text: string
}

interface OfferPair {
    offer: AccountOffer
    other: AccountOffer
}

const CENTS_PER_UNIT = 100
const LOCALE_PRICES = 'en-CA'
const MESSAGE_SIGNED_OUT = 'This copy of remi is not signed in to an account.'
const OFFERS_MAX = 4
const PERCENT = 100
const PUBLISHABLE_KEY_PATTERN = /^pk_(?:live|test)_[A-Za-z0-9]{1,250}$/
const account = ref<Account | null>(null)
const error_message = ref<string | null>(null)
const status = ref<AccountStatus>({ billing: false, signed_in: false })
const sign_up_needed = computed(() => status.value.billing && !status.value.signed_in)

const balance_text = computed(() =>
    account.value === null ? '' : seconds_to_balance(account.value.balance_seconds))

const api = Object.freeze({
    account,
    balance_text,
    error_message,
    sign_up_needed,
    status,
    account_load,
    checkout_finish,
    checkout_start,
    code_copy,
    create,
    promo_redeem,
    sign_in,
    status_load,
})


export function offer_cards(offers: readonly AccountOffer[], balance_seconds: number): OfferCard[] {
    assert(offers.length <= OFFERS_MAX)
    assert(Number.isSafeInteger(balance_seconds))

    const best = offer_best(offers)
    const priciest = offers.reduce<AccountOffer | null>(offer_pricier, null)

    return offers.map((offer) => {
        const balance_after_seconds = balance_seconds + offer.hours * SECONDS_PER_HOUR
        const pair = { offer, other: priciest ?? offer }
        const regular_cents = offer_regular_cents(pair)
        const saving_cents = regular_cents - offer.price_cents

        return {
            balance_after_text: seconds_to_balance(balance_after_seconds),
            best: offer === best,
            offer,
            price_text: offer_price(offer),
            rate_text: offer_rate(offer),
            regular_text: price_format(regular_cents / CENTS_PER_UNIT, offer.currency),
            saving_percent: offer_saving_percent(pair),
            saving_text: price_format(saving_cents / CENTS_PER_UNIT, offer.currency),
        }
    })
}

export function offer_hours(offer: AccountOffer): string {
    assert(Number.isSafeInteger(offer.hours))
    assert(offer.hours > 0)

    const unit = offer.hours === 1 ? 'hour' : 'hours'

    return `${String(offer.hours)} ${unit}`
}

export function offer_price(offer: AccountOffer): string {
    assert(Number.isSafeInteger(offer.price_cents))
    assert(offer.price_cents >= 0)

    return price_format(offer.price_cents / CENTS_PER_UNIT, offer.currency)
}

export function price_format(amount: number, currency: string): string {
    assert(Number.isFinite(amount))
    assert(currency.length === 3)

    const format = new Intl.NumberFormat(LOCALE_PRICES, {
        currency: currency.toUpperCase(),
        style: 'currency',
    })

    return format.format(amount)
}

export function use_account(): typeof api {
    assert(Object.isFrozen(api))
    assert(typeof status.value.billing === 'boolean')

    if (status.value.signed_in) assert(status.value.billing)

    return api
}

async function account_load(): Promise<void> {
    if (!status.value.signed_in) return

    assert(status.value.billing)

    return ipc.account_get().then(account_loaded, error_record)
}

function account_loaded(loaded: Account | null): void {
    assert(status.value.billing)
    assert(loaded === null || Number.isSafeInteger(loaded.balance_seconds))
    assert(loaded === null || loaded.balance_seconds >= 0)
    assert(loaded === null || loaded.email.length > 0)
    assert(loaded === null || loaded.offers.length <= OFFERS_MAX)

    const key = loaded?.publishable_key ?? ''

    if (key !== '') assert(PUBLISHABLE_KEY_PATTERN.test(key))

    account.value = loaded
    error_message.value = null
    status.value = { billing: true, signed_in: loaded !== null }
}

async function checkout_finish(session_id: CheckoutSessionID): Promise<boolean> {
    assert(status.value.signed_in)
    assert(session_id.length > 0)

    return ipc.account_checkout_finish(session_id).then(checkout_finished)
}

function checkout_finished(finished: CheckoutFinished): boolean {
    assert(typeof finished.paid === 'boolean')
    assert(Number.isSafeInteger(finished.account.balance_seconds))

    account_loaded(finished.account)

    return finished.paid
}

async function checkout_start(hours: number): Promise<CheckoutStarted> {
    assert(status.value.signed_in)
    assert(account.value?.offers.some((offer) => offer.hours === hours) === true)

    return ipc.account_checkout_start(hours)
}

async function code_copy(): Promise<void> {
    assert(status.value.billing)
    assert(typeof navigator.clipboard.writeText === 'function')

    return ipc.account_code_get().then(async (code) => {
        if (code === null) throw new Error(MESSAGE_SIGNED_OUT)

        return navigator.clipboard.writeText(code)
    })
}

async function create(sign_up: AccountSignUp): Promise<void> {
    assert(sign_up.name.trim().length > 0)
    assert(sign_up.email.trim().length > 0)

    return ipc.account_create(sign_up).then(account_loaded)
}

function error_record(error: unknown): void {
    const friendly = error_friendly(error)

    assert(friendly.message.length > 0)

    error_message.value = friendly.message
}

function offer_best(offers: readonly AccountOffer[]): AccountOffer | null {
    assert(offers.length <= OFFERS_MAX)

    const cheapest = offers.reduce<AccountOffer | null>(offer_cheaper, null)

    if (cheapest === null) return null
    if (offers.length < 2) return null

    const ties = offers.filter((offer) => offer_rate_compare({ offer, other: cheapest }) === 0)

    return ties.length === 1 ? cheapest : null
}

function offer_cheaper(cheapest: AccountOffer | null, offer: AccountOffer): AccountOffer {
    assert(cheapest === null || cheapest.hours > 0)
    assert(offer.hours > 0)

    if (cheapest === null) return offer

    return offer_rate_compare({ offer, other: cheapest }) < 0 ? offer : cheapest
}

function offer_pricier(priciest: AccountOffer | null, offer: AccountOffer): AccountOffer {
    assert(priciest === null || priciest.hours > 0)
    assert(offer.hours > 0)

    if (priciest === null) return offer

    return offer_rate_compare({ offer, other: priciest }) > 0 ? offer : priciest
}

function offer_rate(offer: AccountOffer): string {
    assert(offer.hours > 0)
    assert(Number.isSafeInteger(offer.price_cents))

    return price_format(offer.price_cents / offer.hours / CENTS_PER_UNIT, offer.currency)
}

function offer_rate_compare(pair: OfferPair): number {
    assert(pair.offer.hours > 0)
    assert(pair.other.hours > 0)

    return pair.offer.price_cents * pair.other.hours - pair.other.price_cents * pair.offer.hours
}

function offer_regular_cents(pair: OfferPair): number {
    assert(offer_rate_compare(pair) <= 0)
    assert(pair.other.hours > 0)

    const regular_cents = Math.round((pair.offer.hours * pair.other.price_cents) / pair.other.hours)

    assert(Number.isSafeInteger(regular_cents))
    assert(regular_cents >= pair.offer.price_cents)

    return regular_cents
}

function offer_saving_percent(pair: OfferPair): number {
    assert(offer_rate_compare(pair) <= 0)
    assert(pair.other.price_cents > 0)

    const { offer, other } = pair
    const rate_gap = offer.hours * other.price_cents - offer.price_cents * other.hours
    const saving_percent = Math.floor((PERCENT * rate_gap) / (offer.hours * other.price_cents))

    assert(saving_percent >= 0)
    assert(saving_percent < PERCENT)

    return saving_percent
}

async function promo_redeem(code: PromoCode): Promise<void> {
    assert(status.value.billing)
    assert(status.value.signed_in)
    assert(code.trim().length > 0)

    return ipc.account_promo_redeem(code.trim()).then(account_loaded)
}

async function sign_in(code: SignInCode): Promise<void> {
    assert(typeof code === 'string')
    assert(code.trim().length > 0)

    return ipc.account_sign_in(code.trim()).then(account_loaded)
}

async function status_load(): Promise<void> {
    return ipc.account_status().then(status_loaded, error_record)
}

function status_loaded(loaded: AccountStatus): void {
    assert(typeof loaded.billing === 'boolean')
    assert(typeof loaded.signed_in === 'boolean')

    if (!loaded.billing) assert(!loaded.signed_in)

    status.value = loaded

    if (!loaded.signed_in) account.value = null
}
