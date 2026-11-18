import { spawn } from 'node:child_process'
import { expect } from '@playwright/test'
import { assert } from '../../src/lib/assert'
import type { ChildProcess } from 'node:child_process'


export interface Session {
    readonly id: string
}

export interface Target {
    readonly using: 'css selector' | 'xpath'
    readonly value: string
}

interface Exchange {
    readonly body?: object
    readonly method: 'DELETE' | 'GET' | 'POST'
    readonly path: string
}

export const WAIT_MS = 60_000

const ALWAYS_MATCH = 'alwaysMatch'
const ARGUMENTS = 'args'
const DRIVER_PORT = 4444
const DRIVER_URL = `http://127.0.0.1:${String(DRIVER_PORT)}`
const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf'
const ENVIRONMENT = 'env'
const POLL_INTERVALS_MS = Object.freeze([250])
const SCROLL_SCRIPT = 'arguments[0].scrollIntoView({ block: "center" })'


export function css(value: string): Target {
    assert(value.length > 0)
    assert(!value.startsWith('/'))

    return { using: 'css selector', value }
}

export async function click(session: Session, target: Target): Promise<void> {
    assert(session.id.length > 0)
    assert(target.value.length > 0)

    const options = { intervals: [...POLL_INTERVALS_MS], timeout: WAIT_MS }

    await expect.poll(async () => element_enabled_or_false(session, target), options).toBe(true)

    const element = await element_find(session, target)
    const reference = { [ELEMENT_KEY]: element }

    await command({
        body: { [ARGUMENTS]: [reference], script: SCROLL_SCRIPT },
        method: 'POST',
        path: `/session/${session.id}/execute/sync`,
    })

    await command({
        body: {},
        method: 'POST',
        path: `/session/${session.id}/element/${element}/click`,
    })
}

export async function count(session: Session, target: Target): Promise<number> {
    assert(session.id.length > 0)
    assert(target.value.length > 0)

    const found = await command({
        body: target,
        method: 'POST',
        path: `/session/${session.id}/elements`,
    })

    assert(Array.isArray(found))

    return found.length
}

export async function driver_start(environment: NodeJS.ProcessEnv): Promise<ChildProcess> {
    assert(Object.keys(environment).length > 0)
    assert(DRIVER_URL.startsWith('http://127.0.0.1:'))

    const driver = spawn('tauri-driver', ['--port', String(DRIVER_PORT)], {
        [ENVIRONMENT]: environment,
        stdio: 'inherit',
    })

    const options = { intervals: [...POLL_INTERVALS_MS], timeout: WAIT_MS }

    await expect.poll(driver_ready, options).toBe(true)

    return driver
}

export async function evaluate(
    session: Session,
    script: string,
    script_arguments: readonly unknown[],
): Promise<unknown> {
    assert(session.id.length > 0)
    assert(script.length > 0)
    assert(script_arguments.every((value) => value !== undefined))

    return command({
        body: { [ARGUMENTS]: script_arguments, script },
        method: 'POST',
        path: `/session/${session.id}/execute/sync`,
    })
}

export async function session_end(session: Session): Promise<void> {
    assert(session.id.length > 0)

    await command({ method: 'DELETE', path: `/session/${session.id}` })
}

export async function session_start(application: string): Promise<Session> {
    assert(application.length > 0)
    assert(application.startsWith('/'))

    const capabilities = { [ALWAYS_MATCH]: { 'tauri:options': { application } } }
    const reply = await command({ body: { capabilities }, method: 'POST', path: '/session' })
    const id: unknown = Reflect.get(record_of(reply), 'sessionId')

    assert(typeof id === 'string')

    return { id }
}

export async function text(session: Session, target: Target): Promise<string> {
    assert(session.id.length > 0)
    assert(target.value.length > 0)

    const element = await element_find(session, target)
    const path = `/session/${session.id}/element/${element}/text`
    const reply = await command({ method: 'GET', path })

    assert(typeof reply === 'string')

    return reply
}

export async function text_wait(
    session: Session,
    target: Target,
    wanted: string | RegExp,
): Promise<void> {
    assert(session.id.length > 0)
    assert(target.value.length > 0)
    assert(wanted !== '')

    const options = { intervals: [...POLL_INTERVALS_MS], timeout: WAIT_MS }

    await expect.poll(async () => text_or_empty(session, target), options).toMatch(wanted)
}

export async function type(session: Session, target: Target, keys: string): Promise<void> {
    assert(session.id.length > 0)
    assert(target.value.length > 0)
    assert(keys.length > 0)

    const element = await element_find(session, target)
    const path = `/session/${session.id}/element/${element}`

    await command({ body: {}, method: 'POST', path: `${path}/clear` })
    await command({ body: { text: keys }, method: 'POST', path: `${path}/value` })
}

export function xpath(value: string): Target {
    assert(value.startsWith('/'))
    assert(value.length > 1)

    return { using: 'xpath', value }
}

async function command(exchange: Exchange): Promise<unknown> {
    assert(exchange.path.startsWith('/'))
    assert(exchange.method.length > 0)

    const { body, method, path } = exchange

    const response = await fetch(`${DRIVER_URL}${path}`, {
        body: body === undefined ? null : JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
        method,
    })

    const value: unknown = Reflect.get(record_of(await response.json()), 'value')

    if (!response.ok) throw new Error(`${method} ${path} failed: ${JSON.stringify(value)}`)

    return value
}

async function driver_ready(): Promise<boolean> {
    assert(DRIVER_URL.startsWith('http'))
    assert(DRIVER_URL.endsWith(String(DRIVER_PORT)))

    const reply = await fetch(`${DRIVER_URL}/status`).catch(reply_absent)

    return reply?.ok === true
}

async function element_enabled(session: Session, target: Target): Promise<boolean> {
    assert(session.id.length > 0)
    assert(target.value.length > 0)

    const element = await element_find(session, target)
    const path = `/session/${session.id}/element/${element}/enabled`
    const reply = await command({ method: 'GET', path })

    assert(typeof reply === 'boolean')

    return reply
}

async function element_enabled_or_false(session: Session, target: Target): Promise<boolean> {
    assert(session.id.length > 0)
    assert(target.value.length > 0)

    return element_enabled(session, target).catch(() => false)
}

async function element_find(session: Session, target: Target): Promise<string> {
    assert(session.id.length > 0)
    assert(target.value.length > 0)

    const found = await command({
        body: target,
        method: 'POST',
        path: `/session/${session.id}/element`,
    })

    const element: unknown = Reflect.get(record_of(found), ELEMENT_KEY)

    if (typeof element !== 'string') throw new Error(`${target.value} matched no element`)

    return element
}

function record_of(value: unknown): object {
    assert(typeof value === 'object', 'a WebDriver reply is not an object')
    assert(value !== null, 'a WebDriver reply is null')

    return value
}

function reply_absent(reason: unknown): null {
    assert(reason !== undefined)
    assert(reason !== null)

    return null
}

async function text_or_empty(session: Session, target: Target): Promise<string> {
    assert(session.id.length > 0)
    assert(target.value.length > 0)

    return text(session, target).catch(() => '')
}
