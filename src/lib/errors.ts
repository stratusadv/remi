import { use_dialog } from '../composables/use_dialog'
import { assert } from './assert'


type ErrorKind = 'network' | 'api' | 'config' | 'unknown'

interface FriendlyError {
    title: string
    message: string
    kind: ErrorKind
}

const MARKER_STOPPED_MIDWAY = 'decoding response body'
const PREFIX_API = 'api error:'
const PREFIX_CONFIG = 'config error:'
const PREFIX_NETWORK = 'network error:'


export async function error_dialog_show(error: unknown): Promise<void> {
    const friendly = error_friendly(error)
    const { message } = use_dialog()
    const kind = friendly.kind === 'network' || friendly.kind === 'unknown' ? 'error' : 'warning'

    assert(friendly.title.length > 0)
    assert(typeof friendly.message === 'string')

    return message(friendly.message, { title: friendly.title, kind })
}

export function error_friendly(error: unknown): FriendlyError {
    const raw = error_text_extract(error)
    const lower = raw.toLowerCase()

    assert(typeof raw === 'string')
    assert(PREFIX_NETWORK.endsWith(':'))
    assert(PREFIX_API.endsWith(':'))
    assert(PREFIX_CONFIG.endsWith(':'))

    if (lower.startsWith(PREFIX_NETWORK)) {
        return error_friendly_network(raw)
    }

    if (lower.startsWith(PREFIX_API)) {
        return {
            title: 'The server rejected the request',
            message: error_strip_prefix(raw, PREFIX_API),
            kind: 'api',
        }
    }

    if (lower.startsWith(PREFIX_CONFIG)) {
        return {
            title: 'Configuration issue',
            message: error_strip_prefix(raw, PREFIX_CONFIG),
            kind: 'config',
        }
    }

    return {
        title: 'Something went wrong',
        message: raw,
        kind: 'unknown',
    }
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

function error_friendly_network(raw: string): FriendlyError {
    assert(raw.length > 0)
    assert(MARKER_STOPPED_MIDWAY.length > 0)

    const lower = raw.toLowerCase()
    const detail = error_strip_prefix(raw, PREFIX_NETWORK)

    if (lower.includes(MARKER_STOPPED_MIDWAY)) {
        return {
            title: 'The server stopped responding',
            message: 'The server stopped part-way through its reply. It may be busy; wait a '
                + `minute and try again. (${detail})`,
            kind: 'network',
        }
    }

    return {
        title: 'Network problem',
        message: 'The server could not be reached. Check your internet connection and try again. '
            + `(${detail})`,
        kind: 'network',
    }
}

function error_object_text(error: object): string {
    assert(typeof error === 'object')
    assert(typeof JSON.stringify === 'function')

    const maybe = (error as { message?: unknown }).message

    if (typeof maybe === 'string') return maybe

    return JSON.stringify(error)
}

function error_strip_prefix(raw: string, prefix: `${string}:`): string {
    assert(prefix.length > 0)
    assert(typeof raw === 'string')

    if (raw.toLowerCase().startsWith(prefix.toLowerCase())) {
        return raw.slice(prefix.length).trim()
    }

    return raw
}
