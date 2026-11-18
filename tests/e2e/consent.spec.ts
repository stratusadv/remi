import { expect, test } from '@playwright/test'
import { assert } from '../../src/lib/assert'
import type { Locator, Page } from '@playwright/test'


const ACCEPT = 'Accept'
const BANNER = 'Cookie choice'
const CHOICE_KEY = 'remi.consent'
const DECLINE = 'Decline'
const PAGE_GENERAL = '/docs/index.html'
const PAGE_WIB = '/docs/wib/index.html'
const PRIVACY = 'Privacy policy'
const SETTINGS = 'Cookie settings'
const TAG_MANAGER = /^https:\/\/www\.googletagmanager\.com\/gtm\.js\?id=GTM-W33NVHZH$/u
const TITLE_ACCEPTED = 'an accepted choice loads the Google tag on later pages without asking again'
const TITLE_DECLINED = 'a declined visitor gets no Google tag until accepting in cookie settings'
const TITLE_WITHDRAWN = 'declining after accepting deletes the analytics cookies and stops the tag'

const PAGES = Object.freeze([
    PAGE_GENERAL,
    '/docs/download/index.html',
    PAGE_WIB,
    '/docs/wib/download/index.html',
])


function banner(page: Page): Locator {
    assert(!page.isClosed())
    assert(BANNER.length > 0)

    return page.getByRole('region', { name: BANNER })
}

async function choice_stored(page: Page): Promise<string | null> {
    assert(!page.isClosed())
    assert(CHOICE_KEY.startsWith('remi.'))

    return page.evaluate((key) => localStorage.getItem(key), CHOICE_KEY)
}

async function site_open(page: Page, path: string): Promise<string[]> {
    assert(!page.isClosed())
    assert(path.startsWith('/docs/'))

    const requests: string[] = []

    await page.route(/^https:\/\//u, async (route) => route.fulfill({ status: 204 }))

    await page.route('https://fonts.googleapis.com/**', async (route) => {
        await route.fulfill({ body: '', headers: { 'content-type': 'text/css' } })
    })

    await page.route(TAG_MANAGER, async (route) => {
        requests.push(route.request().url())
        await route.fulfill({ body: '', headers: { 'content-type': 'text/javascript' } })
    })

    await page.goto(path)

    return requests
}

for (const path of PAGES) {
    test(`${path} loads the Google tag only after the visitor accepts`, async ({ page }) => {
        const requests = await site_open(page, path)
        const privacy = new URL('/docs/privacy/', page.url()).href
        const link = banner(page).getByRole('link', { name: PRIVACY })

        await expect(banner(page)).toBeVisible()
        await expect(link).toHaveAttribute('href', privacy)
        expect(requests).toEqual([])

        await banner(page).getByRole('button', { name: ACCEPT }).click()

        await expect.poll(() => requests.length).toBe(1)
        await expect(banner(page)).toHaveCount(0)
        expect(await choice_stored(page)).toBe('granted')
    })
}

test(TITLE_ACCEPTED, async ({ page }) => {
    const requests = await site_open(page, PAGE_GENERAL)

    await banner(page).getByRole('button', { name: ACCEPT }).click()
    await expect.poll(() => requests.length).toBe(1)
    await page.goto(PAGE_WIB)

    await expect.poll(() => requests.length).toBe(2)
    await expect(banner(page)).toHaveCount(0)
})

test(TITLE_DECLINED, async ({ page }) => {
    const requests = await site_open(page, PAGE_GENERAL)

    await banner(page).getByRole('button', { name: DECLINE }).click()
    await expect(banner(page)).toHaveCount(0)
    await page.reload()

    await expect(banner(page)).toHaveCount(0)
    expect(requests).toEqual([])
    expect(await choice_stored(page)).toBe('denied')

    await page.getByRole('link', { name: SETTINGS }).click()

    await expect(banner(page).getByRole('button', { name: DECLINE })).toBeFocused()
    expect(new URL(page.url()).hash).toBe('')

    await banner(page).getByRole('button', { name: ACCEPT }).click()

    await expect.poll(() => requests.length).toBe(1)
    expect(await choice_stored(page)).toBe('granted')
})

test(TITLE_WITHDRAWN, async ({ page }) => {
    const requests = await site_open(page, PAGE_GENERAL)
    const origin = new URL('/', page.url()).href

    await page.context().addCookies([
        { name: '_ga', url: origin, value: 'GA1.1.1234567890.1763500000' },
        { name: '_ga_GYQQ1H2S7Z', url: origin, value: 'GS2.1.s1763500000$o1$g0$t1763500000' },
        { name: 'theme', url: origin, value: 'dark' },
    ])

    await banner(page).getByRole('button', { name: ACCEPT }).click()
    await expect.poll(() => requests.length).toBe(1)
    await page.getByRole('link', { name: SETTINGS }).click()

    const reloaded = page.waitForEvent('load')

    await banner(page).getByRole('button', { name: DECLINE }).click()
    await reloaded

    const cookies = await page.context().cookies(origin)

    expect(cookies.map((cookie) => cookie.name)).toEqual(['theme'])
    expect(requests).toHaveLength(1)
    await expect(banner(page)).toHaveCount(0)
    expect(await choice_stored(page)).toBe('denied')
})
