import { expect, test } from '@playwright/test'
import { assert } from '../../src/lib/assert'
import { HAS_TEXT, app_open, network_set } from './helpers'
import type { Locator } from '@playwright/test'


const CLOSE_INSET_PIXELS_MAX = 20
const LINE_OFFSET_PIXELS_MAX = 1
const VIEWPORT_NARROW = Object.freeze({ height: 800, width: 720 })


interface BannerGeometry {
    readonly actions_top: number | null
    readonly banner_right: number
    readonly close_bottom: number
    readonly close_center: number
    readonly close_right: number
    readonly line_count: number
    readonly line_first_center: number
}

test.use({ viewport: VIEWPORT_NARROW })

test.beforeEach(async ({ page }) => {
    await app_open(page)
})

async function close_cornered_check(banner: Locator): Promise<void> {
    assert(!banner.page().isClosed())

    const geometry = await banner.evaluate((element): BannerGeometry => {
        const actions = element.querySelector('.banner-actions')
        const close = element.querySelector('[aria-label="Dismiss"]')
        const message = element.querySelector('p')

        if (close === null) throw new Error('the banner has no close button')
        if (message === null) throw new Error('the banner has no message')

        const range = document.createRange()

        range.selectNodeContents(message)

        const lines = [...range.getClientRects()].filter((rect) => rect.width > 1)
        const line_first = lines[0]

        if (line_first === undefined) throw new Error('the banner message has no text')

        const banner_box = element.getBoundingClientRect()
        const close_box = close.getBoundingClientRect()

        return {
            actions_top: actions === null ? null : actions.getBoundingClientRect().top,
            banner_right: banner_box.right,
            close_bottom: close_box.bottom,
            close_center: close_box.top + close_box.height / 2,
            close_right: close_box.right,
            line_count: new Set(lines.map((rect) => Math.round(rect.top))).size,
            line_first_center: line_first.top + line_first.height / 2,
        }
    })

    assert(geometry.line_count > 0)

    expect(geometry.line_count).toBeGreaterThanOrEqual(2)
    expect(geometry.banner_right - geometry.close_right).toBeLessThanOrEqual(CLOSE_INSET_PIXELS_MAX)

    expect(Math.abs(geometry.close_center - geometry.line_first_center))
        .toBeLessThanOrEqual(LINE_OFFSET_PIXELS_MAX)

    if (geometry.actions_top !== null) {
        expect(geometry.close_bottom).toBeLessThanOrEqual(geometry.actions_top)
    }
}

test('a wrapped banner with actions holds its close button on the first line', async ({ page }) => {
    await page.goto('/?transcript-cached')
    await expect(page.locator('.app-shell[data-ready="true"]')).toBeVisible()
    await page.getByRole('button', { name: 'New recording' }).first().click()
    await page.getByRole('button', { name: 'Open or drop a recording' }).click()
    await page.getByRole('button', { name: 'Transcribe', exact: true }).click()

    const banner = page.getByRole('status').filter({
        [HAS_TEXT]: 'This recording was already transcribed',
    })

    await expect(banner.getByRole('button', { name: 'Transcribe again' })).toBeVisible()

    await close_cornered_check(banner)
})

test('a wrapped shell banner holds its close button on the first line', async ({ page }) => {
    await page.setViewportSize({ height: VIEWPORT_NARROW.height, width: 480 })
    await network_set(page, 'offline')

    const banner = page.getByRole('status').filter({ [HAS_TEXT]: 'You appear to be offline.' })

    await expect(banner).toBeVisible()

    await close_cornered_check(banner)
})
