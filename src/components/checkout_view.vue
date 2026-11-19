<script setup lang="ts">
import {
    computed,
    nextTick,
    onBeforeUnmount,
    onMounted,
    ref,
    shallowRef,
    useTemplateRef,
    watch,
} from 'vue'
import {
    hours_is_valid,
    hours_quote,
    price_format,
    price_hour_text,
    use_account,
} from '../composables/use_account'
import { use_dialog } from '../composables/use_dialog'
import { assert } from '../lib/assert'
import { SECONDS_PER_HOUR } from '../lib/duration'
import { error_friendly, error_shown } from '../lib/errors'
import { log_warn } from '../lib/log'
import { TEST_CARDS, checkout_preload, stripe_preload } from '../lib/stripe'
import CheckoutHours from './checkout_hours.vue'
import NoticeBanner from './notice_banner.vue'
import type { CheckoutForm, TestCard } from '../lib/stripe'
import type { CheckoutSessionID } from '../types'


type CheckoutPhase = 'choosing' | 'failed' | 'loading' | 'paying' | 'ready'

const HOURS_DEFAULT = 10
const MESSAGE_PAYMENTS_OFF = 'This server is not set up to take payments yet.'
const MESSAGE_PENDING = 'Your payment is being confirmed. The hours appear as soon as it clears.'
const POINT_ONE_TIME = 'One-time payment, no subscription'
const POINT_UNLIMITED = 'Unlimited notes and Ask questions for monthly active users'
const WAVE_BAR_STEP = 14
const WAVE_HEIGHT = 120

const GHOST_FIELDS = Object.freeze([
    { label: 'Card number', wide: true },
    { label: 'Expiration date', wide: false },
    { label: 'Security code', wide: false },
    { label: 'Country', wide: true },
])

const WAVE_LEVELS = Object.freeze([
    0.3,
    0.46,
    0.62,
    0.5,
    0.72,
    0.9,
    0.66,
    0.44,
    0.58,
    0.82,
    1,
    0.78,
    0.54,
    0.38,
    0.6,
    0.84,
    0.68,
    0.46,
    0.32,
    0.52,
    0.74,
    0.6,
    0.42,
    0.3,
    0.48,
    0.64,
    0.5,
    0.34,
])

const WAVE_BARS = Object.freeze(WAVE_LEVELS.map((level, index) => ({
    height: level * WAVE_HEIGHT,
    left: index * WAVE_BAR_STEP,
    top: ((1 - level) * WAVE_HEIGHT) / 2,
})))

const WAVE_WIDTH = WAVE_LEVELS.length * WAVE_BAR_STEP

const {
    account,
    account_load,
    balance_text,
    checkout_finish,
    checkout_start,
} = use_account()

const { message: dialog_message } = use_dialog()
const error_text = ref<string | null>(null)
const host_element = useTemplateRef<HTMLElement>('host_element')
const hours_current = ref<number | null>(null)
const hours_input = ref<number | string>(HOURS_DEFAULT)
const phase = ref<CheckoutPhase>('choosing')
const price_text = ref('')
const run_current = ref(0)
const test_cards_shown = ref(false)
const action_enabled = computed(() => phase.value === 'ready' || phase.value === 'failed')
const fields_shown = computed(() => phase.value === 'ready' || phase.value === 'paying')
const form_current = shallowRef<CheckoutForm | null>(null)
const session_current = shallowRef<CheckoutSessionID | null>(null)
const step = computed(() => (phase.value === 'choosing' ? 'choose' : 'pay'))

const action_label = computed(() => {
    if (phase.value === 'failed') return 'Try again'
    if (phase.value === 'paying') return 'Paying…'

    return `Pay ${price_text.value}`
})

const balance_line = computed(() =>
    account.value === null ? 'Loading…' : `${balance_text.value} of transcription left`)

const balance_low = computed(() => {
    const seconds = account.value?.balance_seconds ?? SECONDS_PER_HOUR

    return seconds < SECONDS_PER_HOUR
})

const currency_text = computed(() => account.value?.price_currency.toUpperCase() ?? '')

const points = computed(() => {
    const current = account.value

    if (current === null) return []

    return [
        `${price_hour_text(current)} per hour of transcription`,
        POINT_UNLIMITED,
        POINT_ONE_TIME,
    ]
})

const quote_current = computed(() => {
    const current = account.value
    const hours = hours_current.value

    if (current === null) return null
    if (!hours_is_valid(current, hours)) return null

    return hours_quote(current, hours)
})

const rate_text = computed(() => (account.value === null ? '' : price_hour_text(account.value)))


watch(() => account.value?.publishable_key ?? '', key_preload, { immediate: true })

onBeforeUnmount(checkout_unmount)

onMounted(account_load)

function account_retry(): void {
    assert(phase.value === 'choosing')
    assert(account.value?.payments === false)

    void account_load()
}

function action_click(): void {
    assert(step.value === 'pay')
    assert(hours_current.value !== null)

    if (phase.value === 'failed') {
        void checkout_restart()

        return
    }

    void pay(null)
}

function checkout_back(): void {
    assert(step.value === 'pay')
    assert(hours_current.value !== null)

    if (phase.value === 'paying') return

    checkout_unmount()

    hours_current.value = null
    phase.value = 'choosing'
}

async function checkout_mount(): Promise<void> {
    const hours = hours_current.value

    assert(hours !== null)
    assert(phase.value !== 'paying')

    run_current.value += 1

    const run = run_current.value

    phase.value = 'loading'
    error_text.value = null
    price_text.value = quote_current.value?.price_text ?? ''

    return checkout_prepare(run, hours).catch((error: unknown) => {
        checkout_failed(run, error)
    })
}

async function checkout_open(run: number, key: string, hours: number): Promise<void> {
    assert(run <= run_current.value)
    assert(key.startsWith('pk_'))
    assert(Number.isSafeInteger(hours))

    if (run !== run_current.value) return

    const host = host_element.value

    assert(host !== null)

    const preloaded = await checkout_preload(key, checkout_start(hours))

    if (run !== run_current.value) return

    const form = await preloaded.open(host)

    if (run !== run_current.value) {
        form.destroy()

        return
    }

    form_current.value = form
    session_current.value = preloaded.session_id
    price_text.value = price_format(form.amount, form.currency)
    test_cards_shown.value = form.confirm_test !== null
    phase.value = 'ready'
}

async function checkout_prepare(run: number, hours: number): Promise<void> {
    assert(run === run_current.value)
    assert(hours === hours_current.value)

    const key = account.value?.publishable_key ?? ''

    if (key === '') throw new Error(MESSAGE_PAYMENTS_OFF)

    return nextTick().then(async () => checkout_open(run, key, hours))
}

function checkout_failed(run: number, error: unknown): void {
    assert(run <= run_current.value)

    if (run !== run_current.value) return

    assert(phase.value === 'loading')

    phase.value = 'failed'
    error_text.value = error_shown(error)
}

async function checkout_restart(): Promise<void> {
    assert(step.value === 'pay')
    assert(hours_current.value !== null)

    if (phase.value === 'paying') return

    checkout_unmount()

    const run = run_current.value

    return account_load().then(async () => checkout_restart_reloaded(run))
}

async function checkout_restart_reloaded(run: number): Promise<void> {
    assert(run <= run_current.value)

    if (run !== run_current.value) return

    assert(phase.value === 'loading')
    assert(hours_current.value !== null)

    return checkout_mount()
}

function checkout_unmount(): void {
    const paying = phase.value === 'paying'

    assert(!paying || form_current.value !== null)
    assert(!paying || session_current.value !== null)

    run_current.value += 1

    if (!paying) form_current.value?.destroy()

    form_current.value = null
    error_text.value = null
    phase.value = 'loading'
    session_current.value = null
    test_cards_shown.value = false
}

function finish_failed(error: unknown): boolean {
    assert(error !== undefined)
    assert(session_current.value === null || phase.value === 'paying')

    log_warn('[checkout] the paid session could not be credited yet', error)

    return false
}

function hours_choose(hours: number): void {
    assert(account.value !== null)
    assert(hours_is_valid(account.value, hours))

    if (phase.value !== 'choosing') return

    assert(hours_current.value === null)

    hours_current.value = hours

    void checkout_mount()
}

function key_preload(key: string): void {
    assert(key === (account.value?.publishable_key ?? ''))
    assert(key === '' || key.startsWith('pk_'))

    if (key === '') return

    stripe_preload(key)
}

async function pay(card: TestCard | null): Promise<void> {
    assert(card === null || test_cards_shown.value)
    assert(step.value === 'pay')

    if (phase.value !== 'ready') return
    if (form_current.value === null) return
    if (session_current.value === null) return

    return pay_submit(form_current.value, session_current.value, card)
}

async function pay_confirm(form: CheckoutForm, card: TestCard | null): Promise<string | null> {
    assert(form === form_current.value)
    assert(card === null || TEST_CARDS.some((option) => option.card === card))

    if (card === null) return form.confirm()

    assert(form.confirm_test !== null)

    return form.confirm_test(card)
}

function pay_failed(error: unknown): string {
    const message = error_friendly(error).message

    assert(message.length > 0)

    log_warn('[checkout] the payment could not be confirmed', error)

    return message
}

function pay_refused(run: number, form: CheckoutForm, refusal: string): void {
    assert(refusal.length > 0)
    assert(run <= run_current.value)
    assert(run !== run_current.value || form === form_current.value)

    if (run !== run_current.value) {
        form.destroy()

        return
    }

    assert(phase.value === 'paying')

    phase.value = 'ready'
    error_text.value = refusal
}

async function pay_settled(run: number, form: CheckoutForm, paid: boolean): Promise<void> {
    assert(run <= run_current.value)
    assert(run !== run_current.value || form === form_current.value)

    form.destroy()

    if (run === run_current.value) {
        assert(phase.value === 'paying')

        checkout_unmount()

        hours_current.value = null
        phase.value = 'choosing'
    }

    if (!paid) void account_load()

    return settled_announce(paid)
}

async function pay_submit(
    form: CheckoutForm,
    session_id: CheckoutSessionID,
    card: TestCard | null,
): Promise<void> {
    assert(form === form_current.value)
    assert(session_id === session_current.value)
    assert(card === null || form.confirm_test !== null)

    const run = run_current.value

    phase.value = 'paying'
    error_text.value = null

    return pay_confirm(form, card).catch(pay_failed).then(async (refusal) => {
        if (refusal !== null) {
            pay_refused(run, form, refusal)

            return
        }

        const paid = await checkout_finish(session_id).catch(finish_failed)

        return pay_settled(run, form, paid)
    })
}

async function settled_announce(paid: boolean): Promise<void> {
    assert(typeof paid === 'boolean')

    if (!paid) return dialog_message(MESSAGE_PENDING, { title: 'Payment processing' })

    assert(account.value !== null)

    const text = `Your payment went through. You now have ${balance_text.value} of transcription.`

    return dialog_message(text, { kind: 'success', title: 'Thank you' })
}

function test_pay(card: TestCard): void {
    assert(test_cards_shown.value)
    assert(TEST_CARDS.some((option) => option.card === card))

    void pay(card)
}
</script>

<template>
    <section class="checkout-view view-stretch" :data-step="step">
        <header class="checkout-header">
            <div class="checkout-header-copy">
                <div class="checkout-title-row">
                    <h2 class="checkout-title">Buy hours</h2>
                    <p class="checkout-balance" :data-low="balance_low">
                        <span class="checkout-balance-dot" aria-hidden="true" />
                        {{ balance_line }}
                    </p>
                </div>
                <ul v-if="step === 'choose' && points.length > 0" class="checkout-points">
                    <li v-for="point in points" :key="point">
                        <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2.2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            aria-hidden="true"
                        >
                            <path d="M5 12.5l4.5 4.5L19 7.5" />
                        </svg>
                        {{ point }}
                    </li>
                </ul>
            </div>
            <svg
                v-if="step === 'choose'"
                class="checkout-wave"
                :viewBox="`0 0 ${WAVE_WIDTH} ${WAVE_HEIGHT}`"
                fill="currentColor"
                aria-hidden="true"
            >
                <rect
                    v-for="bar in WAVE_BARS"
                    :key="bar.left"
                    :x="bar.left"
                    :y="bar.top"
                    width="8"
                    :height="bar.height"
                    rx="4"
                />
            </svg>
        </header>

        <div v-if="step === 'choose'" key="choose" class="checkout-step">
            <div v-if="account !== null && !account.payments" class="checkout-off">
                <span class="checkout-icon">
                    <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.8"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                    >
                        <rect x="3" y="5.5" width="18" height="13" rx="2" />
                        <path d="M3 10h18M7 15h3" />
                    </svg>
                </span>
                <div class="checkout-off-copy">
                    <p class="checkout-off-title">Payments are unavailable</p>
                    <p class="checkout-off-text">{{ MESSAGE_PAYMENTS_OFF }}</p>
                </div>
                <button type="button" class="btn-default" @click="account_retry">
                    Try again
                </button>
            </div>

            <template v-else-if="account !== null">
                <CheckoutHours
                    v-model:hours="hours_input"
                    :account="account"
                    @choose="hours_choose"
                />
                <p class="checkout-note checkout-trust">
                    <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.8"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                    >
                        <rect x="5" y="11" width="14" height="9" rx="2" />
                        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
                    </svg>
                    One-time payments through Stripe. Card details never reach remi.
                </p>
            </template>
        </div>

        <div v-else key="pay" class="checkout-step">
            <button
                type="button"
                class="checkout-back"
                :disabled="phase === 'paying'"
                @click="checkout_back"
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                >
                    <path d="M14.5 6l-6 6 6 6" />
                </svg>
                Change hours
            </button>

            <div class="checkout-pay">
                <aside
                    v-if="hours_current !== null && quote_current !== null"
                    class="checkout-order"
                >
                    <h3 class="checkout-label">Order summary</h3>
                    <p class="checkout-order-hours">
                        <span class="checkout-order-count">{{ hours_current }}</span>
                        <span class="checkout-order-unit">
                            {{ hours_current === 1 ? 'hour' : 'hours' }} of transcription
                        </span>
                    </p>
                    <dl class="checkout-order-lines">
                        <div>
                            <dt>Per hour</dt>
                            <dd>{{ rate_text }}</dd>
                        </div>
                        <div>
                            <dt>Current balance</dt>
                            <dd>{{ balance_text }}</dd>
                        </div>
                        <div>
                            <dt>Balance after purchase</dt>
                            <dd>{{ quote_current.balance_after_text }}</dd>
                        </div>
                        <div>
                            <dt>Billing</dt>
                            <dd>One-time, no subscription</dd>
                        </div>
                    </dl>
                    <p class="checkout-order-total">
                        <span>Total</span>
                        <span class="checkout-order-amount">
                            {{ quote_current.price_text }}
                            <span class="checkout-order-currency">{{ currency_text }}</span>
                        </span>
                    </p>
                </aside>

                <div class="checkout-panel">
                    <h3 class="checkout-label">Payment details</h3>
                    <div
                        class="checkout-fields"
                        :data-phase="phase"
                        :data-shown="fields_shown"
                        :aria-busy="phase === 'loading'"
                    >
                        <div :key="run_current" ref="host_element" class="checkout-element" />
                        <div class="checkout-ghost" aria-hidden="true">
                            <div
                                v-for="field in GHOST_FIELDS"
                                :key="field.label"
                                class="checkout-ghost-cell"
                                :data-wide="field.wide"
                            >
                                <span class="checkout-ghost-label">{{ field.label }}</span>
                                <span class="checkout-ghost-field" />
                            </div>
                        </div>
                    </div>
                    <NoticeBanner
                        v-if="error_text !== null"
                        class="checkout-error"
                        @dismiss="error_text = null"
                    >
                        {{ error_text }}
                    </NoticeBanner>
                    <div class="checkout-submit">
                        <p class="checkout-note">
                            <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="1.8"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                aria-hidden="true"
                            >
                                <rect x="5" y="11" width="14" height="9" rx="2" />
                                <path d="M8 11V8a4 4 0 0 1 8 0v3" />
                            </svg>
                            Payments are processed by Stripe. Card details never reach remi.
                        </p>
                        <button
                            type="button"
                            class="btn-primary checkout-action"
                            :data-phase="phase"
                            :disabled="!action_enabled"
                            @click="action_click"
                        >
                            <svg
                                v-if="phase === 'paying'"
                                class="checkout-spinner"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2.4"
                                stroke-linecap="round"
                                aria-hidden="true"
                            >
                                <path d="M21 12a9 9 0 1 1-6.2-8.56" />
                            </svg>
                            {{ action_label }}
                        </button>
                    </div>
                </div>
            </div>

            <div v-if="test_cards_shown" class="checkout-test">
                <div class="checkout-test-copy">
                    <p class="checkout-test-title">Test cards</p>
                    <p class="checkout-test-text">
                        Stripe's fake test cards. Nothing real is charged. Only development
                        builds with a test key show this.
                    </p>
                </div>
                <div class="checkout-test-cards">
                    <button
                        v-for="option in TEST_CARDS"
                        :key="option.card"
                        type="button"
                        class="btn-default"
                        :disabled="phase !== 'ready'"
                        @click="test_pay(option.card)"
                    >
                        {{ option.label }}
                    </button>
                </div>
            </div>
        </div>
    </section>
</template>

<style scoped>
.checkout-view {
    container-type: inline-size;
    width: 100%;
}

.checkout-step {
    animation: checkout-step-enter 180ms ease-out;
}

.checkout-header {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 2rem;
    margin-bottom: 1.5rem;
}

.checkout-view[data-step="choose"] .checkout-header {
    overflow: hidden;
    margin-bottom: 1.75rem;
    padding: 2rem 2.5rem;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-xl);
    background: linear-gradient(
        104deg,
        var(--color-panel) 0 64%,
        color-mix(in oklab, var(--color-panel), var(--lift) 4%) 64%
    );
}

.checkout-header-copy {
    min-width: 0;
}

.checkout-title-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1rem;
}

.checkout-title {
    margin: 0;
}

.checkout-view[data-step="choose"] .checkout-title {
    font-size: 2.25rem;
    letter-spacing: -0.03em;
    line-height: 1.15;
}

.checkout-points {
    display: grid;
    gap: 0.5rem;
    margin: 1.125rem 0 0;
    padding: 0;
    color: var(--color-content);
    font-size: 0.9375rem;
    font-weight: 500;
    line-height: 1.375rem;
    list-style: none;
}

.checkout-points li {
    display: flex;
    align-items: center;
    gap: 0.625rem;
}

.checkout-points svg {
    flex: none;
    width: 1.125rem;
    height: 1.125rem;
    padding: 0.1875rem;
    border-radius: var(--radius-sm);
    background-color: var(--color-accent-soft);
    color: var(--color-accent-strong);
}

.checkout-balance {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
    padding: 0.25rem 0.75rem 0.25rem 0.625rem;
    border: 1px solid var(--color-border-strong);
    border-radius: 999px;
    background-color: var(--color-surface);
    color: var(--color-content);
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
    font-weight: 500;
    line-height: 1.25rem;
}

.checkout-balance-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 999px;
    background-color: var(--color-online);
}

.checkout-balance[data-low="true"] {
    border-color: var(--color-warning-border);
    background-color: var(--color-warning-bg);
    color: var(--color-warning-content);
}

.checkout-balance[data-low="true"] .checkout-balance-dot {
    background-color: var(--color-warning-content);
}

.checkout-wave {
    flex: none;
    width: min(20rem, 34%);
    height: auto;
    color: var(--color-accent);
    opacity: 0.55;
    -webkit-mask-image: linear-gradient(to right, transparent, black 50%);
    mask-image: linear-gradient(to right, transparent, black 50%);
}

.checkout-off {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 1rem;
    padding: 1.25rem 1.5rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-xl);
    background-color: var(--color-panel);
}

.checkout-off-copy {
    flex: 1 1 16rem;
    min-width: 0;
}

.checkout-off-title {
    margin: 0;
    color: var(--color-content-strong);
    font-size: 0.9375rem;
    font-weight: 600;
    line-height: 1.375rem;
}

.checkout-off-text {
    margin: 0.125rem 0 0;
    color: var(--color-content-muted);
    font-size: 0.875rem;
}

.checkout-note {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    margin: 1rem 0 0;
    color: var(--color-content-meta);
    font-size: 0.8125rem;
    text-align: center;
    text-wrap: balance;
}

.checkout-note svg {
    flex: none;
    width: 0.875rem;
    height: 0.875rem;
}

.checkout-trust {
    margin-top: 2rem;
}

.checkout-icon {
    display: grid;
    flex: none;
    place-items: center;
    width: 2rem;
    height: 2rem;
    border-radius: var(--radius-md);
    background-color: var(--color-elevated);
    color: var(--color-content-muted);
}

.checkout-icon svg {
    width: 1rem;
    height: 1rem;
}

.checkout-back {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    margin: 0 0 1rem -0.375rem;
    padding: 0.25rem 0.5rem 0.25rem 0.25rem;
    border-radius: var(--radius-md);
    color: var(--color-content-muted);
    font-size: 0.875rem;
    font-weight: 500;
    transition: background-color 120ms ease, color 120ms ease;
}

.checkout-back:enabled:hover {
    background-color: var(--color-row-hover);
    color: var(--color-content-strong);
}

.checkout-back:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.checkout-back svg {
    width: 1rem;
    height: 1rem;
}

.checkout-pay {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    overflow: hidden;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-xl);
    background-color: var(--color-panel);
}

.checkout-label {
    margin: 0 0 1.5rem;
    color: var(--color-content-meta);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    line-height: 1rem;
    text-transform: uppercase;
}

.checkout-order {
    display: flex;
    flex-direction: column;
    padding: 2.5rem 2.25rem;
    border-right: 1px solid var(--color-border);
    background-color: var(--color-surface);
}

.checkout-order-hours {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    margin: 0;
}

.checkout-order-count {
    color: var(--color-content-strong);
    font-size: 4.5rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.05em;
    line-height: 1;
}

.checkout-order-unit {
    color: var(--color-content-muted);
    font-size: 1rem;
    font-weight: 500;
}

.checkout-order-lines {
    display: grid;
    gap: 1rem;
    margin: 2.25rem 0 2.5rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--color-border);
}

.checkout-order-lines div {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    min-height: 1.25rem;
}

.checkout-order-lines dt {
    color: var(--color-content-muted);
    font-size: 0.875rem;
}

.checkout-order-lines dd {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
    color: var(--color-content-strong);
    font-size: 0.875rem;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
}

.checkout-order-total {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    margin: auto 0 0;
    padding: 1.625rem 0 0.375rem;
    border-top: 1px solid var(--color-border);
    color: var(--color-content-strong);
    font-weight: 600;
    line-height: 2rem;
}

.checkout-order-amount {
    font-size: 1.5rem;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.015em;
    line-height: 2rem;
}

.checkout-order-currency {
    margin-left: 0.125rem;
    color: var(--color-content-meta);
    font-size: 0.8125rem;
    font-weight: 500;
    letter-spacing: 0;
}

.checkout-panel {
    display: flex;
    flex-direction: column;
    padding: 2.5rem 2.25rem;
}

.checkout-panel:only-child {
    grid-column: 1 / -1;
}

.checkout-fields {
    display: grid;
}

.checkout-element,
.checkout-ghost {
    grid-area: 1 / 1;
    transition: opacity 200ms ease, visibility 0s linear 0s;
}

.checkout-element {
    opacity: 0;
}

.checkout-ghost {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 1rem 0.75rem;
    align-content: start;
    pointer-events: none;
}

.checkout-fields[data-shown="true"] .checkout-element {
    opacity: 1;
}

.checkout-fields[data-shown="true"] .checkout-ghost {
    visibility: hidden;
    opacity: 0;
    transition: opacity 200ms ease, visibility 0s linear 200ms;
}

.checkout-ghost-cell {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
}

.checkout-ghost-cell[data-wide="true"] {
    grid-column: 1 / -1;
}

.checkout-ghost-label {
    color: var(--color-content-muted);
    font-size: 0.875rem;
    font-weight: 500;
    line-height: 1.25rem;
}

.checkout-ghost-field {
    height: calc(2.5rem + 2px);
    border: 1px solid var(--color-field-border);
    border-radius: var(--radius-md);
    background-color: var(--color-field);
}

.checkout-fields[data-phase="loading"] .checkout-ghost-field {
    animation: checkout-ghost-pulse 1.4s ease-in-out infinite;
}

.checkout-error {
    margin-top: 1rem;
}

.checkout-submit {
    margin-top: auto;
    padding-top: 2rem;
}

.checkout-submit .checkout-note {
    justify-content: flex-start;
    margin: 0 0 1rem;
    text-align: left;
}

.checkout-action {
    width: 100%;
    height: 2.75rem;
    border-color: var(--color-accent);
    background-color: var(--color-accent);
    color: var(--color-accent-content);
    transition: opacity 200ms ease, background-color 120ms ease, border-color 120ms ease;
}

.checkout-action:enabled:hover,
.checkout-action:enabled:active {
    border-color: var(--color-accent-hover);
    background-color: var(--color-accent-hover);
}

.checkout-action[data-phase="paying"]:disabled {
    opacity: 1;
    cursor: progress;
}

.checkout-spinner {
    width: 1rem;
    height: 1rem;
    animation: checkout-spin 800ms linear infinite;
}

.checkout-test {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.875rem 1.5rem;
    margin-top: 1rem;
    padding: 0.875rem 1rem;
    border: 1px dashed var(--color-border-dashed);
    border-radius: var(--radius-lg);
}

.checkout-test-copy {
    flex: 1 1 18rem;
    min-width: 0;
}

.checkout-test-title {
    margin: 0;
    color: var(--color-content-strong);
    font-size: 0.8125rem;
    font-weight: 600;
}

.checkout-test-text {
    margin: 0.125rem 0 0;
    color: var(--color-content-meta);
    font-size: 0.8125rem;
    line-height: 1.45;
}

.checkout-test-cards {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
}

.checkout-test-cards .btn-default {
    height: 2rem;
    padding: 0 0.75rem;
    font-size: 0.8125rem;
}

@container (min-width: 54rem) {
    .checkout-view[data-step="choose"] {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        grid-template-rows: 1fr auto;
        column-gap: 1.75rem;
        max-height: 52rem;
    }

    .checkout-view[data-step="choose"] .checkout-header {
        grid-column: 2;
        grid-row: 1;
        flex-direction: column;
        align-items: stretch;
        margin-bottom: 0;
        padding: 2.25rem;
    }

    .checkout-view[data-step="choose"] .checkout-step {
        display: grid;
        grid-column: 1;
        grid-row: 1 / span 2;
        grid-template-rows: subgrid;
    }

    .checkout-wave {
        width: 100%;
    }

    .checkout-view[data-step="choose"] .hours-card {
        max-width: none;
    }
}

@container (max-width: 48rem) {
    .checkout-view[data-step="choose"] .checkout-header {
        padding: 2rem 1.75rem;
    }

    .checkout-wave {
        display: none;
    }

    .checkout-pay {
        grid-template-columns: minmax(0, 1fr);
        max-width: 40rem;
    }

    .checkout-order {
        border-right: 0;
        border-bottom: 1px solid var(--color-border);
    }
}

@keyframes checkout-spin {
    to {
        transform: rotate(360deg);
    }
}

@keyframes checkout-step-enter {
    from {
        opacity: 0;
        transform: translateY(0.375rem);
    }
}

@keyframes checkout-ghost-pulse {
    50% {
        background-color: var(--color-elevated);
    }
}

@media (prefers-reduced-motion: reduce) {
    .checkout-step,
    .checkout-spinner,
    .checkout-fields[data-phase="loading"] .checkout-ghost-field {
        animation: none;
    }

    .checkout-element,
    .checkout-ghost,
    .checkout-fields[data-shown="true"] .checkout-ghost {
        transition: none;
    }
}
</style>
