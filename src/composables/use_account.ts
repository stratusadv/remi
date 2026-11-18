import { computed, ref, shallowRef } from 'vue'
import { assert } from '../lib/assert'
import { SECONDS_PER_HOUR, seconds_to_balance } from '../lib/duration'
import { error_shown } from '../lib/errors'
import { ipc } from '../lib/ipc'
import { region_is_known } from '../lib/regions'
import type {
    Account,
    AccountSignUp,
    AccountStatus,
    CheckoutFinished,
    CheckoutSessionID,
    CheckoutStarted,
    PromoCode,
    SignInCode,
} from '../types'


export interface HoursQuote {
    balance_after_text: string
    price_text: string
}

const ACCOUNT_GENERATION_MAX = Number.MAX_SAFE_INTEGER
const CENTS_PER_UNIT = 100
const LOCALE_PRICES = 'en-CA'
const MESSAGE_SIGNED_OUT = 'This copy of remi is not signed in to an account.'
const PUBLISHABLE_KEY_PATTERN = /^pk_(?:live|test)_[A-Za-z0-9]{1,250}$/u
const account = ref<Account | null>(null)
const account_generation = shallowRef(0)
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
    refresh,
    sign_in,
    status_load,
})


export function hours_is_valid(current: Account, hours: unknown): hours is number {
    assert(Number.isSafeInteger(current.checkout_hours_max))
    assert(current.checkout_hours_max > 0)

    if (typeof hours !== 'number') return false
    if (!Number.isSafeInteger(hours)) return false

    return hours >= 1 && hours <= current.checkout_hours_max
}

export function hours_quote(current: Account, hours: number): HoursQuote {
    assert(hours_is_valid(current, hours))
    assert(Number.isSafeInteger(current.price_hour_cents))

    const balance_after_seconds = current.balance_seconds + hours * SECONDS_PER_HOUR
    const price_cents = hours * current.price_hour_cents

    return {
        balance_after_text: seconds_to_balance(balance_after_seconds),
        price_text: price_format(price_cents / CENTS_PER_UNIT, current.price_currency),
    }
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

export function price_hour_text(current: Account): string {
    assert(Number.isSafeInteger(current.price_hour_cents))
    assert(current.price_hour_cents > 0)

    return price_format(current.price_hour_cents / CENTS_PER_UNIT, current.price_currency)
}

export function use_account(): typeof api {
    assert(account.value === null || status.value.signed_in)
    assert(typeof status.value.billing === 'boolean')

    if (status.value.signed_in) assert(status.value.billing)

    return api
}

function account_generation_advance(): void {
    const generation = account_generation.value

    assert(Number.isSafeInteger(generation))
    assert(generation < ACCOUNT_GENERATION_MAX)

    account_generation.value = generation + 1
}

async function account_load(): Promise<void> {
    if (!status.value.signed_in) return

    assert(status.value.billing)

    account_generation_advance()

    const generation = account_generation.value

    return ipc.account_get()
        .then((loaded) => {
            if (account_generation.value === generation) account_loaded(loaded)
        })
        .catch((error: unknown) => {
            if (account_generation.value === generation) error_record(error)
        })
}

function account_loaded(loaded: Account | null): void {
    assert(loaded === null || Number.isSafeInteger(loaded.balance_seconds))
    assert(loaded === null || loaded.balance_seconds >= 0)
    assert(loaded === null || loaded.email.length > 0)
    assert(loaded === null || loaded.price_hour_cents > 0)

    const key = loaded?.publishable_key ?? ''

    if (key !== '') assert(PUBLISHABLE_KEY_PATTERN.test(key))

    if (!status.value.billing) {
        assert(!status.value.signed_in)
        assert(account.value === null)

        return
    }

    account_generation_advance()
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
    assert(account.value !== null)
    assert(hours_is_valid(account.value, hours))

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
    assert(status.value.billing)
    assert(sign_up.name.trim().length > 0)
    assert(sign_up.email.trim().length > 0)
    assert(region_is_known(sign_up.region))

    return ipc.account_create(sign_up).then(account_loaded)
}

function error_record(error: unknown): void {
    const message = error_shown(error)

    assert(message.length > 0)

    error_message.value = message
}

async function promo_redeem(code: PromoCode): Promise<void> {
    assert(status.value.billing)
    assert(status.value.signed_in)
    assert(code.trim().length > 0)

    return ipc.account_promo_redeem(code.trim()).then(account_loaded)
}

async function refresh(): Promise<void> {
    return status_load().then(() => {
        assert(account.value === null || status.value.signed_in)
        assert(status.value.billing || !status.value.signed_in)

        void account_load()
    })
}

async function sign_in(code: SignInCode): Promise<void> {
    assert(status.value.billing)
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

    if (loaded.signed_in) return

    account_generation_advance()
    account.value = null
}
