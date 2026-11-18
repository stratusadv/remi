import { expect, test } from '@playwright/test'
import { assert } from '../../src/lib/assert'
import {
    HAS_TEXT,
    RECORDING_TITLED,
    RECORDING_UNTITLED,
    STREAM_TIMEOUT_MS,
    app_open,
    command_count,
    command_watch,
    editor,
    editor_content_set,
    nav_to,
    network_set,
    recording_open,
    step_current,
    transcript_rows,
} from './helpers'
import type { Page } from '@playwright/test'


interface ShellPlacement {
    notes_scrolled: boolean
    overscroll: string
    shell_top: number
    sidebar_top: number
}

const COMPONENT_DELETED = '/src/components/component_deleted.vue?vue&type=style&index=0&lang.css'
const CREDIT = 'Powered by Stratus Advanced Technologies'
const NOTES_PARAGRAPHS = 120
const PARAGRAPH_FIRST = 'Paragraph 1 of a long meeting.'
const PARAGRAPH_LAST = `Paragraph ${String(NOTES_PARAGRAPHS)} of a long meeting.`
const STATUS_NOT_FOUND = 404
const TITLE_COMPONENT = 'a request for a deleted component answers 404 instead of a server error'
const TITLE_CREDIT = 'the footer centers the Stratus credit under the page and opens the website'
const TITLE_SCROLL = 'a long note scrolls inside its pane and the app never moves with the window'
const WHEEL_PAST_END_PX = 20_000


async function shell_placement(page: Page): Promise<ShellPlacement> {
    assert(!page.isClosed())
    assert(page.url().length > 0)

    return page.evaluate(() => {
        const pane = document.querySelector('.rich-editor-body')
        const shell = document.querySelector('.app-shell')
        const sidebar = document.querySelector('aside')

        return {
            notes_scrolled: (pane?.scrollTop ?? 0) > 0,
            overscroll: getComputedStyle(document.documentElement).overscrollBehaviorY,
            shell_top: shell?.getBoundingClientRect().top ?? Number.NaN,
            sidebar_top: sidebar?.getBoundingClientRect().top ?? Number.NaN,
        }
    })
}

async function window_scroll_force(page: Page): Promise<number> {
    assert(!page.isClosed())
    assert(page.url().length > 0)

    const scrolled = await page.evaluate(() => {
        const spacer = document.createElement('div')

        spacer.style.height = `${String(window.innerHeight * 4)}px`
        document.documentElement.append(spacer)
        window.scrollTo(0, window.innerHeight)

        return window.scrollY
    })

    assert(Number.isFinite(scrolled))

    return scrolled
}

test.beforeEach(async ({ page }) => {
    await app_open(page)
})

test(TITLE_CREDIT, async ({ page }) => {
    const footer = page.getByRole('contentinfo')
    const credit = footer.getByRole('link', { name: CREDIT })

    await expect(credit).toHaveAttribute('href', 'https://stratusadv.com')

    const box_footer = await footer.boundingBox()
    const box_credit = await credit.boundingBox()
    const viewport = page.viewportSize()

    assert(box_footer !== null)
    assert(box_credit !== null)
    assert(viewport !== null)

    const offset = box_credit.x + box_credit.width / 2 - (box_footer.x + box_footer.width / 2)

    expect(box_footer.y + box_footer.height).toBeCloseTo(viewport.height, 0)
    expect(Math.abs(offset)).toBeLessThanOrEqual(1)

    const url = page.url()

    await command_watch(page, 'desktop_website_open')
    await credit.click()

    await expect.poll(async () => command_count(page, 'desktop_website_open')).toBe(1)
    await expect(page).toHaveURL(url)
})

test(TITLE_SCROLL, async ({ page }) => {
    const notes = [...Array(NOTES_PARAGRAPHS).keys()]
        .map((index) => `Paragraph ${String(index + 1)} of a long meeting.`)
        .join('\n\n')

    await recording_open(page, RECORDING_TITLED)
    await editor_content_set(page, notes)
    await editor(page).getByText(PARAGRAPH_FIRST, { exact: true }).click()
    await page.keyboard.press('Control+End')

    await expect(editor(page).getByText(PARAGRAPH_LAST, { exact: true })).toBeInViewport()

    await page.mouse.wheel(0, WHEEL_PAST_END_PX)

    const scrolled = await window_scroll_force(page)

    expect(scrolled).toBeGreaterThan(0)

    await expect.poll(async () => shell_placement(page)).toEqual({
        notes_scrolled: true,
        overscroll: 'none',
        shell_top: 0,
        sidebar_top: 0,
    })
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
    await page.getByRole('button', { name: 'remi', exact: true }).click()

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

test('going offline shows a banner that can be dismissed', async ({ page }) => {
    const banner = page.getByRole('status').filter({ [HAS_TEXT]: 'You appear to be offline.' })

    await expect(banner).toHaveCount(0)

    await network_set(page, 'offline')

    await expect(banner).toBeVisible()

    await banner.getByRole('button', { name: 'Dismiss' }).click()

    await expect(banner).toHaveCount(0)

    await network_set(page, 'online')
    await network_set(page, 'offline')

    await expect(banner).toBeVisible()

    await network_set(page, 'online')

    await expect(banner).toHaveCount(0)
})

test('offline disables transcription and note generation', async ({ page }) => {
    await recording_open(page, RECORDING_UNTITLED)
    await network_set(page, 'offline')
    await page.getByRole('button', { name: 'Next' }).click()

    const generate = page.getByRole('button', { name: 'Generate notes' })

    await expect(step_current(page)).toHaveText('Notes')
    await expect(generate).toBeDisabled()
    await expect(page.locator('.notes-stream-pane')).toHaveCount(0)

    await network_set(page, 'online')

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
    await network_set(page, 'offline')
    await page.getByRole('button', { name: 'Next' }).click()

    await expect(step_current(page)).toHaveText('Notes')
    await expect(page.locator('.notes-empty')).toBeVisible()

    await network_set(page, 'online')
    await expect(page.getByRole('button', { name: 'Generate notes' })).toBeEnabled()
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

test(TITLE_COMPONENT, async ({ page }) => {
    const response = await page.request.get(COMPONENT_DELETED)

    expect(response.status()).toBe(STATUS_NOT_FOUND)
})
