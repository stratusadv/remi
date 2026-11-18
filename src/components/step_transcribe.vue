<script setup lang="ts">
import {
    computed,
    nextTick,
    onMounted,
    onUnmounted,
    ref,
    shallowRef,
    useTemplateRef,
    watch,
} from 'vue'
import { listen } from '@tauri-apps/api/event'
import { open as dialog_open } from '@tauri-apps/plugin-dialog'
import { MESSAGE_ENDPOINT_MISSING, use_endpoints } from '../composables/use_endpoints'
import { use_network } from '../composables/use_network'
import { use_pipeline } from '../composables/use_pipeline'
import { use_recorder } from '../composables/use_recorder'
import { use_shortcuts } from '../composables/use_shortcuts'
import { is_cancelled_error, use_tasks } from '../composables/use_tasks'
import { action_report } from '../lib/actions'
import { assert } from '../lib/assert'
import { seconds_to_clock_hours } from '../lib/duration'
import { error_dialog_show, error_shown } from '../lib/errors'
import { ipc } from '../lib/ipc'
import { AUDIO_EXTENSIONS, MEDIA_EXTENSIONS, VIDEO_EXTENSIONS } from '../lib/media'
import { folder_start, path_file_name, path_file_name_short } from '../lib/paths'
import { SURROGATE_HIGH_TRAILING } from '../lib/text'
import NoticeBanner from './notice_banner.vue'
import RecordingTrace from './recording_trace.vue'
import StepBar from './step_bar.vue'
import StepCitation from './step_citation.vue'
import TranscriptPane from './transcript_pane.vue'
import type { DialogFilter } from '@tauri-apps/plugin-dialog'
import type {
    JobID,
    LineCorrection,
    SegmentChunk,
    StageChunk,
    TranscriptionResult,
    TranscriptionStage,
} from '../types'


interface CorrectionReply {
    job_id: JobID
    corrections: LineCorrection[]
    lines: string[]
}

interface JobBinding {
    readonly job_id: JobID | null
    readonly source_path: string | null
}

interface TypewriterPace {
    backlog_min: number
    reveal_size: number
    delay_ms: number
}

const EVENT_TRANSCRIPTION_SEGMENT = 'transcription_segment'
const EVENT_TRANSCRIPTION_STAGE = 'transcription_stage'
const COPIED_FLASH_MS = 1500
const KEY_DEFAULT_PATH = 'defaultPath'

const TYPEWRITER_PACES = Object.freeze<TypewriterPace[]>([
    { backlog_min: 1000, reveal_size: 24, delay_ms: 6 },
    { backlog_min: 400, reveal_size: 12, delay_ms: 10 },
    { backlog_min: 120, reveal_size: 6, delay_ms: 14 },
    { backlog_min: 0, reveal_size: 3, delay_ms: 14 },
])

const FILE_FILTERS = Object.freeze<DialogFilter[]>([
    { name: 'Audio or video', extensions: [...MEDIA_EXTENSIONS] },
    { name: 'Audio only', extensions: [...AUDIO_EXTENSIONS] },
    { name: 'Video only', extensions: [...VIDEO_EXTENSIONS] },
    { name: 'All files', extensions: ['*'] },
])

const {
    source_path,
    transcript,
    job_id_current,
    view_current,
    view_set,
    pipeline_reset,
    meta_refresh,
    notes_refresh,
    source_replace,
    transcript_segments_text_set,
    transcript_stored_segments_text_set,
} = use_pipeline()

const {
    recording,
    starting: recording_starting,
    stopping: recording_stopping,
    elapsed_seconds: recording_elapsed_seconds,
    start: recording_start,
    stop: recording_stop,
    discard: recording_discard,
} = use_recorder()

const { endpoints_by_purpose } = use_endpoints()
const { online } = use_network()
const { task_run } = use_tasks()
const endpoint_id_selected = ref<string | null>(null)
const busy = ref(false)
const error_message = ref<string | null>(null)
const stream_id_active = ref<string | null>(null)
const stage_active = ref<TranscriptionStage | null>(null)
const streaming_box = useTemplateRef<HTMLElement>('streaming_box')
const display_text = ref<string>('')
const segments_received = ref(0)
const transcript_copied = ref(false)
const transcript_cached = ref(false)
const correction_instruction = ref('')
const correction_busy = ref(false)
const correction_indexes = ref<number[]>([])
const correction_undo = ref<LineCorrection[] | null>(null)
const transcript_copied_timer = shallowRef<ReturnType<typeof setTimeout> | null>(null)
const buffer_pending = shallowRef('')
const typewriter_handle = shallowRef<number | null>(null)
const endpoints_transcription = computed(() => endpoints_by_purpose('transcription'))
const endpoint_id_notes = computed(() => endpoints_by_purpose('notes')[0]?.id ?? null)
const recorder_active = computed(() => recording.value || recording_starting.value)
const recorder_transitioning = computed(() => recording_starting.value || recording_stopping.value)

const can_correct = computed(() => {
    if (transcript.value === null) return false
    if (correction_busy.value) return false
    if (busy.value) return false
    if (!online.value) return false

    return correction_instruction.value.trim().length > 0
})

const source_name = computed(() =>
    (source_path.value === null ? '' : path_file_name(source_path.value)))

const source_extension = computed(() => source_name.value.split('.').pop()?.toLowerCase() ?? '')
const source_is_video = computed(() => VIDEO_EXTENSIONS.includes(source_extension.value))

const can_transcribe = computed(() => {
    if (source_path.value === null) return false
    if (busy.value) return false
    if (correction_busy.value) return false
    if (recorder_active.value) return false
    if (!online.value) return false

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

    assert(view_current.value === 'jobs')
    assert(job_id_current.value === null)
}

function continue_to_details(): void {
    assert(transcript.value !== null)
    assert(!busy.value)

    view_set('details')

    assert(view_current.value === 'details')
}

async function correct(): Promise<void> {
    assert(!busy.value)

    const current = transcript.value

    if (current === null) return
    if (!can_correct.value) return

    const endpoint_id = endpoint_id_notes.value

    if (endpoint_id === null) {
        error_message.value = MESSAGE_ENDPOINT_MISSING

        return
    }

    const job_id = job_id_current.value

    assert(job_id !== null)

    correction_busy.value = true
    correction_indexes.value = []
    error_message.value = null

    const lines = current.segments.map((segment) => segment.text)
    const instruction = correction_instruction.value.trim()

    assert(instruction.length > 0)

    return ipc.transcript_correct_streaming(crypto.randomUUID(), endpoint_id, lines, instruction)
        .then(async (corrections) => {
            assert(corrections.every((correction) => Number.isInteger(correction.index)))
            assert(correction_busy.value)

            return corrections_apply({ job_id, corrections, lines })
        })
        .catch(async (error: unknown) => {
            if (is_cancelled_error(error)) return

            error_message.value = error_shown(error)

            return error_dialog_show(error)
        })
        .finally(() => {
            correction_busy.value = false
        })
}

async function correction_undo_apply(): Promise<void> {
    assert(transcript.value !== null)
    assert(!busy.value)

    const originals = correction_undo.value

    if (originals === null) return
    if (correction_busy.value) return

    correction_busy.value = true
    correction_undo.value = null
    correction_indexes.value = []

    return correction_undo_persist(originals).finally(() => {
        correction_busy.value = false
    })
}

const segment_listening = listen<SegmentChunk>(EVENT_TRANSCRIPTION_SEGMENT, (event) => {
    assert(event.event === EVENT_TRANSCRIPTION_SEGMENT)
    assert(event.payload.stream_id.length > 0)

    if (event.payload.stream_id !== stream_id_active.value) return

    segment_append(event.payload)
})

const stage_listening = listen<StageChunk>(EVENT_TRANSCRIPTION_STAGE, (event) => {
    assert(event.event === EVENT_TRANSCRIPTION_STAGE)
    assert(event.payload.stream_id.length > 0)

    if (event.payload.stream_id !== stream_id_active.value) return

    stage_active.value = event.payload.stage
})

onMounted(async () => {
    await Promise.all([segment_listening, stage_listening])
})

onUnmounted(() => {
    void Promise.allSettled([segment_listening, stage_listening]).then((listenings) => {
        for (const listening of listenings) {
            if (listening.status === 'fulfilled') listening.value()
        }
    })

    if (transcript_copied_timer.value !== null) clearTimeout(transcript_copied_timer.value)

    typewriter_stop()
})

async function correction_undo_persist(originals: LineCorrection[]): Promise<void> {
    assert(originals.length > 0)
    assert(correction_busy.value)

    return transcript_segments_text_set(originals).catch(async (error: unknown) => {
        error_message.value = error_shown(error)

        return error_dialog_show(error)
    })
}

async function corrections_apply(reply: CorrectionReply): Promise<void> {
    assert(reply.job_id.length > 0)
    assert(correction_busy.value)

    const { job_id, corrections, lines } = reply

    if (job_id_current.value !== job_id) {
        return transcript_stored_segments_text_set(job_id, corrections)
    }

    const originals = corrections.flatMap((correction) => {
        const text = lines[correction.index]

        return text === undefined ? [] : [{ index: correction.index, text }]
    })

    return transcript_segments_text_set(corrections).then(() => {
        if (job_id_current.value !== job_id) return

        correction_indexes.value = corrections.map((correction) => correction.index)
        correction_undo.value = originals.length > 0 ? originals : null
    })
}

async function file_pick(): Promise<void> {
    if (recorder_active.value) return

    error_message.value = null

    return folder_start()
        .then(async (folder) => dialog_open({
            [KEY_DEFAULT_PATH]: folder,
            filters: [...FILE_FILTERS],
            multiple: false,
        }))
        .then((selected) => {
            if (typeof selected !== 'string') return

            assert(selected.length > 0)

            source_replace(selected)
            action_report('upload-recording')
        })
        .catch((error: unknown) => {
            error_message.value = error_shown(error)
        })
}

function file_pick_shortcut(event: KeyboardEvent): void {
    assert(event.type === 'keydown')
    assert(view_current.value === 'transcribe')

    void file_pick()
}

function job_binding_holds(binding: JobBinding): boolean {
    assert(binding.job_id === null || binding.job_id.length > 0)
    assert(job_id_current.value === null || job_id_current.value.length > 0)

    return job_id_current.value === binding.job_id && source_path.value === binding.source_path
}

function paste_instead(): void {
    assert(!busy.value)
    assert(!recording.value)
    assert(!recording_starting.value)

    pipeline_reset()
    view_set('import')

    assert(view_current.value === 'import')
}

async function record_click(): Promise<void> {
    assert(!recording.value)
    assert(!recording_starting.value)
    assert(source_path.value === null)

    error_message.value = null

    return recording_start().catch(error_dialog_show)
}

async function record_discard_click(): Promise<void> {
    assert(recording.value)
    assert(!recording_starting.value)
    assert(!recording_stopping.value)

    return recording_discard().catch(error_dialog_show)
}

async function record_stop_click(): Promise<void> {
    assert(recording.value)
    assert(!recording_starting.value)
    assert(!recording_stopping.value)

    const binding: JobBinding = { job_id: job_id_current.value, source_path: source_path.value }

    error_message.value = null

    return recording_stop()
        .then((path_saved) => {
            if (job_binding_holds(binding)) source_replace(path_saved)
        })
        .catch(error_dialog_show)
}

function segment_append(chunk: SegmentChunk): void {
    assert(chunk.stream_id === stream_id_active.value)
    assert(busy.value)

    segments_received.value += 1

    typewriter_push(chunk.text.trim())
}

function streaming_box_scroll_to_end(): void {
    assert(busy.value)
    assert(stream_id_active.value !== null)

    const element = streaming_box.value

    void nextTick(() => {
        requestAnimationFrame(() => {
            if (element !== null) element.scrollTop = element.scrollHeight
        })
    })
}

async function transcribe(transcript_reuse: boolean): Promise<void> {
    assert(!busy.value)
    assert(!recording.value)
    assert(!recording_starting.value)
    assert(!correction_busy.value)

    const source_for_task = source_path.value

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

    const endpoint_for_task = endpoint_id_selected.value
    const binding: JobBinding = { job_id: job_id_current.value, source_path: source_for_task }

    const finished = task_run({
        kind: 'transcribe',
        label: path_file_name_short(source_for_task),
        stream_id,
        async runner() {
            assert(stream_id_active.value === stream_id)
            assert(busy.value)

            if (endpoint_for_task === null) throw new Error(MESSAGE_ENDPOINT_MISSING)

            return ipc.transcription_remote(
                source_for_task,
                endpoint_for_task,
                stream_id,
                transcript_reuse,
            )
        },
        job_id_of(result) {
            assert(result.job_id.length > 0)
            assert(typeof result.cached === 'boolean')

            return result.job_id
        },
    })

    return finished
        .then((result) => {
            transcribe_success(binding, result)
        })
        .catch(async (error: unknown) => {
            if (is_cancelled_error(error)) return

            error_message.value = error_shown(error)

            return error_dialog_show(error)
        })
        .finally(() => {
            typewriter_flush()
            busy.value = false
            stream_id_active.value = null
            stage_active.value = null
        })
}

function transcribe_shortcut(event: KeyboardEvent): void {
    assert(event.type === 'keydown')
    assert(view_current.value === 'transcribe')

    if (can_transcribe.value) void transcribe(true)
}

function transcribe_success(binding: JobBinding, result: TranscriptionResult): void {
    assert(binding.source_path !== null)
    assert(result.job_id.length > 0)
    assert(busy.value)

    if (!job_binding_holds(binding)) return

    transcript.value = result.transcript
    transcript_cached.value = result.cached
    job_id_current.value = result.job_id

    void meta_refresh()

    if (binding.job_id !== result.job_id) void notes_refresh()
}

function transcript_copied_clear(): void {
    assert(transcript_copied.value)
    assert(transcript_copied_timer.value !== null)

    transcript_copied.value = false
    transcript_copied_timer.value = null
}

async function transcript_copy(): Promise<void> {
    if (transcript.value === null) return

    try {
        await navigator.clipboard.writeText(transcript.value.text)
    } catch (error) {
        await error_dialog_show(error)

        return
    }

    assert(transcript_copied_timer.value === null || transcript_copied.value)

    transcript_copied.value = true

    if (transcript_copied_timer.value !== null) clearTimeout(transcript_copied_timer.value)

    transcript_copied_timer.value = setTimeout(transcript_copied_clear, COPIED_FLASH_MS)
}

function typewriter_flush(): void {
    assert(busy.value)
    assert(stream_id_active.value !== null)

    typewriter_stop()

    if (buffer_pending.value.length > 0) {
        display_text.value += buffer_pending.value
        buffer_pending.value = ''
    }

    streaming_box_scroll_to_end()
}

function typewriter_pace_for(backlog: number): TypewriterPace {
    assert(Number.isInteger(backlog))
    assert(backlog > 0)

    const pace = TYPEWRITER_PACES.find((candidate) => backlog >= candidate.backlog_min)

    return pace ?? { backlog_min: 0, reveal_size: 3, delay_ms: 14 }
}

function typewriter_pump(): void {
    assert(typewriter_handle.value !== null)
    assert(busy.value)

    if (buffer_pending.value.length === 0) {
        typewriter_handle.value = null

        return
    }

    const pace = typewriter_pace_for(buffer_pending.value.length)

    assert(pace.reveal_size > 0)

    const reveal_size = typewriter_reveal_size(pace.reveal_size)

    display_text.value += buffer_pending.value.slice(0, reveal_size)
    buffer_pending.value = buffer_pending.value.slice(reveal_size)

    streaming_box_scroll_to_end()
    typewriter_handle.value = window.setTimeout(typewriter_pump, pace.delay_ms)
}

function typewriter_push(text: string): void {
    assert(text === text.trim())
    assert(busy.value)

    if (text.length === 0) return

    const joiner = display_text.value.length > 0 || buffer_pending.value.length > 0 ? ' ' : ''

    buffer_pending.value += joiner + text

    typewriter_handle.value ??= window.setTimeout(typewriter_pump, 0)
}

function typewriter_reset(): void {
    assert(busy.value)
    assert(stream_id_active.value !== null)

    typewriter_stop()

    buffer_pending.value = ''
    display_text.value = ''
}

function typewriter_reveal_size(reveal_size_paced: number): number {
    assert(Number.isInteger(reveal_size_paced))
    assert(reveal_size_paced > 0)

    const head = buffer_pending.value.slice(0, reveal_size_paced)

    return SURROGATE_HIGH_TRAILING.test(head) ? reveal_size_paced + 1 : reveal_size_paced
}

function typewriter_stop(): void {
    if (typewriter_handle.value === null) return

    window.clearTimeout(typewriter_handle.value)
    typewriter_handle.value = null
}

use_shortcuts({
    'ctrl+o': file_pick_shortcut,
    'ctrl+enter': transcribe_shortcut,
})
</script>

<template>
    <section class="view-fill step-view">
        <StepBar />
        <StepCitation />

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
                <button
                    type="button"
                    class="btn-default"
                    :disabled="!can_transcribe"
                    @click="transcribe(false)"
                >
                    Transcribe again
                </button>
            </template>
        </NoticeBanner>

        <div v-if="!transcript && !busy" class="file-picker">
            <div v-if="recording" class="file-picker-filled">
                <RecordingTrace />
                <div class="file-picker-name">
                    <span class="mic-dot" aria-hidden="true" />
                    Recording {{ seconds_to_clock_hours(recording_elapsed_seconds) }}
                </div>
            </div>
            <div v-else-if="recording_starting" class="file-picker-filled">
                <div class="file-picker-name">Starting the microphone…</div>
            </div>
            <div v-else-if="source_path" class="file-picker-filled">
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
            <template v-else>
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
                <button
                    type="button"
                    class="btn-default"
                    :disabled="busy || recorder_active"
                    @click="cancel"
                >
                    Cancel
                </button>
            </div>
            <div v-if="recorder_active" class="actions-row">
                <button
                    type="button"
                    class="btn-default"
                    :disabled="recorder_transitioning"
                    @click="record_discard_click"
                >
                    Discard
                </button>
                <button
                    type="button"
                    class="btn-primary"
                    :disabled="recorder_transitioning"
                    @click="record_stop_click"
                >
                    Stop recording
                </button>
            </div>
            <div v-else class="actions-row">
                <button
                    v-if="!transcript && !busy"
                    type="button"
                    class="btn-default"
                    @click="paste_instead"
                >
                    Paste a transcript
                </button>
                <button
                    v-if="!transcript || busy"
                    type="button"
                    class="btn-primary"
                    :disabled="!can_transcribe"
                    @click="transcribe(true)"
                >
                    {{ transcribe_label }}
                </button>
                <button
                    v-if="transcript && !busy"
                    type="button"
                    class="btn-default"
                    @click="transcript_copy"
                >
                    <span
                        class="btn-label-swap"
                        :data-swapped="transcript_copied ? 'true' : 'false'"
                    >
                        <span>Copy transcript</span>
                        <span>Copied</span>
                    </span>
                </button>
                <button
                    v-if="transcript && !busy"
                    type="button"
                    class="btn-primary"
                    @click="continue_to_details"
                >
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
