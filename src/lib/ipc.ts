import { invoke } from '@tauri-apps/api/core'
import { assert } from './assert'
import type { InvokeArgs } from '@tauri-apps/api/core'
import type {
    APIEndpoint,
    APIEndpointPurpose,
    APIKey,
    AudioPath,
    EndpointID,
    EngineID,
    Group,
    Instruction,
    JobID,
    JobListing,
    JobMeta,
    JobMetaPatch,
    JobSearchHit,
    LineCorrection,
    Markdown,
    NotesModels,
    NotesTemplate,
    Person,
    RecordID,
    SecondsEnd,
    SecondsStart,
    ServiceStatus,
    Settings,
    StreamID,
    TargetPath,
    TemplateID,
    Title,
    Transcript,
    TranscriptText,
    TranscriptionResult,
    Waveform,
    WindowSize,
} from '../types'


async function invoke_void(command: string, call?: InvokeArgs): Promise<void> {
    assert(command.length > 0)
    assert(call === undefined || typeof call === 'object')

    return invoke(command, call)
}

function query<Reply>(command: string): () => Promise<Reply> {
    assert(command.length > 0)
    assert(!command.includes(' '))

    return (invoke<Reply>).bind(undefined, command)
}

export const ipc = Object.freeze({
    app_relaunch: query<undefined>('app_relaunch'),
    endpoints_list: query<APIEndpoint[]>('endpoints_list'),
    async group_remove(id: RecordID): Promise<void> {
        assert(typeof id === 'string')

        return invoke_void('group_remove', { id })
    },
    async group_save(group: Group): Promise<void> {
        assert(typeof group.id === 'string')
        assert(Array.isArray(group.person_ids))

        return invoke_void('group_save', { group })
    },
    groups_list: query<Group[]>('groups_list'),
    async job_audio_clip_get(
        job_id: JobID,
        start_seconds: SecondsStart,
        end_seconds: SecondsEnd,
    ): Promise<string | null> {
        assert(job_id.length > 0)
        assert(typeof start_seconds === 'number')
        assert(typeof end_seconds === 'number')

        return invoke<string | null>('job_audio_clip_get', { job_id, start_seconds, end_seconds })
    },
    async job_audio_path_get(job_id: JobID): Promise<string | null> {
        assert(typeof job_id === 'string')
        assert(job_id.length > 0)

        return invoke<string | null>('job_audio_path_get', { job_id })
    },
    async job_delete(job_id: JobID): Promise<void> {
        assert(typeof job_id === 'string')
        assert(job_id.length > 0)

        return invoke_void('job_delete', { job_id })
    },
    async job_meta_get(job_id: JobID): Promise<JobMeta | null> {
        assert(typeof job_id === 'string')
        assert(job_id.length > 0)

        return invoke<JobMeta | null>('job_meta_get', { job_id })
    },
    async job_meta_update(job_id: JobID, patch: JobMetaPatch): Promise<JobMeta> {
        assert(job_id.length > 0)
        assert(typeof patch === 'object')

        return invoke<JobMeta>('job_meta_update', { job_id, patch })
    },
    async job_transcript_engines_list(job_id: JobID): Promise<string[]> {
        assert(typeof job_id === 'string')
        assert(job_id.length > 0)

        return invoke<string[]>('job_transcript_engines_list', { job_id })
    },
    async job_transcript_load(job_id: JobID, engine_id: EngineID): Promise<Transcript | null> {
        assert(job_id.length > 0)
        assert(typeof engine_id === 'string')

        return invoke<Transcript | null>('job_transcript_load', { job_id, engine_id })
    },
    async job_transcript_save(job_id: JobID, transcript: Transcript): Promise<void> {
        assert(job_id.length > 0)
        assert(Array.isArray(transcript.segments))

        return invoke_void('job_transcript_save', { job_id, transcript })
    },
    async job_waveform_get(job_id: JobID, bar_count: number): Promise<Waveform | null> {
        assert(job_id.length > 0)
        assert(typeof bar_count === 'number')

        return invoke<Waveform | null>('job_waveform_get', { job_id, bar_count })
    },
    jobs_list: query<JobListing[]>('jobs_list'),
    async jobs_search(search: string): Promise<JobSearchHit[]> {
        assert(typeof search === 'string')

        return invoke<JobSearchHit[]>('jobs_search', { query: search })
    },
    async markdown_render_html(markdown: Markdown): Promise<string> {
        assert(typeof markdown === 'string')
        assert(markdown.length >= 0)

        return invoke<string>('markdown_render_html', { markdown })
    },
    async notes_export(job_id: JobID, target_path: TargetPath): Promise<string> {
        assert(job_id.length > 0)
        assert(target_path.length > 0)

        return invoke<string>('notes_export', { job_id, target_path })
    },
    async notes_generate_remote_streaming(
        stream_id: StreamID,
        job_id: JobID | null,
        transcript_text: TranscriptText,
        template_id: TemplateID,
        endpoint_id: EndpointID,
    ): Promise<string> {
        assert(stream_id.length > 0)
        assert(job_id === null || job_id.length > 0)
        assert(typeof transcript_text === 'string')
        assert(typeof template_id === 'string')
        assert(endpoint_id.length > 0)

        return invoke<string>('notes_generate_remote_streaming', {
            stream_id,
            job_id,
            transcript_text,
            template_id,
            endpoint_id,
        })
    },
    async notes_load(job_id: JobID): Promise<string | null> {
        assert(typeof job_id === 'string')
        assert(job_id.length > 0)

        return invoke<string | null>('notes_load', { job_id })
    },
    notes_models_list: query<NotesModels>('notes_models_list'),
    async notes_print(job_id: JobID): Promise<void> {
        assert(typeof job_id === 'string')
        assert(job_id.length > 0)

        return invoke_void('notes_print', { job_id })
    },
    async notes_save(job_id: JobID, markdown: Markdown): Promise<void> {
        assert(job_id.length > 0)
        assert(typeof markdown === 'string')

        return invoke_void('notes_save', { job_id, markdown })
    },
    async notes_template_delete(id: TemplateID): Promise<void> {
        assert(typeof id === 'string')

        return invoke_void('notes_template_delete', { id })
    },
    async notes_template_generate(
        endpoint_id: EndpointID,
        description: Instruction,
    ): Promise<string> {
        assert(endpoint_id.length > 0)
        assert(typeof description === 'string')

        return invoke<string>('notes_template_generate', { endpoint_id, description })
    },
    async notes_template_save(template: NotesTemplate): Promise<void> {
        assert(typeof template.id === 'string')
        assert(typeof template.instructions === 'string')

        return invoke_void('notes_template_save', { template })
    },
    notes_templates_list: query<NotesTemplate[]>('notes_templates_list'),
    async notes_text_rewrite_streaming(
        stream_id: StreamID,
        endpoint_id: EndpointID,
        text: Markdown,
        instruction: Instruction,
        template_id: TemplateID | null,
    ): Promise<string> {
        assert(stream_id.length > 0)
        assert(endpoint_id.length > 0)
        assert(typeof text === 'string')
        assert(typeof instruction === 'string')
        assert(template_id === null || typeof template_id === 'string')

        return invoke<string>('notes_text_rewrite_streaming', {
            stream_id,
            endpoint_id,
            text,
            instruction,
            template_id,
        })
    },
    people_list: query<Person[]>('people_list'),
    async person_remove(id: RecordID): Promise<void> {
        assert(typeof id === 'string')

        return invoke_void('person_remove', { id })
    },
    async person_save(person: Person): Promise<void> {
        assert(typeof person.id === 'string')
        assert(typeof person.name_first === 'string')

        return invoke_void('person_save', { person })
    },
    async recording_append(pcm_bytes: Uint8Array): Promise<void> {
        assert(pcm_bytes instanceof Uint8Array)
        assert(pcm_bytes.length > 0)

        return invoke_void('recording_append', pcm_bytes)
    },
    recording_discard: query<undefined>('recording_discard'),
    recording_finish: query<string>('recording_finish'),
    async recording_start(sample_rate: number): Promise<string> {
        assert(typeof sample_rate === 'number')

        return invoke<string>('recording_start', { sample_rate })
    },
    recordings_directory_default: query<string>('recordings_directory_default'),
    async service_api_key_set(purpose: APIEndpointPurpose, api_key: APIKey): Promise<void> {
        assert(purpose.length > 0)
        assert(typeof api_key === 'string')

        return invoke_void('service_api_key_set', { purpose, api_key })
    },
    service_status: query<ServiceStatus>('service_status'),
    settings_get: query<Settings>('settings_get'),
    async settings_update(settings: Settings): Promise<void> {
        assert(typeof settings === 'object')
        assert(Object.keys(settings).length > 0)

        return invoke_void('settings_update', { settings })
    },
    async task_cancel(stream_id: StreamID): Promise<void> {
        assert(typeof stream_id === 'string')
        assert(stream_id.length > 0)

        return invoke_void('task_cancel', { stream_id })
    },
    async transcript_correct_streaming(
        stream_id: StreamID,
        endpoint_id: EndpointID,
        lines: string[],
        instruction: Instruction,
    ): Promise<LineCorrection[]> {
        assert(stream_id.length > 0)
        assert(endpoint_id.length > 0)
        assert(Array.isArray(lines))
        assert(typeof instruction === 'string')

        return invoke<LineCorrection[]>('transcript_correct_streaming', {
            stream_id,
            endpoint_id,
            lines,
            instruction,
        })
    },
    async transcript_import(
        title: Title,
        transcript_text: TranscriptText,
    ): Promise<TranscriptionResult> {
        assert(typeof title === 'string')
        assert(typeof transcript_text === 'string')

        return invoke<TranscriptionResult>('transcript_import', { title, transcript_text })
    },
    async transcription_remote(
        audio_path: AudioPath,
        endpoint_id: EndpointID,
        stream_id: StreamID | null,
        transcript_reuse: boolean,
    ): Promise<TranscriptionResult> {
        assert(typeof audio_path === 'string')
        assert(endpoint_id.length > 0)
        assert(stream_id === null || stream_id.length > 0)

        return invoke<TranscriptionResult>('transcription_remote', {
            audio_path,
            endpoint_id,
            stream_id,
            transcript_reuse,
        })
    },
    async window_resize_rendered(size: WindowSize): Promise<void> {
        assert(Number.isSafeInteger(size.height))
        assert(Number.isSafeInteger(size.width))
        assert(size.height >= 0)
        assert(size.width >= 0)

        return invoke_void('window_resize_rendered', { size })
    },
})
