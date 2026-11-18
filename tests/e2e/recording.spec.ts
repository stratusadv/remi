import { expect, test } from '@playwright/test'
import { assert } from '../../src/lib/assert'
import { actions_reported, actions_watch, app_open, step_current } from './helpers'
import type { Locator } from '@playwright/test'


const BASELINE = 100
const PATH_POINT = /[ML][\d.]+ (?<y>[\d.]+)/gu
const PEAK_HEARD = 30
const POLL_INTERVAL_MS = 50
const POLL_TIMEOUT_MS = 10_000


async function trace_peak(trace: Locator): Promise<number> {
    assert(!trace.page().isClosed())

    const path = (await trace.getAttribute('d')) ?? ''
    const ordinates = [...path.matchAll(PATH_POINT)].map((match) => Number(match.groups?.['y']))
    const heights = ordinates.map((ordinate) => Math.abs(ordinate - BASELINE))

    assert(path.startsWith('M0'))
    assert(heights.every((height) => height <= BASELINE))

    return Math.max(0, ...heights)
}

test.beforeEach(async ({ page }) => {
    await app_open(page)
})

test('the recording panel draws what the microphone hears and clears on Stop', async ({ page }) => {
    const trace = page.locator('.recording-trace path')

    await page.getByRole('button', { name: 'New recording' }).first().click()
    await expect(step_current(page)).toHaveText('Transcript')
    await page.getByRole('button', { name: 'Record with the microphone' }).click()

    await expect(page.getByText(/Recording \d/u)).toBeVisible()

    await expect
        .poll(async () => trace_peak(trace), {
            intervals: [POLL_INTERVAL_MS],
            timeout: POLL_TIMEOUT_MS,
        })
        .toBeGreaterThan(PEAK_HEARD)

    await page.getByRole('button', { name: 'Stop recording' }).click()

    await expect(trace).toHaveCount(0)
})

test('Record reports one recording, and the file it saves no upload', async ({ page }) => {
    await actions_watch(page)
    await page.getByRole('button', { name: 'New recording' }).first().click()
    await page.getByRole('button', { name: 'Record with the microphone' }).click()

    await expect(page.getByText(/Recording \d/u)).toBeVisible()
    await expect.poll(async () => actions_reported(page)).toEqual(['in-app-recording'])

    await page.getByRole('button', { name: 'Stop recording' }).click()

    await expect(page.getByRole('button', { name: 'Replace' })).toBeVisible()

    const reported = await actions_reported(page)

    expect(reported).toEqual(['in-app-recording'])
})
