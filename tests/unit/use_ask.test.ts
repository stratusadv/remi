import { listen } from '@tauri-apps/api/event'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { use_ask } from '../../src/composables/use_ask'
import { use_endpoints } from '../../src/composables/use_endpoints'
import { use_pipeline } from '../../src/composables/use_pipeline'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import { ask_source_build, deferred_new, job_meta_build } from './fixtures'
import type { Exchange } from '../../src/composables/use_ask'
import type {
    APIEndpoint,
    AskScope,
    AskTurn,
    ChatExchange,
    ChatOpened,
    StreamID,
} from '../../src/types'


vi.mock('../../src/lib/ipc')
vi.mock('@tauri-apps/api/event')

const CHAT_SAVED = '1b4e28ba-2fa1-41d2-883f-0016d3cca427'
const EVENT_CHUNK = 'notes_generate_chunk'
const EVENT_SOURCES = 'notes_ask_sources'
const EVENT_WAIT = 'notes_ask_wait'
const EXCHANGES_MAX = 30
const NOTICE_HALF = 'You have used half of this month\'s full-speed questions. About 40 are left.'
const NOTICE_WAIT = 'You have asked 20 questions in the last 10 minutes, so remi is pacing them.'
const SCOPE_ALL = Object.freeze<AskScope>({ kind: 'all' })
const SCOPE_PROJECT = Object.freeze<AskScope>({ kind: 'project', project: 'remi' })

const ENDPOINT_NOTES = Object.freeze<APIEndpoint>({
    id: 'notes-ep',
    name: 'Notes',
    purpose: 'notes',
    host: 'https://ai.example.invalid',
    api_key: '',
    model: 'write',
    temperature: null,
    output_tokens_max: null,
    api_path_chat: null,
    api_path_transcribe: null,
    transcribe_verbose: null,
    transcribe_chunk_seconds: null,
    has_api_key: true,
})

const ask_state = use_ask()
const { endpoints } = use_endpoints()
const { view_current } = use_pipeline()
const unlisten = vi.fn()


function chat_exchange_build(turn: AskTurn): ChatExchange {
    assert(turn.question.trim().length > 0)
    assert(turn.answer.trim().length > 0)

    return {
        answer: turn.answer,
        error: null,
        id: `exchange-${turn.question}`,
        question: turn.question,
        scope: SCOPE_PROJECT,
        sources: [ask_source_build()],
        state: 'done',
    }
}

function chat_saved_build(): ChatOpened {
    assert(CHAT_SAVED.length > 0)
    assert(SCOPE_PROJECT.kind === 'project')

    return {
        exchanges: [
            chat_exchange_build({ question: 'Q1', answer: 'A1 [M1].' }),
            chat_exchange_build({ question: 'Q2', answer: 'A2 [M1].' }),
        ],
        id: CHAT_SAVED,
        meetings: [job_meta_build()],
    }
}

function chunk_send(stream_id: StreamID, text: string): void {
    assert(stream_id.length > 0)
    assert(typeof text === 'string')

    event_send(EVENT_CHUNK, { stream_id, text, done: false })
}

function event_send(name: string, payload: unknown): void {
    assert(name.length > 0)

    const call = vi.mocked(listen).mock.calls.filter((entry) => entry[0] === name).at(-1)

    assert(call !== undefined, `nothing listens for ${name}`)

    call[1]({ event: name, id: 1, payload })
}

function exchange_build(patch: Partial<Exchange>): Exchange {
    assert(typeof patch === 'object')
    assert(patch.question === undefined || patch.question.trim().length > 0)

    return {
        id: crypto.randomUUID(),
        question: 'Who drafts the banner?',
        scope: SCOPE_ALL,
        answer: 'Sam drafts it [M1].',
        meetings: [],
        notice: '',
        sources: [],
        state: 'done',
        error: null,
        stream_id: crypto.randomUUID(),
        ...patch,
    }
}

function sources_send(stream_id: StreamID): void {
    assert(stream_id.length > 0)
    assert(ask_state.busy.value)

    event_send(EVENT_SOURCES, {
        stream_id,
        meetings: [job_meta_build()],
        notice: '',
        sources: [ask_source_build()],
    })
}

beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(listen).mockResolvedValue(unlisten)
    vi.mocked(ipc.task_cancel).mockResolvedValue(undefined)
    vi.mocked(ipc.chat_save).mockResolvedValue(undefined)
    vi.mocked(ipc.chat_remove).mockResolvedValue(undefined)
    vi.mocked(ipc.chat_get).mockResolvedValue(chat_saved_build())
    ask_state.exchanges.value = []
    ask_state.chat_id.value = crypto.randomUUID()
    ask_state.chats.value = []
    ask_state.scope.value = SCOPE_ALL
    endpoints.value = [ENDPOINT_NOTES]
})

describe('ask', () => {
    it('searches, streams its own chunks after the sources, and settles as done', async () => {
        const streamed: Exchange[] = []

        vi.mocked(ipc.notes_ask_streaming).mockImplementation(async (stream_id) => {
            sources_send(stream_id)
            chunk_send(stream_id, 'Sam drafts it ')
            chunk_send('another-stream', 'ignored')
            chunk_send(stream_id, '[M1].')
            event_send(EVENT_CHUNK, { stream_id, text: 'not this', done: true })
            streamed.push(...ask_state.exchanges.value)

            return Promise.resolve('Sam drafts it [M1].')
        })

        const asking = ask_state.ask('  Who drafts the banner?  ', SCOPE_ALL)

        expect(ask_state.exchanges.value[0]?.state).toBe('searching')
        expect(ask_state.busy.value).toBe(true)

        await asking

        expect(streamed[0]).toMatchObject({
            question: 'Who drafts the banner?',
            answer: 'Sam drafts it [M1].',
            state: 'answering',
        })

        expect(streamed[0]?.sources).toHaveLength(1)
        expect(ask_state.exchanges.value[0]?.state).toBe('done')
        expect(ask_state.busy.value).toBe(false)
        expect(unlisten).toHaveBeenCalledTimes(vi.mocked(listen).mock.calls.length)
    })
})

describe('ask notices', () => {
    it('shows the wait for a turn, then the notice the turn came with', async () => {
        const seen: string[] = []

        vi.mocked(ipc.notes_ask_streaming).mockImplementation(async (stream_id) => {
            event_send(EVENT_WAIT, { notice: NOTICE_WAIT, stream_id: 'another-stream' })
            seen.push(ask_state.exchanges.value[0]?.notice ?? 'missing')
            event_send(EVENT_WAIT, { notice: NOTICE_WAIT, stream_id })
            seen.push(ask_state.exchanges.value[0]?.notice ?? 'missing')

            event_send(EVENT_SOURCES, {
                stream_id,
                meetings: [job_meta_build()],
                notice: NOTICE_HALF,
                sources: [ask_source_build()],
            })

            seen.push(ask_state.exchanges.value[0]?.notice ?? 'missing')

            return Promise.resolve('Sam drafts it [M1].')
        })

        await ask_state.ask('Who drafts the banner?', SCOPE_ALL)

        expect(seen).toEqual(['', NOTICE_WAIT, NOTICE_HALF])
        expect(ask_state.exchanges.value[0]?.state).toBe('done')
        expect(ask_state.exchanges.value[0]?.notice).toBe(NOTICE_HALF)
        expect(vi.mocked(listen).mock.calls.map((entry) => entry[0])).toContain(EVENT_WAIT)
    })

    it('starts a retried question without the notice of the last attempt', async () => {
        vi.mocked(ipc.notes_ask_streaming).mockRejectedValue(new Error('api error: busy'))

        ask_state.exchanges.value = [exchange_build({ notice: NOTICE_HALF, state: 'failed' })]

        const retrying = ask_state.retry()

        expect(ask_state.exchanges.value[0]?.notice).toBe('')

        await retrying

        expect(ask_state.exchanges.value[0]?.state).toBe('failed')
    })
})

describe('ask within a conversation', () => {
    it('sends the newest four finished turns as the conversation so far', async () => {
        vi.mocked(ipc.notes_ask_streaming).mockResolvedValue('Friday.')

        ask_state.exchanges.value = [
            exchange_build({ question: 'Q1', answer: 'A1' }),
            exchange_build({ question: 'Q2', answer: 'A2' }),
            exchange_build({ question: 'Q3', answer: 'A3' }),
            exchange_build({ question: 'QF', answer: '', state: 'failed', error: 'boom' }),
            exchange_build({ question: 'QS', answer: 'Half', state: 'stopped' }),
            exchange_build({ question: 'Q4', answer: 'A4' }),
            exchange_build({ question: 'Q5', answer: 'A5' }),
        ]

        await ask_state.ask('When is it due?', SCOPE_ALL)

        const history = vi.mocked(ipc.notes_ask_streaming).mock.calls[0]?.[4]

        expect(history?.map((turn) => turn.question)).toEqual(['Q2', 'Q3', 'Q4', 'Q5'])
        expect(history?.map((turn) => turn.answer)).toEqual(['A2', 'A3', 'A4', 'A5'])
        expect(ask_state.exchanges.value.at(-1)?.answer).toBe('Friday.')
    })

    it('ignores a second question while one is still answering', async () => {
        const answered = deferred_new<string>()

        vi.mocked(ipc.notes_ask_streaming).mockReturnValue(answered.promise)

        const asking = ask_state.ask('First?', SCOPE_ALL)

        await ask_state.ask('Second?', SCOPE_ALL)

        expect(ask_state.exchanges.value.map((exchange) => exchange.question)).toEqual(['First?'])

        answered.resolve('Done.')
        await asking
    })

    it('keeps the newest thirty exchanges', async () => {
        vi.mocked(ipc.notes_ask_streaming).mockResolvedValue('Done.')

        const earlier: Exchange[] = []

        for (let index = 0; index < EXCHANGES_MAX; index += 1) {
            earlier.push(exchange_build({ question: `Q${String(index)}` }))
        }

        ask_state.exchanges.value = earlier

        await ask_state.ask('Newest?', SCOPE_ALL)

        expect(ask_state.exchanges.value).toHaveLength(EXCHANGES_MAX)
        expect(ask_state.exchanges.value[0]?.question).toBe('Q1')
        expect(ask_state.exchanges.value.at(-1)?.question).toBe('Newest?')
    })
})

describe('ask when it cannot answer', () => {
    it('fails at once when no notes service is set', async () => {
        endpoints.value = []

        await ask_state.ask('Who drafts the banner?', SCOPE_ALL)

        expect(ask_state.exchanges.value[0]?.state).toBe('failed')
        expect(ask_state.exchanges.value[0]?.error).toContain('Settings')
        expect(ipc.notes_ask_streaming).not.toHaveBeenCalled()
    })

    it('records the failure of the request', async () => {
        vi.mocked(ipc.notes_ask_streaming).mockRejectedValue(new Error('api error: overloaded'))

        await ask_state.ask('Who drafts the banner?', SCOPE_ALL)

        expect(ask_state.exchanges.value[0]?.state).toBe('failed')
        expect(ask_state.exchanges.value[0]?.error).toBe('Error: api error: overloaded')
        expect(ask_state.busy.value).toBe(false)
    })
})

describe('stop', () => {
    it('keeps the partial answer, cancels the stream, and ignores anything later', async () => {
        vi.mocked(ipc.notes_ask_streaming).mockImplementation(async (stream_id) => {
            sources_send(stream_id)
            chunk_send(stream_id, 'Sam drafts')

            await ask_state.stop()

            expect(ask_state.busy.value).toBe(false)
            expect(ipc.task_cancel).toHaveBeenCalledWith(stream_id)

            chunk_send(stream_id, ' it late')

            return Promise.resolve('Sam drafts it late')
        })

        await ask_state.ask('Who drafts the banner?', SCOPE_ALL)

        expect(ipc.task_cancel).toHaveBeenCalledTimes(1)

        expect(ask_state.exchanges.value[0]).toMatchObject({
            answer: 'Sam drafts',
            state: 'stopped',
        })
    })

    it('does nothing when nothing is answering', async () => {
        ask_state.exchanges.value = [exchange_build({})]

        await ask_state.stop()

        expect(ipc.task_cancel).not.toHaveBeenCalled()
        expect(ask_state.exchanges.value[0]?.state).toBe('done')
    })
})

describe('retry', () => {
    it('asks the last question again on a fresh stream in the same place', async () => {
        vi.mocked(ipc.notes_ask_streaming)
            .mockRejectedValueOnce(new Error('api error: overloaded'))
            .mockResolvedValueOnce('Sam drafts it.')

        await ask_state.ask('Who drafts the banner?', SCOPE_ALL)

        const failed = ask_state.exchanges.value[0]

        await ask_state.retry()

        const streams = vi.mocked(ipc.notes_ask_streaming).mock.calls.map((call) => call[0])

        expect(ask_state.exchanges.value).toHaveLength(1)

        expect(ask_state.exchanges.value[0]).toMatchObject({
            id: failed?.id,
            answer: 'Sam drafts it.',
            state: 'done',
            error: null,
        })

        expect(new Set(streams).size).toBe(2)
        expect(vi.mocked(ipc.notes_ask_streaming).mock.calls[1]?.[2]).toBe('Who drafts the banner?')
    })

    it('leaves a live exchange alone', async () => {
        const answered = deferred_new<string>()

        vi.mocked(ipc.notes_ask_streaming).mockReturnValue(answered.promise)

        const asking = ask_state.ask('Who drafts the banner?', SCOPE_ALL)
        const stream = ask_state.exchanges.value[0]?.stream_id

        await ask_state.retry()

        expect(ask_state.exchanges.value[0]?.stream_id).toBe(stream)

        await flushPromises()
        answered.resolve('Sam.')
        await asking

        expect(ipc.notes_ask_streaming).toHaveBeenCalledTimes(1)
    })
})

describe('clear', () => {
    it('empties the conversation and cancels the live stream', async () => {
        vi.mocked(ipc.notes_ask_streaming).mockImplementation(async (stream_id) => {
            await ask_state.clear()

            expect(ask_state.busy.value).toBe(false)
            expect(ipc.task_cancel).toHaveBeenCalledWith(stream_id)

            return Promise.resolve('Too late.')
        })

        await ask_state.ask('Who drafts the banner?', SCOPE_ALL)

        expect(ask_state.exchanges.value).toEqual([])
        expect(ipc.task_cancel).toHaveBeenCalledTimes(1)
    })

    it('starts the next chat about every meeting', async () => {
        const before = ask_state.chat_id.value

        ask_state.scope.value = SCOPE_PROJECT

        await ask_state.clear()

        expect(ask_state.scope.value).toEqual(SCOPE_ALL)
        expect(ask_state.chat_id.value).not.toBe(before)
    })
})

describe('chat history', () => {
    it('saves each settled answer under one chat with only the sources it cites', async () => {
        vi.mocked(ipc.notes_ask_streaming).mockImplementation(async (stream_id) => {
            event_send(EVENT_SOURCES, {
                stream_id,
                meetings: [job_meta_build()],
                sources: [ask_source_build(), ask_source_build({ marker: 'M2' })],
            })

            return Promise.resolve('Sam drafts it [M1].')
        })

        await ask_state.ask('Who drafts the banner?', SCOPE_ALL)
        await ask_state.ask('When is it due?', SCOPE_ALL)

        const saves = vi.mocked(ipc.chat_save).mock.calls
        const stored = saves.at(-1)?.[1] ?? []

        expect(saves.map((call) => call[0])).toEqual([
            ask_state.chat_id.value,
            ask_state.chat_id.value,
        ])

        expect(stored.map((exchange) => exchange.question)).toEqual([
            'Who drafts the banner?',
            'When is it due?',
        ])

        const keys = Object.keys(stored[0] ?? {}).sort()

        expect(stored[0]?.sources.map((source) => source.marker)).toEqual(['M1'])

        expect(keys).toEqual([
            'answer',
            'error',
            'id',
            'question',
            'scope',
            'sources',
            'state',
        ])
    })

    it('opens a saved chat in its own scope and continues it with its history', async () => {
        vi.mocked(ipc.notes_ask_streaming).mockResolvedValue('A3 [M1].')

        await ask_state.chat_open(CHAT_SAVED)

        expect(ask_state.exchanges.value.map((exchange) => exchange.meetings)).toEqual([
            [job_meta_build()],
            [job_meta_build()],
        ])

        await ask_state.ask('Q3', ask_state.scope.value)

        const history = vi.mocked(ipc.notes_ask_streaming).mock.calls[0]?.[4]
        const saved = vi.mocked(ipc.chat_save).mock.calls.at(-1)

        expect(ask_state.chat_id.value).toBe(CHAT_SAVED)
        expect(ask_state.scope.value).toEqual(SCOPE_PROJECT)
        expect(history?.map((turn) => turn.question)).toEqual(['Q1', 'Q2'])
        expect(saved?.[0]).toBe(CHAT_SAVED)
        expect(saved?.[1].map((exchange) => exchange.question)).toEqual(['Q1', 'Q2', 'Q3'])
    })
})

describe('chat history while an answer is coming', () => {
    it('stops and saves the live answer before it opens another chat', async () => {
        const before = ask_state.chat_id.value

        vi.mocked(ipc.notes_ask_streaming).mockImplementation(async (stream_id) => {
            sources_send(stream_id)
            chunk_send(stream_id, 'Sam drafts')

            await ask_state.chat_open(CHAT_SAVED)

            return Promise.resolve('Sam drafts it late')
        })

        await ask_state.ask('Who drafts the banner?', SCOPE_ALL)

        const saves = vi.mocked(ipc.chat_save).mock.calls

        expect(saves).toHaveLength(1)
        expect(saves[0]?.[0]).toBe(before)

        expect(saves[0]?.[1].map((exchange) => [exchange.state, exchange.answer])).toEqual([
            ['stopped', 'Sam drafts'],
        ])

        expect(ipc.task_cancel).toHaveBeenCalledTimes(1)
        expect(ask_state.exchanges.value.map((exchange) => exchange.question)).toEqual(['Q1', 'Q2'])
    })
})

describe('chat removal', () => {
    it('deletes the open chat and starts a new one', async () => {
        const current = ask_state.chat_id.value

        ask_state.exchanges.value = [exchange_build({})]

        ask_state.chats.value = [
            { id: current, title: 'Who drafts the banner?', updated_at_unix_ms: 2 },
            { id: CHAT_SAVED, title: 'Q1', updated_at_unix_ms: 1 },
        ]

        await ask_state.chat_remove(current)

        expect(ipc.chat_remove).toHaveBeenCalledWith(current)
        expect(ask_state.exchanges.value).toEqual([])
        expect(ask_state.chat_id.value).not.toBe(current)
        expect(ask_state.chats.value.map((chat) => chat.id)).toEqual([CHAT_SAVED])
    })

    it('leaves the open chat alone when another chat is deleted', async () => {
        const current = ask_state.chat_id.value
        const shown = [exchange_build({})]

        ask_state.exchanges.value = shown

        await ask_state.chat_remove(CHAT_SAVED)

        expect(ipc.chat_remove).toHaveBeenCalledWith(CHAT_SAVED)
        expect(ask_state.exchanges.value).toEqual(shown)
        expect(ask_state.chat_id.value).toBe(current)
    })
})

describe('ask about a folder', () => {
    it('starts a new chat scoped to the folder and opens Ask', async () => {
        const before = ask_state.chat_id.value

        ask_state.exchanges.value = [exchange_build({})]
        view_current.value = 'jobs'

        await ask_state.folder_ask('Acme Mining')

        expect(ask_state.chat_id.value).not.toBe(before)
        expect(ask_state.exchanges.value).toEqual([])
        expect(ask_state.scope.value).toEqual({ kind: 'project', project: 'Acme Mining' })
        expect(view_current.value).toBe('ask')
    })
})

describe('ask about a meeting', () => {
    it('starts a new chat scoped to the meeting and opens Ask', async () => {
        const before = ask_state.chat_id.value

        ask_state.exchanges.value = [exchange_build({})]
        view_current.value = 'jobs'

        await ask_state.meeting_ask('job-7')

        expect(ask_state.chat_id.value).not.toBe(before)
        expect(ask_state.exchanges.value).toEqual([])
        expect(ask_state.scope.value).toEqual({ kind: 'meeting', job_id: 'job-7' })
        expect(view_current.value).toBe('ask')
    })
})
