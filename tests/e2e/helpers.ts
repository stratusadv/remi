import { expect } from '@playwright/test'
import { assert } from '../../src/lib/assert'
import type { Locator, Page } from '@playwright/test'


export const HAS_TEXT = 'hasText'
export const RECORDING_TITLED = 'Weekly platform sync'
export const RECORDING_UNTITLED = 'discovery-call.wav'
export const STREAM_TIMEOUT_MS = 30_000

const CORNER_PIXELS = 4
const DIALOG_LEAVING = '.app-dialog-leave-active'
const SELECTION_SETTLE_MS = 1_000
const TITLE_SELECTION = 'Rewrite the selected text with AI'


type RowLabel = string

export async function app_open(page: Page): Promise<void> {
    assert(!page.isClosed())
    assert(page.url().length > 0)

    await page.goto('/')
    await expect(page.locator('.app-shell[data-ready="true"]')).toBeVisible()
}

export async function corner_click(page: Page, button: 'left' | 'right'): Promise<void> {
    assert(!page.isClosed())
    assert(button.length > 0)

    await page.mouse.click(CORNER_PIXELS, CORNER_PIXELS, { button })
}

export async function corner_drag(page: Page, from: Locator): Promise<void> {
    assert(!page.isClosed())
    assert(from.page() === page)

    await from.hover()
    await page.mouse.down()
    await page.mouse.move(CORNER_PIXELS, CORNER_PIXELS, { steps: 5 })
    await page.mouse.up()
}

export function dialog(page: Page, title: string): Locator {
    assert(!page.isClosed())
    assert(title.length > 0)

    return page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: title }) })
}

export async function dialog_stays(page: Page, shown: Locator): Promise<void> {
    assert(!page.isClosed())
    assert(shown.page() === page)

    await expect(page.locator(DIALOG_LEAVING)).toHaveCount(0)
    await expect(shown).toBeVisible()
}

export function editor(page: Page): Locator {
    assert(!page.isClosed())
    assert(page.url().length > 0)

    return page.locator('.rich-editor-content .ProseMirror')
}

export async function editor_content_set(page: Page, markdown: string): Promise<void> {
    assert(!page.isClosed())
    assert(typeof markdown === 'string')

    await page.getByRole('button', { name: 'Markdown', exact: true }).click()
    await page.locator('.rich-editor-source').fill(markdown)
    await page.getByRole('button', { name: 'Rich editor' }).click()
    await expect(editor(page)).toBeVisible()
}

export async function editor_line_select(page: Page, text: string): Promise<void> {
    assert(!page.isClosed())
    assert(text.length > 0)

    const selected = page.locator('.rich-editor-toolbar').getByTitle(TITLE_SELECTION)

    await expect(async () => {
        await editor(page).getByText(text, { exact: true }).click()
        await page.keyboard.press('End')
        await page.keyboard.press('Shift+Home')
        await expect(selected).toBeVisible({ timeout: SELECTION_SETTLE_MS })
    }).toPass()
}

export async function nav_to(page: Page, label: string): Promise<void> {
    assert(!page.isClosed())
    assert(label.length > 0)

    await page.locator('aside').getByRole('button', { name: label, exact: true }).click()
    await expect(page.getByRole('heading', { name: label })).toBeVisible()
}

export async function recording_open(page: Page, title: string): Promise<void> {
    assert(!page.isClosed())
    assert(title.length > 0)

    await tiles(page).filter({ [HAS_TEXT]: title }).click()
    await expect(step_current(page)).toBeVisible()
}

export async function row_menu_pick(page: Page, row_label: RowLabel, item: string): Promise<void> {
    assert(row_label.length > 0)
    assert(item.length > 0)

    await page.getByRole('button', { name: `Options for ${row_label}` }).click()
    await page.getByRole('menuitem', { name: item }).click()
}

export async function selection_text(page: Page): Promise<string> {
    assert(!page.isClosed())
    assert(page.url().length > 0)

    return page.evaluate(() => window.getSelection()?.toString() ?? '')
}

export function setting(page: Page, heading: string): Locator {
    assert(!page.isClosed())
    assert(heading.length > 0)

    return page
        .locator('section > div > div')
        .filter({ has: page.getByRole('heading', { name: heading }) })
}

export function step_current(page: Page): Locator {
    assert(!page.isClosed())
    assert(page.url().length > 0)

    return page.locator('.step-bar-item[aria-current="step"]')
}

export function tiles(page: Page): Locator {
    assert(!page.isClosed())
    assert(page.url().length > 0)

    return page.locator('.recording-tile:not(.recording-tile-new)')
}

export function transcript_rows(page: Page): Locator {
    assert(!page.isClosed())
    assert(page.url().length > 0)

    return page.locator('.transcript-pane-row')
}

export async function transcript_step_open(page: Page): Promise<void> {
    assert(!page.isClosed())
    assert(RECORDING_UNTITLED.length > 0)

    await recording_open(page, RECORDING_UNTITLED)
    await page.getByRole('button', { name: 'Transcript', exact: true }).click()
    await expect(transcript_rows(page)).toHaveCount(3)
}
