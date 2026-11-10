import { expect, test } from '@playwright/test'
import {
    HAS_TEXT,
    RECORDING_TITLED,
    RECORDING_UNTITLED,
    STREAM_TIMEOUT_MS,
    app_open,
    editor,
    nav_to,
    recording_open,
    step_current,
    transcript_rows,
} from './helpers'


test.beforeEach(async ({ page }) => {
    await app_open(page)
})

test('the sidebar navigates between the screens', async ({ page }) => {
    await nav_to(page, 'Templates')

    await expect(page.locator('aside .sidebar-nav-item-active')).toHaveText('Templates')

    await nav_to(page, 'People')
    await nav_to(page, 'Settings')

    await expect(page.locator('aside .sidebar-nav-item-active')).toHaveText('Settings')

    await nav_to(page, 'Home')

    await expect(page.locator('aside .sidebar-nav-item-active')).toHaveText('Home')
})

test('the brand button resets the pipeline and returns home', async ({ page }) => {
    await recording_open(page, RECORDING_TITLED)
    await page.getByRole('button', { name: 'scribe', exact: true }).click()

    await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible()
})

test('the sidebar collapses and remembers the choice across a reload', async ({ page }) => {
    const sidebar = page.locator('aside')

    await expect(sidebar).toHaveAttribute('data-collapsed', 'false')
    await expect(sidebar.getByText('Templates')).toBeVisible()

    await page.getByRole('button', { name: 'Collapse sidebar' }).click()

    await expect(sidebar).toHaveAttribute('data-collapsed', 'true')
    await expect(sidebar.getByText('Templates')).toHaveCount(0)
    await expect(sidebar.getByRole('button', { name: 'Templates' })).toBeVisible()

    await app_open(page)

    await expect(sidebar).toHaveAttribute('data-collapsed', 'true')

    await sidebar.getByRole('button', { name: 'Settings' }).click()

    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()

    await page.getByRole('button', { name: 'Expand sidebar' }).click()

    await expect(sidebar).toHaveAttribute('data-collapsed', 'false')
    await expect(sidebar.getByText('Templates')).toBeVisible()
})

test('going offline shows a banner that can be dismissed', async ({ context, page }) => {
    const banner = page.getByRole('status').filter({ [HAS_TEXT]: 'You appear to be offline.' })

    await expect(banner).toHaveCount(0)

    await context.setOffline(true)

    await expect(banner).toBeVisible()

    await banner.getByRole('button', { name: 'Dismiss' }).click()

    await expect(banner).toHaveCount(0)

    await context.setOffline(false)
    await context.setOffline(true)

    await expect(banner).toBeVisible()

    await context.setOffline(false)

    await expect(banner).toHaveCount(0)
})

test('offline disables transcription and note generation', async ({ context, page }) => {
    await recording_open(page, RECORDING_UNTITLED)
    await page.getByRole('button', { name: 'Next' }).click()

    const generate = page.getByRole('button', { name: 'Generate notes' })

    await expect(generate).toBeEnabled()

    await context.setOffline(true)

    await expect(generate).toBeDisabled()

    await context.setOffline(false)

    await expect(generate).toBeEnabled()
})

test('Ctrl+O picks a file and Ctrl+Enter transcribes it', async ({ page }) => {
    await page.getByRole('button', { name: 'New recording' }).first().click()
    await page.keyboard.press('Control+o')

    await expect(page.locator('.file-picker-name')).toHaveText('weekly-sync.m4a')

    await page.keyboard.press('Control+Enter')

    await expect(page.locator('.streaming-display')).toBeVisible()
    await expect(transcript_rows(page)).toHaveCount(8, { timeout: STREAM_TIMEOUT_MS })
})

test('Escape leaves the paste step and Ctrl+Enter imports', async ({ page }) => {
    await page.getByRole('button', { name: 'New recording' }).first().click()
    await page.getByRole('button', { name: 'Paste a transcript' }).click()

    const textarea = page.getByRole('textbox', { name: 'Transcript' })

    await expect(textarea).toBeVisible()

    await page.keyboard.press('Escape')

    await expect(textarea).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Open or drop a recording' })).toBeVisible()

    await page.getByRole('button', { name: 'Paste a transcript' }).click()
    await textarea.fill('One line.\nTwo lines.')
    await textarea.press('Control+Enter')

    await expect(step_current(page)).toHaveText('Meeting')
})

test('Ctrl+G generates notes', async ({ page }) => {
    await recording_open(page, RECORDING_UNTITLED)
    await page.getByRole('button', { name: 'Next' }).click()

    await expect(step_current(page)).toHaveText('Notes')

    await page.keyboard.press('Control+g')

    await expect(page.locator('.notes-stream-pane')).toBeVisible()
    await expect(editor(page)).toBeVisible({ timeout: STREAM_TIMEOUT_MS })
    await expect(editor(page).locator('h1')).toHaveText(RECORDING_TITLED)
})

test('Ctrl+S saves the notes before leaving', async ({ page }) => {
    await recording_open(page, RECORDING_TITLED)
    await editor(page).getByText('The team agreed to ship').click()
    await page.keyboard.press('End')
    await page.keyboard.type(' Saved by shortcut.')
    await page.keyboard.press('Control+s')
    await nav_to(page, 'Home')
    await recording_open(page, RECORDING_TITLED)

    await expect(editor(page)).toContainText('Saved by shortcut.')
})

test('Escape closes the row menu', async ({ page }) => {
    await page.getByRole('button', { name: `Options for ${RECORDING_TITLED}` }).click()

    await expect(page.getByRole('menu')).toBeVisible()

    await page.keyboard.press('Escape')

    await expect(page.getByRole('menu')).toHaveCount(0)
})

test('the recent tasks panel lists a finished generation and opens it', async ({ page }) => {
    await recording_open(page, RECORDING_UNTITLED)
    await page.getByRole('button', { name: 'Next' }).click()
    await page.getByRole('button', { name: 'Generate notes' }).click()

    const tasks = page.locator('.sidebar-tasks')

    await expect(tasks).toContainText('Generating notes')
    await expect(tasks).toContainText('Notes ready', { timeout: STREAM_TIMEOUT_MS })

    await nav_to(page, 'Home')
    await tasks.locator('.sidebar-task-main').click()

    await expect(step_current(page)).toHaveText('Notes')
    await expect(editor(page)).toBeVisible()

    await tasks.getByRole('button', { name: 'Clear' }).click()

    await expect(tasks).toHaveCount(0)
})
