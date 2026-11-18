import { use_dialog } from '../composables/use_dialog'
import { AssertionError, assert } from './assert'
import { log_warn } from './log'


type ErrorKind =
    | 'api'
    | 'audio'
    | 'config'
    | 'export'
    | 'file'
    | 'internal'
    | 'network'
    | 'search'
    | 'transcription'
    | 'unknown'

interface ErrorCategory {
    readonly kind: ErrorKind
    readonly message: string | null
    readonly prefix: `${string}:`
    readonly title: string
}

interface FriendlyError {
    title: string
    message: string
    kind: ErrorKind
}

interface IPCFailure {
    readonly command: string
    readonly raw: string
}

const API_STATUS_HEAD = /^(?<status>\d{3}) [^:]+: /u
const BRAND_LEADING = /^remi\b/u

const ERRORS_UNSHOWN = Object.freeze([
    AssertionError,
    DOMException,
    EvalError,
    RangeError,
    ReferenceError,
    SyntaxError,
    TypeError,
    URIError,
])

const KINDS_WARNING: readonly ErrorKind[] = Object.freeze([
    'api',
    'audio',
    'config',
    'export',
    'transcription',
])

const MARKER_STOPPED_MIDWAY = 'decoding response body'

const MESSAGE_FILE = 'remi could not read or write one of its files. Check that the disk has '
    + 'free space, then try again.'

const MESSAGE_LENGTH_MAX = 400
const MESSAGE_SEARCH = 'Search ran into a problem. remi keeps the details in its log.'

export const MESSAGE_UNSHOWN = 'remi ran into a problem it cannot show here. The details are in '
    + 'its log.'

const PREFIX_API = 'api error:'
const PREFIX_NETWORK = 'network error:'
const SENTENCE_END = /[!).?]$/u
const STATUS_SERVER_FIRST = 500
const TITLE_GENERIC = 'Something went wrong'

const ERROR_CATEGORIES: readonly ErrorCategory[] = Object.freeze([
    { kind: 'audio', message: null, prefix: 'audio error:', title: 'Audio problem' },
    { kind: 'config', message: null, prefix: 'config error:', title: 'Configuration issue' },
    { kind: 'export', message: null, prefix: 'export error:', title: 'Export problem' },
    { kind: 'file', message: MESSAGE_FILE, prefix: 'io error:', title: 'File problem' },
    { kind: 'internal', message: MESSAGE_UNSHOWN, prefix: 'internal error:', title: TITLE_GENERIC },
    { kind: 'internal', message: MESSAGE_UNSHOWN, prefix: 'serde error:', title: TITLE_GENERIC },
    {
        kind: 'search',
        message: MESSAGE_SEARCH,
        prefix: 'search index error:',
        title: 'Search problem',
    },
    { kind: 'internal', message: MESSAGE_UNSHOWN, prefix: 'task error:', title: TITLE_GENERIC },
    {
        kind: 'transcription',
        message: null,
        prefix: 'transcription error:',
        title: 'Transcription problem',
    },
])


export class IPCError extends Error {
    readonly command: string
    readonly friendly: FriendlyError
    readonly raw: string

    constructor({ command, raw }: IPCFailure) {
        assert(command.length > 0)
        assert(typeof raw === 'string')

        const friendly = error_friendly_strict(raw)

        super(friendly.message)

        this.name = ''
        this.command = command
        this.friendly = friendly
        this.raw = raw

        assert(String(this) === friendly.message)
    }
}

export async function error_dialog_sentence_show(sentence: string): Promise<void> {
    const { message } = use_dialog()

    assert(error_message_showable(sentence))
    assert(TITLE_GENERIC.length > 0)

    return message(sentence, { title: TITLE_GENERIC, kind: 'error' })
}

export async function error_dialog_show(error: unknown): Promise<void> {
    const friendly = error_friendly(error)
    const shown = error_shown(error)
    const { message } = use_dialog()
    const kind = KINDS_WARNING.includes(friendly.kind) ? 'warning' : 'error'

    assert(friendly.title.length > 0)
    assert(shown === friendly.message)

    return message(shown, { title: friendly.title, kind })
}

export function error_friendly(error: unknown): FriendlyError {
    const friendly = error instanceof IPCError
        ? error.friendly
        : error_friendly_thrown(error)

    assert(friendly.title.length > 0)
    assert(error_message_showable(friendly.message))

    return friendly
}

export function error_shown(error: unknown): string {
    const { message } = error_friendly(error)

    assert(error_message_showable(message))
    assert(message.length <= MESSAGE_LENGTH_MAX)

    if (error instanceof IPCError) return message

    log_warn('[error] shown to the user', error)

    return message
}

export function error_text_extract(error: unknown): string {
    if (typeof error === 'string') return error
    if (error instanceof Error) return error.message

    switch (typeof error) {
        case 'object':
            return error === null ? 'null' : error_object_text(error)
        case 'undefined':
            return 'undefined'
        case 'function':
            return error.name
        case 'symbol':
            return error.description ?? 'symbol'
        case 'bigint':
        case 'boolean':
        case 'number':
        case 'string':
            return String(error)
    }
}

function error_friendly_api(detail: string): FriendlyError {
    assert(typeof detail === 'string')
    assert(!API_STATUS_HEAD.global)

    const head = API_STATUS_HEAD.exec(detail)
    const status = Number(head?.groups?.['status'] ?? 0)
    const message = error_sentence(head === null ? detail : detail.slice(head[0].length))

    if (status >= STATUS_SERVER_FIRST) {
        return { title: 'The server had a problem', message, kind: 'api' }
    }

    return { title: 'The server rejected the request', message, kind: 'api' }
}

function error_friendly_network(raw: string): FriendlyError {
    assert(raw.length > 0)
    assert(MARKER_STOPPED_MIDWAY.length > 0)

    if (raw.toLowerCase().includes(MARKER_STOPPED_MIDWAY)) {
        return {
            title: 'The server stopped responding',
            message: 'The server stopped part-way through its reply. It may be busy; wait a '
                + 'minute and try again.',
            kind: 'network',
        }
    }

    return {
        title: 'Network problem',
        message: 'The server could not be reached. Check your internet connection and try again.',
        kind: 'network',
    }
}

function error_friendly_prefixed(raw: string): FriendlyError {
    assert(typeof raw === 'string')
    assert(ERROR_CATEGORIES.every((category) => category.prefix === category.prefix.toLowerCase()))

    const lower = raw.toLowerCase()

    if (lower.startsWith(PREFIX_NETWORK)) return error_friendly_network(raw)
    if (lower.startsWith(PREFIX_API)) return error_friendly_api(error_strip_prefix(raw, PREFIX_API))

    const category = ERROR_CATEGORIES.find((candidate) => lower.startsWith(candidate.prefix))

    if (category === undefined) return { title: TITLE_GENERIC, message: raw, kind: 'unknown' }

    return {
        title: category.title,
        message: category.message ?? error_sentence(error_strip_prefix(raw, category.prefix)),
        kind: category.kind,
    }
}

function error_friendly_strict(raw: string): FriendlyError {
    assert(typeof raw === 'string')

    const friendly = error_friendly_text(raw)

    assert(friendly.title.length > 0)
    assert(error_message_showable(friendly.message))

    if (friendly.kind !== 'unknown') return friendly

    return { title: TITLE_GENERIC, message: MESSAGE_UNSHOWN, kind: 'internal' }
}

function error_friendly_text(raw: string): FriendlyError {
    assert(typeof raw === 'string')
    assert(error_message_showable(MESSAGE_UNSHOWN))

    const friendly = error_friendly_prefixed(raw)

    if (error_message_showable(friendly.message)) return friendly

    return { ...friendly, message: MESSAGE_UNSHOWN }
}

function error_friendly_thrown(error: unknown): FriendlyError {
    assert(!(error instanceof IPCError))
    assert(ERRORS_UNSHOWN.length > 0)

    if (ERRORS_UNSHOWN.some((unshown) => error instanceof unshown)) {
        return { title: TITLE_GENERIC, message: MESSAGE_UNSHOWN, kind: 'internal' }
    }

    if (error instanceof Error) return error_friendly_text(error.message)

    return error_friendly_strict(error_text_extract(error))
}

function error_message_showable(message: string): boolean {
    assert(typeof message === 'string')
    assert(MESSAGE_UNSHOWN.length <= MESSAGE_LENGTH_MAX)

    if (message.trim().length === 0) return false
    if (message.length > MESSAGE_LENGTH_MAX) return false

    return !/[\n\r]/u.test(message)
}

function error_object_text(error: object): string {
    assert(typeof error === 'object')
    assert(typeof JSON.stringify === 'function')

    const maybe = (error as { message?: unknown }).message

    if (typeof maybe === 'string') return maybe

    return JSON.stringify(error)
}

function error_sentence(text: string): string {
    assert(typeof text === 'string')
    assert(!SENTENCE_END.global)

    const trimmed = text.trim()

    if (trimmed.length === 0) return trimmed

    const head = BRAND_LEADING.test(trimmed)
        ? trimmed
        : trimmed.charAt(0).toUpperCase() + trimmed.slice(1)

    const sentence = SENTENCE_END.test(head) ? head : `${head}.`

    assert(SENTENCE_END.test(sentence))
    assert(sentence.length - trimmed.length <= 1)

    return sentence
}

function error_strip_prefix(raw: string, prefix: `${string}:`): string {
    assert(prefix.length > 0)
    assert(typeof raw === 'string')

    if (raw.toLowerCase().startsWith(prefix.toLowerCase())) {
        return raw.slice(prefix.length).trim()
    }

    return raw
}
