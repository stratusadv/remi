import { ref, watch } from 'vue'
import { assert } from '../lib/assert'
import { ipc } from '../lib/ipc'
import { log_warn } from '../lib/log'
import { use_notes_templates } from './use_notes_templates'
import { use_settings } from './use_settings'
import type {
    JobID,
    JobMeta,
    JobSearchHit,
    LineCorrection,
    SegmentFocus,
    Transcript,
    Waveform,
} from '../types'


export type View =
    | 'ask'
    | 'checkout'
    | 'jobs'
    | 'transcribe'
    | 'import'
    | 'details'
    | 'notes'
    | 'settings'
    | 'templates'
    | 'people'

export type ViewIntent =
    | 'group_add'
    | 'person_add'
    | 'settings_account'
    | 'settings_ai'
    | 'settings_general'
    | 'template_add'

type ChunkHit = Pick<JobSearchHit, 'segment_index_first' | 'segment_index_last' | 'source'>

interface JobDocuments {
    notes: string | null
    transcript: Transcript | null
}

const WAVEFORM_BAR_COUNT_DEFAULT = 360

const VIEW_OF_INTENT: Readonly<Record<ViewIntent, View>> = Object.freeze({
    group_add: 'people',
    person_add: 'people',
    settings_account: 'settings',
    settings_ai: 'settings',
    settings_general: 'settings',
    template_add: 'templates',
})

const view_current = ref<View>('jobs')
const job_id_current = ref<string | null>(null)
const source_path = ref<string | null>(null)
const transcript = ref<Transcript | null>(null)
const notes_markdown = ref<string>('')
const template_id_selected = ref<string | null>(null)
const meta_current = ref<JobMeta | null>(null)
const waveform_current = ref<Waveform | null>(null)
const segment_focus = ref<SegmentFocus | null>(null)
const job_open_busy = ref(false)
const view_intent = ref<ViewIntent | null>(null)
const view_reopen_count = ref(0)


watch(view_current, () => {
    view_reopen_count.value = 0
})

export function use_pipeline(): typeof api {
    assert(Object.isFrozen(api))
    assert(view_current.value.length > 0)

    return api
}

async function job_documents_load(id: JobID): Promise<JobDocuments> {
    const engines = await ipc.job_transcript_engines_list(id)
    const [engine_first] = engines

    const [transcript_loaded, notes_loaded] = await Promise.all([
        engine_first !== undefined ? ipc.job_transcript_load(id, engine_first) : null,
        ipc.notes_load(id),
    ])

    assert(notes_loaded === null || typeof notes_loaded === 'string')

    return { notes: notes_loaded, transcript: transcript_loaded }
}

async function job_open(
    meta: JobMeta,
    view_target: View | null,
    focus: SegmentFocus | null = null,
): Promise<void> {
    assert(meta.id.length > 0)
    assert(view_target === null || view_target.length > 0)
    assert(focus === null || focus.job_id === meta.id)

    if (job_open_busy.value) return

    job_open_busy.value = true

    return job_documents_load(meta.id)
        .then((documents) => {
            job_open_commit(meta, view_target, documents, focus)
        })
        .finally(() => {
            job_open_busy.value = false
        })
}

async function job_open_at(meta: JobMeta, hit: ChunkHit): Promise<void> {
    assert(meta.id.length > 0)
    assert(hit.segment_index_first === null || hit.segment_index_first >= 0)

    if (hit.source === 'notes') return job_open(meta, 'notes')

    const first = hit.segment_index_first
    const last = hit.segment_index_last

    if (first === null) return job_open(meta, 'transcribe')
    if (last === null) return job_open(meta, 'transcribe')

    assert(first <= last)

    return job_open(meta, 'transcribe', {
        job_id: meta.id,
        segment_index_first: first,
        segment_index_last: last,
    })
}

function job_open_commit(
    meta: JobMeta,
    view_target: View | null,
    documents: JobDocuments,
    focus: SegmentFocus | null,
): void {
    assert(meta.id.length > 0)
    assert(view_target === null || view_target.length > 0)
    assert(typeof documents === 'object')
    assert(focus === null || focus.job_id === meta.id)

    job_id_current.value = meta.id
    source_path.value = meta.source_path
    meta_current.value = meta
    transcript.value = documents.transcript
    notes_markdown.value = documents.notes ?? ''
    waveform_current.value = null
    segment_focus.value = focus

    void waveform_refresh()

    view_current.value = view_target ?? view_for_job_state()
}

function job_start_new(): void {
    pipeline_reset()

    view_current.value = 'transcribe'

    assert(job_id_current.value === null)
    assert(source_path.value === null)
}

async function meta_refresh(): Promise<void> {
    const id = job_id_current.value

    if (id === null) return

    assert(typeof id === 'string')
    assert(id.length > 0)

    return ipc.job_meta_get(id)
        .then((fresh) => {
            if (fresh !== null) meta_current.value = fresh
        })
        .catch((error: unknown) => {
            log_warn('[pipeline] meta refresh failed', id, error)
        })
}

function pipeline_reset(): void {
    job_id_current.value = null
    source_path.value = null
    transcript.value = null
    notes_markdown.value = ''
    template_id_selected.value = null
    meta_current.value = null
    waveform_current.value = null
    segment_focus.value = null
    view_current.value = 'jobs'

    assert(view_current.value.length > 0)
    assert(view_reopen_count.value >= 0)
}

function template_id_ensure(): void {
    const { templates } = use_notes_templates()
    const { settings } = use_settings()
    const candidate = template_id_selected.value ?? settings.value.notes_template_id_default
    const known = templates.value.some((template) => template.id === candidate)

    template_id_selected.value = known ? candidate : null

    assert(template_id_selected.value === null || known)
    assert(Array.isArray(templates.value))
}

async function transcript_segments_text_set(corrections: LineCorrection[]): Promise<void> {
    assert(Array.isArray(corrections))
    assert(corrections.every((correction) => correction.index >= 0))

    const current = transcript.value

    if (current === null) return
    if (corrections.length === 0) return

    const text_by_index = new Map(
        corrections.map((correction) => [correction.index, correction.text]),
    )

    const segments = current.segments.map((segment, index) => {
        const text = text_by_index.get(index)

        return text === undefined ? segment : { ...segment, text }
    })

    const text_full = segments
        .map((segment) => segment.text.trim())
        .filter((segment_text) => segment_text.length > 0)
        .join(' ')

    transcript.value = { text: text_full, segments }

    const id = job_id_current.value

    if (id === null) return

    return ipc.job_transcript_save(id, transcript.value)
}

function view_for_job_state(): View {
    assert(typeof notes_markdown.value === 'string')
    assert(job_id_current.value !== null)

    if (notes_markdown.value.length > 0) return 'notes'
    if (transcript.value !== null) return 'details'

    return 'transcribe'
}

function view_intent_open(intent: ViewIntent): void {
    assert(Object.hasOwn(VIEW_OF_INTENT, intent), `${intent} is not a view intent`)

    const view = VIEW_OF_INTENT[intent]

    assert(view.length > 0)

    view_reopen(view)
    view_intent.value = intent

    assert(view_current.value === view)
}

function view_intent_take(): ViewIntent | null {
    const intent = view_intent.value

    assert(intent === null || VIEW_OF_INTENT[intent] === view_current.value)
    assert(view_reopen_count.value >= 0)

    view_intent.value = null

    return intent
}

function view_reopen(view: View): void {
    assert(view.length > 0)
    assert(view_reopen_count.value >= 0)

    view_intent.value = null

    if (view_current.value === view) {
        view_reopen_count.value += 1

        return
    }

    view_set(view)
}

function view_set(view: View): void {
    assert(view.length > 0)

    view_intent.value = null

    if (view_current.value === view) return

    view_current.value = view

    assert(view_reopen_count.value >= 0)
}

const api = Object.freeze({
    view_current,
    job_id_current,
    source_path,
    transcript,
    notes_markdown,
    template_id_selected,
    meta_current,
    waveform_current,
    segment_focus,
    job_open_busy,
    view_intent_open,
    view_intent_take,
    view_reopen,
    view_reopen_count,
    view_set,
    pipeline_reset,
    job_open,
    job_open_at,
    job_start_new,
    meta_refresh,
    template_id_ensure,
    transcript_segments_text_set,
    waveform_refresh,
})

async function waveform_refresh(): Promise<void> {
    const id = job_id_current.value

    if (id === null) {
        waveform_current.value = null

        return
    }

    assert(typeof id === 'string')
    assert(id.length > 0)

    return ipc.job_waveform_get(id, WAVEFORM_BAR_COUNT_DEFAULT)
        .then((waveform) => {
            waveform_current.value = waveform
        })
        .catch((error: unknown) => {
            waveform_current.value = null

            log_warn('[pipeline] waveform unavailable', id, error)
        })
}
