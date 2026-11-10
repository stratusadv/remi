import { expect, test } from '@playwright/test'
import { nav_to, setting } from './helpers'


const TITLE_FIRST_RUN = 'a first run opens on the welcome screen and lands in the app '
    + 'once the keys are saved'

test(TITLE_FIRST_RUN, async ({ page }) => {
    await page.goto('/?first-run')

    const welcome = page.getByRole('heading', { name: 'Welcome to scribe' })
    const proceed = page.getByRole('button', { name: 'Continue' })

    await expect(welcome).toBeVisible()
    await expect(page.locator('aside')).toHaveCount(0)
    await expect(proceed).toBeDisabled()

    await page.getByLabel('Transcription key').fill('audio-key')

    await expect(proceed).toBeDisabled()

    await page.getByLabel('Notes key').fill('notes-key')
    await proceed.click()

    await expect(welcome).toHaveCount(0)
    await expect(page.locator('aside')).toBeVisible()

    await nav_to(page, 'Settings')
    await page.getByRole('tab', { name: 'AI' }).click()

    const key = setting(page, 'Notes key').locator('input[type="password"]')

    await expect(key).toHaveValue('•'.repeat('notes-key'.length))
})

test('a configured app never shows the welcome screen', async ({ page }) => {
    await page.goto('/')

    await expect(page.locator('.app-shell[data-ready="true"]')).toBeVisible()
    await expect(page.locator('aside')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Welcome to scribe' })).toHaveCount(0)
})
