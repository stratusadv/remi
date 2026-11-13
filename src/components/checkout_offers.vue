<script setup lang="ts">
import { computed } from 'vue'
import { offer_cards, offer_hours } from '../composables/use_account'
import { assert } from '../lib/assert'
import type { AccountOffer } from '../types'


const props = defineProps<{
    balance_seconds: number
    offers: readonly AccountOffer[]
}>()

const emit = defineEmits<{
    choose: [offer: AccountOffer]
    consider: [offer: AccountOffer]
}>()

const CONSIDER_DELAY_MS = 200

const cards = computed(() => offer_cards(props.offers, props.balance_seconds))
let consider_timer: ReturnType<typeof setTimeout> | null = null
let considered: AccountOffer | null = null

function choose(offer: AccountOffer): void {
    assert(props.offers.includes(offer))
    assert(offer.hours > 0)

    consider_cancel()
    emit('choose', offer)
}

function consider_cancel(): void {
    if (consider_timer !== null) clearTimeout(consider_timer)

    consider_timer = null
    considered = null
}

function consider_emit(): void {
    const offer = considered

    assert(offer !== null)
    assert(consider_timer !== null)

    consider_timer = null

    emit('consider', offer)
}

function consider_start(offer: AccountOffer): void {
    assert(props.offers.includes(offer))
    assert(offer.hours > 0)

    if (considered === offer) return

    consider_cancel()

    consider_timer = setTimeout(consider_emit, CONSIDER_DELAY_MS)
    considered = offer
}
</script>

<template>
    <ul class="offers" :data-count="cards.length">
        <li
            v-for="card in cards"
            :key="card.offer.hours"
            class="offer"
            :data-best="card.best"
            @focusin="consider_start(card.offer)"
            @focusout="consider_cancel"
            @pointerenter="consider_start(card.offer)"
            @pointerleave="consider_cancel"
        >
            <p v-if="card.best" class="offer-tag">
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path
                        d="M12 2.75l2.83 5.95 6.53.8-4.81 4.5 1.26 6.47
                           L12 17.27l-5.81 3.2 1.26-6.47-4.81-4.5 6.53-.8z"
                    />
                </svg>
                Best value
            </p>
            <p class="offer-hours">
                <span class="offer-hours-count">{{ card.offer.hours }}</span>
                <span class="offer-hours-unit">
                    {{ card.offer.hours === 1 ? 'hour' : 'hours' }} of transcription
                </span>
            </p>
            <p class="offer-price">
                {{ card.price_text }}
                <span class="offer-currency">{{ card.offer.currency.toUpperCase() }}</span>
                <s v-if="card.saving_percent > 0" class="offer-regular">
                    <span class="sr-only">Regular price</span>
                    {{ card.regular_text }}
                </s>
            </p>
            <p class="offer-rate">
                <span>{{ card.rate_text }} per hour</span>
                <span v-if="card.saving_percent > 0" class="offer-saving">
                    Save {{ card.saving_percent }}%
                </span>
            </p>
            <span
                class="offer-meter"
                :style="{ '--offer-saved': `${card.saving_percent}%` }"
                aria-hidden="true"
            />
            <p class="offer-after">
                <span>Balance after</span>
                <span class="offer-after-value">{{ card.balance_after_text }}</span>
            </p>
            <button
                type="button"
                class="offer-buy"
                :class="card.best ? 'btn-primary' : 'btn-default'"
                @click="choose(card.offer)"
            >
                Buy {{ offer_hours(card.offer) }}
            </button>
        </li>
    </ul>
</template>

<style scoped>
.offers {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 1.25rem;
    margin: 0;
    padding: 1rem 0 0;
    list-style: none;
}

.offers[data-count="1"] {
    max-width: 24rem;
}

.offers[data-count="2"],
.offers[data-count="4"] {
    grid-template-columns: repeat(2, minmax(0, 1fr));
}

.offers[data-count="3"] {
    grid-template-columns: repeat(3, minmax(0, 1fr));
}

.offer {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 29rem;
    padding: 2.75rem 2.25rem 2.25rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-xl);
    background-color: var(--color-panel);
    transition: border-color 160ms ease, box-shadow 200ms ease, transform 200ms ease;
}

.offer:hover {
    border-color: var(--color-border-strong);
    box-shadow: 6px 6px 0 var(--color-plane);
    transform: translate(-2px, -2px);
}

.offer[data-best="true"] {
    margin-top: -1rem;
    padding-top: 3.75rem;
    border-color: var(--color-content-strong);
    background: linear-gradient(
        104deg,
        var(--color-panel) 0 62%,
        color-mix(in oklab, var(--color-panel), var(--lift) 4%) 62%
    );
    box-shadow: 8px 8px 0 var(--color-display-accent);
}

.offer[data-best="true"]:hover {
    border-color: var(--color-content-strong);
    box-shadow: 10px 10px 0 var(--color-display-accent);
}

.offer-tag {
    position: absolute;
    top: 1.25rem;
    left: 2.25rem;
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    margin: 0;
    padding: 0.125rem 0.625rem 0.125rem 0.5rem;
    border-radius: 999px;
    background-color: var(--color-display-accent);
    color: var(--color-surface);
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    line-height: 1.25rem;
}

.offer-tag svg {
    width: 0.75rem;
    height: 0.75rem;
}

.offer-hours {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin: 0;
    color: var(--color-content-strong);
}

.offer-hours-count {
    font-size: 5rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.055em;
    line-height: 1;
}

.offer-hours-unit {
    color: var(--color-content-muted);
    font-size: 1rem;
    font-weight: 500;
}

.offer-price {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 0.5rem;
    margin: 2.25rem 0 0;
    color: var(--color-content-strong);
    font-size: 2rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.025em;
    line-height: 2.5rem;
}

.offer-currency {
    color: var(--color-content-meta);
    font-size: 0.8125rem;
    font-weight: 500;
    letter-spacing: 0;
}

.offer-regular {
    color: var(--color-content-subtle);
    font-size: 1rem;
    font-weight: 500;
    letter-spacing: 0;
    text-decoration-thickness: 1.5px;
}

.offer-rate {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem 0.625rem;
    min-height: 1.5rem;
    margin: 0.625rem 0 0;
    color: var(--color-content-muted);
    font-size: 0.875rem;
    font-variant-numeric: tabular-nums;
}

.offer-saving {
    padding: 0 0.5rem;
    border-radius: 999px;
    background-color: var(--color-accent-soft);
    color: var(--color-accent-strong);
    font-size: 0.75rem;
    font-weight: 600;
    line-height: 1.25rem;
}

.offer-meter {
    display: block;
    height: 0.375rem;
    margin: 1rem 0 2.25rem;
    border-radius: 999px;
    background: linear-gradient(
        to right,
        var(--color-border-strong) calc(100% - var(--offer-saved)),
        var(--color-accent) 0
    );
}

.offer-after {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    margin: auto 0 0;
    padding-top: 1.5rem;
    border-top: 1px solid var(--color-border);
    color: var(--color-content-muted);
    font-size: 0.875rem;
}

.offer-after-value {
    color: var(--color-content);
    font-variant-numeric: tabular-nums;
}

.offer-buy {
    width: 100%;
    height: 2.75rem;
    margin-top: 1.5rem;
}

.offer-buy::after {
    position: absolute;
    inset: 0;
    border-radius: var(--radius-xl);
    content: "";
}

.offer[data-best="true"] .offer-buy {
    --color-plane: var(--color-display-accent);
}

@container (max-width: 52rem) {
    .offers[data-count] {
        grid-template-columns: minmax(0, 1fr);
    }

    .offer {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        column-gap: 1.5rem;
        min-height: 0;
        padding: 1.75rem 1.5rem;
    }

    .offer[data-best="true"] {
        margin-top: 0;
        padding-top: 3.25rem;
    }

    .offer > :not(.offer-buy) {
        grid-column: 1;
    }

    .offer-tag {
        top: 1rem;
        left: 1.5rem;
    }

    .offer-hours {
        flex-direction: row;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 0.5rem;
    }

    .offer-hours-count {
        font-size: 2.75rem;
    }

    .offer-price {
        margin-top: 1rem;
        font-size: 1.5rem;
        line-height: 2rem;
    }

    .offer-meter {
        max-width: 16rem;
        margin: 0.75rem 0 0;
    }

    .offer-after {
        justify-content: flex-start;
        gap: 0.375rem;
        margin-top: 0.75rem;
        padding-top: 0;
        border-top: 0;
    }

    .offer-buy {
        grid-column: 2;
        grid-row: 1 / span 5;
        width: auto;
        margin-top: 0;
    }
}

@media (prefers-reduced-motion: reduce) {
    .offer {
        transition: none;
    }

    .offer:hover {
        transform: none;
    }
}
</style>
