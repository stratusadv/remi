<script setup lang="ts">
import {
    computed,
    onActivated,
    onDeactivated,
    onMounted,
    onUnmounted,
    ref,
    shallowRef,
    useTemplateRef,
    watch,
} from 'vue'
import { listen } from '@tauri-apps/api/event'
import { save as dialog_save } from '@tauri-apps/plugin-dialog'
import { use_dialog } from '../composables/use_dialog'
import { MESSAGE_ENDPOINT_MISSING, use_endpoints } from '../composables/use_endpoints'
import { use_network } from '../composables/use_network'
import { use_pipeline } from '../composables/use_pipeline'
import { use_shortcuts } from '../composables/use_shortcuts'
import { is_cancelled_error, use_tasks } from '../composables/use_tasks'
import { assert } from '../lib/assert'
import { seconds_to_clock } from '../lib/duration'
import { error_dialog_show, error_shown } from '../lib/errors'
import { ipc } from '../lib/ipc'
import { log_warn } from '../lib/log'
import { path_file_stem, path_in_folder_start } from '../lib/paths'
import NoticeBanner from './notice_banner.vue'
import { rich_editor_async as RichEditorAsync } from './rich_editor_async'
import StepBar from './step_bar.vue'
import StepCitation from './step_citation.vue'
import TranscriptPane from './transcript_pane.vue'
import type { NotesGeneration } from '../composables/use_pipeline'
import type {
    AIRewriteRequest,
    ChatChunk,
    EndpointID,
    JobID,
    Markdown,
    TargetPath,
    TemplateID,
    Transcript,
    TranscriptText,
} from '../types'


type ExportFileFormat = 'docx' | 'markdown'
type ExportFormat = 'pdf' | ExportFileFormat
type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved'

interface ExportFileDialog {
    title: string
    filter: string
    extension: string
}

interface GenerationRequest {
    transcript_text: TranscriptText
    template_id: TemplateID
    endpoint_id: EndpointID
}

interface NotesDraft {
    job_id: JobID
    markdown: Markdown
}

const AUTOSAVE_DEBOUNCE_MS = 1000
const EVENT_NOTES_CHUNK = 'notes_generate_chunk'
const KEY_DEFAULT_PATH = 'defaultPath'
const SLUG_CHARS_MAX = 80
const MESSAGE_NO_JOB = 'There is no active job. Transcribe a file first to create one.'

const EXPORT_FILE_DIALOGS = Object.freeze<Record<ExportFileFormat, ExportFileDialog>>({
    docx: { title: 'Save notes as Word document', filter: 'Word document', extension: 'docx' },
    markdown: { title: 'Save notes as Markdown', filter: 'Markdown', extension: 'md' },
})

const {
    transcript,
    notes_markdown,
    notes_generations,
    job_id_current,
    meta_current,
    template_id_selected,
    view_current,
    view_set,
    meta_refresh,
    pipeline_reset,
    template_id_ensure,
    view_intent_take,
} = use_pipeline()

const { confirm: dialog_confirm, message: dialog_message } = use_dialog()
const { endpoints_by_purpose } = use_endpoints()
const { online } = use_network()
const { task_run } = use_tasks()
const endpoint_id_selected = ref<string | null>(null)
const error_message = ref<string | null>(null)
const autosave_status = ref<SaveStatus>('idle')
const transcript_side_by_side = ref(false)
const export_busy = ref(false)
const export_menu_open = ref(false)
const export_menu_root = useTemplateRef<HTMLElement>('export_menu_root')
const stream_pane_element = useTemplateRef<HTMLElement>('stream_pane_element')
const view_active = ref(true)
const autosave_draft = shallowRef<NotesDraft | null>(null)
const autosave_timer_id = shallowRef<ReturnType<typeof setTimeout> | null>(null)
const stream_scroll_pending = shallowRef(false)
const endpoints_notes = computed(() => endpoints_by_purpose('notes'))

const generation_current = computed(() => notes_generations.value.find(
    (generation) => generation.job_id === job_id_current.value,
) ?? null)

const busy = computed(() => generation_current.value !== null)
const stream_id_active = computed(() => generation_current.value?.stream_id ?? null)
const notes_present = computed(() => notes_markdown.value.trim().length > 0)

const stream_status_text = computed(() =>
    notes_markdown.value.length === 0 ? 'Reading the transcript…' : 'Writing notes')

const can_generate = computed(
    () =>
        transcript.value !== null
        && template_id_selected.value !== null
        && endpoint_id_selected.value !== null
        && !busy.value
        && online.value,
)

const can_export = computed(
    () =>
        job_id_current.value !== null
        && notes_present.value
        && !export_busy.value
        && stream_id_active.value === null,
)


async function ai_rewrite_handler(request: AIRewriteRequest): Promise<string> {
    assert(request.text.trim().length > 0)
    assert(request.instruction.trim().length > 0)

    const endpoint_id = endpoint_for_notes_resolve()

    if (endpoint_id === null) throw new Error(MESSAGE_ENDPOINT_MISSING)
    if (endpoint_id_selected.value !== endpoint_id) endpoint_id_selected.value = endpoint_id

    const stream_id = crypto.randomUUID()

    const listening = listen<ChatChunk>(EVENT_NOTES_CHUNK, (event) => {
        assert(event.event === EVENT_NOTES_CHUNK)
        assert(event.payload.stream_id.length > 0)

        if (event.payload.stream_id !== stream_id) return
        if (event.payload.done) return

        request.on_chunk(event.payload.text)
    })

    return listening.then(async (unlisten) => ipc
        .notes_text_rewrite_streaming(
            stream_id,
            endpoint_id,
            request.text,
            request.instruction,
            request.whole_document ? template_id_selected.value : null,
        )
        .finally(unlisten))
}

function autosave_cancel(): void {
    assert(autosave_timer_id.value === null || autosave_draft.value !== null)

    autosave_timer_clear()
    autosave_draft.value = null

    assert(autosave_timer_id.value === null)
}

async function autosave_flush(): Promise<void> {
    assert(autosave_draft.value !== null)

    const { job_id, markdown } = autosave_draft.value

    assert(job_id.length > 0)

    autosave_cancel()

    autosave_status.value = 'saving'

    return ipc.notes_save(job_id, markdown)
        .then(() => {
            autosave_status.value = 'saved'
        })
        .catch((error: unknown) => {
            autosave_status.value = 'idle'
            error_message.value = error_shown(error)
        })
}

function autosave_release(): void {
    assert(autosave_timer_id.value === null || autosave_draft.value !== null)

    if (autosave_draft.value === null) return

    const { job_id, markdown } = autosave_draft.value

    assert(job_id.length > 0)

    autosave_cancel()

    void ipc.notes_save(job_id, markdown).catch(error_dialog_show)
}

function autosave_schedule(): void {
    assert(stream_id_active.value === null)
    assert(view_active.value || autosave_timer_id.value === null)

    const job_id = job_id_current.value

    assert(job_id !== null)

    if (autosave_draft.value !== null) {
        if (autosave_draft.value.job_id !== job_id) autosave_release()
    }

    autosave_status.value = 'pending'
    autosave_draft.value = { job_id, markdown: notes_markdown.value }

    autosave_timer_clear()

    if (!view_active.value) {
        autosave_release()

        return
    }

    autosave_timer_id.value = setTimeout(autosave_timer_fire, AUTOSAVE_DEBOUNCE_MS)
}

function autosave_timer_clear(): void {
    assert(autosave_timer_id.value === null || autosave_draft.value !== null)

    if (autosave_timer_id.value === null) return

    clearTimeout(autosave_timer_id.value)
    autosave_timer_id.value = null
}

function autosave_timer_fire(): void {
    assert(autosave_timer_id.value !== null)
    assert(autosave_draft.value !== null)
    assert(view_active.value)

    void autosave_flush()
}

function back(): void {
    const view_previous = view_current.value

    assert(view_previous === 'notes')
    assert(!busy.value)

    view_set('details')

    assert(view_current.value === 'details')
}

async function done(): Promise<void> {
    assert(!busy.value)
    assert(autosave_timer_id.value === null || autosave_draft.value !== null)

    if (autosave_timer_id.value !== null) {
        autosave_timer_clear()

        return autosave_flush().then(pipeline_reset)
    }

    pipeline_reset()
}

function endpoint_for_notes_resolve(): string | null {
    assert(endpoints_notes.value.every((endpoint) => endpoint.purpose === 'notes'))
    assert(endpoint_id_selected.value === null || endpoint_id_selected.value.length > 0)

    if (endpoint_id_selected.value !== null) return endpoint_id_selected.value

    return endpoints_notes.value[0]?.id ?? null
}

function export_filename_default(extension: string): string {
    assert(extension.length > 0)
    assert(!extension.startsWith('.'))

    const title = meta_current.value?.title?.trim() ?? ''
    const raw = title.length > 0 ? title : 'notes'

    const slug = raw
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, SLUG_CHARS_MAX)

    assert(!slug.startsWith('-'))
    assert(!slug.includes('/'))

    return `${slug.length > 0 ? slug : 'notes'}.${extension}`
}

function export_menu_close_on_escape(event: KeyboardEvent): void {
    assert(event.type === 'keydown')
    assert(event.currentTarget === document)

    if (event.key !== 'Escape') return
    if (!export_menu_open.value) return

    export_menu_open.value = false
}

onActivated(() => {
    const returning = !view_active.value

    view_active.value = true

    template_id_ensure()

    if (returning) void meta_refresh()

    intent_apply()
})

onDeactivated(() => {
    view_active.value = false
    export_menu_open.value = false
    error_message.value = null

    autosave_release()
})

onMounted(() => {
    template_id_ensure()

    document.addEventListener('mousedown', export_menu_close_on_outside, true)
    document.addEventListener('keydown', export_menu_close_on_escape, true)

    void meta_refresh()
})

onUnmounted(() => {
    autosave_release()

    document.removeEventListener('mousedown', export_menu_close_on_outside, true)
    document.removeEventListener('keydown', export_menu_close_on_escape, true)
})

watch(
    () => endpoints_notes.value,
    () => {
        if (endpoint_id_selected.value !== null) return

        const resolved = endpoint_for_notes_resolve()

        if (resolved !== null) endpoint_id_selected.value = resolved
    },
    { immediate: true },
)

watch(job_id_current, () => {
    autosave_release()

    autosave_status.value = 'idle'
    error_message.value = null
})

watch(notes_markdown, () => {
    if (stream_id_active.value === null) return

    stream_pane_scroll()
})

function export_menu_close_on_outside(event: MouseEvent): void {
    assert(event.type === 'mousedown')
    assert(event.currentTarget === document)

    if (!export_menu_open.value) return

    const root = export_menu_root.value

    if (root === null) return

    if (event.target instanceof Node) {
        if (root.contains(event.target)) return
    }

    export_menu_open.value = false
}

async function export_menu_pick(format: ExportFormat): Promise<void> {
    assert(export_menu_open.value)
    assert(format === 'pdf' || Object.hasOwn(EXPORT_FILE_DIALOGS, format))

    export_menu_open.value = false

    if (format === 'pdf') return print_notes()

    return export_notes(format)
}

function export_menu_toggle(): void {
    assert(can_export.value)
    assert(export_menu_root.value !== null)

    export_menu_open.value = !export_menu_open.value
}

async function export_notes(format: ExportFileFormat): Promise<void> {
    assert(Object.hasOwn(EXPORT_FILE_DIALOGS, format))
    assert(!export_menu_open.value)

    const job_id = job_id_current.value

    if (job_id === null) {
        error_message.value = MESSAGE_NO_JOB

        return
    }

    return save_pending_flush()
        .then(async () => export_target_pick(format))
        .then(async (target) => {
            assert(target === null || target.length > 0)

            if (target === null) return

            return export_write(job_id, target)
        })
}

async function export_open_offer(path_saved: string): Promise<void> {
    assert(path_saved.length > 0)

    const offered = dialog_confirm(
        `The notes were exported to ${path_saved}. Open the file now?`,
        { title: 'Notes exported', kind: 'info' },
    )

    return offered.then(async (open_wanted) => {
        if (!open_wanted) return

        return ipc.desktop_export_open().catch(async (error: unknown) => {
            log_warn('[notes] the exported file did not open', error)

            const failure = 'The notes were saved, but the file could not be opened automatically. '
                + `You can open it from ${path_saved}.`

            return dialog_message(failure, { title: 'Notes exported', kind: 'info' })
        })
    })
}

async function export_target_pick(format: ExportFileFormat): Promise<TargetPath | null> {
    assert(Object.hasOwn(EXPORT_FILE_DIALOGS, format))

    const dialog = EXPORT_FILE_DIALOGS[format]
    const filename = export_filename_default(dialog.extension)

    return path_in_folder_start(filename)
        .then(async (path_default) => {
            assert(path_default.endsWith(filename))

            return dialog_save({
                title: dialog.title,
                [KEY_DEFAULT_PATH]: path_default,
                filters: [{ name: dialog.filter, extensions: [dialog.extension] }],
            })
        })
        .catch(async (error: unknown) => {
            await error_dialog_show(error)

            return null
        })
}

async function export_write(job_id: JobID, target: TargetPath): Promise<void> {
    assert(job_id.length > 0)
    assert(target.length > 0)

    export_busy.value = true
    error_message.value = null

    return ipc.notes_export(job_id, target)
        .then(export_open_offer)
        .catch(async (error: unknown) => {
            error_message.value = error_shown(error)

            return error_dialog_show(error)
        })
        .finally(() => {
            export_busy.value = false
        })
}

async function generate(): Promise<void> {
    const job_id = job_id_current.value
    const transcript_source = transcript.value
    const template_id = template_id_selected.value
    const endpoint_id = endpoint_id_selected.value

    if (transcript_source === null) return
    if (template_id === null) return
    if (endpoint_id === null) return
    if (!(await generate_confirm_overwrite())) return
    if (job_id_current.value !== job_id) return

    autosave_release()

    const generation = { job_id, stream_id: crypto.randomUUID(), text: '' }
    const transcript_text = transcript_with_timestamps_text(transcript_source)
    const request = { transcript_text, template_id, endpoint_id }

    assert(notes_generations.value.every((entry) => entry.job_id !== generation.job_id))

    notes_markdown.value = ''
    error_message.value = null
    notes_generations.value = [...notes_generations.value, generation]

    const listening = listen<ChatChunk>(EVENT_NOTES_CHUNK, (event) => {
        assert(event.event === EVENT_NOTES_CHUNK)
        assert(event.payload.stream_id.length > 0)

        if (event.payload.stream_id !== generation.stream_id) return
        if (event.payload.done) return

        generation.text += event.payload.text

        if (job_id_current.value === generation.job_id) notes_markdown.value = generation.text
    })

    return listening
        .then(async (unlisten) => generation_run(generation, request).finally(unlisten))
        .catch(async (error: unknown) => {
            if (is_cancelled_error(error)) return

            error_message.value = error_shown(error)

            return error_dialog_show(error)
        })
        .finally(() => {
            notes_generations.value = notes_generations.value.filter(
                (entry) => entry !== generation,
            )
        })
}

async function generate_confirm_overwrite(): Promise<boolean> {
    assert(transcript.value !== null)
    assert(!busy.value)

    if (!notes_present.value) return true

    return dialog_confirm(
        'This will overwrite the current notes. Continue?',
        { title: 'Overwrite notes', kind: 'warning' },
    )
}

function generate_shortcut(event: KeyboardEvent): void {
    assert(event.type === 'keydown')
    assert(view_active.value)

    if (can_generate.value) void generate()
}

async function generation_run(
    generation: NotesGeneration,
    request: GenerationRequest,
): Promise<void> {
    assert(generation.stream_id.length > 0)
    assert(request.template_id.length > 0)
    assert(notes_generations.value.includes(generation))

    return task_run({
        kind: 'generate',
        label: notes_task_label(),
        stream_id: generation.stream_id,
        async runner() {
            assert(generation.text.length === 0)
            assert(request.endpoint_id.length > 0)

            const finished = ipc.notes_generate_remote_streaming(
                generation.stream_id,
                generation.job_id,
                request.transcript_text,
                request.template_id,
                request.endpoint_id,
            )

            return finished.then(async (text_final: Markdown) => {
                assert(notes_generations.value.includes(generation))

                const text = text_final.length > 0 ? text_final : generation.text

                if (job_id_current.value === generation.job_id) {
                    if (notes_markdown.value !== text) notes_markdown.value = text
                }

                if (generation.job_id === null) return

                return ipc.notes_save(generation.job_id, text)
            })
        },
        job_id_of() {
            assert(notes_generations.value.includes(generation))
            assert(generation.job_id === null || generation.job_id.length > 0)

            return generation.job_id
        },
    })
}

function intent_apply(): void {
    const intent = view_intent_take()

    assert(intent === null || intent === 'notes_generate')
    assert(view_active.value)

    if (intent === null) return
    if (notes_present.value) return
    if (!can_generate.value) return

    void generate()
}

function notes_edit(markdown: Markdown): void {
    assert(view_active.value || autosave_timer_id.value === null)

    if (stream_id_active.value !== null) return

    notes_markdown.value = markdown

    if (job_id_current.value === null) return

    autosave_schedule()
}

function notes_task_label(): string {
    const title = meta_current.value?.title?.trim() ?? ''

    if (title.length > 0) return title

    const stem = path_file_stem(meta_current.value?.source_path ?? '')

    return stem.length > 0 ? stem : 'Notes'
}

async function print_notes(): Promise<void> {
    const job_id = job_id_current.value

    if (job_id === null) {
        error_message.value = MESSAGE_NO_JOB

        return
    }

    await save_pending_flush()

    export_busy.value = true
    error_message.value = null

    try {
        await ipc.notes_print(job_id)
    } catch (error) {
        error_message.value = error_shown(error)

        await error_dialog_show(error)
    } finally {
        export_busy.value = false
    }
}

async function save_now(): Promise<void> {
    assert(view_active.value)

    if (job_id_current.value === null) {
        error_message.value = MESSAGE_NO_JOB

        return
    }

    autosave_cancel()

    error_message.value = null
    autosave_status.value = 'saving'

    return ipc.notes_save(job_id_current.value, notes_markdown.value)
        .then(() => {
            autosave_status.value = 'saved'
        })
        .catch(async (error: unknown) => {
            autosave_status.value = 'idle'
            error_message.value = error_shown(error)

            return error_dialog_show(error)
        })
}

async function save_pending_flush(): Promise<void> {
    if (autosave_status.value === 'pending') return save_now()
    if (autosave_timer_id.value !== null) return save_now()
}

function save_shortcut(event: KeyboardEvent): void {
    assert(event.type === 'keydown')
    assert(view_active.value)

    void save_now()
}

function stream_pane_scroll(): void {
    assert(stream_id_active.value !== null)

    if (stream_scroll_pending.value) return

    stream_scroll_pending.value = true

    requestAnimationFrame(() => {
        assert(stream_scroll_pending.value)

        stream_scroll_pending.value = false

        const pane = stream_pane_element.value

        if (pane !== null) pane.scrollTop = pane.scrollHeight
    })
}

function transcript_with_timestamps_text(source: Transcript): string {
    const lines: string[] = []

    for (const segment of source.segments) {
        const text = segment.text.trim()

        if (text.length === 0) continue

        lines.push(`[${seconds_to_clock(segment.start_seconds)}] ${text}`)
    }

    assert(lines.length <= source.segments.length)

    if (lines.length === 0) return source.text

    return lines.join('\n')
}

use_shortcuts({
    'ctrl+g': generate_shortcut,
    'ctrl+s': save_shortcut,
})
</script>

<template>
    <section class="view-fill step-view">
        <div class="step-head">
            <StepBar />
            <button
                v-if="transcript"
                type="button"
                class="notes-controls-toggle"
                :data-active="transcript_side_by_side ? 'true' : 'false'"
                @click="transcript_side_by_side = !transcript_side_by_side"
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
                    <path d="M4 6h16" />
                    <path d="M4 12h10" />
                    <path d="M4 18h16" />
                </svg>
                Transcript
            </button>
        </div>
        <StepCitation />

        <NoticeBanner v-if="error_message" @dismiss="error_message = null">
            {{ error_message }}
        </NoticeBanner>

        <div class="notes-split" :data-side-by-side="transcript_side_by_side ? 'true' : 'false'">
            <div v-if="stream_id_active !== null" class="notes-stream-shell">
                <p class="streaming-status">{{ stream_status_text }}</p>
                <pre
                    ref="stream_pane_element"
                    class="notes-stream-pane"
                >{{ notes_markdown }}<span class="streaming-caret">▌</span></pre>
            </div>
            <RichEditorAsync
                v-else-if="notes_present"
                :key="job_id_current ?? ''"
                :model-value="notes_markdown"
                placeholder="Type or paste notes here."
                :ai_rewrite="ai_rewrite_handler"
                @update:model-value="notes_edit"
            />
            <div v-else class="notes-empty">
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
                        <path d="M9 12h6" />
                        <path d="M9 16h4" />
                    </svg>
                </span>
                <h3>No notes yet</h3>
                <p v-if="!transcript" class="meta">Transcribe a recording first.</p>
            </div>
            <TranscriptPane
                v-if="transcript_side_by_side && transcript"
                :transcript="transcript"
            />
        </div>

        <footer class="step-footer">
            <div class="step-footer-start">
                <button
                    type="button"
                    class="btn-default"
                    :disabled="busy"
                    @click="back"
                >
                    Back
                </button>
            </div>
            <div v-if="notes_present" class="actions-row">
                <button
                    type="button"
                    class="btn-default"
                    :disabled="!can_generate"
                    @click="generate"
                >
                    {{ busy ? 'Regenerating…' : 'Regenerate notes' }}
                </button>
                <div ref="export_menu_root" class="menu">
                    <button
                        type="button"
                        class="btn-default export-menu-trigger"
                        :disabled="!can_export"
                        :aria-haspopup="true"
                        :aria-expanded="export_menu_open"
                        @click="export_menu_toggle"
                    >
                        <span>{{ export_busy ? 'Exporting…' : 'Export' }}</span>
                        <svg
                            class="export-menu-caret"
                            viewBox="0 0 12 12"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.6"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            aria-hidden="true"
                        >
                            <path d="M2.5 4.5l3.5 3.5 3.5-3.5" />
                        </svg>
                    </button>
                    <ul v-if="export_menu_open" class="menu-popover menu-popover-up" role="menu">
                        <li>
                            <button
                                type="button"
                                class="menu-item"
                                role="menuitem"
                                @click="export_menu_pick('pdf')"
                            >
                                <span class="export-menu-item-label">PDF</span>
                                <span class="export-menu-item-ext">.pdf</span>
                            </button>
                        </li>
                        <li>
                            <button
                                type="button"
                                class="menu-item"
                                role="menuitem"
                                @click="export_menu_pick('docx')"
                            >
                                <span class="export-menu-item-label">Word</span>
                                <span class="export-menu-item-ext">.docx</span>
                            </button>
                        </li>
                        <li>
                            <button
                                type="button"
                                class="menu-item"
                                role="menuitem"
                                @click="export_menu_pick('markdown')"
                            >
                                <span class="export-menu-item-label">Markdown</span>
                                <span class="export-menu-item-ext">.md</span>
                            </button>
                        </li>
                    </ul>
                </div>
                <button
                    type="button"
                    class="btn-primary"
                    :disabled="busy"
                    @click="done"
                >
                    Done
                </button>
            </div>
            <div v-else class="actions-row">
                <button
                    type="button"
                    class="btn-default"
                    :disabled="busy"
                    @click="done"
                >
                    Done
                </button>
                <button
                    type="button"
                    class="btn-primary"
                    :disabled="!can_generate"
                    @click="generate"
                >
                    {{ busy ? 'Generating…' : 'Generate notes' }}
                </button>
            </div>
        </footer>
    </section>
</template>
