import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { assert } from '../../src/lib/assert'
import type { Page, Request } from '@playwright/test'


const AGENT_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Version/18.0 Safari/605.1.15'

const BEACON_CONTENT_TYPE = 'application/x-www-form-urlencoded;charset=UTF-8'
const FUNNEL_ORIGIN = 'https://funnel.example.test'
const FUNNEL_ORIGIN_DECLARATION = /^const funnel_origin = '[^']*';$/m
const FUNNEL_PATH = new URL('../../docs/assets/funnel.js', import.meta.url)
const FUNNEL_SOURCE = readFileSync(FUNNEL_PATH, 'utf8')
const PAGE_GENERAL = '/docs/index.html'
const PAGE_WIB_SCANNED = '/docs/wib/index.html?utm_source=qr'
const RELEASE_DOWNLOAD = 'https://github.com/stratusadv/remi/releases/download/v1.4.0/'

const RELEASE = Object.freeze({
    assets: [
        release_asset('Remi.Remembers-1.4.0-1.x86_64.rpm'),
        release_asset('Remi.Remembers_1.4.0_amd64.AppImage'),
        release_asset('Remi.Remembers_1.4.0_amd64.deb'),
        release_asset('Remi.Remembers_1.4.0_universal.dmg'),
        release_asset('Remi.Remembers_1.4.0_x64-setup.exe'),
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
    assert(agent.includes('Macintosh'))
    assert(!agent.includes('\''))
    assert(!agent.includes('\\'))

    return `Object.defineProperty(navigator, 'userAgent', { get: () => '${agent}' })`
}

function beacon_expected(kind: 'download' | 'visit', body: string): Beacon {
    assert(kind.length > 0)
    assert(body.startsWith('campaign='))

    return { body, path: `/api/v1/funnel/${kind}/`, type: BEACON_CONTENT_TYPE }
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

async function landing_open(page: Page, path: string): Promise<Beacon[]> {
    assert(!page.isClosed())
    assert(path.startsWith('/docs/'))

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

    await page.route('**/docs/assets/funnel.js', async (route) => {
        const body = funnel_script(FUNNEL_ORIGIN)

        await route.fulfill({ body, headers: { 'content-type': 'text/javascript' } })
    })

    await page.goto(path)

    return beacons
}

function release_asset(name: string): object {
    assert(name.startsWith('Remi.Remembers'))
    assert(!name.includes('/'))

    return { browser_download_url: `${RELEASE_DOWNLOAD}${name}`, name, size: 9_000_000 }
}

test('a scan of the WIB code and the downloads after it reach the funnel', async ({ page }) => {
    const beacons = await landing_open(page, PAGE_WIB_SCANNED)
    const visit = beacon_expected('visit', 'campaign=wib&source=qr')
    const windows = beacon_expected('download', 'campaign=wib&platform=windows')
    const linux = beacon_expected('download', 'campaign=wib&platform=linux')

    await expect.poll(() => beacons).toEqual([visit])

    await page.locator('a[href$="-setup.exe"]').first().click()

    await expect.poll(() => beacons).toEqual([visit, windows])

    await page.locator('a[href$=".AppImage"]').first().click()

    await expect.poll(() => beacons).toEqual([visit, windows, linux])
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
        const image = `${RELEASE_DOWNLOAD}Remi.Remembers_1.4.0_universal.dmg`

        await expect(button).toHaveText('Download for macOS')
        await expect(button).toHaveAttribute('href', image)

        await button.click()

        await expect.poll(() => beacons).toEqual([visit, macos])
    })

    test('the WIB page recommends the disk image', async ({ page }) => {
        await landing_open(page, PAGE_WIB_SCANNED)

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
