import { assert } from './assert'
import { log_information, log_warn } from './log'
import type {
    APIEndpoint,
    APIEndpointPurpose,
    EventCallback,
    Group,
    JobID,
    JobListing,
    JobMeta,
    JobMetaPatch,
    JobSearchHit,
    LineCorrection,
    Markdown,
    NotesTemplate,
    Person,
    RecordID,
    ServiceStatus,
    Settings,
    StreamID,
    Transcript,
    TranscriptionResult,
    Waveform,
} from '../types'


type CommandCall = Record<string, unknown>
type ListTag = 'ul' | 'ol'
type Segment = Transcript['segments'][number]

interface CallbackEntry {
    callback: EventCallback
    once: boolean
}

interface ListenerEntry {
    event: string
    callback_id: number
}

interface MockStore {
    settings: Settings
    service_api_keys: Record<APIEndpointPurpose, string>
    endpoints: APIEndpoint[]
    notes_templates: NotesTemplate[]
    people: Person[]
    groups: Group[]
    jobs: JobMeta[]
    notes_markdown: Map<string, string>
    transcripts: Map<string, Transcript>
    callbacks: Map<number, CallbackEntry>
    listeners: Map<number, ListenerEntry>
    streams_cancelled: Set<string>
    callback_id_next: number
    listener_id_next: number
}

interface Identified {
    id: string
}

interface PayloadFields {
    group: Group
    patch: JobMetaPatch
    person: Person
    settings: Settings
    template: NotesTemplate
    transcript: Transcript
}

const API_HOST = 'https://ai.example.invalid'
const CHUNK_DELAY_MS = 45
const COMMAND_FAMILY_JOB = /^(?:job|transcript)/
const COMMAND_FAMILY_NOTES = /^(?:markdown|notes)_/
const COMMAND_FAMILY_PEOPLE = /^(?:group|people|person)/
const DURATION_SECONDS_SAMPLE = 144
const ENDPOINT_ID_NOTES = 'builtin-notes'
const ENDPOINT_ID_TRANSCRIPTION = 'builtin-transcription'
const JOB_ID_SAMPLE = '86dfb1d3b0140ecf2fd59075421f1cb5'
const JOB_ID_SAMPLE_SECOND = '47ead100cc5cd956aa10b3c4d5e6f708'
const KEY_LENGTH_MAX = 64
const RECORDING_PATH_SAMPLE = 'C:\\Users\\mock\\Music\\scribe\\Recording mock.wav'
const RECORDINGS_DIRECTORY_SAMPLE = 'C:\\Users\\mock\\Music\\scribe'
const SECONDS_PER_LINE = 18
const SEGMENT_DELAY_MS = 260
const SNIPPET_CHARS_AFTER = 80
const SNIPPET_CHARS_BEFORE = 40
const SOURCE_PATH_IMPORTED = '(imported transcript)'
const STREAM_EVENT_NOTES = 'notes_generate_chunk'
const TAURI_EVENT_INTERNALS = '__TAURI_EVENT_PLUGIN_INTERNALS__'
const TAURI_INTERNALS = '__TAURI_INTERNALS__'
const TRANSCRIPTION_STAGE = 'transcription_stage'
const WAVEFORM_BAR_COUNT_MAX = 2000

const NOTES_SAMPLE_LINES = Object.freeze([
    '# Weekly platform sync',
    '',
    '## Summary',
    '',
    'The team agreed to ship the transcription retry work this week [0:12].',
    'The offline banner copy is due before the release [1:48].',
    '',
    '## Decisions',
    '',
    '- Retry policy lives in one place per integration [0:34]',
    '- Chunked upload stays capped at eight parallel requests [2:05]',
    '',
    '## Action items',
    '',
    '- [ ] Dana: measure upload latency on a 90 minute recording [2:31]',
    '- [ ] Sam: draft the offline banner copy [3:02]',
])

const NOTES_SAMPLE = NOTES_SAMPLE_LINES.join('\n')

const REPLIES_FIXED: ReadonlyMap<string, unknown> = new Map<string, unknown>([
    ['job_audio_clip_get', null],
    ['job_audio_path_get', null],
    [
        'notes_models_list',
        {
            models: ['stratus.qwen3827b', 'stratus.thinking', 'stratus.turbo'],
            model_default: 'stratus.thinking',
        },
    ],
    ['plugin:app|identifier', 'com.stratusadv.scribe'],
    ['plugin:app|name', 'scribe'],
    ['plugin:app|tauri_version', '2.11.0'],
    ['plugin:app|version', '0.1.0-browser-mock'],
    ['plugin:dialog|save', '/home/you/Documents/notes.docx'],
    ['plugin:path|resolve_directory', '/home/you/Documents'],
    ['plugin:updater|check', null],
    ['recording_append', null],
    ['recording_discard', null],
    ['recording_finish', RECORDING_PATH_SAMPLE],
    ['recording_start', RECORDING_PATH_SAMPLE],
    ['recordings_directory_default', RECORDINGS_DIRECTORY_SAMPLE],
    ['window_resize_rendered', null],
])

const SEED_ENDPOINTS: readonly APIEndpoint[] = Object.freeze([
    {
        id: ENDPOINT_ID_NOTES,
        name: 'Stratus Thinking (browser mock)',
        purpose: 'notes',
        host: API_HOST,
        api_key: '',
        model: 'stratus.thinking',
        temperature: null,
        output_tokens_max: null,
        api_path_chat: null,
        api_path_transcribe: null,
        transcribe_verbose: null,
        transcribe_chunk_seconds: null,
        has_api_key: true,
    },
    {
        id: ENDPOINT_ID_TRANSCRIPTION,
        name: 'Stratus Listen (browser mock)',
        purpose: 'transcription',
        host: API_HOST,
        api_key: '',
        model: 'stratus.listen',
        temperature: null,
        output_tokens_max: null,
        api_path_chat: null,
        api_path_transcribe: null,
        transcribe_verbose: false,
        transcribe_chunk_seconds: 30,
        has_api_key: true,
    },
])

const SEED_JOBS: readonly JobMeta[] = Object.freeze([
    {
        id: JOB_ID_SAMPLE,
        source_path: '/home/you/recordings/weekly-sync.m4a',
        source_size_bytes: 55326134,
        created_at_unix: 1775000000,
        recorded_at_unix: 1774990000,
        label: 'weekly-sync.m4a',
        title: 'Weekly platform sync',
        attendees: ['John Doe', 'Jane Doe', 'Sam Smith'],
        person_ids: ['person-john', 'person-jane'],
        person_ids_mentioned: ['person-sam'],
        project: 'scribe',
        tags: ['meeting-notes', 'platform'],
        favourite: true,
    },
    {
        id: JOB_ID_SAMPLE_SECOND,
        source_path: '/home/you/recordings/discovery-call.wav',
        source_size_bytes: 18220400,
        created_at_unix: 1774600000,
        recorded_at_unix: null,
        label: 'discovery-call.wav',
        title: null,
        attendees: [],
        person_ids: [],
        person_ids_mentioned: [],
        project: null,
        tags: [],
        favourite: false,
    },
])

const SEED_NOTES_TEMPLATES: readonly NotesTemplate[] = Object.freeze([
    {
        id: 'default-meeting-notes',
        name: 'Meeting notes',
        description: 'A summary, the decisions, and who does what next.',
        instructions: [
            '## Summary',
            '',
            'A short summary.',
            '',
            '## Decisions',
            '',
            'What was decided.',
            '',
            '## To do',
            '',
            '- [ ] Who does what.',
        ].join('\n'),
        edited: false,
    },
    {
        id: 'default-standup',
        name: 'Stand-up digest',
        description: 'What each person did, what is next, and what is blocking them.',
        instructions: [
            '## Done',
            '',
            'What each person did.',
            '',
            '## Next',
            '',
            'What they will do next.',
            '',
            '## Blocked',
            '',
            'What is in their way.',
        ].join('\n'),
        edited: false,
    },
])

const SEED_PEOPLE: readonly Person[] = Object.freeze([
    {
        id: 'person-john',
        name_first: 'John',
        name_last: 'Doe',
        role: 'Developer',
        description: 'Builds scribe. Usually runs the platform sync.',
    },
    {
        id: 'person-jane',
        name_first: 'Jane',
        name_last: 'Doe',
        role: 'Product owner',
        description: 'Decides what ships next.',
    },
    {
        id: 'person-sam',
        name_first: 'Sam',
        name_last: 'Smith',
        role: 'Client',
        description: '',
    },
])

const SEED_SETTINGS: Readonly<Settings> = Object.freeze({
    notes_template_id_default: 'default-meeting-notes',
    theme: 'dark',
    palette: null,
    recordings_directory: null,
    notes_model: null,
    notes_thinking: null,
    api_host: null,
    jobs_view: null,
})

const store = store_new()


export function tauri_browser_mock_install(): void {
    assert(!Reflect.has(window, TAURI_INTERNALS))
    assert(!Reflect.has(window, TAURI_EVENT_INTERNALS))

    const metadata = Object.fromEntries([
        ['currentWindow', { label: 'main' }],
        ['currentWebview', { label: 'main' }],
    ])

    const internals = Object.fromEntries<unknown>([
        ['invoke', invoke_mock],
        ['transformCallback', callback_transform],
        ['unregisterCallback', callback_unregister],
        ['convertFileSrc', file_source_convert],
        ['metadata', metadata],
        ['plugins', {}],
    ])

    const event_internals = Object.fromEntries([['unregisterListener', listener_unregister]])

    Reflect.set(window, TAURI_INTERNALS, internals)
    Reflect.set(window, TAURI_EVENT_INTERNALS, event_internals)

    log_information('[scribe] browser mock backend active: no Tauri, no real network calls')
}

function callback_transform(callback: EventCallback, once: boolean): number {
    assert(typeof callback === 'function')

    store.callback_id_next += 1

    const id = store.callback_id_next - 1

    assert(!store.callbacks.has(id), 'a callback id was handed out twice')

    store.callbacks.set(id, { callback, once })

    assert(id > 0)

    return id
}

function callback_unregister(id: number): void {
    assert(Number.isInteger(id))
    assert(id > 0)

    void store.callbacks.delete(id)
}

function command_dispatch(command: string, call: CommandCall): unknown {
    assert(command.length > 0)
    assert(typeof call === 'object')

    if (REPLIES_FIXED.has(command)) return REPLIES_FIXED.get(command)
    if (command.startsWith('plugin:')) return commands_plugin(command, call)
    if (COMMAND_FAMILY_JOB.test(command)) return commands_job(command, call)
    if (COMMAND_FAMILY_NOTES.test(command)) return commands_notes(command, call)
    if (COMMAND_FAMILY_PEOPLE.test(command)) return commands_people(command, call)

    return commands_core(command, call)
}

function command_unknown(command: string): null {
    assert(command.length > 0)
    assert(!REPLIES_FIXED.has(command))

    log_warn(`[scribe] browser mock has no handler for "${command}"`)

    return null
}

function commands_core(command: string, call: CommandCall): unknown {
    assert(command.length > 0)
    assert(typeof call === 'object')

    switch (command) {
        case 'app_relaunch':
            window.location.reload()

            return null
        case 'endpoints_list':
            return endpoints_list()
        case 'service_api_key_set':
            return service_api_key_set(call)
        case 'service_status':
            return service_status()
        case 'settings_get':
            return { ...store.settings }
        case 'settings_update':
            return Object.assign(store.settings, record_field(call, 'settings'))
        case 'task_cancel':
            return store.streams_cancelled.add(text_field(call, 'stream_id'))
        default:
            return command_unknown(command)
    }
}

function commands_job(command: string, call: CommandCall): unknown {
    assert(command.length > 0)
    assert(typeof call === 'object')

    switch (command) {
        case 'job_delete':
            return record_remove(store.jobs, text_field(call, 'job_id'))
        case 'job_meta_get':
            return job_find(text_field(call, 'job_id'))
        case 'job_meta_update':
            return job_meta_update(call)
        case 'job_transcript_engines_list':
            return store.transcripts.has(text_field(call, 'job_id')) ? ['stratus.listen'] : []
        case 'job_transcript_load':
            return store.transcripts.get(text_field(call, 'job_id')) ?? null
        case 'job_transcript_save':
            return store.transcripts.set(
                text_field(call, 'job_id'),
                record_field(call, 'transcript'),
            )
        case 'job_waveform_get':
            return job_waveform(call)
        case 'jobs_list':
            return jobs_list()
        case 'jobs_search':
            return jobs_search(text_field(call, 'query'))
        case 'transcript_correct_streaming':
            return transcript_correct(call)
        case 'transcript_import':
            return transcript_import(text_field(call, 'transcript_text'))
        case 'transcription_remote':
            return transcription_remote(call)
        default:
            return command_unknown(command)
    }
}

function commands_notes(command: string, call: CommandCall): unknown {
    assert(command.length > 0)
    assert(typeof call === 'object')

    switch (command) {
        case 'markdown_render_html':
            return markdown_html_render(text_field(call, 'markdown'))
        case 'notes_export':
            return field_of(call, 'target_path')
        case 'notes_generate_remote_streaming':
            return stream_text_emit(text_field(call, 'stream_id'), NOTES_SAMPLE)
        case 'notes_load':
            return store.notes_markdown.get(text_field(call, 'job_id')) ?? null
        case 'notes_print':
            window.print()

            return null
        case 'notes_save':
            return store.notes_markdown.set(
                text_field(call, 'job_id'),
                text_field(call, 'markdown'),
            )
        case 'notes_template_delete':
            return record_remove(store.notes_templates, text_field(call, 'id'))
        case 'notes_template_generate':
            return template_layout_sample(text_field(call, 'description'))
        case 'notes_template_save':
            return record_upsert(store.notes_templates, {
                ...record_field(call, 'template'),
            })
        case 'notes_templates_list':
            return store.notes_templates.map((template) => ({ ...template }))
        case 'notes_text_rewrite_streaming':
            return stream_text_emit(
                text_field(call, 'stream_id'),
                text_field(call, 'text').toUpperCase(),
            )
        default:
            return command_unknown(command)
    }
}

function commands_people(command: string, call: CommandCall): unknown {
    assert(command.length > 0)
    assert(typeof call === 'object')

    switch (command) {
        case 'group_remove':
            return record_remove(store.groups, text_field(call, 'id'))
        case 'group_save':
            return record_upsert(store.groups, group_copy(record_field(call, 'group')))
        case 'groups_list':
            return store.groups.map(group_copy)
        case 'people_list':
            return store.people.map((person) => ({ ...person }))
        case 'person_remove':
            return person_remove(text_field(call, 'id'))
        case 'person_save':
            return record_upsert(store.people, { ...record_field(call, 'person') })
        default:
            return command_unknown(command)
    }
}

function path_join(call: CommandCall): string {
    assert(typeof call === 'object')

    const parts = field_of(call, 'paths')

    assert(Array.isArray(parts))
    assert(parts.length > 0)

    return parts.join('/')
}

function commands_plugin(command: string, call: CommandCall): unknown {
    assert(command.length > 0)
    assert(typeof call === 'object')

    switch (command) {
        case 'plugin:dialog|open':
            return dialog_open(call)
        case 'plugin:event|emit':
        case 'plugin:event|emit_to':
            event_emit(text_field(call, 'event'), field_of(call, 'payload'))

            return null
        case 'plugin:event|listen':
            return event_listen(call)
        case 'plugin:event|unlisten':
            return store.listeners.delete(number_field(call, 'eventId'))
        case 'plugin:path|join':
            return path_join(call)
        case 'plugin:opener|open_path':
            log_information('[scribe] mock openPath', field_of(call, 'path'))

            return null
        case 'plugin:opener|open_url':
            return window.open(text_field(call, 'url'), '_blank', 'noopener')
        case 'plugin:opener|reveal_item_in_dir':
            log_information('[scribe] mock revealItemInDir', field_of(call, 'path'))

            return null
        default:
            return command_unknown(command)
    }
}

function dialog_open(call: CommandCall): string {
    assert(typeof call === 'object')

    const options = field_of(call, 'options')

    assert(options === undefined || typeof options === 'object')

    const directory = options === undefined ? false : field_of(options, 'directory') === true

    return directory ? '/home/you/Music/meetings' : '/home/you/recordings/weekly-sync.m4a'
}

function endpoints_list(): APIEndpoint[] {
    assert(store.endpoints.length > 0)
    assert(store.endpoints.every((endpoint) => endpoint.purpose.length > 0))

    return store.endpoints.map((endpoint) => ({
        ...endpoint,
        has_api_key: store.service_api_keys[endpoint.purpose].length > 0,
    }))
}

function event_emit(name: string, payload: unknown): void {
    assert(name.length > 0)
    assert(store.listeners.size >= 0)

    for (const [listener_id, listener] of store.listeners) {
        if (listener.event !== name) continue

        const entry = store.callbacks.get(listener.callback_id)

        if (entry === undefined) continue

        entry.callback({ event: name, id: listener_id, payload })

        if (entry.once) void store.callbacks.delete(listener.callback_id)
    }
}

function event_listen(call: CommandCall): number {
    assert(typeof call === 'object')

    store.listener_id_next += 1

    const listener_id = store.listener_id_next - 1

    assert(!store.listeners.has(listener_id), 'a listener id was handed out twice')

    store.listeners.set(listener_id, {
        event: text_field(call, 'event'),
        callback_id: number_field(call, 'handler'),
    })

    assert(listener_id > 0)

    return listener_id
}

function field_of(value: unknown, key: string): unknown {
    assert(value !== null)
    assert(key.length > 0)
    assert(key.length <= KEY_LENGTH_MAX)

    if (typeof value !== 'object') return undefined

    const field: unknown = Object.getOwnPropertyDescriptor(value, key)?.value

    return field
}

function file_source_convert(path: string): string {
    assert(typeof path === 'string')
    assert(path.length >= 0)

    return path
}

function group_copy(group: Group): Group {
    assert(typeof group.id === 'string')
    assert(Array.isArray(group.person_ids))

    return { ...group, person_ids: [...group.person_ids] }
}

function html_escape(text: string): string {
    assert(typeof text === 'string')
    assert(text.length >= 0)

    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}

function inline_html_render(text: string): string {
    assert(typeof text === 'string')
    assert(text.length >= 0)

    return html_escape(text)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
}

async function invoke_mock(command: string, call?: CommandCall): Promise<unknown> {
    assert(command.length > 0)
    assert(call === undefined || typeof call === 'object')

    return Promise.resolve().then(() => command_dispatch(command, call ?? {}))
}

function job_find(job_id: JobID): JobMeta | null {
    assert(typeof job_id === 'string')

    const found = store.jobs.find((job) => job.id === job_id) ?? null

    assert(found === null || found.id === job_id)

    return found
}

function job_meta_update(call: CommandCall): JobMeta {
    assert(typeof call === 'object')

    const job = job_find(text_field(call, 'job_id'))

    if (job === null) throw new Error('job not found')

    const patch = { ...record_field(call, 'patch') }

    if (patch.title !== undefined) patch.title = text_clean(patch.title)
    if (patch.project !== undefined) patch.project = text_clean(patch.project)

    Object.assign(job, patch)

    assert(job.id.length > 0)

    return { ...job }
}

function job_waveform(call: CommandCall): Waveform | null {
    assert(typeof call === 'object')

    const job = job_find(text_field(call, 'job_id'))

    if (job?.source_path === SOURCE_PATH_IMPORTED) return null

    const waveform = waveform_build(number_field(call, 'bar_count'))

    assert(waveform.peaks.length <= WAVEFORM_BAR_COUNT_MAX, 'the waveform has too many bars')

    return waveform
}

function jobs_list(): JobListing[] {
    assert(Array.isArray(store.jobs))
    assert(store.transcripts.size >= 0)

    return store.jobs.map((job) => {
        const imported = job.source_path === SOURCE_PATH_IMPORTED

        return {
            ...job,
            has_transcript: store.transcripts.has(job.id),
            has_notes: store.notes_markdown.has(job.id),
            duration_seconds: imported ? null : DURATION_SECONDS_SAMPLE,
        }
    })
}

function jobs_search(query: string): JobSearchHit[] {
    assert(typeof query === 'string')

    const needle = query.trim().toLowerCase()

    if (needle.length === 0) return []

    const hits: JobSearchHit[] = []

    for (const job of store.jobs) {
        const notes = store.notes_markdown.get(job.id) ?? ''
        const transcript = store.transcripts.get(job.id)?.text ?? ''
        const notes_position = notes.toLowerCase().indexOf(needle)
        const transcript_position = transcript.toLowerCase().indexOf(needle)

        if (notes_position >= 0) {
            hits.push({
                job_id: job.id,
                source: 'notes',
                snippet: snippet_around(notes, notes_position),
            })

            continue
        }

        if (transcript_position >= 0) {
            hits.push({
                job_id: job.id,
                source: 'transcript',
                snippet: snippet_around(transcript, transcript_position),
            })
        }
    }

    assert(hits.length <= store.jobs.length, 'a job matched more than once')

    return hits
}

function list_close(html: string[], current: ListTag | null): void {
    assert(Array.isArray(html))
    assert(current === null || current.length > 0)

    if (current !== null) html.push(`</${current}>`)
}

function list_open_ensure(html: string[], current: ListTag | null, wanted: ListTag): ListTag {
    assert(Array.isArray(html))
    assert(wanted.length > 0)
    assert(current === null || current.length > 0)

    if (current === wanted) return current
    if (current !== null) html.push(`</${current}>`)

    html.push(`<${wanted}>`)

    return wanted
}

function listener_unregister(event_name: string, listener_id: number): void {
    assert(typeof event_name === 'string')
    assert(Number.isInteger(listener_id))

    const listener = store.listeners.get(listener_id)

    if (listener !== undefined) void store.callbacks.delete(listener.callback_id)

    void store.listeners.delete(listener_id)
}

function markdown_html_render(markdown: Markdown): string {
    assert(typeof markdown === 'string')

    const html: string[] = []
    let list_open: ListTag | null = null
    let code_open = false

    for (const line of markdown.split('\n')) {
        if (line.trimStart().startsWith('```')) {
            html.push(code_open ? '</code></pre>' : '<pre><code>')
            code_open = !code_open

            continue
        }

        if (code_open) {
            html.push(html_escape(line))

            continue
        }

        list_open = markdown_line_render(html, line, list_open)
    }

    list_close(html, list_open)

    if (code_open) html.push('</code></pre>')

    assert(html.length >= 0)

    return html.join('\n')
}

function markdown_line_render(
    html: string[],
    line: string,
    list_open: ListTag | null,
): ListTag | null {
    assert(Array.isArray(html))
    assert(typeof line === 'string')
    assert(list_open === null || list_open.length > 0)

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+\.\s+(.*)$/.exec(line)
    const quote = /^>\s?(.*)$/.exec(line)

    if (heading !== null) {
        const level = String((heading[1] ?? '#').length)

        list_close(html, list_open)

        html.push(`<h${level}>${inline_html_render(heading[2] ?? '')}</h${level}>`)

        return null
    }

    if (bullet !== null) {
        const list = list_open_ensure(html, list_open, 'ul')

        html.push(`<li>${inline_html_render(bullet[1] ?? '')}</li>`)

        return list
    }

    if (numbered !== null) {
        const list = list_open_ensure(html, list_open, 'ol')

        html.push(`<li>${inline_html_render(numbered[1] ?? '')}</li>`)

        return list
    }

    list_close(html, list_open)

    if (quote !== null) {
        html.push(`<blockquote>${inline_html_render(quote[1] ?? '')}</blockquote>`)

        return null
    }

    if (line.trim().length === 0) return null

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
        html.push('<hr/>')

        return null
    }

    html.push(`<p>${inline_html_render(line)}</p>`)

    return null
}

function notes_markdown_seed(): Map<string, string> {
    assert(JOB_ID_SAMPLE.length > 0)
    assert(NOTES_SAMPLE.length > 0)

    return new Map<string, string>([[JOB_ID_SAMPLE, NOTES_SAMPLE]])
}

function number_field(value: unknown, key: string): number {
    assert(value !== undefined)
    assert(key.length > 0)

    const field = field_of(value, key)

    assert(typeof field === 'number')

    return field
}

function payload_is<Key extends keyof PayloadFields>(
    key: Key,
    value: unknown,
): value is PayloadFields[Key] {
    assert(key.length > 0)
    assert(value !== undefined)

    return typeof value === 'object' && value !== null
}

function person_remove(id: RecordID): null {
    assert(typeof id === 'string')
    assert(id.length > 0)

    record_remove(store.people, id)

    for (const group of store.groups) {
        group.person_ids = group.person_ids.filter((person_id) => person_id !== id)
    }

    return null
}

function record_field<Key extends keyof PayloadFields>(
    value: unknown,
    key: Key,
): PayloadFields[Key] {
    assert(value !== undefined)
    assert(key.length > 0)

    const field = field_of(value, key)

    assert(payload_is(key, field))

    return field
}

function record_remove(items: Identified[], id: RecordID): null {
    assert(Array.isArray(items))
    assert(typeof id === 'string')

    const index = items.findIndex((item) => item.id === id)

    if (index >= 0) void items.splice(index, 1)

    return null
}

function record_upsert<Item extends Identified>(items: Item[], item: Item): null {
    assert(Array.isArray(items))
    assert(typeof item.id === 'string')

    const index = items.findIndex((existing) => existing.id === item.id)

    if (index < 0) {
        items.push(item)

        return null
    }

    void items.splice(index, 1, item)

    return null
}

function service_api_key_set(call: CommandCall): null {
    assert(typeof call === 'object')

    const purpose = text_field(call, 'purpose')

    assert(purpose === 'notes' || purpose === 'transcription')

    store.service_api_keys[purpose] = text_field(call, 'api_key').trim()

    return null
}

function service_api_keys_seed(): Record<APIEndpointPurpose, string> {
    assert(typeof window === 'object')

    const run_first = new URLSearchParams(window.location.search).has('first-run')

    assert(typeof run_first === 'boolean')

    if (run_first) return { notes: '', transcription: '' }

    return { notes: 'mock-key', transcription: 'mock-key' }
}

function service_status(): ServiceStatus {
    assert(typeof store.service_api_keys.notes === 'string')
    assert(typeof store.service_api_keys.transcription === 'string')

    return {
        host: { builtin: true, user: store.settings.api_host !== null },
        notes: {
            builtin: false,
            length: store.service_api_keys.notes.length,
            user: store.service_api_keys.notes.length > 0,
        },
        transcription: {
            builtin: false,
            length: store.service_api_keys.transcription.length,
            user: store.service_api_keys.transcription.length > 0,
        },
    }
}

async function sleep(milliseconds: number): Promise<void> {
    assert(Number.isFinite(milliseconds))
    assert(milliseconds > 0)

    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds)
    })
}

function snippet_around(text: string, position: number): string {
    assert(position >= 0)
    assert(position <= text.length)

    const start = Math.max(0, position - SNIPPET_CHARS_BEFORE)
    const end = Math.min(text.length, position + SNIPPET_CHARS_AFTER)
    const lead = start > 0 ? '…' : ''
    const body = text.slice(start, end).replace(/\s+/g, ' ')
    const tail = end < text.length ? '…' : ''

    return `${lead}${body}${tail}`
}

function store_new(): MockStore {
    assert(SEED_ENDPOINTS.length > 0)
    assert(SEED_JOBS.length > 0)

    return {
        settings: { ...SEED_SETTINGS },
        service_api_keys: service_api_keys_seed(),
        endpoints: [...structuredClone(SEED_ENDPOINTS)],
        notes_templates: [...structuredClone(SEED_NOTES_TEMPLATES)],
        people: [...structuredClone(SEED_PEOPLE)],
        groups: [
            { id: 'group-team', name: 'Product team', person_ids: ['person-john', 'person-jane'] },
        ],
        jobs: [...structuredClone(SEED_JOBS)],
        notes_markdown: notes_markdown_seed(),
        transcripts: transcripts_seed(),
        callbacks: new Map<number, CallbackEntry>(),
        listeners: new Map<number, ListenerEntry>(),
        streams_cancelled: new Set<string>(),
        callback_id_next: 1,
        listener_id_next: 1,
    }
}

async function stream_text_emit(stream_id: StreamID, text: Markdown): Promise<string> {
    assert(stream_id.length > 0)
    assert(typeof text === 'string')

    void store.streams_cancelled.delete(stream_id)

    const words = text.split(/(\s+)/)

    const sent = words.reduce(
        async (sent_so_far, word) => {
            const sent_text = await sent_so_far

            return stream_word_emit(stream_id, sent_text, word)
        },
        Promise.resolve(''),
    )

    return sent.then((sent_text) => {
        event_emit(STREAM_EVENT_NOTES, { stream_id, text: '', done: true })

        void store.streams_cancelled.delete(stream_id)

        return sent_text
    })
}

async function stream_word_emit(
    stream_id: StreamID,
    sent_text: string,
    word: Markdown,
): Promise<string> {
    assert(stream_id.length > 0)
    assert(typeof word === 'string')
    assert(typeof sent_text === 'string')

    if (store.streams_cancelled.has(stream_id)) return sent_text

    event_emit(STREAM_EVENT_NOTES, { stream_id, text: word, done: false })

    return sleep(CHUNK_DELAY_MS).then(() => sent_text + word)
}

function strings_field(value: unknown, key: string): string[] {
    assert(value !== undefined)
    assert(key.length > 0)

    const field = field_of(value, key)

    assert(Array.isArray(field))
    assert(field.every((item) => typeof item === 'string'))

    return field
}

function template_layout_sample(description: string): Markdown {
    assert(typeof description === 'string')
    assert(description.length >= 0)

    return [
        '## Summary',
        '',
        `Two or three sentences on what "${description}" covered.`,
        '',
        '## Decisions',
        '',
        '- One bullet per decision made, with who made it.',
        '',
        '## Actions',
        '',
        '| Who | What | By when |',
        '| --- | --- | --- |',
        '| The person responsible | The task in one line | The date agreed |',
        '',
    ].join('\n')
}

function text_clean(text: string | null): string | null {
    assert(text === null || typeof text === 'string')

    const trimmed = text?.trim() ?? ''

    assert(trimmed.length >= 0)

    return trimmed.length > 0 ? trimmed : null
}

function text_field(value: unknown, key: string): string {
    assert(value !== undefined)
    assert(key.length > 0)

    const field = field_of(value, key)

    assert(typeof field === 'string')

    return field
}

function transcript_build(lines: string[]): Transcript {
    assert(Array.isArray(lines))
    assert(Number.isInteger(SECONDS_PER_LINE))

    const segments = lines.map((text, index) => ({
        text,
        start_seconds: index * SECONDS_PER_LINE,
        end_seconds: (index + 1) * SECONDS_PER_LINE,
    }))

    return { text: lines.join(' '), segments }
}

async function transcript_correct(call: CommandCall): Promise<LineCorrection[]> {
    assert(typeof call === 'object')

    const lines = strings_field(call, 'lines')
    const instruction = text_field(call, 'instruction')

    const corrections = lines.flatMap((text, index) =>
        text.includes(instruction) ? [{ index, text: text.toUpperCase() }] : [])

    assert(corrections.length <= lines.length)

    return sleep(CHUNK_DELAY_MS * 10).then(() => corrections)
}

function transcript_import(text: string): TranscriptionResult {
    assert(typeof text === 'string')

    const lines = text.split('\n').filter((line) => line.trim().length > 0)

    assert(lines.length >= 0)

    return { job_id: JOB_ID_SAMPLE, transcript: transcript_build(lines), cached: false }
}

async function transcription_remote(call: CommandCall): Promise<TranscriptionResult> {
    assert(typeof call === 'object')

    const stream_id = field_of(call, 'stream_id')

    assert(stream_id === null || typeof stream_id === 'string')

    const transcript = store.transcripts.get(JOB_ID_SAMPLE)
        ?? transcript_build(['No sample audio.'])

    const result = { job_id: JOB_ID_SAMPLE, transcript, cached: false }

    return transcription_stream_emit(stream_id, transcript).then(() => result)
}

function transcription_segment_emit(stream_id: StreamID, segment: Segment): Promise<void> | null {
    assert(stream_id.length > 0)
    assert(typeof segment.text === 'string')

    if (store.streams_cancelled.has(stream_id)) return null

    event_emit('transcription_segment', {
        stream_id,
        text: segment.text,
        start_seconds: segment.start_seconds,
        end_seconds: segment.end_seconds,
    })

    return sleep(SEGMENT_DELAY_MS)
}

async function transcription_stream_emit(
    stream_id: StreamID | null,
    transcript: Transcript,
): Promise<void> {
    assert(stream_id === null || stream_id.length > 0)
    assert(Array.isArray(transcript.segments))

    if (stream_id === null) return

    void store.streams_cancelled.delete(stream_id)

    event_emit(TRANSCRIPTION_STAGE, { stream_id, stage: 'preparing_audio' })

    let chain = sleep(SEGMENT_DELAY_MS).then(() => {
        event_emit(TRANSCRIPTION_STAGE, { stream_id, stage: 'transcribing' })
    })

    for (const segment of transcript.segments) {
        chain = chain.then(async () => {
            await transcription_segment_emit(stream_id, segment)
        })
    }

    return chain.then(() => {
        event_emit(TRANSCRIPTION_STAGE, { stream_id, stage: 'done' })

        void store.streams_cancelled.delete(stream_id)
    })
}

function transcripts_seed(): Map<string, Transcript> {
    assert(JOB_ID_SAMPLE.length > 0)
    assert(JOB_ID_SAMPLE_SECOND.length > 0)

    const sample_first = transcript_build([
        'Alright, everyone is here, so let us start with transcription.',
        'The retry work is close. I want it merged before Thursday.',
        'One caveat: the remote endpoint rejects verbose_json, so segments are synthesized.',
        'That means the waveform overlay is coarser than it looks on Whisper proper.',
        'The release stays behind the flag until the copy lands.',
        'Dana, can you measure upload latency on a ninety minute recording?',
        'Yes. I will have numbers by tomorrow afternoon.',
        'Sam is drafting the offline banner copy, so we can close that one out.',
    ])

    const sample_second = transcript_build([
        'Thanks for making time. Tell me about your current note taking.',
        'We record everything and then nobody writes it up.',
        'That is the gap we are trying to close.',
    ])

    return new Map<string, Transcript>([
        [JOB_ID_SAMPLE, sample_first],
        [JOB_ID_SAMPLE_SECOND, sample_second],
    ])
}

function waveform_build(bar_count: number): Waveform {
    assert(Number.isFinite(bar_count))

    const count = Math.min(Math.max(bar_count, 1), WAVEFORM_BAR_COUNT_MAX)
    const peaks = new Array<number>(count)

    for (let index = 0; index < count; index += 1) {
        const envelope = 0.35 + 0.45 * Math.abs(Math.sin(index / 11))

        peaks[index] = envelope * (0.6 + 0.4 * Math.abs(Math.sin(index / 3.7)))
    }

    assert(peaks.length === count)

    return { peaks, duration_seconds: DURATION_SECONDS_SAMPLE }
}
