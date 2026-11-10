<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { convertFileSrc } from '@tauri-apps/api/core'
import { use_pipeline } from '../composables/use_pipeline'
import { use_shortcuts } from '../composables/use_shortcuts'
import { seconds_to_clock } from '../lib/duration'
import { error_dialog_show } from '../lib/errors'
import { ipc } from '../lib/ipc'
import { log_warn } from '../lib/log'
import type { ComponentPublicInstance } from 'vue'
import type { Transcript, TranscriptSegment } from '../types'


interface DisplayRow {
    text: string
    start_seconds: number
    end_seconds: number
    segment_index: number
}

const props = defineProps<{
    transcript: Transcript | null
    segment_indexes_highlighted?: number[]
}>()

const ROWS_RENDER_STEP = 60
const ROWS_RENDER_THRESHOLD_PX = 200
const COPIED_FLASH_MS = 1500
const HIGHLIGHT_NAME = 'transcript-filter'
const REGEX_ESCAPE = /[.*+?^${}()|[\]\\]/g
const { job_id_current, transcript_segments_text_set } = use_pipeline()

const filter_text = ref('')
const index_copied = ref<number | null>(null)
const index_editing = ref<number | null>(null)
const text_editing = ref('')
const list_ref = ref<HTMLElement | null>(null)
const audio_ref = ref<HTMLAudioElement | null>(null)
const audio_path = ref<string | null>(null)
const audio_src = ref<string | null>(null)
const audio_checked = ref(false)
const playback_index = ref<number | null>(null)
const rows_render_limit = ref(ROWS_RENDER_STEP)

const rows = computed<DisplayRow[]>(() => {
    if (props.transcript === null) return []

    return props.transcript.segments
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

    return new RegExp(needle.replace(REGEX_ESCAPE, '\\$&'), 'i')
})

const timing_present = computed(
    () => props.transcript?.segments.some((segment) => segment.end_seconds > 0) ?? false,
)

const rows_filtered = computed<DisplayRow[]>(() => {
    const regex = filter_regex.value

    if (regex === null) return rows.value

    return rows.value.filter((row) => regex.test(row.text))
})

const rows_rendered = computed<DisplayRow[]>(
    () => rows_filtered.value.slice(0, rows_render_limit.value),
)


watch(rows_filtered, () => {
    rows_render_limit.value = ROWS_RENDER_STEP
    index_editing.value = null
})

watch(rows_rendered, async () => {
    await nextTick()

    rows_render_grow()
})

watch([rows_rendered, filter_regex, index_editing], highlights_apply, { flush: 'post' })

async function audio_clip_attach(row: DisplayRow): Promise<HTMLAudioElement | null> {
    const id = job_id_current.value

    if (id === null) return null
    if (row.end_seconds <= row.start_seconds) return null

    audio_src_release()

    const path = await ipc.job_audio_clip_get(id, row.start_seconds, row.end_seconds)

    if (path === null) return null

    const response = await fetch(convertFileSrc(path))

    if (!response.ok) throw new Error(`clip fetch: ${String(response.status)}`)

    audio_src.value = URL.createObjectURL(await response.blob())

    await nextTick()

    return audio_ref.value
}

function audio_error_handler(): void {
    playback_clear()
    audio_src_release()
}

async function audio_path_load(): Promise<void> {
    audio_src_release()

    audio_path.value = null

    const id = job_id_current.value

    if (id === null) {
        audio_checked.value = true

        return
    }

    try {
        audio_path.value = await ipc.job_audio_path_get(id)
    } catch (error) {
        audio_path.value = null

        log_warn('[transcript] audio path unavailable', id, error)
    } finally {
        audio_checked.value = true
    }
}

function audio_pause_handler(): void {
    if (audio_ref.value?.paused === true) playback_clear()
}

function audio_pause_if_playing(): void {
    if (audio_ref.value !== null && !audio_ref.value.paused) audio_ref.value.pause()
}

function audio_src_release(): void {
    if (audio_src.value !== null) URL.revokeObjectURL(audio_src.value)

    audio_src.value = null
}

function highlights_apply(): void {
    const registry = highlights_registry()
    const regex = filter_regex.value
    const container = list_ref.value

    if (registry === null) return

    if (regex === null || container === null) {
        registry.delete(HIGHLIGHT_NAME)

        return
    }

    const matcher = new RegExp(regex.source, 'gi')
    const ranges: Range[] = []

    for (const element of container.querySelectorAll('.transcript-pane-row-text')) {
        const node = element.firstChild

        if (!(node instanceof Text)) continue

        for (const match of node.data.matchAll(matcher)) {
            const range = new Range()

            range.setStart(node, match.index)
            range.setEnd(node, match.index + match[0].length)
            ranges.push(range)
        }
    }

    registry.set(HIGHLIGHT_NAME, new Highlight(...ranges))
}

function highlights_registry(): HighlightRegistry | null {
    if (typeof CSS === 'undefined') return null

    const css: { highlights?: HighlightRegistry } = CSS

    return css.highlights ?? null
}

function playback_clear(): void {
    playback_index.value = null
}

function playback_mark(index: number): void {
    playback_index.value = index
}

function playback_space_toggle(): void {
    const audio = audio_ref.value

    if (audio === null) return

    if (audio.paused) {
        void audio.play().catch((error: unknown) => {
            log_warn('[transcript] playback refused', error)
        })

        return
    }

    audio.pause()
}

async function row_copy(row: DisplayRow, index: number): Promise<void> {
    try {
        await navigator.clipboard.writeText(row.text)
        index_copied.value = index

        setTimeout(() => {
            if (index_copied.value === index) index_copied.value = null
        }, COPIED_FLASH_MS)
    } catch (error) {
        index_copied.value = null

        log_warn('[transcript] clipboard write failed', error)
    }
}

function row_edit_cancel(): void {
    index_editing.value = null
}

async function row_edit_commit(row: DisplayRow, index: number): Promise<void> {
    if (index_editing.value !== index) return

    const text = text_editing.value.trim()

    index_editing.value = null

    if (text.length === 0) return
    if (text === row.text) return

    try {
        await transcript_segments_text_set([{ index: row.segment_index, text }])
    } catch (error) {
        await error_dialog_show(error)
    }
}

function row_edit_focus(element: Element | ComponentPublicInstance | null): void {
    if (element instanceof HTMLTextAreaElement) element.focus()
}

function row_edit_toggle(row: DisplayRow, index: number, event: Event): void {
    event.stopPropagation()

    if (index_editing.value === index) {
        void row_edit_commit(row, index)

        return
    }

    index_editing.value = index
    text_editing.value = row.text
}

function row_highlighted(row: DisplayRow): boolean {
    return props.segment_indexes_highlighted?.includes(row.segment_index) ?? false
}

function row_label(row: DisplayRow): string {
    if (timing_present.value) return seconds_to_clock(row.start_seconds)

    return `Line ${String(row.segment_index + 1)}`
}

async function row_play_toggle(row: DisplayRow, index: number, event: Event): Promise<void> {
    event.stopPropagation()

    if (playback_index.value === index) {
        audio_pause_if_playing()
        playback_clear()

        return
    }

    audio_pause_if_playing()

    try {
        const audio = await audio_clip_attach(row)

        if (audio === null) return

        playback_mark(index)

        await audio.play()
    } catch (error) {
        playback_clear()

        log_warn('[transcript] playback refused', error)
    }
}

function rows_render_grow(): void {
    const container = list_ref.value

    if (container === null) return
    if (rows_render_limit.value >= rows_filtered.value.length) return

    const distance_to_end = container.scrollHeight - container.scrollTop - container.clientHeight

    if (distance_to_end > ROWS_RENDER_THRESHOLD_PX) return

    rows_render_limit.value += ROWS_RENDER_STEP
}

use_shortcuts({ space: playback_space_toggle })

onMounted(() => {
    void audio_path_load()
})

watch(() => job_id_current.value, () => {
    audio_pause_if_playing()
    playback_clear()

    void audio_path_load()
})

onUnmounted(() => {
    audio_pause_if_playing()
    audio_src_release()
    highlights_registry()?.delete(HIGHLIGHT_NAME)
})
</script>

<template>
    <div class="transcript-pane card">
        <audio
            v-if="audio_src"
            ref="audio_ref"
            :src="audio_src"
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
            ref="list_ref"
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
            >
                <div class="transcript-pane-actions">
                    <button
                        v-if="audio_path && timing_present"
                        type="button"
                        class="transcript-pane-play"
                        :title="playback_index === index ? 'Pause' : 'Play segment'"
                        @click="row_play_toggle(row, index, $event)"
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
                        @click="row_edit_toggle(row, index, $event)"
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
