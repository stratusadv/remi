import { expect } from '@playwright/test'
import { assert } from '../../src/lib/assert'


export interface Descriptor {
    readonly fakes_url: string
    readonly portal_api_key: string
    readonly portal_url: string
    readonly remi_url: string
}

export interface SendgridMessage {
    readonly html: string
    readonly subject: string
    readonly text: string
    readonly to: readonly string[]
}

export interface StripeSession {
    readonly amount_total: number
    readonly id: string
    readonly payment_status: string
}

interface PortalValue {
    readonly reference: string
    readonly value: number
}

export type Totals = ReadonlyMap<string, number>

export const CODE_PATTERN = /WIB-[23456789A-HJKMNP-TV-Z]{4}-[23456789A-HJKMNP-TV-Z]{4}/u
export const PORTAL_WAIT_MS = 30_000

const DAY_MS = 86_400_000
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u
const POLL_INTERVALS_MS = Object.freeze([250])
const PORTAL_DAY_OFFSETS: readonly number[] = Object.freeze([-1, 0, 1])
const PORTAL_PAGE_SIZE = 5000
const PORTAL_REFERENCE_PREFIX = 'remi:'
const PORTAL_SUB_DOMAIN_KEY = 'remi--metrics'
const QUANTUM_PLACES = 10_000

const PORTAL_STATISTICS: readonly string[] = Object.freeze([
    'remi--remi-metric--acquisition',
    'remi--remi-metric--action',
])


export function address_unique(prefix: string): string {
    assert(/^[a-z]+$/u.test(prefix))
    assert(prefix.length < 20)

    const salt = `${String(Date.now())}${String(process.pid)}${String(Math.random()).slice(2, 8)}`

    return `${prefix}-${salt}@example.com`
}

export function descriptor_read(): Descriptor {
    const descriptor = {
        fakes_url: environment_read('REMI_WORLD_FAKES_URL'),
        portal_api_key: environment_read('REMI_WORLD_PORTAL_API_KEY'),
        portal_url: environment_read('REMI_WORLD_PORTAL_URL'),
        remi_url: environment_read('REMI_WORLD_REMI_URL'),
    }

    assert(descriptor.remi_url.startsWith('http://127.0.0.1:'))
    assert(descriptor.fakes_url.startsWith('http://127.0.0.1:'))

    return descriptor
}

export async function fakes_control(path: string, payload: object): Promise<unknown> {
    assert(path.startsWith('/control/'))
    assert(typeof payload === 'object')

    const url = `${descriptor_read().fakes_url}${path}`
    const headers = { 'content-type': 'application/json' }
    const body = JSON.stringify(payload)
    const response = await fetch(url, { body, headers, method: 'POST' })

    assert(response.ok, `the fakes refused ${path}: ${String(response.status)}`)

    return response.json()
}

export async function messages_to(address: string): Promise<SendgridMessage[]> {
    assert(address.includes('@'))
    assert(address === address.trim())

    const state = await fakes_state()
    const messages = array_field(state, 'sendgrid_messages').map(message_of)

    return messages.filter((message) => message.to.includes(address))
}

export async function portal_deltas_wait(
    before: Totals,
    expected: Readonly<Record<string, number>>,
): Promise<void> {
    assert([...before.values()].every((total) => total > 0), 'a total before is not positive')
    assert(Object.keys(expected).length > 0)

    const entries = Object.entries(expected)

    assert(entries.every(([reference]) => reference.startsWith(PORTAL_REFERENCE_PREFIX)))
    assert(entries.every(([, delta]) => delta !== 0), 'an expected delta is zero')

    const wanted = Object.fromEntries(entries.sort(entry_compare))
    const options = { intervals: [...POLL_INTERVALS_MS], timeout: PORTAL_WAIT_MS }

    await expect.poll(async () => portal_deltas(before), options).toEqual(wanted)
}

export async function portal_totals(): Promise<Totals> {
    const now = Date.now()
    const days = PORTAL_DAY_OFFSETS.map((offset) => date_iso(now + (offset * DAY_MS)))

    const queries = PORTAL_STATISTICS.flatMap(
        (statistic) => days.map((day) => ({ day, statistic })),
    )

    const replies = await Promise.all(queries.map(portal_day_values))
    const totals = new Map<string, number>()

    assert(replies.length === PORTAL_STATISTICS.length * PORTAL_DAY_OFFSETS.length)

    for (const { reference, value } of replies.flat()) {
        totals.set(reference, (totals.get(reference) ?? 0) + value)
    }

    return totals
}

export async function sessions_list(): Promise<StripeSession[]> {
    const state = await fakes_state()
    const sessions = array_field(state, 'sessions').map(session_of)

    assert(sessions.every((session) => session.id.startsWith('cs_')))
    assert(sessions.every((session) => Number.isSafeInteger(session.amount_total)))

    return sessions
}

function array_field(value: unknown, field: string): unknown[] {
    assert(field.length > 0)

    const found: unknown = Reflect.get(record_of(value), field)

    assert(Array.isArray(found), `${field} is not a list`)

    return found
}

function date_iso(milliseconds: number): string {
    assert(Number.isSafeInteger(milliseconds))
    assert(milliseconds > 0)

    return new Date(milliseconds).toISOString().slice(0, 10)
}

function entry_compare(
    left: readonly [string, unknown],
    right: readonly [string, unknown],
): number {
    assert(left[0] !== '')
    assert(right[0] !== '')

    return left[0].localeCompare(right[0])
}

function environment_read(name: string): string {
    assert(name.startsWith('REMI_WORLD_'))

    const value = process.env[name] ?? ''

    assert(value !== '', `${name} names the live world: run just test-world`)

    return value
}

async function fakes_state(): Promise<unknown> {
    const response = await fetch(`${descriptor_read().fakes_url}/control/state`)

    assert(response.ok)

    return response.json()
}

function message_of(value: unknown): SendgridMessage {
    const recipients = array_field(value, 'to')

    assert(recipients.every((recipient) => typeof recipient === 'string'))
    assert(recipients.length > 0)

    return {
        html: text_field(value, 'html'),
        subject: text_field(value, 'subject'),
        text: text_field(value, 'text'),
        to: recipients.map(String),
    }
}

function number_field(value: unknown, field: string): number {
    assert(field.length > 0)

    const found: unknown = Reflect.get(record_of(value), field)

    assert(typeof found === 'number', `${field} is not a number`)

    return found
}

async function portal_day_values(
    { day, statistic }: { day: string, statistic: string },
): Promise<PortalValue[]> {
    assert(DAY_PATTERN.test(day))
    assert(PORTAL_STATISTICS.includes(statistic))

    const descriptor = descriptor_read()

    const query = new URLSearchParams({
        limit: String(PORTAL_PAGE_SIZE),
        sub_domain_key: PORTAL_SUB_DOMAIN_KEY,
        value_date: day,
    })

    const base = `${descriptor.portal_url}/ds/api/v1/metric/domain/statistic`
    const headers = { 'x-api-key': descriptor.portal_api_key }
    const response = await fetch(`${base}/${statistic}/values?${query.toString()}`, { headers })

    assert(response.ok, `the portal answered ${String(response.status)} for ${statistic}`)

    const reply: unknown = await response.json()

    assert(Array.isArray(reply), `the portal sent the ${statistic} values as no list`)
    assert(reply.length < PORTAL_PAGE_SIZE, `${statistic} on ${day} fills a page of values`)

    return reply.map(portal_value_of)
}

async function portal_deltas(before: Totals): Promise<Record<string, number>> {
    assert([...before.values()].every((total) => total > 0), 'a total before is not positive')

    const after = await portal_totals()
    const references = [...new Set([...before.keys(), ...after.keys()])]

    const deltas = references.map((reference) => {
        const change = (after.get(reference) ?? 0) - (before.get(reference) ?? 0)

        return [reference, Math.round(change * QUANTUM_PLACES) / QUANTUM_PLACES] as const
    })

    const moved = deltas.filter(([, delta]) => delta !== 0)

    assert(moved.length <= references.length)

    return Object.fromEntries(moved.sort(entry_compare))
}

function portal_value_of(value: unknown): PortalValue {
    const reference = text_field(value, 'reference')
    const amount = Number(text_field(value, 'value'))

    assert(reference.startsWith(PORTAL_REFERENCE_PREFIX), `${reference} is outside remi`)
    assert(Number.isFinite(amount), `${reference} carries ${String(amount)}`)
    assert(amount > 0, `${reference} carries ${String(amount)}`)

    return { reference, value: amount }
}

function record_of(value: unknown): object {
    assert(typeof value === 'object', 'a reply is not an object')
    assert(value !== null, 'a reply is null')

    return value
}

function session_of(value: unknown): StripeSession {
    return {
        amount_total: number_field(value, 'amount_total'),
        id: text_field(value, 'id'),
        payment_status: text_field(value, 'payment_status'),
    }
}

function text_field(value: unknown, field: string): string {
    assert(field.length > 0)

    const found: unknown = Reflect.get(record_of(value), field)

    assert(typeof found === 'string', `${field} is not text`)

    return found
}
