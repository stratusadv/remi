<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { use_network } from '../composables/use_network'
import { use_pipeline } from '../composables/use_pipeline'
import { use_service } from '../composables/use_service'
import { assert } from '../lib/assert'
import { ICON_PATH_FOLDER } from '../lib/menu'
import type { AskScopeChip } from '../types'


const props = defineProps<{
    busy: boolean
    scope: AskScopeChip | null
}>()

const emit = defineEmits<{
    scope_clear: []
    send: [question: string]
    stop: []
    typing: []
}>()

const INPUT_HEIGHT_MAX_PX = 192
const QUESTION_CHARS_MAX = 1000

const ICON_PATH_DOCUMENT = 'M6.75 3.75h10.5a1.5 1.5 0 0 1 1.5 1.5v13.5a1.5 1.5 0 0 1-1.5 1.5H6.75'
    + 'a1.5 1.5 0 0 1-1.5-1.5V5.25a1.5 1.5 0 0 1 1.5-1.5Z'

const SCOPE_ICON_PATHS: Readonly<Record<AskScopeChip['kind'], readonly string[]>> = Object.freeze({
    folder: [ICON_PATH_FOLDER],
    meeting: [ICON_PATH_DOCUMENT, 'M8.75 8.25h6.5', 'M8.75 12h6.5', 'M8.75 15.75h4'],
})

const SCOPE_PLACEHOLDERS: Readonly<Record<AskScopeChip['kind'], string>> = Object.freeze({
    folder: 'Ask about this folder',
    meeting: 'Ask about this meeting',
})

const { online } = use_network()
const { notes_ready } = use_service()
const { view_set } = use_pipeline()
const draft = ref('')
const input_ref = ref<HTMLTextAreaElement | null>(null)

const sendable = computed(
    () => draft.value.trim().length > 0 && online.value && notes_ready.value,
)

const placeholder = computed(() => {
    const chosen = props.scope

    return chosen === null ? 'Ask about your meetings' : SCOPE_PLACEHOLDERS[chosen.kind]
})


onMounted(focus)

defineExpose({ focus })

function focus(): void {
    input_ref.value?.focus()
}

function grow(): void {
    const input = input_ref.value

    if (input === null) return

    input.style.height = 'auto'
    input.style.height = `${String(Math.min(input.scrollHeight, INPUT_HEIGHT_MAX_PX))}px`
}

function input_changed(): void {
    grow()
    emit('typing')
}

function keydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return
    if (event.shiftKey || event.isComposing) return

    event.preventDefault()
    send()
}

function send(): void {
    if (props.busy) return
    if (!sendable.value) return

    const question = draft.value.trim()

    assert(question.length > 0)
    assert(question.length <= QUESTION_CHARS_MAX)

    draft.value = ''
    emit('send', question)
    void nextTick(grow)
}
</script>

<template>
    <div class="ask-composer-shell">
        <p v-if="!notes_ready" class="ask-composer-notice" role="status">
            Ask needs the API address and keys before it can answer.
            <button type="button" class="ask-composer-link" @click="view_set('settings')">
                Open settings
            </button>
        </p>
        <p v-else-if="!online" class="ask-composer-notice" role="status">
            You are offline. Ask works again once you reconnect.
        </p>

        <div v-if="scope !== null" class="ask-scope-line">
            <span class="eyebrow ask-scope-lead">Asking about</span>
            <span class="ask-scope" :data-kind="scope.kind" :title="scope.label">
                <svg
                    class="ask-scope-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                >
                    <path v-for="path in SCOPE_ICON_PATHS[scope.kind]" :key="path" :d="path" />
                </svg>
                <span class="ask-scope-text">{{ scope.label }}</span>
                <button
                    type="button"
                    class="ask-scope-clear"
                    aria-label="Ask about all meetings"
                    title="Ask about all meetings"
                    @click="emit('scope_clear')"
                >
                    <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        aria-hidden="true"
                    >
                        <path d="M7 7l10 10" />
                        <path d="M17 7L7 17" />
                    </svg>
                </button>
            </span>
        </div>

        <form class="ask-composer" @submit.prevent="send" @click.self="focus">
            <textarea
                ref="input_ref"
                v-model="draft"
                class="ask-composer-input"
                rows="1"
                :maxlength="QUESTION_CHARS_MAX"
                :placeholder="placeholder"
                aria-label="Question"
                @input="input_changed"
                @keydown="keydown"
            />

            <div class="ask-composer-bar" @click.self="focus">
                <button
                    v-if="busy"
                    type="button"
                    class="ask-send"
                    aria-label="Stop"
                    title="Stop"
                    @click="emit('stop')"
                >
                    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <rect x="7" y="7" width="10" height="10" rx="1.5" />
                    </svg>
                </button>
                <button
                    v-else
                    type="submit"
                    class="ask-send"
                    aria-label="Send"
                    title="Send"
                    :disabled="!sendable"
                >
                    <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                    >
                        <path d="M12 19V5" />
                        <path d="M5.5 11.5L12 5l6.5 6.5" />
                    </svg>
                </button>
            </div>
        </form>
    </div>
</template>

<style scoped>
.ask-composer-shell {
    display: grid;
    gap: 0.5rem;
}

.ask-composer-notice {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem 0.5rem;
    margin: 0;
    color: var(--color-content-muted);
    font-size: 0.8125rem;
}

.ask-composer-link {
    color: var(--color-link);
    font-weight: 500;
}

.ask-composer-link:hover {
    color: var(--color-link-hover);
    text-decoration: underline;
}

.ask-composer {
    display: grid;
    gap: 0.375rem;
    padding: 0.75rem 0.625rem 0.5rem 1rem;
    border: 1px solid var(--color-field-border);
    border-radius: var(--radius-xl);
    background: var(--color-field);
    cursor: text;
    transition: border-color 120ms ease, box-shadow 120ms ease;
}

.ask-composer:focus-within {
    border-color: var(--color-accent);
    box-shadow: 0 0 0 1px var(--color-accent), 6px 6px 0 var(--color-plane);
}

.ask-composer-input {
    display: block;
    width: 100%;
    min-height: 1.5rem;
    max-height: 12rem;
    padding: 0.125rem 0.375rem 0.125rem 0;
    border: 0;
    outline: none;
    background: transparent;
    color: var(--color-content);
    font: inherit;
    line-height: 1.5;
    resize: none;
}

.ask-composer-input::placeholder {
    color: var(--color-content-subtle);
}

.ask-composer-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
}

.ask-scope-line {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
    padding-inline: 0.25rem;
}

.ask-scope-lead {
    flex: none;
    margin: 0;
}

.ask-scope {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    min-width: 0;
    padding: 0.1875rem 0.25rem 0.1875rem 0.625rem;
    border: 1px solid var(--color-border-strong);
    border-radius: 999px;
    background: linear-gradient(
        104deg,
        var(--color-panel) 0 60%,
        color-mix(in oklab, var(--color-panel), var(--lift) 5%) 60%
    );
    color: var(--color-content);
    font-size: 0.8125rem;
    cursor: default;
}

.ask-scope-icon {
    flex: none;
    width: 0.875rem;
    height: 0.875rem;
    color: var(--color-content-muted);
}

.ask-scope-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ask-scope-clear {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 999px;
    color: var(--color-content-meta);
    transition: background-color 100ms ease, color 100ms ease;
}

.ask-scope-clear:hover {
    background: var(--color-chip);
    color: var(--color-content);
}

.ask-scope-clear svg {
    width: 0.75rem;
    height: 0.75rem;
}

.ask-send {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    margin-left: auto;
    border-radius: 999px;
    background: var(--color-primary);
    color: var(--color-primary-content);
    transition: background-color 120ms ease, opacity 120ms ease;
}

.ask-send:hover:not(:disabled) {
    background: var(--color-primary-hover);
}

.ask-send:disabled {
    opacity: 0.35;
    cursor: default;
}

.ask-send svg {
    width: 1rem;
    height: 1rem;
}
</style>
