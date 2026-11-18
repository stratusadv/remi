import { existsSync, readFileSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { test as base, expect } from '@playwright/test'
import { assert } from '../../src/lib/assert'
import {
    CODE_PATTERN,
    address_unique,
    delta_key,
    descriptor_read,
    fakes_control,
    messages_to,
    portal_deltas_wait,
    portal_totals,
} from './world'
import type { Browser, BrowserContext, Page, Route } from '@playwright/test'


interface Fixtures {
    page_open: (agent: string) => Promise<Page>
}

const AGENT_LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const AGENT_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Version/18.0 Safari/605.1.15'

const AGENT_PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) '
    + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

const AGENT_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const CONTEXT_COUNT_MAX = 4
const DOCS_DIRECTORY = resolve(import.meta.dirname, '../../docs')
const EMAIL_STATUS_FAILED = 'The email did not send. Your mail app can send it instead.'

const EMAIL_STATUS_SENT = 'The email is on its way. '
    + 'Check your spam folder if it is not in your inbox in a minute.'

const FUNNEL_ORIGIN_DECLARATION = /^const funnel_origin = '[^']*';$/mu
const LAUNCH_FIRST_PLATFORMS: readonly string[] = Object.freeze(['macos', 'windows'])
const LAUNCH_FIRST_STEPS = 'https://remirememberthat.com/install/#first-launch-on-macos'
const ORIGIN_API = 'https://api.remirememberthat.com'
const ORIGIN_SITE = 'https://remirememberthat.com'
const RELEASE_DOWNLOAD = 'https://github.com/stratusadv/remi/releases/download/v1.4.0/'
const TITLE_CONFERENCE = 'a guest scans the code, emails it, and downloads with it on a computer'
const TITLE_GENERAL = 'the download page sends a phone to a computer, which downloads the Mac app'
const TITLE_HOME = 'a visitor from a link downloads the Linux app from the home page'
const TITLE_REFUSED = 'an email the server cannot send offers the mail app instead'
const USER_AGENT = 'userAgent'

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
    '.css': 'text/css',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
})

const RELEASE = Object.freeze({
    assets: [
        release_asset('remi-1.4.0-1.x86_64.rpm'),
        release_asset('remi_1.4.0_amd64.AppImage'),
        release_asset('remi_1.4.0_amd64.deb'),
        release_asset('remi_1.4.0_universal.dmg'),
        release_asset('remi_1.4.0_x64-setup.exe'),
    ],
    published_at: '2026-11-01T12:00:00Z',
    tag_name: 'v1.4.0',
})

const test = base.extend<Fixtures>({ page_open: page_open_fixture })


async function api_forward(route: Route): Promise<void> {
    assert(route.request().url().startsWith(`${ORIGIN_API}/`))

    const request = route.request()
    const url = new URL(request.url())
    const target = `${descriptor_read().remi_url}${url.pathname}${url.search}`

    assert(url.origin === ORIGIN_API)
    assert(url.pathname.startsWith('/api/'))

    const response = await route.fetch({ url: target })

    await route.fulfill({ response })
}

async function code_received(address: string): Promise<string> {
    assert(address.includes('@'))
    assert(address === address.trim())

    const [message] = await messages_to(address)
    const code = CODE_PATTERN.exec(message?.text ?? '')?.[0] ?? ''

    expect(code).toMatch(CODE_PATTERN)
    expect(message?.text).toContain(download_link(code))

    return code
}

async function contexts_close(contexts: BrowserContext[]): Promise<void> {
    assert(contexts.length <= CONTEXT_COUNT_MAX)

    const closing = contexts.splice(0, contexts.length)

    await Promise.all(closing.map(async (context) => context.close()))

    assert(contexts.length === 0)
}

function docs_file(pathname: string): string {
    assert(pathname.startsWith('/'))
    assert(!pathname.includes('..'))

    const relative = pathname.endsWith('/') ? `${pathname}index.html` : pathname
    const path = resolve(DOCS_DIRECTORY, `.${relative}`)

    assert(path.startsWith(`${DOCS_DIRECTORY}${sep}`), `${pathname} leaves the docs`)

    return path
}

async function docs_serve(route: Route): Promise<void> {
    assert(route.request().url().startsWith(`${ORIGIN_SITE}/`))

    const url = new URL(route.request().url())
    const path = docs_file(url.pathname)

    assert(url.origin === ORIGIN_SITE)

    if (!existsSync(path)) {
        await route.fulfill({ status: 404 })

        return
    }

    const content_type = CONTENT_TYPES[extname(path)] ?? 'application/octet-stream'
    const headers = { 'content-type': content_type }
    const source = readFileSync(path)

    if (!path.endsWith(`${sep}funnel.js`)) {
        await route.fulfill({ body: source, headers })

        return
    }

    const script = source.toString('utf8')

    assert(FUNNEL_ORIGIN_DECLARATION.test(script))

    const live = script.replace(FUNNEL_ORIGIN_DECLARATION, `const funnel_origin = '${ORIGIN_API}';`)

    await route.fulfill({ body: live, headers })
}

function download_link(code: string): string {
    assert(CODE_PATTERN.test(code))

    const query = new URLSearchParams({ code, utm_source: 'email' })

    return `${ORIGIN_SITE}/wib/download/?${query.toString()}`
}

async function download_link_open(computer: Page, code: string): Promise<void> {
    assert(!computer.isClosed())
    assert(CODE_PATTERN.test(code))

    await computer.goto(download_link(code))

    await expect(computer.locator('#code')).toHaveText(code)
}

async function download_start(page: Page, label: string, platform: string | null): Promise<void> {
    assert(!page.isClosed())
    assert(label.startsWith('Download for '))
    assert(platform === null || LAUNCH_FIRST_PLATFORMS.includes(platform))

    const shown = page.locator('[data-first-launch]:visible')
    const steps = page.locator('[data-first-launch="macos"] a')

    await expect(page.locator('#get-main')).toHaveText(label)
    await expect(steps).toHaveJSProperty('href', LAUNCH_FIRST_STEPS)

    if (platform === null) {
        await expect(shown).toHaveCount(0)
    } else {
        await expect(shown).toHaveCount(1)
        await expect(shown).toHaveAttribute('data-first-launch', platform)
    }

    await page.locator('#get-main').click()
}

async function email_send(page: Page, address: string): Promise<void> {
    assert(!page.isClosed())
    assert(address.includes('@'))

    await page.getByLabel('First name').fill('Avery')
    await page.getByLabel('Last name').fill('Lee')
    await page.getByLabel('Your email').fill(address)
    await page.getByRole('button', { exact: true, name: 'Email my code' }).click()
}

async function email_send_twice(phone: Page, address: string): Promise<void> {
    assert(!phone.isClosed())
    assert(address.includes('@'))

    await email_send(phone, address)

    await expect(phone.locator('#email-status')).toHaveText(EMAIL_STATUS_SENT)
    await expect.poll(async () => (await messages_to(address)).length).toBe(1)

    await email_send(phone, address)

    await expect(phone.locator('#email-status')).toHaveText(EMAIL_STATUS_SENT)
}

async function notice_shown(phone: Page): Promise<void> {
    assert(!phone.isClosed())
    assert(phone.url() === 'about:blank')

    const notice = phone.locator('#mobile')

    await phone.goto(`${ORIGIN_SITE}/download/`)

    await expect(notice).toBeVisible()
    await expect(notice.locator('a[href^="mailto:"]')).toHaveAttribute('href', /com%2Fdownload%2F/u)
}

async function page_open_fixture(
    { browser }: { browser: Browser },
    use: (page_open: Fixtures['page_open']) => Promise<void>,
): Promise<void> {
    assert(browser.isConnected())

    const contexts: BrowserContext[] = []

    await use(page_open_tracked.bind(null, browser, contexts))
    await contexts_close(contexts)
}

async function page_open_tracked(
    browser: Browser,
    contexts: BrowserContext[],
    agent: string,
): Promise<Page> {
    assert(browser.isConnected())
    assert(agent.startsWith('Mozilla/5.0 ('))
    assert(contexts.length < CONTEXT_COUNT_MAX)

    const context = await browser.newContext({ [USER_AGENT]: agent })

    contexts.push(context)

    const page = await context.newPage()

    await page.route(/^https:\/\//u, async (route) => route.fulfill({ status: 204 }))

    await page.route('https://fonts.googleapis.com/**', async (route) => {
        await route.fulfill({ body: '', headers: { 'content-type': 'text/css' } })
    })

    await page.route('https://api.github.com/**', async (route) => route.fulfill({ json: RELEASE }))
    await page.route(`${ORIGIN_SITE}/**`, docs_serve)
    await page.route(`${ORIGIN_API}/**`, api_forward)

    return page
}

function release_asset(name: string): object {
    assert(name.startsWith('remi'))
    assert(!name.includes('/'))

    return { browser_download_url: `${RELEASE_DOWNLOAD}${name}`, name, size: 9_000_000 }
}

test(TITLE_CONFERENCE, async ({ page_open }) => {
    const before = await portal_totals()
    const address = address_unique('website')
    const phone = await page_open(AGENT_PHONE)

    await phone.goto(`${ORIGIN_SITE}/wib/?utm_source=qr`)
    await email_send_twice(phone, address)

    const code = await code_received(address)
    const computer = await page_open(AGENT_WINDOWS)

    await download_link_open(computer, code)
    await download_start(computer, 'Download for Windows', 'windows')

    await portal_deltas_wait(before, {
        [delta_key({ campaign: 'wib', statistic: 'remi--funnel--downloads' })]: 1,
        [delta_key({ campaign: 'wib', statistic: 'remi--funnel--scans' })]: 1,
        [delta_key({ campaign: 'wib', statistic: 'remi--funnel--visits' })]: 2,
    })

    const messages = await messages_to(address)

    expect(messages).toHaveLength(1)
})

test(TITLE_GENERAL, async ({ page_open }) => {
    const before = await portal_totals()
    const phone = await page_open(AGENT_PHONE)

    await notice_shown(phone)

    const computer = await page_open(AGENT_MAC)

    await computer.goto(`${ORIGIN_SITE}/download/`)

    await expect(computer.locator('#mobile')).toBeHidden()
    await download_start(computer, 'Download for macOS', 'macos')

    await portal_deltas_wait(before, {
        [delta_key({ campaign: 'general', statistic: 'remi--funnel--downloads' })]: 1,
        [delta_key({ campaign: 'general', statistic: 'remi--funnel--visits' })]: 2,
    })
})

test(TITLE_HOME, async ({ page_open }) => {
    const before = await portal_totals()
    const page = await page_open(AGENT_LINUX)

    await page.goto(`${ORIGIN_SITE}/`)
    await page.locator('a[href="#download"]').first().click()
    await download_start(page, 'Download for Ubuntu', null)

    await portal_deltas_wait(before, {
        [delta_key({ campaign: 'general', statistic: 'remi--funnel--downloads' })]: 1,
        [delta_key({ campaign: 'general', statistic: 'remi--funnel--visits' })]: 1,
    })
})

test(TITLE_REFUSED, async ({ page_open }) => {
    const before = await portal_totals()
    const address = address_unique('refused')
    const phone = await page_open(AGENT_PHONE)

    await phone.goto(`${ORIGIN_SITE}/wib/?utm_source=qr`)
    await fakes_control('/control/faults', { sendgrid_down: true })

    try {
        await email_send(phone, address)

        await expect(phone.locator('#email-status')).toHaveText(EMAIL_STATUS_FAILED)
        await expect(phone.locator('#mailto')).toBeVisible()
    } finally {
        await fakes_control('/control/faults', { sendgrid_down: false })
    }

    await portal_deltas_wait(before, {
        [delta_key({ campaign: 'wib', statistic: 'remi--funnel--scans' })]: 1,
        [delta_key({ campaign: 'wib', statistic: 'remi--funnel--visits' })]: 1,
    })

    const messages = await messages_to(address)

    expect(messages).toHaveLength(0)
})
