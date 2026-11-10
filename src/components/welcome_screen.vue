<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import stratus_mark from '../../assets/stratus-mark.svg'
import { use_endpoints } from '../composables/use_endpoints'
import { use_service } from '../composables/use_service'
import { use_settings } from '../composables/use_settings'
import ClearableInput from './clearable_input.vue'
import type { APIEndpointPurpose } from '../types'


const ICON_ARROW = 'M5 12h14M13 6l6 6-6 6'

const KEY_LABELS: Readonly<Record<APIEndpointPurpose, string>> = Object.freeze({
    notes: 'Notes key',
    transcription: 'Transcription key',
})

const KEY_PURPOSES: readonly APIEndpointPurpose[] = Object.freeze(['transcription', 'notes'])

const { status, refresh: service_refresh, api_key_set } = use_service()
const { endpoints, refresh: endpoints_refresh } = use_endpoints()
const { settings, error_message: settings_error, update } = use_settings()

const host_current = settings.value.api_host ?? endpoints.value[0]?.host ?? ''

const keys_shown: readonly APIEndpointPurpose[] = KEY_PURPOSES.filter((purpose) => {
    const source = status.value[purpose]

    return !source.builtin && !source.user
})

const host_draft = ref(host_current)
const key_drafts = reactive<Record<APIEndpointPurpose, string>>({ notes: '', transcription: '' })
const problem = ref<string | null>(null)
const submitting = ref(false)

const ready = computed(() => {
    if (host_draft.value.trim() === '') return false

    return keys_shown.every((purpose) => key_drafts[purpose].trim() !== '')
})


async function host_save(): Promise<boolean> {
    const host = host_draft.value.trim()

    if (host === host_current) return true

    await update({ api_host: host })

    problem.value = settings_error.value

    return settings_error.value === null
}

async function submit(): Promise<void> {
    if (!ready.value || submitting.value) return

    submitting.value = true
    problem.value = null

    await submit_steps()
        .catch((error: unknown) => {
            problem.value = String(error)
        })
        .finally(() => {
            submitting.value = false
        })
}

async function submit_steps(): Promise<void> {
    const host_saved = await host_save()

    if (!host_saved) return

    let chain = Promise.resolve()

    for (const purpose of keys_shown) {
        chain = chain.then(async () => {
            await api_key_set(purpose, key_drafts[purpose])
        })
    }

    await chain
    await Promise.all([service_refresh(), endpoints_refresh()])
}
</script>

<template>
    <section class="welcome">
        <div class="welcome-side">
            <div class="welcome-body">
                <h1 class="welcome-title">
                    Welcome to <span class="welcome-brand">scribe</span>
                </h1>
                <p class="welcome-text">
                    Please enter the {{ keys_shown.length > 1 ? 'API keys' : 'API key' }} for this
                    app.
                </p>

                <form class="welcome-form" @submit.prevent="submit">
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
                    <button
                        type="submit"
                        class="btn-primary welcome-action"
                        :disabled="submitting || !ready"
                    >
                        {{ submitting ? 'Saving…' : 'Continue' }}
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

                <p v-if="problem !== null" class="welcome-problem">{{ problem }}</p>
            </div>
        </div>

        <footer class="welcome-art">
            <img :src="stratus_mark" alt="">
            <span class="welcome-company">Stratus Advanced Technologies</span>
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
    display: grid;
    place-items: center;
    padding: 2rem 1.25rem;
    overflow-y: auto;
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

.welcome-art img {
    width: 1.25rem;
    opacity: 0.5;
    user-select: none;
}

.welcome-company {
    color: var(--color-content-meta);
    font-size: 0.625rem;
    font-weight: 500;
    letter-spacing: 0.24em;
    opacity: 0.5;
    text-transform: uppercase;
    white-space: nowrap;
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
    font-size: 2rem;
    font-weight: 600;
    letter-spacing: -0.045em;
    line-height: 1.1;
}

.welcome-brand {
    color: var(--color-accent);
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
    border-radius: 999px;
}

.welcome-action svg {
    width: 1rem;
    height: 1rem;
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

.welcome-title,
.welcome-text {
    will-change: transform;
    animation: entrance-rise 760ms cubic-bezier(0.16, 1, 0.3, 1) 200ms backwards;
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
    .welcome-title,
    .welcome-text,
    .welcome-form {
        animation: none;
    }
}
</style>
