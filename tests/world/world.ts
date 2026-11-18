import { expect } from '@playwright/test'
import { assert } from '../../src/lib/assert'


export interface Descriptor {
    readonly fakes_url: string
    readonly portal_api_key: string
    readonly portal_url: string
    readonly remi_url: string
}

export interface Metric {
    readonly campaign: string
    readonly statistic: string
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

export type Totals = ReadonlyMap<string, number>

export const CAMPAIGNS: readonly string[] = Object.freeze(['general', 'wib'])
export const CODE_PATTERN = /WIB-[23456789A-HJKMNP-TV-Z]{4}-[23456789A-HJKMNP-TV-Z]{4}/u
export const PORTAL_WAIT_MS = 30_000

export const STATISTICS: readonly string[] = Object.freeze([
    'remi--funnel--activations',
    'remi--funnel--checkouts',
    'remi--funnel--downloads',
    'remi--funnel--paying-clients',
    'remi--funnel--promos',
    'remi--funnel--purchases',
    'remi--funnel--scans',
    'remi--funnel--signups',
    'remi--funnel--visits',
    'remi--sales--revenue',
    'remi--usage--hours',
    'remi--usage--meetings',
])

const DAY_MS = 86_400_000
const POLL_INTERVALS_MS = Object.freeze([250])
const QUANTUM_PLACES = 10_000


export function address_unique(prefix: string): string {
    assert(/^[a-z]+$/u.test(prefix))
    assert(prefix.length < 20)

    const salt = `${String(Date.now())}${String(process.pid)}${String(Math.random()).slice(2, 8)}`

    return `${prefix}-${salt}@example.com`
}

export function delta_key({ campaign, statistic }: Metric): string {
    assert(STATISTICS.includes(statistic))
    assert(CAMPAIGNS.includes(campaign))

    return `${statistic} ${campaign}`
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

export async function sessions_list(): Promise<StripeSession[]> {
    const state = await fakes_state()
    const sessions = array_field(state, 'sessions').map(session_of)

    assert(sessions.every((session) => session.id.startsWith('cs_')))
    assert(sessions.every((session) => Number.isSafeInteger(session.amount_total)))

    return sessions
}

export async function portal_total({ campaign, statistic }: Metric): Promise<number> {
    assert(STATISTICS.includes(statistic))
    assert(CAMPAIGNS.includes(campaign))

    const descriptor = descriptor_read()
    const now = Date.now()

    const query = new URLSearchParams({
        end_date: date_iso(now + DAY_MS),
        start_date: date_iso(now - DAY_MS),
        sub_domain_key: `remi--${campaign}`,
    })

    const base = `${descriptor.portal_url}/ds/api/v1/metric/domain/statistic`
    const headers = { 'x-api-key': descriptor.portal_api_key }
    const response = await fetch(`${base}/${statistic}/summary?${query.toString()}`, { headers })

    assert(response.ok, `the portal answered ${String(response.status)} for ${statistic}`)

    const reply: unknown = await response.json()
    const totals = Object.values(record_of(Reflect.get(record_of(reply), 'totals')))

    assert(totals.every((total) => typeof total === 'string'), `${statistic} totals are not text`)

    return totals.reduce<number>((sum, total) => sum + Number(total), 0)
}

export async function portal_totals(): Promise<Totals> {
    const keys = STATISTICS.flatMap(
        (statistic) => CAMPAIGNS.map((campaign) => ({ campaign, statistic })),
    )

    const totals = await Promise.all(keys.map(async (metric) => {
        const total = await portal_total(metric)

        return [delta_key(metric), total] as const
    }))

    assert(totals.length === STATISTICS.length * CAMPAIGNS.length)
    assert(new Set(totals.map(([key]) => key)).size === totals.length)

    return new Map(totals)
}

export async function portal_deltas_wait(
    before: Totals,
    expected: Readonly<Record<string, number>>,
): Promise<void> {
    assert(before.size === STATISTICS.length * CAMPAIGNS.length)
    assert(Object.keys(expected).length > 0)

    const wanted = Object.fromEntries(Object.entries(expected).sort(entry_compare))
    const options = { intervals: [...POLL_INTERVALS_MS], timeout: PORTAL_WAIT_MS }

    await expect.poll(async () => portal_deltas(before), options).toEqual(wanted)
}

async function portal_deltas(before: Totals): Promise<Record<string, number>> {
    assert(before.size > 0)

    const after = await portal_totals()

    assert(after.size === before.size)

    const moved = [...after].filter(([key, total]) => total !== before.get(key))

    const deltas = moved.map(([key, total]) => {
        const change = Math.round((total - (before.get(key) ?? 0)) * QUANTUM_PLACES)

        return [key, change / QUANTUM_PLACES] as const
    })

    return Object.fromEntries(deltas.sort(entry_compare))
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
