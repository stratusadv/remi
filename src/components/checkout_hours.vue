<script setup lang="ts">
import { computed, useId } from 'vue'
import { hours_is_valid, hours_quote, price_hour_text } from '../composables/use_account'
import { assert } from '../lib/assert'
import RemiMark from './remi_mark.vue'
import type { Account } from '../types'


const properties = defineProps<{
    account: Account
}>()

const emit = defineEmits<{
    choose: [hours: number]
}>()

const hours = defineModel<number | string>('hours', { required: true })
const input_id = useId()
const hint_id = useId()
const currency_text = computed(() => properties.account.price_currency.toUpperCase())
const rate_text = computed(() => price_hour_text(properties.account))

const quote = computed(() => {
    const chosen = hours.value

    if (!hours_is_valid(properties.account, chosen)) return null

    return hours_quote(properties.account, chosen)
})

const range_text = computed(() =>
    `Choose from 1 to ${String(properties.account.checkout_hours_max)} hours.`)


function choose(): void {
    const chosen = hours.value

    assert(properties.account.payments)
    assert(typeof chosen === 'number' || typeof chosen === 'string')

    if (!hours_is_valid(properties.account, chosen)) return

    emit('choose', chosen)
}
</script>

<template>
    <form class="hours-card" novalidate @submit.prevent="choose">
        <span class="hours-card-mark" aria-hidden="true">
            <RemiMark />
        </span>
        <label class="hours-card-label" :for="input_id">How many hours?</label>
        <div class="hours-card-field">
            <input
                :id="input_id"
                v-model="hours"
                class="input hours-card-input"
                type="number"
                inputmode="numeric"
                min="1"
                :max="account.checkout_hours_max"
                step="1"
                :aria-describedby="hint_id"
                :aria-invalid="quote === null"
            >
            <span class="hours-card-unit">hours</span>
        </div>
        <p :id="hint_id" class="hours-card-hint" :data-invalid="quote === null">
            {{ range_text }}
        </p>
        <dl class="hours-card-lines">
            <div>
                <dt>Price per hour</dt>
                <dd>{{ rate_text }}</dd>
            </div>
            <div>
                <dt>Balance after</dt>
                <dd class="hours-card-after">{{ quote?.balance_after_text }}</dd>
            </div>
        </dl>
        <p class="hours-card-total">
            <span>Total</span>
            <span class="hours-card-amount">
                {{ quote?.price_text }}
                <span class="hours-card-currency">{{ currency_text }}</span>
            </span>
        </p>
        <button type="submit" class="btn-primary hours-card-buy" :disabled="quote === null">
            Buy hours
        </button>
    </form>
</template>

<style scoped>
.hours-card {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 30rem;
    margin: 0 auto;
    padding: 2.25rem 2.25rem 2rem;
    border: 1px solid var(--color-content-strong);
    border-radius: var(--radius-xl);
    background: linear-gradient(
        104deg,
        var(--color-panel) 0 62%,
        color-mix(in oklab, var(--color-panel), var(--lift) 4%) 62%
    );
    box-shadow: 8px 8px 0 var(--color-display-accent);
}

.hours-card-mark {
    display: grid;
    place-items: center;
    align-self: flex-start;
    width: 4.5rem;
    height: 4.5rem;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-lg);
    background-color: var(--color-surface);
    font-size: 2.625rem;
    transform: rotate(-8deg);
    transition: transform 320ms cubic-bezier(0.2, 0.9, 0.3, 1.5);
}

.hours-card:hover .hours-card-mark,
.hours-card:focus-within .hours-card-mark {
    transform: rotate(4deg) scale(1.08);
}

.hours-card-label {
    margin: 1.75rem 0 0.625rem;
    color: var(--color-content-strong);
    font-size: 1rem;
    font-weight: 600;
}

.hours-card-field {
    display: flex;
    align-items: center;
    gap: 0.875rem;
}

.hours-card-input {
    flex: 1 1 auto;
    min-width: 0;
    height: 4.5rem;
    padding: 0 1rem;
    color: var(--color-content-strong);
    font-size: 2.75rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.03em;
    appearance: textfield;
}

.hours-card-input::-webkit-inner-spin-button,
.hours-card-input::-webkit-outer-spin-button {
    margin: 0;
    appearance: none;
}

.hours-card-unit {
    flex: none;
    color: var(--color-content-muted);
    font-size: 1.125rem;
    font-weight: 500;
}

.hours-card-hint {
    margin: 0.5rem 0 auto;
    color: var(--color-content-meta);
    font-size: 0.8125rem;
}

.hours-card-hint[data-invalid="true"] {
    color: var(--color-danger-text);
}

.hours-card-lines {
    display: grid;
    gap: 0.75rem;
    margin: 1.75rem 0 0;
    padding-top: 1.25rem;
    border-top: 1px solid var(--color-border);
}

.hours-card-lines div {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    min-height: 1.25rem;
}

.hours-card-lines dt {
    color: var(--color-content-muted);
    font-size: 0.875rem;
}

.hours-card-lines dd {
    margin: 0;
    color: var(--color-content-strong);
    font-size: 0.875rem;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
}

.hours-card-total {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    margin: 1.25rem 0 0;
    padding-top: 1.25rem;
    border-top: 1px solid var(--color-border);
    color: var(--color-content-strong);
    font-weight: 600;
}

.hours-card-amount {
    font-size: 1.75rem;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
    line-height: 2.25rem;
}

.hours-card-currency {
    margin-left: 0.125rem;
    color: var(--color-content-meta);
    font-size: 0.8125rem;
    font-weight: 500;
    letter-spacing: 0;
}

.hours-card-buy {
    --color-plane: var(--color-display-accent);
    width: 100%;
    height: 2.75rem;
    margin-top: 1.5rem;
}

@media (prefers-reduced-motion: reduce) {
    .hours-card-mark {
        transition: none;
    }

    .hours-card:hover .hours-card-mark,
    .hours-card:focus-within .hours-card-mark {
        transform: rotate(-8deg);
    }
}
</style>
