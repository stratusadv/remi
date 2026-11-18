import { invoke } from '@tauri-apps/api/core'
import { assert } from './assert'


type LogLevel = 'error' | 'information' | 'warning'

const DETAILS_MAX = 2
const LINE_LENGTH_MAX = 16_384
const LOG_LEVELS: readonly LogLevel[] = Object.freeze(['error', 'information', 'warning'])
const TAURI_INTERNALS = '__TAURI_INTERNALS__'
const output = globalThis.console


export function log_error(message: string, ...details: readonly unknown[]): void {
    assert(message.length > 0)
    assert(details.length <= DETAILS_MAX)

    output.error(message, ...details)
    log_forward('error', message, details)
}

export function log_information(message: string, ...details: readonly unknown[]): void {
    assert(message.length > 0)
    assert(details.length <= DETAILS_MAX)

    output.info(message, ...details)
    log_forward('information', message, details)
}

export function log_warn(message: string, ...details: readonly unknown[]): void {
    assert(message.length > 0)
    assert(details.length <= DETAILS_MAX)

    output.warn(message, ...details)
    log_forward('warning', message, details)
}

function log_detail_text(detail: unknown): string {
    if (detail instanceof Error) return detail.stack ?? `${detail.name}: ${detail.message}`

    switch (typeof detail) {
        case 'object':
            return detail === null ? 'null' : log_object_text(detail)
        case 'function':
            return detail.name
        case 'bigint':
        case 'boolean':
        case 'number':
        case 'string':
        case 'symbol':
        case 'undefined':
            return String(detail)
    }
}

function log_forward(level: LogLevel, message: string, details: readonly unknown[]): void {
    assert(LOG_LEVELS.includes(level))
    assert(message.length > 0)
    assert(details.length <= DETAILS_MAX)

    if (!Reflect.has(globalThis, TAURI_INTERNALS)) return

    const line = [message, ...details.map(log_detail_text)].join(' ').slice(0, LINE_LENGTH_MAX)

    assert(line.startsWith(message.slice(0, LINE_LENGTH_MAX)))

    void invoke('log_write', { level, message: line }).catch((error: unknown) => {
        output.warn('[remi] the log file did not take a line', error)
    })
}

function log_object_text(detail: object): string {
    assert(typeof detail === 'object')
    assert(!(detail instanceof Error))

    try {
        return JSON.stringify(detail)
    } catch {
        return Object.prototype.toString.call(detail)
    }
}
