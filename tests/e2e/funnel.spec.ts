import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { assert } from '../../src/lib/assert'
import type { Page, Request } from '@playwright/test'


const AGENT_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Version/18.0 Safari/605.1.15'

const AGENT_PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) '
    + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

const BEACON_CONTENT_TYPE = 'application/x-www-form-urlencoded;charset=UTF-8'
const CODE_EMAILED = 'WIB-7KQ4-M2XD'
const CODE_PRINTED = 'WIB2026'
const EMAIL_ADDRESS = 'avery@example.com'
const EMAIL_BODY = 'campaign=wib&email=avery%40example.com'
const EMAIL_STATUS_FAILED = 'The email did not send. Your mail app can send it instead.'
const EMAIL_STATUS_INVALID = 'That address does not look right. Check it and try again.'

const EMAIL_STATUS_SENT = 'The email is on its way. '
    + 'Check your spam folder if it is not in your inbox in a minute.'

const FUNNEL_ORIGIN = 'https://funnel.example.test'
const FUNNEL_ORIGIN_DECLARATION = /^const funnel_origin = '[^']*';$/m
const FUNNEL_PATH = new URL('../../docs/assets/funnel.js', import.meta.url)
const FUNNEL_SOURCE = readFileSync(FUNNEL_PATH, 'utf8')
const PAGE_GENERAL = '/docs/index.html'
const PAGE_WIB = '/docs/wib/index.html'
const PAGE_WIB_DOWNLOAD = '/docs/wib/download/index.html'
const PAGE_WIB_EMAILED = `${PAGE_WIB_DOWNLOAD}?code=${CODE_EMAILED.toLowerCase()}&utm_source=email`
const PAGE_WIB_SCANNED = `${PAGE_WIB}?utm_source=qr`
const RELEASE_DOWNLOAD = 'https://github.com/stratusadv/remi/releases/download/v1.4.0/'

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


interface Beacon {
    body: string
    path: string
    type: string
}

function agent_script(agent: string): string {
    assert(agent.startsWith('Mozilla/5.0 ('))
    assert([AGENT_MAC, AGENT_PHONE].includes(agent))
    assert(!agent.includes('\''))
    assert(!agent.includes('\\'))

    return `Object.defineProperty(navigator, 'userAgent', { get: () => '${agent}' })`
}

function beacon_expected(kind: 'download' | 'visit', body: string): Beacon {
    assert(kind.length > 0)
    assert(body.startsWith('campaign='))

    return { body, path: `/api/v1/funnel/${kind}/`, type: BEACON_CONTENT_TYPE }
}

async function email_answer(page: Page, answer: number | 'unreachable'): Promise<string[]> {
    assert(!page.isClosed())
    assert(answer === 'unreachable' || (answer >= 200 && answer <= 599))

    const bodies: string[] = []
    const headers = { 'access-control-allow-origin': '*' }

    await page.route(`${FUNNEL_ORIGIN}/api/v1/funnel/email/`, async (route) => {
        bodies.push(route.request().postData() ?? '')

        if (answer === 'unreachable') {
            await route.abort('connectionrefused')

            return
        }

        await route.fulfill({ headers, status: answer })
    })

    return bodies
}

function beacon_received(request: Request): Beacon {
    assert(request.method() === 'POST')
    assert(request.url().startsWith(FUNNEL_ORIGIN))

    return {
        body: request.postData() ?? '',
        path: new URL(request.url()).pathname,
        type: request.headers()['content-type'] ?? '',
    }
}

function funnel_script(origin: string): string {
    assert(origin.startsWith('https://'))
    assert(FUNNEL_ORIGIN_DECLARATION.test(FUNNEL_SOURCE))

    return FUNNEL_SOURCE.replace(FUNNEL_ORIGIN_DECLARATION, `const funnel_origin = '${origin}';`)
}

async function landing_open(
    page: Page,
    path: string,
    origin: URL | null = new URL(FUNNEL_ORIGIN),
): Promise<Beacon[]> {
    assert(!page.isClosed())
    assert(path.startsWith('/docs/'))
    assert(origin === null || origin.protocol === 'https:')

    const beacons: Beacon[] = []

    await page.route(/^https:\/\//, async (route) => route.fulfill({ status: 204 }))
    await page.route('https://api.github.com/**', async (route) => route.fulfill({ json: RELEASE }))

    await page.route('https://fonts.googleapis.com/**', async (route) => {
        await route.fulfill({ body: '', headers: { 'content-type': 'text/css' } })
    })

    await page.route(`${FUNNEL_ORIGIN}/**`, async (route) => {
        beacons.push(beacon_received(route.request()))
        await route.fulfill({ status: 204 })
    })

    if (origin !== null) {
        const body = funnel_script(origin.origin)

        await page.route('**/docs/assets/funnel.js', async (route) => {
            await route.fulfill({ body, headers: { 'content-type': 'text/javascript' } })
        })
    }

    await page.goto(path)

    return beacons
}

function release_asset(name: string): object {
    assert(name.startsWith('remi'))
    assert(!name.includes('/'))

    return { browser_download_url: `${RELEASE_DOWNLOAD}${name}`, name, size: 9_000_000 }
}

test('a scan of the WIB code counts a visit and a scan, not a download', async ({ page }) => {
    const beacons = await landing_open(page, PAGE_WIB_SCANNED)
    const visit = beacon_expected('visit', 'campaign=wib&source=qr')

    await expect.poll(() => beacons).toEqual([visit])
    await expect(page.getByLabel('Your email')).toBeVisible()
    await expect(page.locator('a[href$="-setup.exe"]')).toHaveCount(0)
})

test('the emailed download page sends its code with each download', async ({ page }) => {
    const beacons = await landing_open(page, PAGE_WIB_EMAILED)
    const visit = beacon_expected('visit', 'campaign=wib&source=email')
    const fields = `campaign=wib&code=${CODE_EMAILED}`

    await expect(page.locator('#code')).toHaveText(CODE_EMAILED)
    await expect(page.getByRole('button', { name: 'Copy code' })).toBeVisible()
    await expect.poll(() => beacons).toEqual([visit])

    const windows = beacon_expected('download', `${fields}&platform=windows`)

    await page.locator('a[href$="-setup.exe"]').first().click()

    await expect.poll(() => beacons).toEqual([visit, windows])

    const linux = beacon_expected('download', `${fields}&platform=linux`)

    await page.locator('a[href$=".AppImage"]').first().click()

    await expect.poll(() => beacons).toEqual([visit, windows, linux])
})

test('a download page without a usable code shows the printed one', async ({ page }) => {
    const beacons = await landing_open(page, `${PAGE_WIB_DOWNLOAD}?code=two%20words`)
    const visit = beacon_expected('visit', 'campaign=wib&source=link')
    const windows = beacon_expected('download', 'campaign=wib&platform=windows')

    await expect(page.locator('#code')).toHaveText(CODE_PRINTED)

    await page.locator('a[href$="-setup.exe"]').first().click()

    await expect.poll(() => beacons).toEqual([visit, windows])
})

test('the WIB page offers the email form on a computer too', async ({ page }) => {
    await landing_open(page, PAGE_WIB)

    const bodies = await email_answer(page, 204)

    await page.getByLabel('Your email').fill(EMAIL_ADDRESS)
    await page.getByRole('button', { exact: true, name: 'Email my code' }).click()

    await expect.poll(() => bodies).toEqual([EMAIL_BODY])
    await expect(page.locator('#email-status')).toHaveText(EMAIL_STATUS_SENT)
})

test.describe('on a Mac', () => {
    test.beforeEach(async ({ page }) => {
        await page.addInitScript({ content: agent_script(AGENT_MAC) })
    })

    test('the home page offers the disk image and counts it as macOS', async ({ page }) => {
        const beacons = await landing_open(page, PAGE_GENERAL)
        const visit = beacon_expected('visit', 'campaign=general&source=link')
        const macos = beacon_expected('download', 'campaign=general&platform=macos')
        const button = page.locator('#get-main')
        const image = `${RELEASE_DOWNLOAD}remi_1.4.0_universal.dmg`

        await expect(button).toHaveText('Download for macOS')
        await expect(button).toHaveAttribute('href', image)

        await button.click()

        await expect.poll(() => beacons).toEqual([visit, macos])
    })

    test('the WIB download page recommends the disk image', async ({ page }) => {
        await landing_open(page, PAGE_WIB_EMAILED)

        const button = page.locator('#get-main')

        await expect(button).toHaveText('Download for macOS')
        await expect(button).toHaveAttribute('href', /_universal\.dmg$/)
    })
})

test('the home page counts a linked visit, then only clicks on installers', async ({ page }) => {
    const beacons = await landing_open(page, PAGE_GENERAL)
    const visit = beacon_expected('visit', 'campaign=general&source=link')
    const linux = beacon_expected('download', 'campaign=general&platform=linux')
    const installer = page.locator('a[href$=".deb"]').first()

    await expect.poll(() => beacons).toEqual([visit])
    await expect(installer).toBeVisible()

    await page.locator('a[href="#download"]').first().click()
    await installer.click()

    await expect.poll(() => beacons).toEqual([visit, linux])
})

test.describe('on a phone', () => {
    test.beforeEach(async ({ page }) => {
        await page.addInitScript({ content: agent_script(AGENT_PHONE) })
    })

    test('the WIB page emails a code through the server', async ({ page }) => {
        await landing_open(page, PAGE_WIB_SCANNED)

        const bodies = await email_answer(page, 204)
        const address = page.getByLabel('Your email')

        await expect(page.locator('#mailto')).toBeHidden()

        await address.fill(EMAIL_ADDRESS)
        await page.getByRole('button', { exact: true, name: 'Email my code' }).click()

        await expect.poll(() => bodies).toEqual([EMAIL_BODY])
        await expect(page.locator('#email-status')).toHaveText(EMAIL_STATUS_SENT)
        await expect(address).toHaveValue('')
    })

    const failures = [
        { answer: 503, title: 'a refused send falls back to the mail app' },
        { answer: 'unreachable', title: 'an unreachable server falls back to the mail app' },
    ] as const

    for (const failure of failures) {
        test(failure.title, async ({ page }) => {
            await landing_open(page, PAGE_WIB_SCANNED)

            const bodies = await email_answer(page, failure.answer)

            await page.getByLabel('Your email').fill(EMAIL_ADDRESS)
            await page.getByRole('button', { exact: true, name: 'Email my code' }).click()

            await expect.poll(() => bodies).toEqual([EMAIL_BODY])
            await expect(page.locator('#email-status')).toHaveText(EMAIL_STATUS_FAILED)
            await expect(page.locator('#mailto')).toBeVisible()
        })
    }

    test('an address the server refuses asks for another and keeps it', async ({ page }) => {
        await landing_open(page, PAGE_WIB_SCANNED)
        await email_answer(page, 400)

        const address = page.getByLabel('Your email')

        await address.fill(EMAIL_ADDRESS)
        await page.getByRole('button', { exact: true, name: 'Email my code' }).click()

        await expect(page.locator('#email-status')).toHaveText(EMAIL_STATUS_INVALID)
        await expect(address).toHaveValue(EMAIL_ADDRESS)
        await expect(page.locator('#mailto')).toBeHidden()
    })

    test('the WIB page without a funnel server keeps the mail app link', async ({ page }) => {
        await landing_open(page, PAGE_WIB_SCANNED, null)

        await expect(page.locator('#email')).toBeHidden()
        await expect(page.locator('#mailto')).toBeVisible()
        await expect(page.locator('#mailto')).toHaveAttribute('href', /wib%2Fdownload%2F/)
    })
})
