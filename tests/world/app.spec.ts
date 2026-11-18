import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { assert } from '../../src/lib/assert'
import {
    WAIT_MS,
    click,
    count,
    css,
    driver_start,
    evaluate,
    session_end,
    session_start,
    text_wait,
    type,
    xpath,
} from './driver'
import {
    CODE_PATTERN,
    address_unique,
    delta_key,
    descriptor_read,
    fakes_control,
    messages_to,
    portal_deltas_wait,
    portal_totals,
    sessions_list,
} from './world'
import type { ChildProcess } from 'node:child_process'
import type { Session, Target } from './driver'
import type { StripeSession, Totals } from './world'


interface Journey {
    address: string
    before: Totals
    driver: ChildProcess | null
    scratch: string
    session: Session | null
}

const ANSWER_FRAGMENT = /Morgan agreed to send the budget/u

const APPLICATION = process.env['REMI_WORLD_APPLICATION']
    ?? resolve(import.meta.dirname, '../../src-tauri/target/world/debug/remi')

const AUDIO_SAMPLE_RATE = 16_000
const AUDIO_SECONDS = 12
const BALANCE_AFTER_PURCHASE = 'You now have 59.9 hours of transcription.'
const BURST_SAMPLES = 12_000
const GAP_SAMPLES = 4_000
const OFFER_PRICE_CENTS = 1000
const PCM_PEAK = 9_000
const POSITION_X = 'x'
const POSITION_Y = 'y'
const QUANTUM_PLACES = 10_000
const SAMPLE_BYTES = 2
const SCRIPT_EMIT = 'return window.__TAURI_INTERNALS__.invoke("plugin:event|emit", arguments[0])'
const SECONDS_PER_HOUR = 3600
const TITLE_ASK = 'answers a question about the meeting'
const TITLE_PORTAL = 'lands each step of the journey in the portal under its campaign'
const TITLE_PURCHASE = 'buys a pack of hours through the payment form'
const TITLE_SIGN_UP = 'signs up with the code emailed by the conference page'
const TITLE_TRANSCRIBE = 'transcribes a dropped recording and charges its seconds'
const TONE_HERTZ = 220
const WAV_HEADER_BYTES = 44

const STRIPE_STANDIN = `
window.Stripe = function () {
    return {
        createPaymentMethod: function () {
            return Promise.resolve({ paymentMethod: { id: 'pm_world' } })
        },
        initCheckoutElementsSdk: function () {
            var handlers = {}
            var total = { amount: '$10.00', minorUnitsAmount: 1000 }
            var session = {
                currency: 'cad',
                email: null,
                minorUnitsAmountDivisor: 100,
                total: { total: total },
            }
            var actions = {
                confirm: function () { return Promise.resolve({ type: 'success', session }) },
                getSession: function () { return session },
            }
            var element = {
                destroy: function () {},
                mount: function (host) {
                    host.innerHTML = '<input aria-label="Card number" value="4242 4242 4242 4242">'
                    setTimeout(function () { handlers.ready({ elementType: 'payment' }) }, 0)
                },
                on: function (event, handler) { handlers[event] = handler; return element },
            }
            return {
                changeAppearance: function () {},
                createPaymentElement: function () { return element },
                loadActions: function () { return Promise.resolve({ type: 'success', actions }) },
            }
        },
    }
}
window.Stripe.version = 'endive'
return typeof window.Stripe
`


test.describe.serial('the real app against the live server and portal', () => {
    const journey: Journey = {
        address: address_unique('app'),
        before: new Map(),
        driver: null,
        scratch: '',
        session: null,
    }

    test.beforeAll(async () => {
        const scratch = scratch_create()

        journey.scratch = scratch
        journey.before = await portal_totals()
        journey.driver = await driver_start(environment_of(scratch))
        journey.session = await session_start(APPLICATION)
    })

    test.afterAll(journey_close.bind(null, journey))

    test(TITLE_SIGN_UP, journey_sign_up.bind(null, journey))
    test(TITLE_TRANSCRIBE, journey_transcribe.bind(null, journey))
    test(TITLE_PURCHASE, journey_purchase.bind(null, journey))
    test(TITLE_ASK, journey_ask.bind(null, journey))
    test(TITLE_PORTAL, journey_portal.bind(null, journey))
})

function audio_write(journey: Readonly<Journey>, path: string): void {
    assert(path.endsWith('.wav'))
    assert(path.startsWith(journey.scratch))

    const sample_count = AUDIO_SAMPLE_RATE * AUDIO_SECONDS
    const data = Buffer.alloc(sample_count * SAMPLE_BYTES)

    for (let index = 0; index < sample_count; index += 1) {
        const voiced = index % (BURST_SAMPLES + GAP_SAMPLES) < BURST_SAMPLES
        const phase = (2 * Math.PI * TONE_HERTZ * index) / AUDIO_SAMPLE_RATE
        const sample = voiced ? Math.round(PCM_PEAK * Math.sin(phase)) : 0

        data.writeInt16LE(sample, index * SAMPLE_BYTES)
    }

    writeFileSync(path, Buffer.concat([wav_header(data.length), data]))
}

function button_named(name: string): Target {
    assert(name.length > 0)
    assert(!name.includes('"'))

    return xpath(`//button[normalize-space(.)="${name}"]`)
}

async function code_emailed(address: string): Promise<string> {
    assert(address.includes('@'))
    assert(address === address.trim())

    const body = new URLSearchParams({ campaign: 'wib', email: address })
    const headers = { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }
    const url = `${descriptor_read().remi_url}/api/v1/funnel/email/`
    const response = await fetch(url, { body, headers, method: 'POST' })

    assert(response.status === 204, `the email beacon answered ${String(response.status)}`)

    const [message] = await messages_to(address)
    const code = CODE_PATTERN.exec(message?.text ?? '')?.[0] ?? ''

    assert(code !== '', 'the email carries no personal code')

    return code
}

function environment_of(scratch: string): NodeJS.ProcessEnv {
    assert(scratch.length > 0)
    assert(process.env['DISPLAY'] !== undefined, 'the app e2e runs under xvfb-run')

    const inherited = { ...process.env }

    Reflect.deleteProperty(inherited, 'WAYLAND_DISPLAY')

    return {
        ...inherited,
        XDG_CACHE_HOME: join(scratch, 'cache'),
        XDG_CONFIG_HOME: join(scratch, 'config'),
        XDG_DATA_HOME: join(scratch, 'data'),
    }
}

function field_named(label: string): Target {
    assert(label.length > 0)
    assert(!label.includes('"'))

    return xpath(`//label[.//span[normalize-space(.)="${label}"]]//input`)
}

async function journey_ask(journey: Readonly<Journey>): Promise<void> {
    assert(journey.driver?.exitCode === null, 'the tauri-driver exited')

    const session = session_current(journey)

    await click(session, xpath('//aside//button[normalize-space(.)="Ask"]'))
    await type(session, css('textarea.ask-composer-input'), 'What did Morgan agree to send?')
    await click(session, css('button.ask-send'))

    await text_wait(session, css('main .ask-exchange'), ANSWER_FRAGMENT)
}

async function journey_close(journey: Readonly<Journey>): Promise<void> {
    assert(journey.scratch === '' || journey.scratch.startsWith(tmpdir()))
    assert(journey.session === null || journey.driver !== null)

    const { driver, scratch, session } = journey

    try {
        if (session !== null) await session_end(session)
    } finally {
        driver?.kill()

        if (scratch !== '') rmSync(scratch, { force: true, recursive: true })
    }
}

async function journey_portal(journey: Readonly<Journey>): Promise<void> {
    assert(journey.before.size > 0)

    const hours = Math.round((AUDIO_SECONDS / SECONDS_PER_HOUR) * QUANTUM_PLACES) / QUANTUM_PLACES
    const revenue = OFFER_PRICE_CENTS / 100

    assert(hours > 0)

    await portal_deltas_wait(journey.before, {
        [delta_key({ campaign: 'wib', statistic: 'remi--funnel--activations' })]: 1,
        [delta_key({ campaign: 'wib', statistic: 'remi--funnel--checkouts' })]: 1,
        [delta_key({ campaign: 'wib', statistic: 'remi--funnel--paying-clients' })]: 1,
        [delta_key({ campaign: 'wib', statistic: 'remi--funnel--promos' })]: 1,
        [delta_key({ campaign: 'wib', statistic: 'remi--funnel--purchases' })]: 1,
        [delta_key({ campaign: 'wib', statistic: 'remi--funnel--signups' })]: 1,
        [delta_key({ campaign: 'wib', statistic: 'remi--sales--revenue' })]: revenue,
        [delta_key({ campaign: 'wib', statistic: 'remi--usage--hours' })]: hours,
        [delta_key({ campaign: 'wib', statistic: 'remi--usage--meetings' })]: 1,
    })
}

async function journey_purchase(journey: Readonly<Journey>): Promise<void> {
    assert(journey.driver?.exitCode === null, 'the tauri-driver exited')

    const session = session_current(journey)
    const installed = await evaluate(session, STRIPE_STANDIN, [])

    assert(installed === 'function', 'the Stripe.js stand-in did not install')

    await click(session, css('.sidebar-balance-buy'))
    await click(session, button_named('Buy 10 hours'))
    await expect.poll(async () => (await sessions_unpaid()).length).toBe(1)

    const [unpaid] = await sessions_unpaid()

    assert(unpaid !== undefined)
    assert(unpaid.amount_total === OFFER_PRICE_CENTS)

    await fakes_control('/control/stripe/pay', { session_id: unpaid.id })
    await text_wait(session, css('button.checkout-action'), 'Pay $10.00')
    await click(session, css('button.checkout-action'))

    await text_wait(session, css('.checkout-settled-text'), BALANCE_AFTER_PURCHASE)
    await text_wait(session, css('.sidebar-balance-text'), '59.9 hours left')
}

async function journey_sign_up(journey: Readonly<Journey>): Promise<void> {
    assert(journey.address.endsWith('@example.com'))

    const session = session_current(journey)
    const code = await code_emailed(journey.address)

    await text_wait(session, css('.welcome-title'), /Welcome to remi/u)
    await type(session, field_named('Name'), 'Avery Quinn')
    await type(session, field_named('Email'), journey.address)
    await click(session, region_named('Alberta'))
    await type(session, field_named('Promo code (optional)'), code.toLowerCase())
    await click(session, css('button.welcome-action'))

    await text_wait(session, css('.sidebar-balance-text'), '50 hours left')
}

async function journey_transcribe(journey: Readonly<Journey>): Promise<void> {
    assert(journey.scratch.startsWith(tmpdir()))

    const session = session_current(journey)
    const recording = join(journey.scratch, 'planning-meeting.wav')
    const position = { [POSITION_X]: 40, [POSITION_Y]: 40 }
    const drop = { event: 'tauri://drag-drop', payload: { paths: [recording], position } }

    audio_write(journey, recording)

    await evaluate(session, SCRIPT_EMIT, [drop])
    await click(session, button_named('Transcribe'))

    await expect.poll(async () => count(session, css('.transcript-pane-row')), {
        timeout: WAIT_MS,
    }).toBeGreaterThan(0)

    await text_wait(session, css('.sidebar-balance-text'), '49.9 hours left')
}

function region_named(name: string): Target {
    assert(name.length > 0)
    assert(!name.includes('"'))

    const field = '//label[.//span[normalize-space(.)="Province or state"]]'

    return xpath(`${field}//option[normalize-space(.)="${name}"]`)
}

function scratch_create(): string {
    const scratch = mkdtempSync(join(tmpdir(), 'remi-world-app-'))

    mkdirSync(join(scratch, 'config'), { recursive: true })

    assert(scratch.startsWith(tmpdir()))
    assert(existsSync(join(scratch, 'config')))

    return scratch
}

function session_current(journey: Readonly<Journey>): Session {
    assert(journey.session !== null, 'the app session is not open')
    assert(journey.session.id.length > 0)

    return journey.session
}

async function sessions_unpaid(): Promise<StripeSession[]> {
    const sessions = await sessions_list()

    assert(sessions.every((item) => item.amount_total > 0))

    return sessions.filter((item) => item.payment_status === 'unpaid')
}

function wav_header(data_bytes: number): Buffer {
    assert(data_bytes > 0)
    assert(data_bytes % SAMPLE_BYTES === 0)

    const header = Buffer.alloc(WAV_HEADER_BYTES)

    header.write('RIFF', 0, 'ascii')
    header.writeUInt32LE(WAV_HEADER_BYTES - 8 + data_bytes, 4)
    header.write('WAVE', 8, 'ascii')
    header.write('fmt ', 12, 'ascii')
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(1, 22)
    header.writeUInt32LE(AUDIO_SAMPLE_RATE, 24)
    header.writeUInt32LE(AUDIO_SAMPLE_RATE * SAMPLE_BYTES, 28)
    header.writeUInt16LE(SAMPLE_BYTES, 32)
    header.writeUInt16LE(16, 34)
    header.write('data', 36, 'ascii')
    header.writeUInt32LE(data_bytes, 40)

    return header
}
