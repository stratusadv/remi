<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { use_account } from '../composables/use_account'
import { use_endpoints } from '../composables/use_endpoints'
import { use_service } from '../composables/use_service'
import { use_settings } from '../composables/use_settings'
import { assert } from '../lib/assert'
import { error_friendly } from '../lib/errors'
import ClearableInput from './clearable_input.vue'
import RemiMark from './remi_mark.vue'
import StratusCredit from './stratus_credit.vue'
import type { APIEndpointPurpose, AccountSignUp } from '../types'


type WelcomeStep = 'keys' | 'sign_in' | 'sign_up'

const ICON_ARROW = 'M5 12h14M13 6l6 6-6 6'

const KEY_LABELS: Readonly<Record<APIEndpointPurpose, string>> = Object.freeze({
    notes: 'Notes key',
    transcription: 'Transcription key',
})

const KEY_PURPOSES: readonly APIEndpointPurpose[] = Object.freeze(['transcription', 'notes'])

const STEP_ACTIONS: Readonly<Record<WelcomeStep, string>> = Object.freeze({
    keys: 'Continue',
    sign_in: 'Sign in',
    sign_up: 'Get started',
})

const STEP_ACTIONS_BUSY: Readonly<Record<WelcomeStep, string>> = Object.freeze({
    keys: 'Saving…',
    sign_in: 'Signing in…',
    sign_up: 'Setting up…',
})

const {
    status,
    notes_ready,
    refresh: service_refresh,
    transcription_ready,
    api_key_set,
} = use_service()

const { endpoints, refresh: endpoints_refresh } = use_endpoints()
const { settings, error_message: settings_error, update } = use_settings()

const {
    create: account_create,
    sign_in: account_sign_in,
    sign_up_needed,
    status_load: account_status_load,
} = use_account()

const host_current = settings.value.api_host ?? endpoints.value[0]?.host ?? ''

const keys_shown: readonly APIEndpointPurpose[] = KEY_PURPOSES.filter((purpose) => {
    const source = status.value[purpose]

    return !source.builtin && !source.user
})

const keys_needed = !transcription_ready.value || !notes_ready.value
const host_draft = ref(host_current)
const key_drafts = reactive<Record<APIEndpointPurpose, string>>({ notes: '', transcription: '' })
const problem = ref<string | null>(null)
const sign_in_draft = ref('')
const sign_up_draft = reactive<AccountSignUp>({ email: '', name: '', promo_code: '' })
const step = ref<WelcomeStep>(keys_needed ? 'keys' : 'sign_up')
const submitting = ref(false)

const ready = computed(() => {
    switch (step.value) {
        case 'keys':
            return keys_ready()
        case 'sign_in':
            return sign_in_draft.value.trim() !== ''
        case 'sign_up':
            return sign_up_draft.name.trim() !== '' && sign_up_draft.email.trim() !== ''
    }
})


async function host_save(): Promise<boolean> {
    const host = host_draft.value.trim()

    if (host === host_current) return true

    await update({ api_host: host })

    problem.value = settings_error.value

    return settings_error.value === null
}

function keys_ready(): boolean {
    if (host_draft.value.trim() === '') return false

    return keys_shown.every((purpose) => key_drafts[purpose].trim() !== '')
}

async function keys_submit(): Promise<void> {
    const host_saved = await host_save()

    if (!host_saved) return

    let chain = Promise.resolve()

    for (const purpose of keys_shown) {
        chain = chain.then(async () => {
            await api_key_set(purpose, key_drafts[purpose])
        })
    }

    await chain
    await account_status_load()
    await Promise.all([service_refresh(), endpoints_refresh()])

    if (sign_up_needed.value) step.value = 'sign_up'
}

function sign_in_toggle(): void {
    assert(step.value !== 'keys')

    problem.value = null
    step.value = step.value === 'sign_in' ? 'sign_up' : 'sign_in'
}

function sign_up_trimmed(): AccountSignUp {
    assert(sign_up_draft.name.trim().length > 0)
    assert(sign_up_draft.email.trim().length > 0)

    return {
        email: sign_up_draft.email.trim(),
        name: sign_up_draft.name.trim(),
        promo_code: sign_up_draft.promo_code.trim(),
    }
}

async function submit(): Promise<void> {
    if (!ready.value || submitting.value) return

    submitting.value = true
    problem.value = null

    await submit_step()
        .catch((error: unknown) => {
            problem.value = error_friendly(error).message
        })
        .finally(() => {
            submitting.value = false
        })
}

async function submit_step(): Promise<void> {
    switch (step.value) {
        case 'keys':
            return keys_submit()
        case 'sign_in':
            return account_sign_in(sign_in_draft.value)
        case 'sign_up':
            return account_create(sign_up_trimmed())
    }
}
</script>

<template>
    <section class="welcome">
        <div class="welcome-side">
            <div class="welcome-facets" aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
            </div>
            <div class="welcome-body">
                <RemiMark class="welcome-mark" />
                <p class="eyebrow welcome-eyebrow">Private meeting notes</p>
                <h1 class="welcome-title">
                    Welcome to <span class="welcome-brand">remi</span>
                </h1>
                <p v-if="step === 'keys'" class="welcome-text">
                    Please enter the {{ keys_shown.length > 1 ? 'API keys' : 'API key' }} for this
                    app.
                </p>
                <p v-else-if="step === 'sign_up'" class="welcome-text">
                    Enter your name and email to start transcribing. A promo code adds free hours.
                </p>
                <p v-else class="welcome-text">
                    Enter the sign-in code for your account.
                </p>

                <form class="welcome-form" @submit.prevent="submit">
                    <template v-if="step === 'keys'">
                        <label class="welcome-field">
                            <span class="welcome-label">API address</span>
                            <ClearableInput
                                v-model="host_draft"
                                class="welcome-input"
                                type="url"
                                placeholder="https://api.example.com"
                                spellcheck="false"
                                autocomplete="off"
                            />
                        </label>
                        <label v-for="purpose in keys_shown" :key="purpose" class="welcome-field">
                            <span class="welcome-label">{{ KEY_LABELS[purpose] }}</span>
                            <ClearableInput
                                v-model="key_drafts[purpose]"
                                class="welcome-input"
                                type="password"
                                placeholder="Paste the key"
                                autocomplete="off"
                            />
                        </label>
                    </template>
                    <template v-else-if="step === 'sign_up'">
                        <label class="welcome-field">
                            <span class="welcome-label">Name</span>
                            <ClearableInput
                                v-model="sign_up_draft.name"
                                class="welcome-input"
                                type="text"
                                autocomplete="name"
                            />
                        </label>
                        <label class="welcome-field">
                            <span class="welcome-label">Email</span>
                            <ClearableInput
                                v-model="sign_up_draft.email"
                                class="welcome-input"
                                type="email"
                                spellcheck="false"
                                autocomplete="email"
                            />
                        </label>
                        <label class="welcome-field">
                            <span class="welcome-label">Promo code (optional)</span>
                            <ClearableInput
                                v-model="sign_up_draft.promo_code"
                                class="welcome-input"
                                type="text"
                                spellcheck="false"
                                autocomplete="off"
                            />
                        </label>
                    </template>
                    <template v-else>
                        <label class="welcome-field">
                            <span class="welcome-label">Sign-in code</span>
                            <ClearableInput
                                v-model="sign_in_draft"
                                class="welcome-input"
                                type="password"
                                spellcheck="false"
                                autocomplete="off"
                            />
                        </label>
                    </template>
                    <button
                        type="submit"
                        class="btn-primary welcome-action"
                        :disabled="submitting || !ready"
                    >
                        {{ submitting ? STEP_ACTIONS_BUSY[step] : STEP_ACTIONS[step] }}
                        <svg
                            v-if="!submitting"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            aria-hidden="true"
                        >
                            <path :d="ICON_ARROW" />
                        </svg>
                    </button>
                </form>

                <button
                    v-if="step !== 'keys'"
                    type="button"
                    class="welcome-switch"
                    @click="sign_in_toggle"
                >
                    {{ step === 'sign_in' ? 'Create an account instead' : 'Have a sign-in code?' }}
                </button>

                <p v-if="problem !== null" class="welcome-problem" role="alert">{{ problem }}</p>
            </div>
        </div>

        <footer class="welcome-art">
            <StratusCredit class="welcome-credit" />
        </footer>
    </section>
</template>

<style scoped>
.welcome {
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    flex: 1;
    min-height: 0;
}

.welcome-side {
    position: relative;
    isolation: isolate;
    display: grid;
    place-items: center;
    padding: 2rem 1.25rem;
    overflow-y: auto;
}

.welcome-facets {
    position: absolute;
    inset: 0;
    z-index: -1;
    overflow: hidden;
    pointer-events: none;
}

.welcome-facets i {
    position: absolute;
    inset: 0;
    background: var(--fill);
    clip-path: var(--shape);
}

.welcome-facets i:nth-child(1) {
    --shape: polygon(0 0, 24% 0, 13% 100%, 0 100%);
    --fill: var(--color-elevated);
}

.welcome-facets i:nth-child(2) {
    --shape: polygon(7% 12%, 15% 8%, 17% 26%, 8% 29%);
    --fill: var(--color-saffron);
}

.welcome-facets i:nth-child(3) {
    --shape: polygon(86% 0, 100% 0, 100% 30%, 92% 34%);
    --fill: color-mix(in oklab, var(--color-cyan) 35%, transparent);
}

.welcome-facets i:nth-child(4) {
    --shape: polygon(80% 42%, 100% 38%, 100% 66%, 84% 68%);
    --fill:
        radial-gradient(
            circle,
            color-mix(in oklab, var(--color-content) 30%, transparent) 1.4px,
            transparent 2px
        )
        0 0 / 12px 12px;
}

.welcome-facets i:nth-child(5) {
    --shape: polygon(85% 76%, 92% 72%, 94% 88%, 87% 91%);
    --fill: var(--color-rose);
}

.welcome-facets i:nth-child(6) {
    --shape: polygon(0 80%, 9% 76%, 12% 100%, 0 100%);
    --fill: repeating-linear-gradient(38deg, #2f2478 0 7px, #5b4bc4 7px 12px);
}

.welcome-eyebrow {
    margin-bottom: 0.75rem;
}

.welcome-art {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    height: 3rem;
    border-top: 1px solid var(--color-border);
    background: var(--color-panel);
}

.welcome-credit {
    color: var(--color-content-meta);
    font-size: 0.625rem;
    font-weight: 500;
    letter-spacing: 0.24em;
    opacity: 0.5;
    text-transform: uppercase;
    white-space: nowrap;
    transition: opacity 140ms ease;
}

.welcome-credit:hover {
    opacity: 0.85;
}

.welcome-mark {
    margin-bottom: 1.5rem;
    color: var(--color-content-strong);
    font-size: 3rem;
}

.welcome-body {
    display: grid;
    justify-items: start;
    width: 100%;
    max-width: 22rem;
}

.welcome-title {
    margin: 0;
    color: var(--color-content-strong);
    font-family: var(--font-display);
    font-size: 2.75rem;
    font-weight: 600;
    letter-spacing: -0.025em;
    line-height: 1.02;
}

.welcome-brand {
    color: var(--color-display-accent);
    font-style: italic;
}

.welcome-text {
    margin: 0.625rem 0 0;
    color: var(--color-content-muted);
    font-size: 0.9375rem;
}

.welcome-form {
    display: grid;
    gap: 1.25rem;
    width: 100%;
    margin-top: 1.75rem;
}

.welcome-field {
    display: grid;
    gap: 0.25rem;
}

.welcome-label {
    color: var(--color-content-meta);
    font-size: 0.75rem;
    font-weight: 500;
}

.welcome-form :deep(.welcome-input) {
    height: 2.25rem;
    padding: 0 2rem 0 0;
    border: 0;
    border-bottom: 1px solid var(--color-border-strong);
    border-radius: 0;
    background: transparent;
    color: var(--color-content-strong);
    font: inherit;
    font-size: 0.9375rem;
    transition: border-color 140ms ease;
}

.welcome-form :deep(.welcome-input::placeholder) {
    color: var(--color-content-subtle);
}

.welcome-form :deep(.welcome-input:hover:not(:focus)) {
    border-bottom-color: var(--color-content-subtle);
}

.welcome-form :deep(.welcome-input:focus) {
    outline: none;
    border-bottom-color: var(--color-accent);
}

.welcome-action {
    justify-self: start;
    gap: 0.5rem;
    height: 2.5rem;
    margin-top: 0.5rem;
    padding: 0 1.125rem 0 1.25rem;
}

.welcome-action svg {
    width: 1rem;
    height: 1rem;
}

.welcome-switch {
    margin-top: 1.25rem;
    padding: 0;
    background: transparent;
    color: var(--color-content-muted);
    font-size: 0.8125rem;
    text-decoration: underline;
    text-underline-offset: 0.2em;
    transition: color 140ms ease;
}

.welcome-switch:hover {
    color: var(--color-content-strong);
}

.welcome-problem {
    width: 100%;
    margin: 1.25rem 0 0;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--color-danger-strong);
    border-radius: var(--radius-md);
    background: var(--color-danger);
    color: var(--color-danger-text);
    font-size: 0.875rem;
}

.welcome-art {
    animation: entrance-fade 900ms ease 80ms backwards;
}

.welcome-mark,
.welcome-eyebrow,
.welcome-title,
.welcome-text {
    will-change: transform;
    animation: entrance-rise 760ms cubic-bezier(0.16, 1, 0.3, 1) 200ms backwards;
}

.welcome-mark {
    animation-delay: 120ms;
}

.welcome-eyebrow {
    animation-delay: 160ms;
}

.welcome-text {
    animation-delay: 280ms;
}

.welcome-form {
    animation: entrance-fade 760ms ease 360ms backwards;
}

@keyframes entrance-fade {
    from {
        opacity: 0;
    }
}

@keyframes entrance-rise {
    from {
        opacity: 0;
        transform: translateY(12px);
    }
}

@media (prefers-reduced-motion: reduce) {
    .welcome-art,
    .welcome-mark,
    .welcome-eyebrow,
    .welcome-title,
    .welcome-text,
    .welcome-form {
        animation: none;
    }
}
</style>
