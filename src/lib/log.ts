import { assert } from './assert'


const output = globalThis.console


export function log_information(message: string, ...details: readonly unknown[]): void {
    assert(message.length > 0)
    assert(details.length >= 0)

    output.info(message, ...details)
}

export function log_warn(message: string, ...details: readonly unknown[]): void {
    assert(message.length > 0)
    assert(details.length >= 0)

    output.warn(message, ...details)
}
