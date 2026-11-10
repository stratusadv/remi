<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { listen } from '@tauri-apps/api/event'
import { open as dialog_open } from '@tauri-apps/plugin-dialog'
import { use_endpoints } from '../composables/use_endpoints'
import { use_network } from '../composables/use_network'
import { use_pipeline } from '../composables/use_pipeline'
import { use_recorder } from '../composables/use_recorder'
import { use_service } from '../composables/use_service'
import { use_shortcuts } from '../composables/use_shortcuts'
import { is_cancelled_error, use_tasks } from '../composables/use_tasks'
import { seconds_to_clock_hours } from '../lib/duration'
import { error_dialog_show } from '../lib/errors'
import { ipc } from '../lib/ipc'
import { AUDIO_EXTENSIONS, MEDIA_EXTENSIONS, VIDEO_EXTENSIONS } from '../lib/media'
import { folder_start, path_file_name, path_file_name_short } from '../lib/paths'
import NoticeBanner from './notice_banner.vue'
import StepBar from './step_bar.vue'
import TranscriptPane from './transcript_pane.vue'
import type { UnlistenFn } from '@tauri-apps/api/event'
import type { LineCorrection, SegmentChunk, StageChunk, TranscriptionStage } from '../types'


interface TypewriterPace {
    backlog_min: number
    reveal_size: number
    delay_ms: number
}

const EVENT_TRANSCRIPTION_SEGMENT = 'transcription_segment'
const EVENT_TRANSCRIPTION_STAGE = 'transcription_stage'
const COPIED_FLASH_MS = 1500
const MESSAGE_NO_ENDPOINT = 'No remote endpoint is selected.'
const MESSAGE_NO_NOTES_KEY = 'Add your notes API key under Settings first.'

const TYPEWRITER_PACES: TypewriterPace[] = [
    { backlog_min: 1000, reveal_size: 24, delay_ms: 6 },
    { backlog_min: 400, reveal_size: 12, delay_ms: 10 },
    { backlog_min: 120, reveal_size: 6, delay_ms: 14 },
    { backlog_min: 0, reveal_size: 3, delay_ms: 14 },
]

const FILE_FILTERS = [
    { name: 'Audio or video', extensions: [...MEDIA_EXTENSIONS] },
    { name: 'Audio only', extensions: [...AUDIO_EXTENSIONS] },
    { name: 'Video only', extensions: [...VIDEO_EXTENSIONS] },
    { name: 'All files', extensions: ['*'] },
]

const {
    source_path,
    transcript,
    job_id_current,
    view_set,
    pipeline_reset,
    meta_refresh,
    transcript_segments_text_set,
} = use_pipeline()

const {
    recording,
    elapsed_seconds: recording_elapsed_seconds,
    start: recording_start,
    stop: recording_stop,
    discard: recording_discard,
} = use_recorder()

const { endpoints_by_purpose } = use_endpoints()
const { notes_ready, transcription_ready } = use_service()
const { online } = use_network()
const { task_run } = use_tasks()
const endpoint_id_selected = ref<string | null>(null)
const busy = ref(false)
const error_message = ref<string | null>(null)
const ready_banner_dismissed = ref(false)
const stream_id_active = ref<string | null>(null)
const stage_active = ref<TranscriptionStage | null>(null)
const streaming_box = ref<HTMLElement | null>(null)
const display_text = ref<string>('')
const segments_received = ref(0)
const transcript_copied = ref(false)
const transcript_cached = ref(false)
const correction_instruction = ref('')
const correction_busy = ref(false)
const correction_indexes = ref<number[]>([])
const correction_undo = ref<LineCorrection[] | null>(null)
let transcript_copied_timer: ReturnType<typeof setTimeout> | null = null
let buffer_pending = ''
let typewriter_handle: number | null = null
let segment_unlisten: UnlistenFn | null = null
let stage_unlisten: UnlistenFn | null = null
const endpoints_transcription = computed(() => endpoints_by_purpose('transcription'))
const endpoint_id_notes = computed(() => endpoints_by_purpose('notes')[0]?.id ?? null)

const can_correct = computed(() => {
    if (transcript.value === null || correction_busy.value || busy.value) return false
    if (!online.value || !notes_ready.value) return false

    return correction_instruction.value.trim().length > 0
})

const source_name = computed(() =>
    (source_path.value !== null ? path_file_name(source_path.value) : ''))

const source_extension = computed(() => source_name.value.split('.').pop()?.toLowerCase() ?? '')
const source_is_video = computed(() => VIDEO_EXTENSIONS.includes(source_extension.value))

const can_transcribe = computed(() => {
    if (source_path.value === null || busy.value || recording.value) return false
    if (!online.value) return false
    if (!transcription_ready.value) return false

    return endpoint_id_selected.value !== null
})

const transcribe_label = computed(() => {
    if (!busy.value) return 'Transcribe'

    switch (stage_active.value) {
        case 'transcribing': return 'Transcribing…'
        case 'done': return 'Finalizing…'
        case 'preparing_audio':
        case null:
        default: return 'Preparing audio…'
    }
})

const streaming_status = computed(() =>
    stage_active.value === 'preparing_audio' ? 'Preparing audio…' : 'Receiving transcript')

const segments_received_text = computed(() => {
    const count = segments_received.value

    return `(${String(count)} segment${count === 1 ? '' : 's'} received)`
})


watch(
    () => endpoints_transcription.value,
    () => {
        if (endpoint_id_selected.value !== null) return

        const first = endpoints_transcription.value[0]?.id

        if (first !== undefined) endpoint_id_selected.value = first
    },
    { immediate: true },
)

async function cancel(): Promise<void> {
    if (recording.value) {
        try {
            await recording_discard()
        } catch (error) {
            await error_dialog_show(error)
        }
    }

    pipeline_reset()
    view_set('jobs')
}

function continue_to_details(): void {
    view_set('details')
}

async function correct(): Promise<void> {
    const current = transcript.value
    const instruction = correction_instruction.value.trim()

    if (current === null) return
    if (!can_correct.value) return

    const endpoint_id = endpoint_id_notes.value

    if (endpoint_id === null) {
        error_message.value = MESSAGE_NO_NOTES_KEY

        return
    }

    correction_busy.value = true
    correction_indexes.value = []
    error_message.value = null

    try {
        const lines = current.segments.map((segment) => segment.text)

        const corrections = await ipc.transcript_correct_streaming(
            crypto.randomUUID(),
            endpoint_id,
            lines,
            instruction,
        )

        const originals = corrections.flatMap((correction) => {
            const text = lines[correction.index]

            return text === undefined ? [] : [{ index: correction.index, text }]
        })

        await transcript_segments_text_set(corrections)

        correction_indexes.value = corrections.map((correction) => correction.index)
        correction_undo.value = originals.length > 0 ? originals : null
    } catch (error) {
        if (!is_cancelled_error(error)) {
            error_message.value = String(error)
            await error_dialog_show(error)
        }
    } finally {
        correction_busy.value = false
    }
}

async function correction_undo_apply(): Promise<void> {
    const originals = correction_undo.value

    if (originals === null || correction_busy.value) return

    correction_busy.value = true
    correction_undo.value = null
    correction_indexes.value = []

    await correction_undo_persist(originals).finally(() => {
        correction_busy.value = false
    })
}

onMounted(async () => {
    segment_unlisten = await listen<SegmentChunk>(EVENT_TRANSCRIPTION_SEGMENT, (event) => {
        if (event.payload.stream_id !== stream_id_active.value) return

        segment_append(event.payload)
    })

    stage_unlisten = await listen<StageChunk>(EVENT_TRANSCRIPTION_STAGE, (event) => {
        if (event.payload.stream_id !== stream_id_active.value) return

        stage_active.value = event.payload.stage
    })
})

onUnmounted(() => {
    if (segment_unlisten !== null) segment_unlisten()
    if (stage_unlisten !== null) stage_unlisten()
    if (transcript_copied_timer !== null) clearTimeout(transcript_copied_timer)
})

async function correction_undo_persist(originals: LineCorrection[]): Promise<void> {
    try {
        await transcript_segments_text_set(originals)
    } catch (error) {
        error_message.value = String(error)

        await error_dialog_show(error)
    }
}

async function file_pick(): Promise<void> {
    if (recording.value) return

    error_message.value = null

    try {
        const selected = await dialog_open({
            defaultPath: await folder_start(),
            filters: FILE_FILTERS,
            multiple: false,
        })

        if (typeof selected === 'string') {
            source_path.value = selected
            transcript.value = null
            job_id_current.value = null
        }
    } catch (error) {
        error_message.value = String(error)
    }
}

function paste_instead(): void {
    pipeline_reset()
    view_set('import')
}

async function record_click(): Promise<void> {
    error_message.value = null

    try {
        await recording_start()
    } catch (error) {
        await error_dialog_show(error)
    }
}

async function record_discard_click(): Promise<void> {
    try {
        await recording_discard()
    } catch (error) {
        await error_dialog_show(error)
    }
}

async function record_stop_click(): Promise<void> {
    error_message.value = null

    try {
        const path_saved = await recording_stop()

        source_path.value = path_saved
        transcript.value = null
        job_id_current.value = null
    } catch (error) {
        await error_dialog_show(error)
    }
}

function segment_append(chunk: SegmentChunk): void {
    segments_received.value += 1

    typewriter_push(chunk.text.trim())
}

function streaming_box_scroll_to_end(): void {
    const element = streaming_box.value

    void nextTick(() => {
        requestAnimationFrame(() => {
            if (element !== null) element.scrollTop = element.scrollHeight
        })
    })
}

async function transcribe(transcript_reuse = true): Promise<void> {
    const source_for_task = source_path.value
    const endpoint_for_task = endpoint_id_selected.value

    if (source_for_task === null) return

    const stream_id = crypto.randomUUID()

    busy.value = true
    error_message.value = null
    stream_id_active.value = stream_id
    stage_active.value = null
    segments_received.value = 0
    transcript.value = null
    transcript_cached.value = false
    correction_indexes.value = []
    correction_undo.value = null

    typewriter_reset()

    try {
        await task_run({
            kind: 'transcribe',
            label: path_file_name_short(source_for_task),
            stream_id,
            runner: async () => {
                if (endpoint_for_task === null) throw new Error(MESSAGE_NO_ENDPOINT)

                return await ipc.transcription_remote(
                    source_for_task,
                    endpoint_for_task,
                    stream_id,
                    transcript_reuse,
                )
            },
            job_id_of: (result) => result.job_id,
            on_success: (result) => {
                transcript.value = result.transcript
                transcript_cached.value = result.cached
                job_id_current.value = result.job_id

                void meta_refresh()
            },
        })
    } catch (error) {
        if (!is_cancelled_error(error)) {
            error_message.value = String(error)

            await error_dialog_show(error)
        }
    } finally {
        typewriter_flush()
        busy.value = false
        stream_id_active.value = null
        stage_active.value = null
    }
}

async function transcript_copy(): Promise<void> {
    if (transcript.value === null) return

    try {
        await navigator.clipboard.writeText(transcript.value.text)
    } catch (error) {
        await error_dialog_show(error)

        return
    }

    transcript_copied.value = true

    if (transcript_copied_timer !== null) clearTimeout(transcript_copied_timer)

    transcript_copied_timer = setTimeout(() => {
        transcript_copied.value = false
        transcript_copied_timer = null
    }, COPIED_FLASH_MS)
}

function typewriter_flush(): void {
    typewriter_stop()

    if (buffer_pending.length > 0) {
        display_text.value += buffer_pending
        buffer_pending = ''
    }

    streaming_box_scroll_to_end()
}

function typewriter_pace_for(backlog: number): TypewriterPace {
    const pace = TYPEWRITER_PACES.find((candidate) => backlog >= candidate.backlog_min)

    return pace ?? { backlog_min: 0, reveal_size: 3, delay_ms: 14 }
}

function typewriter_pump(): void {
    if (buffer_pending.length === 0) {
        typewriter_handle = null

        return
    }

    const pace = typewriter_pace_for(buffer_pending.length)

    display_text.value += buffer_pending.slice(0, pace.reveal_size)
    buffer_pending = buffer_pending.slice(pace.reveal_size)

    streaming_box_scroll_to_end()
    typewriter_handle = window.setTimeout(typewriter_pump, pace.delay_ms)
}

function typewriter_push(text: string): void {
    if (text.length === 0) return

    const joiner = display_text.value.length > 0 || buffer_pending.length > 0 ? ' ' : ''

    buffer_pending += joiner + text

    typewriter_handle ??= window.setTimeout(typewriter_pump, 0)
}

function typewriter_reset(): void {
    typewriter_stop()

    buffer_pending = ''
    display_text.value = ''
}

function typewriter_stop(): void {
    if (typewriter_handle === null) return

    window.clearTimeout(typewriter_handle)
    typewriter_handle = null
}

use_shortcuts({
    'ctrl+o': () => { void file_pick() },
    'ctrl+enter': () => { if (can_transcribe.value) void transcribe() },
})
</script>

<template>
    <section class="view-fill step-view">
        <StepBar />

        <NoticeBanner
            v-if="!transcription_ready && !ready_banner_dismissed"
            @dismiss="ready_banner_dismissed = true"
        >
            scribe needs the API address and keys set up before it can transcribe.
            <template #actions>
                <button class="btn-primary" @click="view_set('settings')">Open settings</button>
            </template>
        </NoticeBanner>

        <NoticeBanner v-if="error_message" @dismiss="error_message = null">
            {{ error_message }}
        </NoticeBanner>

        <NoticeBanner
            v-if="transcript_cached && transcript && !busy"
            kind="info"
            @dismiss="transcript_cached = false"
        >
            This recording was already transcribed, so its stored transcript is shown.
            <template #actions>
                <button class="btn-default" :disabled="!can_transcribe" @click="transcribe(false)">
                    Transcribe again
                </button>
            </template>
        </NoticeBanner>

        <div v-if="!transcript && !busy" class="file-picker">
            <div v-if="recording" class="file-picker-filled">
                <div class="file-picker-name">
                    <span class="mic-dot" aria-hidden="true" />
                    Recording {{ seconds_to_clock_hours(recording_elapsed_seconds) }}
                </div>
            </div>
            <template v-else-if="!source_path">
                <button type="button" class="file-picker-empty" @click="file_pick">
                    <svg
                        class="file-picker-icon"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                    >
                        <path d="M12 16V4" />
                        <path d="M7 9l5-5 5 5" />
                        <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
                    </svg>
                    <span class="file-picker-headline">Open or drop a recording</span>
                </button>
                <button type="button" class="file-picker-empty" @click="record_click">
                    <svg
                        class="file-picker-icon"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                    >
                        <rect x="9" y="3" width="6" height="11" rx="3" />
                        <path d="M5 11a7 7 0 0 0 14 0" />
                        <path d="M12 18v3" />
                        <path d="M9 21h6" />
                    </svg>
                    <span class="file-picker-headline">Record with the microphone</span>
                </button>
            </template>
            <div v-else class="file-picker-filled">
                <span class="empty-badge">
                    <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                    >
                        <path d="M6 3h9l5 5v13H6z" />
                        <path d="M15 3v5h5" />
                        <template v-if="source_is_video">
                            <path d="M9 12l6 3-6 3z" />
                        </template>
                        <template v-else>
                            <path d="M9 13v5" />
                            <path d="M12 11v9" />
                            <path d="M15 14v3" />
                        </template>
                    </svg>
                </span>
                <div class="file-picker-name">{{ source_name }}</div>
                <button type="button" class="btn-default file-picker-replace" @click="file_pick">
                    Replace
                </button>
            </div>
        </div>

        <div v-else-if="busy" class="streaming-shell">
            <p class="streaming-status">
                {{ streaming_status }}
                <span v-if="segments_received > 0">{{ segments_received_text }}</span>
            </p>
            <div ref="streaming_box" class="streaming-display">
                <div class="streaming-prose">
                    <span>{{ display_text }}</span><span class="streaming-caret">▌</span>
                </div>
            </div>
        </div>

        <TranscriptPane
            v-else-if="transcript"
            :transcript="transcript"
            :segment_indexes_highlighted="correction_indexes"
        />

        <form v-if="transcript && !busy" class="correction-bar" @submit.prevent="correct">
            <input
                v-model="correction_instruction"
                type="search"
                class="input"
                :disabled="correction_busy"
                placeholder="Tell the AI what to fix, e.g. 'it is Jon, not John'"
                aria-label="Correction instruction"
            >
            <button
                v-if="correction_undo"
                type="button"
                class="btn-default"
                :disabled="correction_busy"
                @click="correction_undo_apply"
            >
                Undo
            </button>
            <button type="submit" class="btn-primary" :disabled="!can_correct">
                {{ correction_busy ? 'Working…' : 'Apply' }}
            </button>
        </form>

        <footer class="step-footer">
            <div class="step-footer-start">
                <button class="btn-default" :disabled="busy || recording" @click="cancel">
                    Cancel
                </button>
            </div>
            <div v-if="recording" class="actions-row">
                <button class="btn-default" @click="record_discard_click">Discard</button>
                <button class="btn-primary" @click="record_stop_click">Stop recording</button>
            </div>
            <div v-else class="actions-row">
                <button v-if="!transcript && !busy" class="btn-default" @click="paste_instead">
                    Paste a transcript
                </button>
                <button
                    v-if="!transcript || busy"
                    class="btn-primary"
                    :disabled="!can_transcribe"
                    @click="transcribe()"
                >
                    {{ transcribe_label }}
                </button>
                <button v-if="transcript && !busy" class="btn-default" @click="transcript_copy">
                    <span
                        class="btn-label-swap"
                        :data-swapped="transcript_copied ? 'true' : 'false'"
                    >
                        <span>Copy transcript</span>
                        <span>Copied</span>
                    </span>
                </button>
                <button v-if="transcript && !busy" class="btn-primary" @click="continue_to_details">
                    Next
                </button>
            </div>
        </footer>
    </section>
</template>

<style scoped>
.streaming-shell {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    gap: 0.5rem;
}

.streaming-display {
    border: 1px solid var(--color-field-border);
    border-radius: var(--radius-md);
    padding: 1rem 1.125rem;
    background-color: var(--color-field);
    color: var(--color-content);
    flex: 1;
    min-height: 24rem;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-gutter: stable;
}

.transcript-pane {
    flex: 1;
    min-height: 0;
}

.correction-bar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
}

.correction-bar .input {
    flex: 1;
}

.correction-bar .btn-default,
.correction-bar .btn-primary {
    white-space: nowrap;
}

.streaming-prose {
    font-size: 1rem;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
}
</style>
