import { expect, test } from '@playwright/test'
import {
    RECORDING_TITLED,
    app_open,
    corner_click,
    corner_drag,
    dialog,
    dialog_stays,
    nav_to,
    row_menu_pick,
    selection_text,
    transcript_step_open,
} from './helpers'


const FIELD_TEXT = 'Jordan'
const PLACEHOLDER_FIRST = 'e.g. John'
const TRANSCRIPT_LINE = '.transcript-pane-row-text'


test.beforeEach(async ({ page }) => {
    await app_open(page)
})

test('only a press outside a form closes it', async ({ page }) => {
    await nav_to(page, 'People')
    await page.getByRole('button', { name: 'Add person' }).click()

    const form = dialog(page, 'New person')
    const field = page.getByPlaceholder(PLACEHOLDER_FIRST)

    await field.fill(FIELD_TEXT)
    await corner_drag(page, field)
    await dialog_stays(page, form)
    await expect(field).toHaveValue(FIELD_TEXT)
    await corner_click(page, 'right')
    await dialog_stays(page, form)
    await corner_click(page, 'left')
    await expect(form).toBeHidden()
})

test('a drag out of the rename field leaves the dialog open', async ({ page }) => {
    await row_menu_pick(page, RECORDING_TITLED, 'Rename')

    const rename = dialog(page, 'Rename recording')
    const field = rename.locator('input')

    await field.click()
    await corner_drag(page, field)
    await dialog_stays(page, rename)
    await corner_click(page, 'left')
    await expect(rename).toBeHidden()
})

test('a drag out of a confirmation selects its message and leaves it open', async ({ page }) => {
    await row_menu_pick(page, RECORDING_TITLED, 'Delete')

    const shown = page.locator('.app-dialog')
    const message = page.locator('.app-dialog-message')

    await corner_drag(page, message)
    await dialog_stays(page, shown)

    const selection = await selection_text(page)

    expect(selection).not.toBe('')
    expect(selection).not.toContain('Cancel')

    await corner_click(page, 'left')
    await expect(shown).toBeHidden()
})

test('a press outside the people picker closes only the picker', async ({ page }) => {
    await nav_to(page, 'People')
    await page.getByRole('button', { name: 'Add group' }).click()

    const form = dialog(page, 'New group')

    await form.getByRole('button', { name: '+ Add' }).click()

    const picker = page.locator('.people-picker')
    const search = picker.locator('input').first()

    await corner_drag(page, search)
    await dialog_stays(page, picker)
    await corner_click(page, 'left')
    await expect(picker).toBeHidden()
    await dialog_stays(page, form)
})

test('a drag across a page selects none of it', async ({ page }) => {
    await nav_to(page, 'People')

    const heading = page.getByRole('heading', { name: 'People' })

    await heading.dragTo(page.getByRole('button', { name: 'Add person' }))

    const selection = await selection_text(page)

    expect(selection).toBe('')
})

test('a transcript line can be selected, and a click beside it clears it', async ({ page }) => {
    await transcript_step_open(page)

    const lines = page.locator(TRANSCRIPT_LINE)

    await lines.first().dragTo(lines.nth(1))

    const selection = await selection_text(page)

    expect(selection).not.toBe('')

    await corner_click(page, 'left')

    const cleared = await selection_text(page)

    expect(cleared).toBe('')
})

test('a drag out of the transcript selects none of the controls', async ({ page }) => {
    await transcript_step_open(page)
    await corner_drag(page, page.locator(TRANSCRIPT_LINE).nth(1))

    const selection = await selection_text(page)

    expect(selection).not.toBe('')
    expect(selection).not.toContain('Meeting')
    expect(selection).not.toContain('Notes')
})

test('a press on a clear button keeps the caret in its field', async ({ page }) => {
    await nav_to(page, 'Settings')
    await page.getByRole('tab', { name: 'AI' }).click()

    const field = page.locator('.clearable input').first()

    await field.fill(FIELD_TEXT)
    await page.locator('.clearable-button').first().click()

    const ranges = await page.evaluate(() => window.getSelection()?.rangeCount)

    expect(ranges).toBe(1)

    await page.keyboard.type('next')
    await expect(field).toHaveValue('next')
})
