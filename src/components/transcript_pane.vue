<script setup lang="ts">
import {
    computed,
    nextTick,
    onActivated,
    onDeactivated,
    onMounted,
    onUnmounted,
    ref,
    useTemplateRef,
    watch,
} from 'vue'
import { convertFileSrc } from '@tauri-apps/api/core'
import { use_ask } from '../composables/use_ask'
import { use_context_menu } from '../composables/use_context_menu'
import { use_pipeline } from '../composables/use_pipeline'
import { use_shortcuts } from '../composables/use_shortcuts'
import { assert } from '../lib/assert'
import { seconds_to_clock } from '../lib/duration'
import { error_dialog_show } from '../lib/errors'
import { ipc } from '../lib/ipc'
import { log_warn } from '../lib/log'
import { MENU_ITEM_ASK } from '../lib/menu'
import type { ComponentPublicInstance } from 'vue'
import type { MenuItem } from '../lib/menu'
import type { AudioPath, JobID, SegmentFocus, Transcript, TranscriptSegment } from '../types'


interface DisplayRow {
    text: string
    start_seconds: number
    end_seconds: number
    segment_index: number
}

const properties = defineProps<{
    transcript: Transcript | null
    segment_indexes_highlighted?: number[]
}>()

const ROWS_RENDER_STEP = 60
const ROWS_RENDER_THRESHOLD_PX = 200
const COPIED_FLASH_MS = 1500
const HIGHLIGHT_NAME = 'transcript-filter'
const REGEX_ESCAPE = /[.*+?^${}()|[\]\\]/gu

const MENU_ITEM_LINE_COPY = Object.freeze<MenuItem>({
    id: 'line_copy',
    label: 'Copy line',
    icon: 'copy',
})

const MENU_ITEM_LINE_EDIT = Object.freeze<MenuItem>({
    id: 'line_edit',
    label: 'Correct line',
    icon: 'edit',
})

const MENU_ITEM_PAUSE = Object.freeze<MenuItem>({ id: 'pause', label: 'Pause', icon: 'pause' })
const MENU_ITEM_PLAY = Object.freeze<MenuItem>({ id: 'play', label: 'Play segment', icon: 'play' })
const { job_id_current, segment_focus, transcript_segments_text_set } = use_pipeline()
const { meeting_ask } = use_ask()
const { open: context_menu_open } = use_context_menu()

const filter_text = ref('')
const index_copied = ref<number | null>(null)
const index_editing = ref<number | null>(null)
const text_editing = ref('')
const list_element = useTemplateRef<HTMLElement>('list_element')
const audio_element = useTemplateRef<HTMLAudioElement>('audio_element')
const audio_path = ref<string | null>(null)
const audio_source = ref<string | null>(null)
const audio_checked = ref(false)
const playback_index = ref<number | null>(null)
const rows_render_limit = ref(ROWS_RENDER_STEP)

const rows = computed<DisplayRow[]>(() => {
    if (properties.transcript === null) return []

    return properties.transcript.segments
        .map((segment: TranscriptSegment, segment_index: number) => ({
            text: segment.text.trim(),
            start_seconds: segment.start_seconds,
            end_seconds: segment.end_seconds,
            segment_index,
        }))
        .filter((row) => row.text.length > 0)
})

const filter_regex = computed<RegExp | null>(() => {
    const needle = filter_text.value.trim()

    if (needle.length === 0) return null

    return new RegExp(needle.replace(REGEX_ESCAPE, '\\$&'), 'iu')
})

const timing_present = computed(
    () => properties.transcript?.segments.some((segment) => segment.end_seconds > 0) ?? false,
)

const playback_available = computed(
    () => (audio_path.value ?? '').length > 0 && timing_present.value,
)

const rows_filtered = computed<DisplayRow[]>(() => {
    const regex = filter_regex.value

    if (regex === null) return rows.value

    return rows.value.filter((row) => regex.test(row.text))
})

const rows_rendered = computed<DisplayRow[]>(
    () => rows_filtered.value.slice(0, rows_render_limit.value),
)

const focus_current = computed<SegmentFocus | null>(() => {
    const focus = segment_focus.value

    if (focus === null) return null
    if (focus.job_id !== job_id_current.value) return null

    return focus
})


watch(rows_filtered, () => {
    assert(rows_render_limit.value >= ROWS_RENDER_STEP)

    rows_render_limit.value = ROWS_RENDER_STEP
    index_editing.value = null
})

watch(rows_rendered, async () => {
    await nextTick()

    rows_render_grow()
})

watch([rows_rendered, filter_regex, index_editing], highlights_apply, { flush: 'post' })

watch([focus_current, audio_checked], focus_scroll, { flush: 'post' })

async function audio_clip_attach(row: DisplayRow): Promise<HTMLAudioElement | null> {
    assert(row.text.length > 0)
    assert(row.segment_index >= 0)

    const id = job_id_current.value

    if (id === null) return null
    if (row.end_seconds <= row.start_seconds) return null

    assert(id.length > 0)

    audio_source_release()

    return ipc.job_audio_clip_get(id, row.start_seconds, row.end_seconds)
        .then(async (path) => (path === null ? null : audio_clip_load(path)))
}

async function audio_clip_load(path: AudioPath): Promise<HTMLAudioElement | null> {
    assert(path.length > 0)

    return fetch(convertFileSrc(path))
        .then(async (response) => {
            if (!response.ok) throw new Error(`clip fetch: ${String(response.status)}`)

            return response.blob()
        })
        .then(async (blob) => {
            audio_source.value = URL.createObjectURL(blob)

            assert(audio_source.value.startsWith('blob:'))

            return nextTick()
        })
        .then(() => audio_element.value)
}

function audio_error_handler(event: Event): void {
    assert(event.type === 'error')
    assert(event.currentTarget instanceof HTMLAudioElement)

    playback_clear()
    audio_source_release()
}

async function audio_path_load(): Promise<void> {
    assert(playback_index.value === null)

    audio_source_release()

    audio_path.value = null

    const id = job_id_current.value

    if (id === null) {
        audio_checked.value = true

        return
    }

    assert(id.length > 0)

    return ipc.job_audio_path_get(id)
        .then((path) => {
            audio_path.value = path
        })
        .catch((error: unknown) => {
            audio_path.value = null

            log_warn('[transcript] audio path unavailable', id, error)
        })
        .finally(() => {
            audio_checked.value = true
        })
}

function audio_pause_handler(event: Event): void {
    assert(event.type === 'pause')
    assert(event.currentTarget instanceof HTMLAudioElement)

    if (audio_element.value?.paused === true) playback_clear()
}

function audio_pause_if_playing(): void {
    const audio = audio_element.value

    if (audio === null) return
    if (audio.paused) return

    audio.pause()
}

function audio_source_release(): void {
    assert(audio_source.value === null || audio_source.value.startsWith('blob:'))

    if (audio_source.value !== null) URL.revokeObjectURL(audio_source.value)

    audio_source.value = null
}

async function focus_row_scroll(focus: SegmentFocus, container: HTMLElement): Promise<void> {
    assert(focus.segment_index_first <= focus.segment_index_last)
    assert(container.classList.contains('transcript-pane-list'))
    assert(filter_text.value.length === 0)

    const position = rows.value.findIndex((row) => row.segment_index >= focus.segment_index_first)

    if (position < 0) return

    rows_render_limit.value = Math.max(rows_render_limit.value, position + ROWS_RENDER_STEP)

    return nextTick().then(() => {
        const row = container.querySelector(`[data-row-index="${String(position)}"]`)

        row?.scrollIntoView({ block: 'center' })
    })
}

async function focus_scroll(): Promise<void> {
    const focus = focus_current.value
    const container = list_element.value

    if (focus === null) return
    if (container === null) return

    assert(focus.job_id === job_id_current.value)
    assert(rows.value.length > 0)

    if (filter_text.value.length === 0) return focus_row_scroll(focus, container)

    filter_text.value = ''

    return nextTick().then(async () => focus_row_scroll(focus, container))
}

function highlights_apply(): void {
    const registry = highlights_registry()

    if (registry === null) return

    const ranges = highlights_ranges()

    if (ranges === null) {
        void registry.delete(HIGHLIGHT_NAME)

        return
    }

    registry.set(HIGHLIGHT_NAME, new Highlight(...ranges))
}

function highlights_ranges(): Range[] | null {
    const regex = filter_regex.value
    const container = list_element.value

    if (regex === null) return null
    if (container === null) return null

    assert(regex.flags === 'iu')

    const matcher = new RegExp(regex.source, 'giu')
    const ranges: Range[] = []

    for (const element of container.querySelectorAll('.transcript-pane-row-text')) {
        const node = element.firstChild

        if (!(node instanceof Text)) continue

        for (const match of node.data.matchAll(matcher)) {
            assert(match[0].length > 0)

            const range = new Range()

            range.setStart(node, match.index)
            range.setEnd(node, match.index + match[0].length)
            ranges.push(range)
        }
    }

    return ranges
}

function highlights_registry(): HighlightRegistry | null {
    if (typeof CSS === 'undefined') return null

    const css: { highlights?: HighlightRegistry } = CSS

    return css.highlights ?? null
}

function pane_context_menu(event: MouseEvent): void {
    assert(event.type === 'contextmenu')
    assert(event.currentTarget instanceof HTMLElement)

    const job_id = job_id_current.value

    if (job_id === null) return

    assert(job_id.length > 0)

    context_menu_open(event, [MENU_ITEM_ASK], pane_menu_select.bind(undefined, job_id))
}

async function pane_menu_select(job_id: JobID, id: string): Promise<void> {
    assert(job_id.length > 0)
    assert(id === MENU_ITEM_ASK.id)

    return meeting_ask(job_id)
}

function playback_clear(): void {
    assert(playback_index.value === null || playback_index.value >= 0)

    playback_index.value = null
}

function playback_mark(index: number): void {
    assert(Number.isInteger(index))
    assert(index >= 0)

    playback_index.value = index
}

function playback_space_toggle(event: KeyboardEvent): void {
    assert(event.type === 'keydown')
    assert(event.key === ' ')

    const audio = audio_element.value

    if (audio === null) return

    if (audio.paused) {
        void audio.play().catch((error: unknown) => {
            log_warn('[transcript] playback refused', error)
        })

        return
    }

    audio.pause()
}

function row_context_menu(event: MouseEvent, row: DisplayRow, index: number): void {
    assert(event.type === 'contextmenu')
    assert(row.text.length > 0)
    assert(index >= 0)

    const job_id = job_id_current.value
    const items = row_menu_items(index, job_id)
    const select = row_menu_select.bind(undefined, row, index, job_id)

    context_menu_open(event, items, select)
}

function row_copied_clear(index: number): void {
    assert(Number.isInteger(index))
    assert(index >= 0)

    if (index_copied.value === index) index_copied.value = null
}

async function row_copy(row: DisplayRow, index: number): Promise<void> {
    assert(row.text.length > 0)
    assert(index >= 0)

    return Promise.resolve(row.text)
        .then(async (text) => navigator.clipboard.writeText(text))
        .then(() => {
            index_copied.value = index

            setTimeout(row_copied_clear.bind(undefined, index), COPIED_FLASH_MS)
        })
        .catch((error: unknown) => {
            index_copied.value = null

            log_warn('[transcript] clipboard write failed', error)
        })
}

function row_edit_cancel(event: KeyboardEvent): void {
    assert(event.type === 'keydown')
    assert(event.currentTarget instanceof HTMLTextAreaElement)
    assert(index_editing.value !== null)

    index_editing.value = null
}

async function row_edit_commit(row: DisplayRow, index: number): Promise<void> {
    assert(row.text.length > 0)
    assert(row.segment_index >= 0)
    assert(index >= 0)

    if (index_editing.value !== index) return

    const text = text_editing.value.trim()

    index_editing.value = null

    if (text.length === 0) return
    if (text === row.text) return

    return transcript_segments_text_set([{ index: row.segment_index, text }])
        .catch(error_dialog_show)
}

function row_edit_focus(element: Element | ComponentPublicInstance | null): void {
    assert(element === null || element instanceof HTMLTextAreaElement)

    if (element instanceof HTMLTextAreaElement) element.focus()
}

function row_edit_toggle(row: DisplayRow, index: number): void {
    assert(row.text.length > 0)
    assert(index >= 0)

    if (index_editing.value === index) {
        void row_edit_commit(row, index)

        return
    }

    index_editing.value = index
    text_editing.value = row.text
}

function row_focused(row: DisplayRow): boolean {
    assert(row.segment_index >= 0)

    const focus = focus_current.value

    if (focus === null) return false

    assert(focus.segment_index_first <= focus.segment_index_last)

    return row.segment_index >= focus.segment_index_first
        && row.segment_index <= focus.segment_index_last
}

function row_highlighted(row: DisplayRow): boolean {
    assert(Number.isInteger(row.segment_index))
    assert(row.segment_index >= 0)

    if (row_focused(row)) return true

    return properties.segment_indexes_highlighted?.includes(row.segment_index) ?? false
}

function row_label(row: DisplayRow): string {
    assert(Number.isInteger(row.segment_index))
    assert(row.segment_index >= 0)

    if (timing_present.value) return seconds_to_clock(row.start_seconds)

    return `Line ${String(row.segment_index + 1)}`
}

function row_menu_items(index: number, job_id: JobID | null): MenuItem[] {
    assert(index >= 0)
    assert(job_id === null || job_id.length > 0)

    const items: MenuItem[] = [MENU_ITEM_LINE_COPY]
    const playing = playback_index.value === index

    if (playback_available.value) items.push(playing ? MENU_ITEM_PAUSE : MENU_ITEM_PLAY)

    items.push(MENU_ITEM_LINE_EDIT)

    if (job_id !== null) items.push(MENU_ITEM_ASK)

    assert(items.length <= 4)

    return items
}

async function row_menu_select(
    row: DisplayRow,
    index: number,
    job_id: JobID | null,
    id: string,
): Promise<void> {
    assert(row.text.length > 0)
    assert(index >= 0)
    assert(job_id === null || job_id.length > 0)
    assert(id.length > 0)

    const playing = playback_index.value === index

    if (id === MENU_ITEM_ASK.id) {
        assert(job_id !== null, `the transcript has no action for ${id}`)

        return meeting_ask(job_id)
    }

    if (id === MENU_ITEM_LINE_COPY.id) return row_copy(row, index)
    if (job_id_current.value !== job_id) return

    if (id === MENU_ITEM_PAUSE.id) {
        if (!playing) return

        return row_play_toggle(row, index)
    }

    if (id === MENU_ITEM_PLAY.id) {
        if (playing) return

        return row_play_toggle(row, index)
    }

    assert(id === MENU_ITEM_LINE_EDIT.id, `the transcript has no action for ${id}`)

    row_edit_toggle(row, index)
}

async function row_play_toggle(row: DisplayRow, index: number): Promise<void> {
    assert(row.segment_index >= 0)
    assert(index >= 0)

    if (playback_index.value === index) {
        audio_pause_if_playing()
        playback_clear()

        return
    }

    audio_pause_if_playing()

    return audio_clip_attach(row)
        .then(async (audio) => {
            if (audio === null) return

            playback_mark(index)

            return audio.play()
        })
        .catch((error: unknown) => {
            playback_clear()

            log_warn('[transcript] playback refused', error)
        })
}

function rows_render_grow(): void {
    assert(rows_render_limit.value >= ROWS_RENDER_STEP)

    const container = list_element.value

    if (container === null) return
    if (rows_render_limit.value >= rows_filtered.value.length) return

    assert(rows_rendered.value.length === rows_render_limit.value)

    const distance_to_end = container.scrollHeight - container.scrollTop - container.clientHeight

    if (distance_to_end > ROWS_RENDER_THRESHOLD_PX) return

    rows_render_limit.value += ROWS_RENDER_STEP
}

use_shortcuts({ space: playback_space_toggle })

onActivated(highlights_apply)

onDeactivated(() => {
    audio_pause_if_playing()
    highlights_registry()?.delete(HIGHLIGHT_NAME)
})

onMounted(() => {
    assert(!audio_checked.value)

    void audio_path_load()
})

watch(() => job_id_current.value, () => {
    audio_pause_if_playing()
    playback_clear()

    void audio_path_load()
})

onUnmounted(() => {
    audio_pause_if_playing()
    audio_source_release()
    highlights_registry()?.delete(HIGHLIGHT_NAME)
})
</script>

<template>
    <div class="transcript-pane card" @contextmenu="pane_context_menu">
        <audio
            v-if="audio_source"
            ref="audio_element"
            :src="audio_source"
            preload="metadata"
            @pause="audio_pause_handler"
            @error="audio_error_handler"
        />
        <div class="transcript-pane-header">
            <div class="text-sm font-medium">Transcript</div>
            <input
                v-model="filter_text"
                type="search"
                class="input transcript-pane-filter"
                placeholder="Filter…"
            >
        </div>

        <div v-if="rows.length === 0" class="meta px-3 py-2">
            There is no transcript yet.
        </div>
        <ul
            v-else-if="audio_checked"
            ref="list_element"
            class="transcript-pane-list"
            @scroll.passive="rows_render_grow"
        >
            <li
                v-for="(row, index) in rows_rendered"
                :key="index"
                class="transcript-pane-row"
                :data-row-index="index"
                :data-copied="index_copied === index ? 'true' : 'false'"
                :data-playing="playback_index === index ? 'true' : 'false'"
                :data-highlighted="row_highlighted(row) ? 'true' : 'false'"
                :data-editing="index_editing === index ? 'true' : 'false'"
                title="Click to copy"
                @click="row_copy(row, index)"
                @contextmenu="row_context_menu($event, row, index)"
            >
                <div class="transcript-pane-actions">
                    <button
                        v-if="playback_available"
                        type="button"
                        class="transcript-pane-play"
                        :title="playback_index === index ? 'Pause' : 'Play segment'"
                        @click.stop="row_play_toggle(row, index)"
                    >
                        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <template v-if="playback_index === index">
                                <rect x="6" y="5" width="4" height="14" rx="1" />
                                <rect x="14" y="5" width="4" height="14" rx="1" />
                            </template>
                            <path
                                v-else
                                d="M8 5.5v13a1 1 0 0 0 1.5.87l11-6.5a1 1 0 0 0 0-1.74l-11-6.5
                                   A1 1 0 0 0 8 5.5Z"
                            />
                        </svg>
                    </button>
                    <button
                        type="button"
                        class="transcript-pane-edit"
                        :title="index_editing === index ? 'Done' : 'Correct this line'"
                        @mousedown.prevent
                        @click.stop="row_edit_toggle(row, index)"
                    >
                        <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="3"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            aria-hidden="true"
                        >
                            <path d="M4 20h4l11-11-4-4L4 16v4Z" />
                        </svg>
                    </button>
                </div>
                <div class="transcript-pane-row-body">
                    <div class="transcript-pane-row-meta">
                        <span class="transcript-pane-row-time">
                            {{ row_label(row) }}
                        </span>
                        <span v-if="index_copied === index" class="pill-active">Copied</span>
                    </div>
                    <textarea
                        v-if="index_editing === index"
                        :ref="row_edit_focus"
                        v-model="text_editing"
                        class="transcript-pane-row-text transcript-pane-row-edit"
                        rows="1"
                        aria-label="Transcript line"
                        @click.stop
                        @keydown.enter.prevent="row_edit_commit(row, index)"
                        @keydown.esc="row_edit_cancel"
                        @blur="row_edit_commit(row, index)"
                    />
                    <div v-else class="transcript-pane-row-text">{{ row.text }}</div>
                </div>
            </li>
            <li v-if="rows_filtered.length === 0" class="meta px-3 py-2">
                No segments match.
            </li>
        </ul>
        <p class="transcript-pane-footer">
            Click a line to copy it. Use the pencil to correct it.
        </p>
    </div>
</template>
