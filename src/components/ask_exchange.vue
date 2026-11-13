<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { use_ask } from '../composables/use_ask'
import { use_context_menu } from '../composables/use_context_menu'
import { use_pipeline } from '../composables/use_pipeline'
import {
    answer_blocks,
    answer_parts,
    answer_plain,
    answer_settled,
    source_date,
    source_where,
    sources_cited,
} from '../lib/answer'
import { assert } from '../lib/assert'
import { error_dialog_show, error_friendly } from '../lib/errors'
import { job_title } from '../lib/job_status'
import { log_warn } from '../lib/log'
import { MENU_ITEM_ASK, MENU_ITEM_OPEN_MEETING } from '../lib/menu'
import type { Exchange } from '../composables/use_ask'
import type { AnswerPart, SourceCited } from '../lib/answer'
import type { MenuItem } from '../lib/menu'


interface Preview {
    above: boolean
    cited: SourceCited
    left: number
    top: number
}

interface RenderedBlock {
    item_tag: 'li' | 'span'
    items: AnswerPart[][]
    tag: 'ol' | 'p' | 'ul'
}

const props = defineProps<{
    exchange: Exchange
    last: boolean
}>()

const emit = defineEmits<{ retry: [] }>()

const COPIED_FLASH_MS = 1500
const MENU_ITEM_ANSWER_COPY: MenuItem = { id: 'answer_copy', label: 'Copy answer', icon: 'copy' }
const MENU_ITEM_RETRY: MenuItem = { id: 'retry', label: 'Ask again', icon: 'retry' }
const PREVIEW_GAP_PX = 6
const PREVIEW_HEIGHT_PX = 168
const PREVIEW_WIDTH_PX = 288
const VIEWPORT_MARGIN_PX = 12
const { meeting_ask } = use_ask()
const { open: context_menu_open } = use_context_menu()
const { job_open_at } = use_pipeline()
const copied = ref(false)
const preview = ref<Preview | null>(null)
let copied_timer: ReturnType<typeof setTimeout> | null = null

const live = computed(
    () => props.exchange.state === 'searching' || props.exchange.state === 'answering',
)

const streaming = computed(() => props.exchange.state === 'answering')

const cited = computed(() => {
    const { answer, meetings, sources } = props.exchange

    return sources_cited(answer, sources, meetings)
})

const rendered = computed<RenderedBlock[]>(() => {
    const settled = answer_settled(props.exchange.answer, streaming.value)

    return answer_blocks(settled).map((block): RenderedBlock => {
        if (block.kind === 'paragraph') {
            return { item_tag: 'span', items: [parts_of(block.text)], tag: 'p' }
        }

        const tag = block.ordered ? 'ol' : 'ul'

        return { item_tag: 'li', items: block.items.map(parts_of), tag }
    })
})

const status = computed<string | null>(() => {
    const { answer, meetings, notice, sources, state } = props.exchange

    if (state === 'searching') return notice.length > 0 ? notice : 'Searching your meetings'
    if (state !== 'answering') return null
    if (answer.length > 0) return null

    const passages = count_label(sources.length, 'passage')

    return `Reading ${passages} from ${count_label(meetings.length, 'meeting')}`
})

const notice_shown = computed<boolean>(() => {
    const { notice, state } = props.exchange

    return notice.length > 0 && (state === 'answering' || state === 'done')
})

const problem = computed<string | null>(() => {
    if (props.exchange.state !== 'failed') return null

    return error_friendly(props.exchange.error ?? '').message
})

const scope_label = computed<string | null>(() => {
    const { meetings, scope } = props.exchange

    if (scope.kind === 'all') return null
    if (scope.kind === 'project') return `In ${scope.project}`

    const meeting = meetings.find((candidate) => candidate.id === scope.job_id)

    return `In ${meeting === undefined ? 'one meeting' : job_title(meeting)}`
})

const copyable = computed(() => !live.value && props.exchange.answer.trim().length > 0)


onBeforeUnmount(() => {
    if (copied_timer !== null) clearTimeout(copied_timer)

    preview_hide()
})

function caret_at(index: number, position: number): boolean {
    assert(index >= 0)
    assert(position >= 0)

    if (!streaming.value) return false

    const block = rendered.value.at(-1)

    return index === rendered.value.length - 1 && position === (block?.items.length ?? 0) - 1
}

function cite_label(entry: SourceCited): string {
    assert(entry.number > 0)

    const where = `${source_date(entry.meeting)}, ${source_where(entry.source)}`

    return `Source ${String(entry.number)}: ${job_title(entry.meeting)}, ${where}`
}

async function copy(): Promise<void> {
    assert(copyable.value)

    const text = answer_plain(props.exchange.answer, cited.value)

    try {
        await navigator.clipboard.writeText(text)
    } catch (error) {
        log_warn('[ask] clipboard write failed', error)

        return
    }

    copied.value = true

    if (copied_timer !== null) clearTimeout(copied_timer)

    copied_timer = setTimeout(() => {
        copied.value = false
    }, COPIED_FLASH_MS)
}

function count_label(count: number, noun: string): string {
    assert(Number.isInteger(count))
    assert(noun.length > 0)

    return `${String(count)} ${noun}${count === 1 ? '' : 's'}`
}

function exchange_context_menu(event: MouseEvent): void {
    assert(event.type === 'contextmenu')
    assert(props.exchange.id.length > 0)

    context_menu_open(event, exchange_menu_items(), exchange_menu_select)
}

function exchange_menu_items(): MenuItem[] {
    const { state } = props.exchange
    const actions_shown = state === 'done' || state === 'stopped'
    const items: MenuItem[] = []

    if (actions_shown && copyable.value) items.push(MENU_ITEM_ANSWER_COPY)
    if (props.last && !live.value) items.push(MENU_ITEM_RETRY)

    assert(items.length <= 2)

    return items
}

async function exchange_menu_select(id: string): Promise<void> {
    assert(id.length > 0)

    if (id === MENU_ITEM_ANSWER_COPY.id) return copy()

    assert(id === MENU_ITEM_RETRY.id, `the answer has no action for ${id}`)

    emit('retry')
}

function parts_of(text: string): AnswerPart[] {
    assert(typeof text === 'string')

    return answer_parts(text, cited.value)
}

function preview_hide(): void {
    window.removeEventListener('scroll', preview_hide, true)
    preview.value = null
}

function preview_show(event: Event, entry: SourceCited): void {
    const target = event.currentTarget

    if (!(target instanceof HTMLElement)) return

    const rect = target.getBoundingClientRect()
    const right = window.innerWidth - PREVIEW_WIDTH_PX - VIEWPORT_MARGIN_PX
    const left = Math.max(VIEWPORT_MARGIN_PX, Math.min(rect.left, right))
    const above = rect.bottom + PREVIEW_GAP_PX + PREVIEW_HEIGHT_PX > window.innerHeight
    const top = above ? rect.top - PREVIEW_GAP_PX : rect.bottom + PREVIEW_GAP_PX

    window.addEventListener('scroll', preview_hide, { capture: true, passive: true })
    preview.value = { above, cited: entry, left, top }
}

function source_context_menu(event: MouseEvent, entry: SourceCited): void {
    assert(event.type === 'contextmenu')
    assert(entry.number > 0)

    preview_hide()

    const items = [MENU_ITEM_OPEN_MEETING, MENU_ITEM_ASK]

    context_menu_open(event, items, source_menu_select.bind(undefined, entry))
}

async function source_menu_select(entry: SourceCited, id: string): Promise<void> {
    assert(entry.meeting.id.length > 0)

    if (id === MENU_ITEM_OPEN_MEETING.id) return source_open(entry)

    assert(id === MENU_ITEM_ASK.id, `the source has no action for ${id}`)

    return meeting_ask(entry.meeting.id)
}

async function source_open(entry: SourceCited): Promise<void> {
    preview_hide()

    try {
        await job_open_at(entry.meeting, entry.source)
    } catch (error) {
        await error_dialog_show(error)
    }
}
</script>

<template>
    <li
        class="ask-exchange"
        :aria-busy="live ? 'true' : 'false'"
        @contextmenu="exchange_context_menu"
    >
        <div class="ask-user">
            <p class="ask-question">{{ exchange.question }}</p>
            <span v-if="scope_label !== null" class="ask-scope-label">{{ scope_label }}</span>
        </div>

        <div class="ask-reply">
            <p v-if="status !== null" class="ask-status" role="status">
                <span class="ask-status-dots" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                </span>
                {{ status }}
            </p>

            <div v-if="rendered.length > 0" class="ask-answer">
                <component :is="block.tag" v-for="(block, index) in rendered" :key="index">
                    <component
                        :is="block.item_tag"
                        v-for="(item, position) in block.items"
                        :key="position"
                    >
                        <template v-for="(part, offset) in item" :key="offset">
                            <button
                                v-if="part.cited !== null"
                                type="button"
                                class="ask-cite"
                                :aria-label="cite_label(part.cited)"
                                @click="source_open(part.cited)"
                                @contextmenu="source_context_menu($event, part.cited)"
                                @mouseenter="preview_show($event, part.cited)"
                                @mouseleave="preview_hide"
                                @focus="preview_show($event, part.cited)"
                                @blur="preview_hide"
                            >
                                {{ part.cited.number }}
                            </button>
                            <template v-else>{{ part.text }}</template>
                        </template>
                        <span
                            v-if="caret_at(index, position)"
                            class="streaming-caret"
                            aria-hidden="true"
                        >▌</span>
                    </component>
                </component>
            </div>

            <div v-if="problem !== null" class="ask-problem" role="alert">
                <p>{{ problem }}</p>
                <button v-if="last" type="button" class="btn-default" @click="emit('retry')">
                    Try again
                </button>
            </div>

            <p v-if="exchange.state === 'stopped'" class="ask-stopped">Stopped</p>

            <p v-if="notice_shown" class="ask-notice" role="note">{{ exchange.notice }}</p>

            <details v-if="!live && cited.length > 0" class="ask-sources">
                <summary class="ask-sources-toggle">
                    <svg
                        class="ask-sources-chevron"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.75"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                    >
                        <path d="M9 6l6 6-6 6" />
                    </svg>
                    {{ count_label(cited.length, 'source') }}
                </summary>
                <ol class="ask-source-list">
                    <li
                        v-for="entry in cited"
                        :key="entry.source.marker"
                        @contextmenu="source_context_menu($event, entry)"
                    >
                        <button type="button" class="ask-source" @click="source_open(entry)">
                            <span class="ask-source-number">{{ entry.number }}</span>
                            <span class="ask-source-body">
                                <span class="ask-source-title">{{ job_title(entry.meeting) }}</span>
                                <span class="ask-source-meta">
                                    <svg
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="1.5"
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        aria-hidden="true"
                                    >
                                        <template v-if="entry.source.source === 'transcript'">
                                            <path d="M4.5 10v4" />
                                            <path d="M9 6.5v11" />
                                            <path d="M13.5 8.5v7" />
                                            <path d="M18 10.5v3" />
                                        </template>
                                        <template v-else>
                                            <path d="M6.75 3.75h7.5l3 3v13.5H6.75Z" />
                                            <path d="M9.75 11.25h4.5" />
                                            <path d="M9.75 14.25h4.5" />
                                        </template>
                                    </svg>
                                    <span>{{ source_date(entry.meeting) }}</span>
                                    <span aria-hidden="true">&middot;</span>
                                    <span class="ask-source-where">
                                        {{ source_where(entry.source) }}
                                    </span>
                                </span>
                                <span v-if="entry.source.snippet" class="ask-source-snippet">
                                    {{ entry.source.snippet }}
                                </span>
                            </span>
                        </button>
                    </li>
                </ol>
            </details>

            <div
                v-if="exchange.state === 'done' || exchange.state === 'stopped'"
                class="ask-actions"
            >
                <button
                    v-if="copyable"
                    type="button"
                    class="menu-icon-btn"
                    :aria-label="copied ? 'Copied' : 'Copy'"
                    :title="copied ? 'Copied' : 'Copy'"
                    @click="copy"
                >
                    <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                    >
                        <path v-if="copied" d="M5 12.5l4.5 4.5L19 7.5" />
                        <template v-else>
                            <path d="M8.25 8.25h10.5v10.5H8.25Z" />
                            <path d="M15.75 8.25v-3H5.25v10.5h3" />
                        </template>
                    </svg>
                </button>
                <button
                    v-if="last"
                    type="button"
                    class="menu-icon-btn"
                    aria-label="Ask again"
                    title="Ask again"
                    @click="emit('retry')"
                >
                    <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                    >
                        <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
                        <path d="M19.5 4.5v4.5H15" />
                    </svg>
                </button>
            </div>
        </div>

        <div
            v-if="preview !== null"
            class="ask-preview"
            :data-above="preview.above ? 'true' : 'false'"
            :style="{ left: `${preview.left}px`, top: `${preview.top}px` }"
            aria-hidden="true"
        >
            <p class="ask-preview-title">{{ job_title(preview.cited.meeting) }}</p>
            <p class="ask-preview-meta">
                {{ source_date(preview.cited.meeting) }} &middot;
                {{ source_where(preview.cited.source) }}
            </p>
            <p v-if="preview.cited.source.snippet" class="ask-preview-snippet">
                {{ preview.cited.source.snippet }}
            </p>
        </div>
    </li>
</template>

<style scoped>
.ask-exchange {
    display: grid;
    gap: 1rem;
    padding-block: 1.25rem;
}

.ask-user {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.375rem;
}

.ask-question {
    max-width: 85%;
    margin: 0 0.25rem 0.25rem 0;
    padding: 0.625rem 1rem;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-xl);
    background: var(--color-panel);
    color: var(--color-content-strong);
    box-shadow: 4px 4px 0 var(--color-display-accent);
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    -webkit-user-select: text;
    user-select: text;
}

.ask-scope-label {
    color: var(--color-content-meta);
    font-size: 0.75rem;
}

.ask-reply {
    display: grid;
    gap: 0.875rem;
    min-width: 0;
}

.ask-status {
    display: inline-flex;
    align-items: center;
    gap: 0.625rem;
    margin: 0;
    color: var(--color-content-muted);
    font-size: 0.875rem;
}

.ask-status-dots {
    display: inline-flex;
    gap: 0.1875rem;
}

.ask-status-dots > span {
    width: 0.3125rem;
    height: 0.3125rem;
    border-radius: 999px;
    background: currentColor;
    animation: ask-dot 1.2s ease-in-out infinite;
}

.ask-status-dots > span:nth-child(2) {
    animation-delay: 0.15s;
}

.ask-status-dots > span:nth-child(3) {
    animation-delay: 0.3s;
}

@keyframes ask-dot {
    0%,
    80%,
    100% {
        opacity: 0.25;
        transform: translateY(0);
    }

    40% {
        opacity: 1;
        transform: translateY(-2px);
    }
}

.ask-answer {
    display: grid;
    gap: 0.75rem;
    margin: 0 0 0.3125rem 0.3125rem;
    padding: 1rem 1.25rem;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-xl);
    background: var(--color-panel);
    box-shadow: -5px 5px 0 var(--color-plane);
    color: var(--color-content);
    line-height: 1.7;
    overflow-wrap: anywhere;
    -webkit-user-select: text;
    user-select: text;
}

.ask-answer p {
    margin: 0;
    white-space: pre-line;
}

.ask-answer ul,
.ask-answer ol {
    display: grid;
    gap: 0.375rem;
    margin: 0;
    padding-left: 1.375rem;
}

.ask-answer ul {
    list-style: disc;
}

.ask-answer ol {
    list-style: decimal;
}

.ask-answer li::marker {
    color: var(--color-content-meta);
}

.ask-cite {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.125rem;
    height: 1.125rem;
    margin-inline: 0.125rem;
    padding: 0 0.3125rem;
    border-radius: 999px;
    background: linear-gradient(
        104deg,
        var(--color-accent) 0 58%,
        color-mix(in oklab, var(--color-accent), var(--shade) 14%) 58%
    );
    color: var(--color-accent-content);
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-weight: 600;
    line-height: 1;
    vertical-align: 0.125em;
    transition: background-color 100ms ease, color 100ms ease;
}

.ask-cite:hover,
.ask-cite:focus-visible {
    background: var(--color-content-strong);
    color: var(--color-surface);
}

.ask-problem {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
    padding: 0.75rem 1rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-panel);
}

.ask-problem p {
    flex: 1 1 16rem;
    margin: 0;
    color: var(--color-danger-text);
    font-size: 0.875rem;
    -webkit-user-select: text;
    user-select: text;
}

.ask-stopped,
.ask-notice {
    margin: 0;
    color: var(--color-content-meta);
    font-size: 0.8125rem;
}

.ask-sources {
    display: grid;
    justify-items: start;
}

.ask-sources-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.625rem 0.25rem 0.5rem;
    border: 1px solid var(--color-border-strong);
    border-radius: 999px;
    color: var(--color-content-muted);
    font: 500 0.6875rem/1.5 var(--font-mono);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    list-style: none;
    cursor: pointer;
    transition: background-color 100ms ease, color 100ms ease;
}

.ask-sources-toggle::-webkit-details-marker {
    display: none;
}

.ask-sources-toggle:hover {
    background: var(--color-row-hover);
    color: var(--color-content);
}

.ask-sources-toggle:focus-visible {
    outline: 2px solid var(--color-focus-ring);
    outline-offset: 2px;
}

.ask-sources-chevron {
    flex: none;
    width: 0.75rem;
    height: 0.75rem;
    transition: transform 120ms ease;
}

.ask-sources[open] .ask-sources-chevron {
    transform: rotate(90deg);
}

.ask-sources[open] .ask-source-list {
    width: 100%;
    margin-top: 0.5rem;
}

.ask-source-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
}

.ask-source {
    display: flex;
    gap: 0.625rem;
    width: 100%;
    height: 100%;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-panel);
    text-align: left;
    transition: border-color 120ms ease, background-color 120ms ease;
}

.ask-source:hover {
    border-color: var(--color-border-strong);
    background: var(--color-row-hover);
}

.ask-source-number {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 999px;
    background: linear-gradient(
        104deg,
        var(--color-accent) 0 58%,
        color-mix(in oklab, var(--color-accent), var(--shade) 14%) 58%
    );
    color: var(--color-accent-content);
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-weight: 600;
}

.ask-source-body {
    display: grid;
    gap: 0.125rem;
    min-width: 0;
}

.ask-source-title {
    overflow: hidden;
    color: var(--color-content-strong);
    font-size: 0.875rem;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ask-source-meta {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    min-width: 0;
    color: var(--color-content-meta);
    font-size: 0.75rem;
    white-space: nowrap;
}

.ask-source-meta svg {
    flex: none;
    width: 0.875rem;
    height: 0.875rem;
}

.ask-source-where {
    overflow: hidden;
    text-overflow: ellipsis;
}

.ask-source-snippet {
    display: -webkit-box;
    overflow: hidden;
    color: var(--color-content-muted);
    font-size: 0.75rem;
    line-height: 1.45;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
}

.ask-actions {
    display: flex;
    gap: 0.25rem;
    margin-left: -0.375rem;
}

.ask-preview {
    position: fixed;
    z-index: 40;
    display: grid;
    gap: 0.25rem;
    width: 18rem;
    padding: 0.75rem 0.875rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-panel);
    box-shadow: var(--shadow-elevated);
    pointer-events: none;
}

.ask-preview[data-above="true"] {
    transform: translateY(-100%);
}

.ask-preview p {
    margin: 0;
}

.ask-preview-title {
    overflow: hidden;
    color: var(--color-content-strong);
    font-size: 0.8125rem;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ask-preview-meta {
    color: var(--color-content-meta);
    font-size: 0.75rem;
}

.ask-preview-snippet {
    display: -webkit-box;
    overflow: hidden;
    color: var(--color-content-muted);
    font-size: 0.75rem;
    line-height: 1.45;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 4;
    line-clamp: 4;
}

@media (prefers-reduced-motion: reduce) {
    .ask-status-dots > span {
        animation: none;
        opacity: 0.6;
    }
}
</style>
