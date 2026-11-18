<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'
import { use_ask } from '../composables/use_ask'
import { use_folders } from '../composables/use_folders'
import { use_jobs } from '../composables/use_jobs'
import { use_network } from '../composables/use_network'
import { assert } from '../lib/assert'
import { folder_key } from '../lib/folders'
import { ipc } from '../lib/ipc'
import { job_title } from '../lib/job_status'
import { log_warn } from '../lib/log'
import AskComposer from './ask_composer.vue'
import AskExchange from './ask_exchange.vue'
import AskHistory from './ask_history.vue'
import InfoHint from './info_hint.vue'
import MenuIcon from './menu_icon.vue'
import type { AskScope, AskScopeChip, FolderName } from '../types'


type ScopeNarrowed = Exclude<AskScope, { kind: 'all' }>

const HINT_PAGE = 'Ask about your past meetings. remi searches your titles, people, notes, and '
    + 'transcripts, then answers with the moments it used.'

const PINNED_SLACK_PX = 48
const SCOPE_ALL = Object.freeze<AskScope>({ kind: 'all' })

const SUGGESTIONS = Object.freeze([
    'Summarize my last meeting',
    'What decisions did we make this week?',
    'What action items came up this week?',
])

const SUGGESTIONS_FOLDER = Object.freeze([
    'Summarize these meetings',
    'What decisions were made?',
    'What is still open?',
])

const SUGGESTIONS_MEETING = Object.freeze([
    'Summarize this meeting',
    'What decisions were made?',
    'What action items came up?',
])

const { exchanges, busy, chat_id, scope, thread_scroll, ask, chat_start, retry, stop } = use_ask()
const { folders } = use_folders()
const { jobs, refresh: jobs_refresh } = use_jobs()
const { online } = use_network()
const composer_component = useTemplateRef<InstanceType<typeof AskComposer>>('composer_component')
const scroller_element = useTemplateRef<HTMLElement>('scroller_element')
const pinned = ref(true)
const empty = computed(() => exchanges.value.length === 0)
const ready = computed(() => online.value && !busy.value)
const scope_chip = computed<AskScopeChip | null>(() => scope_chip_of(scope.value))

const suggestions = computed<string[]>(() => {
    const kind = scope.value.kind
    const folder = folders.value[0]

    if (kind === 'meeting') return [...SUGGESTIONS_MEETING]
    if (kind === 'project') return [...SUGGESTIONS_FOLDER]
    if (folder === undefined) return [...SUGGESTIONS]

    return [...SUGGESTIONS, `What is the latest on ${folder}?`]
})

const thread_signature = computed(() => exchanges.value
    .map((exchange) => `${exchange.id}:${exchange.state}:${String(exchange.answer.length)}`)
    .join('|'))


watch([scope, jobs, folders], scope_check, { immediate: true })

watch(thread_signature, () => {
    void nextTick(scroll_follow)
})

onMounted(() => {
    void jobs_refresh()
    void nextTick(scroll_restore)
    connections_warm()
})

onBeforeUnmount(scroll_save)

async function chat_new(): Promise<void> {
    assert(!empty.value)
    assert(composer_component.value !== null)

    return chat_start().then(async () => {
        pinned.value = true

        await nextTick()

        composer_component.value?.focus()
    })
}

function connections_warm(): void {
    ipc.notes_ask_warm().catch((error: unknown) => {
        log_warn('the Ask connections could not be warmed', error)
    })
}

async function history_opened(): Promise<void> {
    pinned.value = true

    await nextTick()
    scroll_bottom()

    assert(pinned.value)
    assert(chat_id.value.length > 0)

    composer_component.value?.focus()
}

function folder_named(name: FolderName): FolderName | null {
    assert(name.length > 0)

    const key = folder_key(name)
    const found = folders.value.find((folder) => folder_key(folder) === key) ?? null

    assert(found === null || folder_key(found) === key)

    return found
}

function meeting_named(job_id: string): string | null {
    assert(job_id.length > 0)

    const meeting = jobs.value.find((job) => job.id === job_id)
    const title = meeting === undefined ? null : job_title(meeting)

    assert(title === null || title.length > 0)

    return title
}

function scope_check(): void {
    assert(scope_chip.value === null || scope.value.kind !== 'all')

    const chosen = scope.value

    if (chosen.kind === 'all') return
    if (scope_target(chosen) !== null) return

    scope.value = SCOPE_ALL

    assert(scope_chip.value === null)
}

function scope_chip_of(chosen: AskScope): AskScopeChip | null {
    assert(chosen.kind !== 'project' || chosen.project.length > 0)
    assert(chosen.kind !== 'meeting' || chosen.job_id.length > 0)

    if (chosen.kind === 'all') return null

    const label = scope_target(chosen)

    if (label === null) return null

    assert(label.length > 0)

    return { kind: chosen.kind === 'project' ? 'folder' : 'meeting', label }
}

function scope_clear(): void {
    assert(scope.value.kind !== 'all')
    assert(scope_chip.value !== null)
    assert(composer_component.value !== null)

    scope.value = SCOPE_ALL
    composer_component.value.focus()
}

function scope_target(chosen: ScopeNarrowed): string | null {
    assert(chosen.kind !== 'project' || chosen.project.length > 0)
    assert(chosen.kind !== 'meeting' || chosen.job_id.length > 0)

    if (chosen.kind === 'project') return folder_named(chosen.project)

    return meeting_named(chosen.job_id)
}

function scroll_bottom(): void {
    const scroller = scroller_element.value

    if (scroller === null) return

    scroller.scrollTop = scroller.scrollHeight
    pinned.value = true

    assert(scroller.scrollTop >= 0)
    assert(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= PINNED_SLACK_PX)
}

function scroll_follow(): void {
    if (!pinned.value) return

    scroll_bottom()

    assert(pinned.value)
}

function scroll_jump(): void {
    assert(!pinned.value)
    assert(!empty.value)
    assert(composer_component.value !== null)

    const scroller = scroller_element.value

    if (scroller === null) return

    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches

    scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    composer_component.value.focus()
}

function scroll_restore(): void {
    const scroller = scroller_element.value
    const saved = thread_scroll.value

    assert(saved === null || saved.top_px >= 0)
    assert(chat_id.value.length > 0)

    thread_scroll.value = null

    if (scroller === null) return

    if (saved?.chat_id !== chat_id.value) {
        scroll_bottom()

        return
    }

    scroller.scrollTop = saved.top_px
    scroll_track()
}

function scroll_save(): void {
    const scroller = scroller_element.value

    if (scroller === null) return
    if (pinned.value) return

    assert(chat_id.value.length > 0)

    thread_scroll.value = { chat_id: chat_id.value, top_px: Math.max(0, scroller.scrollTop) }

    assert(thread_scroll.value.top_px >= 0)
}

function scroll_track(): void {
    const scroller = scroller_element.value

    if (scroller === null) return

    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight

    assert(Number.isFinite(distance))

    pinned.value = distance <= PINNED_SLACK_PX
}

async function send(question: string): Promise<void> {
    assert(question.trim().length > 0)
    assert(scope.value.kind === 'all' || scope_chip.value !== null)

    if (!ready.value) return

    pinned.value = true

    const asked = ask(question, scope.value)
    const exchange = exchanges.value.at(-1)

    assert(exchange?.question === question.trim())
    assert(exchange.state === 'searching' || exchange.state === 'failed')

    return nextTick().then(async () => {
        scroll_bottom()

        await asked
    })
}

function stop_click(): void {
    assert(busy.value)
    assert(composer_component.value !== null)

    void stop()
    composer_component.value.focus()
}
</script>

<template>
    <section class="view-fill ask">
        <header class="page-header">
            <div>
                <p class="eyebrow page-eyebrow">Meeting memory</p>
                <h2 class="!mb-1 flex items-center">
                    Ask
                    <InfoHint :text="HINT_PAGE" />
                </h2>
            </div>
            <div class="page-header-actions">
                <AskHistory @opened="history_opened" />
                <button v-if="!empty" type="button" class="btn-default" @click="chat_new">
                    <svg
                        class="ask-new-icon"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                        aria-hidden="true"
                    >
                        <path d="M12 5.25v13.5" />
                        <path d="M5.25 12h13.5" />
                    </svg>
                    New chat
                </button>
            </div>
        </header>

        <div v-if="empty" class="ask-start">
            <div class="ask-column">
                <div class="ask-hero">
                    <h3 class="ask-hero-title">What do you want to <em>know?</em></h3>
                    <p class="ask-hero-text">
                        Ask about anything said or written in your meetings.
                    </p>
                </div>

                <ul class="ask-suggestions" aria-label="Suggested questions">
                    <li v-for="suggestion in suggestions" :key="suggestion">
                        <button
                            type="button"
                            class="ask-suggestion"
                            :disabled="!ready"
                            @click="send(suggestion)"
                        >
                            <MenuIcon name="sparkles" />
                            {{ suggestion }}
                        </button>
                    </li>
                </ul>

                <AskComposer
                    ref="composer_component"
                    :busy="busy"
                    :scope="scope_chip"
                    @scope_clear="scope_clear"
                    @send="send"
                    @stop="stop_click"
                    @typing="connections_warm"
                />
            </div>
        </div>

        <template v-else>
            <div ref="scroller_element" class="ask-scroll" @scroll.passive="scroll_track">
                <ol class="ask-thread ask-column" aria-label="Conversation">
                    <AskExchange
                        v-for="(exchange, index) in exchanges"
                        :key="exchange.id"
                        :exchange="exchange"
                        :last="index === exchanges.length - 1"
                        @retry="retry"
                    />
                </ol>
            </div>

            <div class="ask-dock ask-column">
                <button
                    v-if="!pinned"
                    type="button"
                    class="ask-jump"
                    @click="scroll_jump"
                >
                    <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.75"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                    >
                        <path d="M12 5v14" />
                        <path d="M5.5 12.5L12 19l6.5-6.5" />
                    </svg>
                    Jump to latest
                </button>

                <AskComposer
                    ref="composer_component"
                    :busy="busy"
                    :scope="scope_chip"
                    @scope_clear="scope_clear"
                    @send="send"
                    @stop="stop_click"
                    @typing="connections_warm"
                />

                <p class="ask-disclaimer">
                    Answers come from your notes and transcripts. Open a source to check anything
                    important.
                </p>
            </div>
        </template>
    </section>
</template>

<style scoped>
.ask-column {
    width: 100%;
    max-width: 46rem;
    margin-inline: auto;
}

.ask-new-icon {
    width: 1rem;
    height: 1rem;
}

.ask-start {
    display: flex;
    flex: 1;
    flex-direction: column;
    justify-content: center;
    min-height: 0;
    padding-bottom: 8vh;
    overflow-y: auto;
}

.ask-hero {
    margin-bottom: 1.5rem;
    text-align: center;
}

.ask-hero-title {
    margin: 0 0 0.5rem;
    color: var(--color-content-strong);
    font-family: var(--font-display);
    font-size: 2.25rem;
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1.1;
}

.ask-hero-title em {
    color: var(--color-display-accent);
    font-style: italic;
}

.ask-hero-text {
    max-width: 30rem;
    margin: 0 auto;
    color: var(--color-content-muted);
    line-height: 1.6;
}

.ask-suggestions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.5rem;
    margin: 0 0 1.25rem;
    padding: 0;
    list-style: none;
}

.ask-suggestion {
    display: inline-flex;
    align-items: center;
    gap: 0.4375rem;
    padding: 0.4375rem 0.875rem 0.4375rem 0.6875rem;
    border: 1px solid color-mix(in oklab, var(--color-accent) 45%, transparent);
    border-radius: 999px;
    background: var(--color-accent-soft);
    color: var(--color-content-strong);
    font-size: 0.8125rem;
    transition:
        background-color 120ms ease,
        border-color 120ms ease,
        box-shadow 160ms ease,
        transform 160ms ease;
}

.ask-suggestion .menu-item-icon {
    color: var(--color-accent-strong);
}

.ask-suggestion:hover:not(:disabled) {
    border-color: var(--color-accent);
    background: color-mix(in oklab, var(--color-accent) 32%, transparent);
    box-shadow: 3px 3px 0 var(--color-plane);
    transform: translate(-1px, -1px);
}

.ask-suggestion:disabled {
    opacity: 0.5;
    cursor: default;
}

.ask-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    scrollbar-gutter: stable both-edges;
}

.ask-thread {
    display: grid;
    margin-block: 0;
    padding: 0;
    list-style: none;
}

.ask-dock {
    position: relative;
    padding-top: 0.75rem;
}

.ask-jump {
    position: absolute;
    top: -2.5rem;
    left: 50%;
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.75rem;
    border: 1px solid var(--color-border-strong);
    border-radius: 999px;
    background: var(--color-panel);
    box-shadow: var(--shadow-elevated);
    color: var(--color-content-strong);
    font-size: 0.8125rem;
    transform: translateX(-50%);
}

.ask-jump:hover {
    background:
        linear-gradient(var(--color-elevated-hover), var(--color-elevated-hover)),
        var(--color-panel);
}

.ask-jump svg {
    width: 0.875rem;
    height: 0.875rem;
}

.ask-disclaimer {
    margin: 0.625rem 0 0;
    color: var(--color-content-subtle);
    font-size: 0.75rem;
    text-align: center;
}
</style>
