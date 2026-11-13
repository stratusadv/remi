<script setup lang="ts">
import {
    computed,
    onActivated,
    onDeactivated,
    onMounted,
    onUnmounted,
    ref,
    watch,
} from 'vue'
import { listen } from '@tauri-apps/api/event'
import { save as dialog_save } from '@tauri-apps/plugin-dialog'
import { use_dialog } from '../composables/use_dialog'
import { use_endpoints } from '../composables/use_endpoints'
import { use_network } from '../composables/use_network'
import { use_pipeline } from '../composables/use_pipeline'
import { use_service } from '../composables/use_service'
import { use_shortcuts } from '../composables/use_shortcuts'
import { is_cancelled_error, use_tasks } from '../composables/use_tasks'
import { seconds_to_clock } from '../lib/duration'
import { error_dialog_show } from '../lib/errors'
import { ipc } from '../lib/ipc'
import { log_warn } from '../lib/log'
import { path_file_stem, path_in_folder_start } from '../lib/paths'
import NoticeBanner from './notice_banner.vue'
import { rich_editor_async as RichEditorAsync } from './rich_editor_async'
import StepBar from './step_bar.vue'
import TranscriptPane from './transcript_pane.vue'
import type { UnlistenFn } from '@tauri-apps/api/event'
import type { AIRewriteArgs, ChatChunk, Transcript } from '../types'


type ExportFileFormat = 'docx' | 'md'
type ExportFormat = 'pdf' | ExportFileFormat
type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved'

interface ExportFileDialog {
    title: string
    filter: string
}

const AUTOSAVE_DEBOUNCE_MS = 1000
const EVENT_NOTES_CHUNK = 'notes_generate_chunk'
const SLUG_CHARS_MAX = 80
const MESSAGE_NO_JOB = 'There is no active job. Transcribe a file first to create one.'
const MESSAGE_KEY_MISSING = 'Add your API key under Settings first.'

const EXPORT_FILE_DIALOGS: Record<ExportFileFormat, ExportFileDialog> = {
    docx: { title: 'Save notes as Word document', filter: 'Word document' },
    md: { title: 'Save notes as Markdown', filter: 'Markdown' },
}

const {
    transcript,
    notes_markdown,
    job_id_current,
    meta_current,
    template_id_selected,
    view_set,
    meta_refresh,
    pipeline_reset,
    template_id_ensure,
} = use_pipeline()

const { confirm: dialog_confirm, message: dialog_message } = use_dialog()
const { endpoints_by_purpose } = use_endpoints()
const { notes_ready } = use_service()
const { online } = use_network()
const { task_run } = use_tasks()
const endpoint_id_selected = ref<string | null>(null)
const busy = ref(false)
const error_message = ref<string | null>(null)
const ready_banner_dismissed = ref(false)
const stream_id_active = ref<string | null>(null)
const autosave_status = ref<SaveStatus>('idle')
const transcript_side_by_side = ref(false)
const export_busy = ref(false)
const export_menu_open = ref(false)
const export_menu_root = ref<HTMLElement | null>(null)
const stream_pane_ref = ref<HTMLElement | null>(null)
const view_active = ref(true)
let chunk_unlisten: UnlistenFn | null = null
let autosave_timer_id: ReturnType<typeof setTimeout> | null = null
let stream_scroll_pending = false
const endpoints_notes = computed(() => endpoints_by_purpose('notes'))
const notes_present = computed(() => notes_markdown.value.trim().length > 0)

const stream_status_text = computed(() =>
    notes_markdown.value.length === 0 ? 'Reading the transcript…' : 'Writing notes')

const can_generate = computed(
    () =>
        transcript.value !== null
        && template_id_selected.value !== null
        && endpoint_id_selected.value !== null
        && notes_ready.value
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


async function ai_rewrite_handler(args: AIRewriteArgs): Promise<string> {
    const endpoint_id = endpoint_for_notes_resolve()

    if (endpoint_id === null) throw new Error(MESSAGE_KEY_MISSING)
    if (endpoint_id_selected.value !== endpoint_id) endpoint_id_selected.value = endpoint_id

    const stream_id = crypto.randomUUID()

    const unlisten = await listen<ChatChunk>(EVENT_NOTES_CHUNK, (event) => {
        if (event.payload.stream_id !== stream_id) return
        if (event.payload.done) return

        args.on_chunk(event.payload.text)
    })

    try {
        return await ipc.notes_text_rewrite_streaming(
            stream_id,
            endpoint_id,
            args.text,
            args.instruction,
            args.whole_document ? template_id_selected.value : null,
        )
    } finally {
        unlisten()
    }
}

async function autosave_flush(): Promise<void> {
    autosave_timer_id = null

    if (job_id_current.value === null) return

    autosave_status.value = 'saving'

    try {
        await ipc.notes_save(job_id_current.value, notes_markdown.value)
        autosave_status.value = 'saved'
    } catch (error) {
        autosave_status.value = 'idle'
        error_message.value = String(error)
    }
}

function autosave_schedule(): void {
    autosave_status.value = 'pending'

    autosave_timer_clear()

    autosave_timer_id = setTimeout(() => {
        void autosave_flush()
    }, AUTOSAVE_DEBOUNCE_MS)
}

function autosave_timer_clear(): void {
    if (autosave_timer_id === null) return

    clearTimeout(autosave_timer_id)
    autosave_timer_id = null
}

function back(): void {
    view_set('details')
}

async function done(): Promise<void> {
    if (autosave_timer_id !== null) {
        autosave_timer_clear()

        await autosave_flush()
    }

    pipeline_reset()
}

function endpoint_for_notes_resolve(): string | null {
    if (endpoint_id_selected.value !== null) return endpoint_id_selected.value

    return endpoints_notes.value[0]?.id ?? null
}

function export_filename_default(extension: string): string {
    const title = meta_current.value?.title?.trim() ?? ''
    const raw = title.length > 0 ? title : 'notes'

    const slug = raw
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, SLUG_CHARS_MAX)

    return `${slug.length > 0 ? slug : 'notes'}.${extension}`
}

function export_menu_close_on_escape(event: KeyboardEvent): void {
    if (event.key === 'Escape' && export_menu_open.value) export_menu_open.value = false
}

onActivated(() => {
    view_active.value = true

    template_id_ensure()
})

onDeactivated(() => {
    view_active.value = false
})

onMounted(async () => {
    template_id_ensure()

    await meta_refresh()

    chunk_unlisten = await listen<ChatChunk>(EVENT_NOTES_CHUNK, (event) => {
        if (event.payload.stream_id !== stream_id_active.value) return
        if (event.payload.done) return

        notes_markdown.value += event.payload.text
    })

    document.addEventListener('mousedown', export_menu_close_on_outside, true)
    document.addEventListener('keydown', export_menu_close_on_escape, true)
})

onUnmounted(() => {
    if (chunk_unlisten !== null) chunk_unlisten()

    autosave_timer_clear()

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

watch(notes_markdown, () => {
    if (stream_id_active.value !== null) {
        stream_pane_scroll()

        return
    }

    if (!view_active.value) return
    if (job_id_current.value === null) return

    autosave_schedule()
})

function export_menu_close_on_outside(event: MouseEvent): void {
    if (!export_menu_open.value) return

    const root = export_menu_root.value

    if (root === null) return
    if (event.target instanceof Node && root.contains(event.target)) return

    export_menu_open.value = false
}

async function export_menu_pick(format: ExportFormat): Promise<void> {
    export_menu_open.value = false

    if (format === 'pdf') {
        await print_notes()

        return
    }

    await export_notes(format)
}

function export_menu_toggle(): void {
    export_menu_open.value = !export_menu_open.value
}

async function export_notes(format: ExportFileFormat): Promise<void> {
    const job_id = job_id_current.value

    if (job_id === null) {
        error_message.value = MESSAGE_NO_JOB

        return
    }

    await save_pending_flush()

    const target = await export_target_pick(format)

    if (target === null) return

    export_busy.value = true
    error_message.value = null

    try {
        const path_saved = await ipc.notes_export(job_id, target)

        await export_open_offer(path_saved)
    } catch (error) {
        error_message.value = String(error)

        await error_dialog_show(error)
    } finally {
        export_busy.value = false
    }
}

async function export_open_offer(path_saved: string): Promise<void> {
    const open_wanted = await dialog_confirm(
        `The notes were exported to ${path_saved}. Open the file now?`,
        { title: 'Notes exported', kind: 'info' },
    )

    if (!open_wanted) return

    try {
        await ipc.desktop_export_open()
    } catch (error) {
        log_warn('[notes] the exported file did not open', error)

        const failure = 'The notes were saved, but the file could not be opened automatically. '
            + `You can open it from ${path_saved}.`

        await dialog_message(failure, { title: 'Notes exported', kind: 'info' })
    }
}

async function export_target_pick(format: ExportFileFormat): Promise<string | null> {
    try {
        return await dialog_save({
            title: EXPORT_FILE_DIALOGS[format].title,
            defaultPath: await path_in_folder_start(export_filename_default(format)),
            filters: [{ name: EXPORT_FILE_DIALOGS[format].filter, extensions: [format] }],
        })
    } catch (error) {
        await error_dialog_show(error)

        return null
    }
}

async function generate(): Promise<void> {
    const transcript_source = transcript.value
    const template_id = template_id_selected.value
    const endpoint_id = endpoint_id_selected.value

    if (transcript_source === null || template_id === null || endpoint_id === null) return
    if (!(await generate_confirm_overwrite())) return

    const stream_id = crypto.randomUUID()
    const transcript_text = transcript_with_timestamps_text(transcript_source)
    const job_id_at_start = job_id_current.value

    notes_markdown.value = ''
    busy.value = true
    error_message.value = null
    stream_id_active.value = stream_id

    try {
        await task_run({
            kind: 'generate',
            label: notes_task_label(),
            stream_id,
            runner: async () => {
                const text_final = await ipc.notes_generate_remote_streaming(
                    stream_id,
                    job_id_at_start,
                    transcript_text,
                    template_id,
                    endpoint_id,
                )

                if (text_final.length > 0 && notes_markdown.value !== text_final) {
                    notes_markdown.value = text_final
                }

                if (job_id_at_start !== null) {
                    await ipc.notes_save(job_id_at_start, notes_markdown.value)
                }

                return text_final
            },
            job_id_of: () => job_id_at_start,
        })
    } catch (error) {
        if (!is_cancelled_error(error)) {
            error_message.value = String(error)

            await error_dialog_show(error)
        }
    } finally {
        busy.value = false
        stream_id_active.value = null
    }
}

async function generate_confirm_overwrite(): Promise<boolean> {
    if (!notes_present.value) return true

    return await dialog_confirm(
        'This will overwrite the current notes. Continue?',
        { title: 'Overwrite notes', kind: 'warning' },
    )
}

function notes_task_label(): string {
    const title = meta_current.value?.title?.trim() ?? ''

    if (title.length > 0) return title

    const stem = path_file_stem(meta_current.value?.source_path ?? '')

    return stem.length > 0 ? stem : 'Notes'
}

async function print_notes(): Promise<void> {
    if (job_id_current.value === null) {
        error_message.value = MESSAGE_NO_JOB

        return
    }

    await save_pending_flush()

    export_busy.value = true
    error_message.value = null

    try {
        await ipc.notes_print(job_id_current.value)
    } catch (error) {
        error_message.value = String(error)

        await error_dialog_show(error)
    } finally {
        export_busy.value = false
    }
}

async function save_now(): Promise<void> {
    if (job_id_current.value === null) {
        error_message.value = MESSAGE_NO_JOB

        return
    }

    autosave_timer_clear()

    error_message.value = null
    autosave_status.value = 'saving'

    try {
        await ipc.notes_save(job_id_current.value, notes_markdown.value)
        autosave_status.value = 'saved'
    } catch (error) {
        autosave_status.value = 'idle'
        error_message.value = String(error)

        await error_dialog_show(error)
    }
}

async function save_pending_flush(): Promise<void> {
    if (autosave_status.value === 'pending' || autosave_timer_id !== null) await save_now()
}

function stream_pane_scroll(): void {
    if (stream_scroll_pending) return

    stream_scroll_pending = true

    requestAnimationFrame(() => {
        stream_scroll_pending = false

        const pane = stream_pane_ref.value

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

    if (lines.length === 0) return source.text

    return lines.join('\n')
}

use_shortcuts({
    'ctrl+g': () => { if (can_generate.value) void generate() },
    'ctrl+s': () => { void save_now() },
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

        <NoticeBanner
            v-if="!notes_ready && !ready_banner_dismissed"
            @dismiss="ready_banner_dismissed = true"
        >
            remi needs the API address and keys set up before it can write notes.
            <template #actions>
                <button class="btn-primary" @click="view_set('settings')">Open settings</button>
            </template>
        </NoticeBanner>

        <NoticeBanner v-if="error_message" @dismiss="error_message = null">
            {{ error_message }}
        </NoticeBanner>

        <div class="notes-split" :data-side-by-side="transcript_side_by_side ? 'true' : 'false'">
            <div v-if="stream_id_active !== null" class="notes-stream-shell">
                <p class="streaming-status">{{ stream_status_text }}</p>
                <pre
                    ref="stream_pane_ref"
                    class="notes-stream-pane"
                >{{ notes_markdown }}<span class="streaming-caret">▌</span></pre>
            </div>
            <div v-else-if="!notes_present" class="notes-empty">
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
            <RichEditorAsync
                v-else
                v-model="notes_markdown"
                placeholder="Type or paste notes here."
                :ai_rewrite="ai_rewrite_handler"
            />
            <TranscriptPane
                v-if="transcript_side_by_side && transcript"
                :transcript="transcript"
            />
        </div>

        <footer class="step-footer">
            <div class="step-footer-start">
                <button class="btn-default" :disabled="busy" @click="back">Back</button>
            </div>
            <div v-if="!notes_present" class="actions-row">
                <button class="btn-default" :disabled="busy" @click="done">Done</button>
                <button class="btn-primary" :disabled="!can_generate" @click="generate">
                    {{ busy ? 'Generating…' : 'Generate notes' }}
                </button>
            </div>
            <div v-else class="actions-row">
                <button
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
                                @click="export_menu_pick('md')"
                            >
                                <span class="export-menu-item-label">Markdown</span>
                                <span class="export-menu-item-ext">.md</span>
                            </button>
                        </li>
                    </ul>
                </div>
                <button class="btn-primary" :disabled="busy" @click="done">Done</button>
            </div>
        </footer>
    </section>
</template>
