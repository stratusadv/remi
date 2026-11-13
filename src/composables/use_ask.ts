import { computed, ref, shallowRef } from 'vue'
import { listen } from '@tauri-apps/api/event'
import { sources_cited } from '../lib/answer'
import { assert } from '../lib/assert'
import { ipc } from '../lib/ipc'
import { log_warn } from '../lib/log'
import { use_endpoints } from './use_endpoints'
import { use_pipeline } from './use_pipeline'
import type { Event } from '@tauri-apps/api/event'
import type {
    AskScope,
    AskSource,
    AskSources,
    AskTurn,
    ChatChunk,
    ChatExchange,
    ChatExchangeState,
    ChatID,
    ChatOpened,
    ChatSummary,
    EndpointID,
    FolderName,
    JobID,
    JobMeta,
    StreamID,
} from '../types'


export type ExchangeID = string
export type ExchangeState = 'searching' | 'answering' | ChatExchangeState

export interface Exchange {
    id: ExchangeID
    question: string
    scope: AskScope
    answer: string
    meetings: JobMeta[]
    sources: AskSource[]
    state: ExchangeState
    error: string | null
    stream_id: StreamID
}

const CHAT_ID_PATTERN = /^[0-9a-f-]{36}$/
const EVENT_ASK_SOURCES = 'notes_ask_sources'
const EVENT_NOTES_CHUNK = 'notes_generate_chunk'
const EXCHANGES_MAX = 30
const HISTORY_TURNS_MAX = 4
const MESSAGE_ENDPOINT_MISSING = 'No notes service is set. Add one on the AI tab of Settings.'
const SCOPE_ALL = Object.freeze<AskScope>({ kind: 'all' })
const SCOPE_KINDS: readonly AskScope['kind'][] = Object.freeze(['all', 'meeting', 'project'])
const STATES_SETTLED: readonly ChatExchangeState[] = Object.freeze(['done', 'failed', 'stopped'])
const exchanges = ref<Exchange[]>([])
const chat_id = ref<ChatID>(crypto.randomUUID())
const chats = ref<ChatSummary[]>([])
const scope = ref<AskScope>(SCOPE_ALL)
const busy = computed(() => exchanges.value.some(exchange_live))
const { endpoints_by_purpose } = use_endpoints()
const { view_set } = use_pipeline()
const chat_writes = shallowRef<Promise<void>>(Promise.resolve())

const api = Object.freeze({
    exchanges,
    busy,
    chat_id,
    chats,
    scope,
    ask,
    chat_open,
    chat_remove,
    chats_refresh,
    clear,
    folder_ask,
    meeting_ask,
    retry,
    stop,
})


export function use_ask(): typeof api {
    assert(Object.isFrozen(api))
    assert(exchanges.value.length <= EXCHANGES_MAX)

    return api
}

async function ask(question: string, asked_in: AskScope): Promise<void> {
    assert(question.trim().length > 0)
    assert(scope_valid(asked_in))

    if (busy.value) return

    return exchange_run(exchange_start(question.trim(), asked_in))
}

async function chat_open(id: ChatID): Promise<void> {
    assert(CHAT_ID_PATTERN.test(id))
    assert(CHAT_ID_PATTERN.test(chat_id.value))

    if (id === chat_id.value) return

    return stop()
        .then(async () => ipc.chat_get(id))
        .then(chat_show)
}

async function chat_persist(chat: ChatID): Promise<void> {
    assert(chat.length > 0)
    assert(exchanges.value.length <= EXCHANGES_MAX)

    if (chat !== chat_id.value) return

    const settled = exchanges.value.filter((exchange) => !exchange_live(exchange))

    if (settled.length === 0) return

    const stored = settled.map(exchange_stored)

    return chat_write(async () => ipc.chat_save(chat, stored)).catch((error: unknown) => {
        log_warn('[ask] chat not saved', error)
    })
}

async function chat_remove(id: ChatID): Promise<void> {
    assert(CHAT_ID_PATTERN.test(id))
    assert(CHAT_ID_PATTERN.test(chat_id.value))

    const cleared = id === chat_id.value ? clear() : Promise.resolve()

    return cleared
        .then(async () => chat_write(async () => ipc.chat_remove(id)))
        .then(() => {
            chats.value = chats.value.filter((chat) => chat.id !== id)
        })
}

function chat_show(opened: ChatOpened): void {
    assert(CHAT_ID_PATTERN.test(opened.id))
    assert(opened.exchanges.length > 0)

    const shown = opened.exchanges
        .slice(-EXCHANGES_MAX)
        .map(exchange_shown.bind(undefined, opened.meetings))

    exchanges.value = shown
    chat_id.value = opened.id
    scope.value = shown.at(-1)?.scope ?? SCOPE_ALL

    assert(!busy.value)
}

async function chat_write(write: () => Promise<void>): Promise<void> {
    assert(CHAT_ID_PATTERN.test(chat_id.value))

    const queued = chat_writes.value.then(write, write)

    chat_writes.value = queued

    return queued
}

async function chats_refresh(): Promise<void> {
    assert(CHAT_ID_PATTERN.test(chat_id.value))

    return ipc.chats_list().then((listed) => {
        assert(listed.every((chat) => CHAT_ID_PATTERN.test(chat.id)))
        assert(listed.every((chat) => chat.title.length > 0))

        chats.value = listed
    })
}

function chunk_append(id: ExchangeID, stream_id: StreamID, event: Event<ChatChunk>): void {
    assert(id.length > 0)
    assert(typeof event.payload.text === 'string')

    if (event.payload.stream_id !== stream_id) return
    if (event.payload.done) return

    exchange_update(id, stream_id, (exchange) => ({ answer: exchange.answer + event.payload.text }))
}

async function clear(): Promise<void> {
    assert(exchanges.value.filter(exchange_live).length <= 1)
    assert(chat_id.value.length > 0)

    return stop().then(() => {
        exchanges.value = []
        chat_id.value = crypto.randomUUID()
        scope.value = SCOPE_ALL

        assert(!busy.value)
    })
}

async function exchange_answer(
    exchange: Exchange,
    endpoint_id: EndpointID,
    history: readonly AskTurn[],
): Promise<string> {
    assert(exchange.question.length > 0)
    assert(endpoint_id.length > 0)
    assert(history.length <= HISTORY_TURNS_MAX)

    const { id, question, stream_id } = exchange
    const append = chunk_append.bind(undefined, id, stream_id)

    return listen<ChatChunk>(EVENT_NOTES_CHUNK, append)
        .then(async (unlisten) => ipc
            .notes_ask_streaming(stream_id, endpoint_id, question, exchange.scope, history)
            .finally(unlisten))
}

function exchange_live(exchange: Exchange): boolean {
    assert(exchange.id.length > 0)
    assert(exchange.stream_id.length > 0)

    return exchange.state === 'searching' || exchange.state === 'answering'
}

async function exchange_run(exchange: Exchange): Promise<void> {
    assert(exchange.state === 'searching')
    assert(exchange.stream_id.length > 0)

    const { id, stream_id } = exchange
    const chat = chat_id.value
    const endpoint_id = endpoints_by_purpose('notes')[0]?.id

    if (endpoint_id === undefined) {
        exchange_update(id, stream_id, () => ({ state: 'failed', error: MESSAGE_ENDPOINT_MISSING }))

        return chat_persist(chat)
    }

    const history = history_before(id)
    const take = sources_take.bind(undefined, id, stream_id)

    return listen<AskSources>(EVENT_ASK_SOURCES, take)
        .then(async (unlisten) => exchange_answer(exchange, endpoint_id, history).finally(unlisten))
        .then((answer) => {
            exchange_update(id, stream_id, () => ({ answer, state: 'done' }))
        })
        .catch((error: unknown) => {
            exchange_update(id, stream_id, () => ({ state: 'failed', error: String(error) }))
        })
        .then(async () => chat_persist(chat))
}

function exchange_start(question: string, asked_in: AskScope): Exchange {
    assert(question.length > 0)
    assert(question === question.trim())
    assert(scope_valid(asked_in))

    const created: Exchange = {
        id: crypto.randomUUID(),
        question,
        scope: asked_in,
        answer: '',
        meetings: [],
        sources: [],
        state: 'searching',
        error: null,
        stream_id: crypto.randomUUID(),
    }

    exchanges.value = [...exchanges.value, created].slice(-EXCHANGES_MAX)

    assert(exchanges.value.length <= EXCHANGES_MAX)

    return created
}

function exchange_shown(meetings: readonly JobMeta[], stored: ChatExchange): Exchange {
    assert(meetings.every((meeting) => meeting.id.length > 0))
    assert(stored.question.length > 0)
    assert(STATES_SETTLED.includes(stored.state))

    const cited = meetings.filter((meeting) => (
        stored.sources.some((source) => source.job_id === meeting.id)
    ))

    assert(cited.length <= stored.sources.length)

    return { ...stored, meetings: cited, stream_id: crypto.randomUUID() }
}

function exchange_stored(exchange: Exchange): ChatExchange {
    assert(exchange.question.length > 0)

    const state = STATES_SETTLED.find((settled) => settled === exchange.state)
    const cited = sources_cited(exchange.answer, exchange.sources, exchange.meetings)

    assert(state !== undefined)

    return {
        answer: exchange.answer,
        error: exchange.error,
        id: exchange.id,
        question: exchange.question,
        scope: { ...exchange.scope },
        sources: cited.map((entry) => ({ ...entry.source })),
        state,
    }
}

function exchange_update(
    id: ExchangeID,
    stream_id: StreamID,
    update: (exchange: Exchange) => Partial<Exchange>,
): void {
    assert(id.length > 0)
    assert(stream_id.length > 0)

    const current = exchanges.value.find((exchange) => exchange.id === id)

    if (current === undefined) return
    if (current.stream_id !== stream_id) return
    if (!exchange_live(current)) return

    const updated: Exchange = { ...current, ...update(current), id, stream_id }

    exchanges.value = exchanges.value.map((exchange) => exchange.id === id ? updated : exchange)
}

async function folder_ask(name: FolderName): Promise<void> {
    assert(name.length > 0)
    assert(name.trim() === name)

    return clear().then(() => {
        scope.value = { kind: 'project', project: name }
        view_set('ask')
    })
}

function history_before(id: ExchangeID): AskTurn[] {
    assert(id.length > 0)

    const index = exchanges.value.findIndex((exchange) => exchange.id === id)

    assert(index >= 0)

    const turns = exchanges.value
        .slice(0, index)
        .filter((exchange) => exchange.state === 'done' && exchange.answer.trim().length > 0)
        .slice(-HISTORY_TURNS_MAX)
        .map((exchange) => ({ answer: exchange.answer, question: exchange.question }))

    assert(turns.length <= HISTORY_TURNS_MAX)

    return turns
}

async function meeting_ask(job_id: JobID): Promise<void> {
    assert(job_id.length > 0)
    assert(job_id.trim() === job_id)

    return clear().then(() => {
        scope.value = { kind: 'meeting', job_id }
        view_set('ask')
    })
}

async function retry(): Promise<void> {
    const last = exchanges.value.at(-1)

    if (last === undefined) return
    if (exchange_live(last)) return

    const fresh: Exchange = {
        ...last,
        answer: '',
        meetings: [],
        sources: [],
        state: 'searching',
        error: null,
        stream_id: crypto.randomUUID(),
    }

    exchanges.value = [...exchanges.value.slice(0, -1), fresh]

    assert(busy.value)

    return exchange_run(fresh)
}

function scope_valid(candidate: AskScope): boolean {
    assert(SCOPE_KINDS.includes(candidate.kind))

    if (candidate.kind === 'all') return true
    if (candidate.kind === 'meeting') return candidate.job_id.length > 0

    return candidate.project.trim().length > 0
}

function sources_take(id: ExchangeID, stream_id: StreamID, event: Event<AskSources>): void {
    assert(id.length > 0)
    assert(event.payload.sources.every((source) => source.marker.startsWith('M')))

    if (event.payload.stream_id !== stream_id) return

    const { meetings, sources } = event.payload

    exchange_update(id, stream_id, () => ({ meetings, sources, state: 'answering' }))
}

async function stop(): Promise<void> {
    const live = exchanges.value.find(exchange_live)
    const chat = chat_id.value

    if (live === undefined) return

    exchange_update(live.id, live.stream_id, () => ({ state: 'stopped' }))

    assert(!busy.value)

    return stream_cancel(live.stream_id).then(async () => chat_persist(chat))
}

async function stream_cancel(stream_id: StreamID): Promise<void> {
    assert(stream_id.length > 0)

    return ipc.task_cancel(stream_id).catch((error: unknown) => {
        log_warn('[ask] cancel not delivered', error)
    })
}
