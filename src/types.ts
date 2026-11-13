export type APIKey = string
export type AudioPath = string
export type ChatExchangeState = 'done' | 'failed' | 'stopped'
export type ChatID = string
export type CheckoutSessionID = string
export type EndpointID = string
export type EngineID = string
export type EventCallback = (payload: unknown) => void
export type Instruction = string
export type JobID = string
export type Markdown = string
export type PromoCode = string
export type RecordID = string
export type SecondsEnd = number
export type SecondsStart = number
export type SignInCode = string
export type StreamID = string
export type TargetPath = string
export type TemplateID = string
export type Title = string
export type TranscriptText = string

export interface TranscriptSegment {
    text: string
    start_seconds: number
    end_seconds: number
}

export interface Transcript {
    text: string
    segments: TranscriptSegment[]
}

export interface LineCorrection {
    index: number
    text: string
}

export interface TranscriptionResult {
    job_id: string
    transcript: Transcript
    cached: boolean
}

export interface Waveform {
    peaks: number[]
    duration_seconds: number
}

export type APIEndpointPurpose = 'transcription' | 'notes'

export interface APIEndpoint {
    id: string
    name: string
    purpose: APIEndpointPurpose
    host: string
    api_key: string
    model: string
    temperature: number | null
    output_tokens_max: number | null
    api_path_chat: string | null
    api_path_transcribe: string | null
    transcribe_verbose: boolean | null
    transcribe_chunk_seconds: number | null
    has_api_key: boolean
}

export interface NotesTemplate {
    id: string
    name: string
    description: string
    instructions: string
    edited: boolean
}

export interface Person {
    id: string
    name_first: string
    name_last: string
    role: string
    description: string
}

export interface Group {
    id: string
    name: string
    person_ids: string[]
}

export interface AskScopeChip {
    kind: 'folder' | 'meeting'
    label: string
}

export type FolderName = string

export interface FolderRename {
    from: FolderName
    to: FolderName
}

export interface JobMeta {
    id: string
    source_path: string
    source_size_bytes: number
    created_at_unix: number
    recorded_at_unix: number | null
    label: string | null
    title: string | null
    attendees: string[]
    person_ids: string[]
    person_ids_mentioned: string[]
    project: string | null
    tags: string[]
    favourite: boolean
}

export interface JobListing extends JobMeta {
    has_transcript: boolean
    has_notes: boolean
    duration_seconds: number | null
}

export interface JobMetaPatch {
    title?: string | null
    attendees?: string[]
    person_ids?: string[]
    person_ids_mentioned?: string[]
    project?: string | null
    tags?: string[]
    favourite?: boolean
}

export interface ChatChunk {
    stream_id: string
    text: string
    done: boolean
}

export interface SegmentChunk {
    stream_id: string
    text: string
    start_seconds: number
    end_seconds: number
}

export type TranscriptionStage = 'preparing_audio' | 'transcribing' | 'done'

export interface StageChunk {
    stream_id: string
    stage: TranscriptionStage
}

export type ThemeChoice = 'system' | 'light' | 'dark'
export type ThinkingChoice = 'low' | 'medium' | 'xhigh'
export type JobsViewChoice = 'grid' | 'list'

export type PaletteChoice =
    | 'cubist'
    | 'rose-pine'
    | 'catppuccin'
    | 'nord'
    | 'gruvbox'
    | 'tokyo-night'
    | 'flexoki'
    | 'ayu'
    | 'dracula'
    | 'one'
    | 'iceberg'
    | 'nightfox'
    | 'night-owl'

export interface Settings {
    notes_template_id_default: string | null
    theme: ThemeChoice | null
    palette: PaletteChoice | null
    recordings_directory: string | null
    notes_model: string | null
    notes_thinking: ThinkingChoice | null
    api_host: string | null
    jobs_view: JobsViewChoice | null
    embeddings_host: string | null
    embeddings_model: string | null
}

export interface SearchStatus {
    error: string | null
    model: string | null
    passages: number
    passages_embedded: number
}

export interface NotesModels {
    models: string[]
    model_default: string
}

export interface KeyStatus {
    builtin: boolean
    length: number
    user: boolean
}

export interface SourceStatus {
    builtin: boolean
    user: boolean
}

export interface ServiceStatus {
    host: SourceStatus
    notes: KeyStatus
    transcription: KeyStatus
}

export interface Account {
    balance_seconds: number
    email: string
    name: string
    offers: AccountOffer[]
    payments: boolean
    publishable_key: string
}

export interface AccountOffer {
    currency: string
    hours: number
    price_cents: number
}

export interface AccountSignUp {
    email: string
    name: string
    promo_code: PromoCode
}

export interface AccountStatus {
    billing: boolean
    signed_in: boolean
}

export interface CheckoutFinished {
    account: Account
    paid: boolean
}

export interface CheckoutStarted {
    client_secret: string
    session_id: CheckoutSessionID
}

export type ChunkSource = 'notes' | 'transcript'

export interface JobSearchHit {
    job_id: JobID
    segment_index_first: number | null
    segment_index_last: number | null
    snippet: string
    source: ChunkSource
    start_seconds: number | null
}

export type AskScope =
    | { kind: 'all' }
    | { kind: 'meeting', job_id: JobID }
    | { kind: 'project', project: string }

export interface AskSource {
    end_seconds: number | null
    heading: string | null
    job_id: JobID
    marker: string
    segment_index_first: number | null
    segment_index_last: number | null
    snippet: string
    source: ChunkSource
    start_seconds: number | null
}

export interface AskSources {
    meetings: JobMeta[]
    sources: AskSource[]
    stream_id: StreamID
}

export interface AskTurn {
    answer: string
    question: string
}

export interface ChatExchange {
    answer: string
    error: string | null
    id: string
    question: string
    scope: AskScope
    sources: AskSource[]
    state: ChatExchangeState
}

export interface ChatOpened {
    exchanges: ChatExchange[]
    id: ChatID
    meetings: JobMeta[]
}

export interface ChatSummary {
    id: ChatID
    title: string
    updated_at_unix_ms: number
}

export interface SegmentFocus {
    job_id: JobID
    segment_index_first: number
    segment_index_last: number
}

export interface AIRewriteArgs {
    text: string
    instruction: string
    whole_document: boolean
    on_chunk: (chunk: string) => void
}

export type AIRewriteHandler = (args: AIRewriteArgs) => Promise<string>
export type AIGenerateHandler = (description: string) => Promise<string>

export interface WindowSize {
    height: number
    width: number
}
