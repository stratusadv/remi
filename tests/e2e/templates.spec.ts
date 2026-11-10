import { expect, test } from '@playwright/test'
import { assert } from '../../src/lib/assert'
import { HAS_TEXT, app_open, dialog, editor, nav_to, row_menu_pick } from './helpers'
import type { Locator, Page } from '@playwright/test'


const PLACEHOLDER_NAME = 'e.g. Meeting notes'
const PLACEHOLDER_DESCRIPTION = 'One line on what this template is for'
const DESCRIPTION_MEETING_NOTES = 'A summary, the decisions, and who does what next.'

const PLACEHOLDER_AI = 'Describe the document, e.g. weekly team meeting: decisions, who does '
    + 'what by when, problems to watch'


function row(page: Page, name: string): Locator {
    assert(!page.isClosed())
    assert(name.length > 0)

    return rows(page).filter({ has: page.getByText(name, { exact: true }) })
}

function rows(page: Page): Locator {
    assert(!page.isClosed())
    assert(page.url().length > 0)

    return page.locator('.list-divider > li')
}

test.beforeEach(async ({ page }) => {
    await app_open(page)
    await nav_to(page, 'Templates')
})

test('the list shows the seeded templates with the default marked', async ({ page }) => {
    await expect(rows(page)).toHaveCount(2)
    await expect(row(page, 'Meeting notes')).toContainText(DESCRIPTION_MEETING_NOTES)
    await expect(row(page, 'Meeting notes').locator('.pill-active')).toHaveText('Default')
    await expect(row(page, 'Stand-up digest').locator('.pill-active')).toHaveCount(0)
})

test('Add template saves a name, description, and layout', async ({ page }) => {
    await page.getByRole('button', { name: 'Add template' }).click()

    const save = page.getByRole('button', { name: 'Save' })

    await expect(save).toBeDisabled()

    await page.getByPlaceholder(PLACEHOLDER_NAME).fill('Retro')
    await page.getByPlaceholder(PLACEHOLDER_DESCRIPTION).fill('What went well and what did not.')

    await expect(save).toBeDisabled()

    await editor(page).click()
    await page.keyboard.type('Went well')

    await expect(save).toBeEnabled()

    await save.click()

    await expect(rows(page)).toHaveCount(3)
    await expect(row(page, 'Retro')).toContainText('What went well and what did not.')

    await row(page, 'Retro').locator('.list-row-main').click()

    await expect(editor(page)).toContainText('Went well')
})

test('Cancel abandons a new template', async ({ page }) => {
    await page.getByRole('button', { name: 'Add template' }).click()
    await page.getByPlaceholder(PLACEHOLDER_NAME).fill('Dropped')
    await page.getByRole('button', { name: 'Cancel' }).click()

    await expect(rows(page)).toHaveCount(2)
    await expect(page.getByText('Dropped')).toHaveCount(0)
})

test('clicking a row edits the template', async ({ page }) => {
    await row(page, 'Stand-up digest').locator('.list-row-main').click()

    await expect(page.getByPlaceholder(PLACEHOLDER_NAME)).toHaveValue('Stand-up digest')
    await expect(editor(page).locator('h2')).toHaveText(['Done', 'Next', 'Blocked'])

    await page.getByPlaceholder(PLACEHOLDER_NAME).fill('Daily digest')
    await page.getByRole('button', { name: 'Save' }).click()

    await expect(row(page, 'Daily digest')).toBeVisible()
    await expect(page.getByText('Stand-up digest')).toHaveCount(0)
})

test('the row menu edits the template', async ({ page }) => {
    await row_menu_pick(page, 'Meeting notes', 'Edit')

    await expect(page.getByPlaceholder(PLACEHOLDER_NAME)).toHaveValue('Meeting notes')

    await expect(page.getByPlaceholder(PLACEHOLDER_DESCRIPTION))
        .toHaveValue(DESCRIPTION_MEETING_NOTES)
})

test('the row menu deletes a template after confirmation', async ({ page }) => {
    await row_menu_pick(page, 'Stand-up digest', 'Delete')

    const confirm = dialog(page, 'Delete template')

    await expect(confirm).toContainText('Delete the "Stand-up digest" template?')

    await confirm.getByRole('button', { name: 'Cancel' }).click()

    await expect(rows(page)).toHaveCount(2)

    await row_menu_pick(page, 'Stand-up digest', 'Delete')
    await confirm.getByRole('button', { name: 'OK' }).click()

    await expect(rows(page)).toHaveCount(1)
    await expect(row(page, 'Meeting notes')).toBeVisible()
})

test('deleting the default template clears the default', async ({ page }) => {
    await row_menu_pick(page, 'Meeting notes', 'Delete')
    await dialog(page, 'Delete template').getByRole('button', { name: 'OK' }).click()

    await expect(rows(page)).toHaveCount(1)
    await expect(page.locator('.pill-active')).toHaveCount(0)

    await nav_to(page, 'Settings')

    await expect(page.getByRole('combobox').filter({ [HAS_TEXT]: 'Ask each time' })).toHaveValue('')
})

test('Make default moves the Default pill', async ({ page }) => {
    await page.getByRole('button', { name: 'Options for Meeting notes' }).click()

    await expect(page.getByRole('menuitem', { name: 'Make default' })).toHaveCount(0)

    await page.keyboard.press('Escape')
    await row_menu_pick(page, 'Stand-up digest', 'Make default')

    await expect(row(page, 'Stand-up digest').locator('.pill-active')).toHaveText('Default')
    await expect(row(page, 'Meeting notes').locator('.pill-active')).toHaveCount(0)
})

test('the AI writes a layout into the editor', async ({ page }) => {
    await page.getByRole('button', { name: 'Add template' }).click()
    await page.getByTitle('Write the layout with AI').click()

    const panel = page.locator('.rich-editor-ai')
    const generate = panel.getByRole('button', { name: 'Generate' })

    await expect(panel).toContainText('AI layout')
    await expect(generate).toBeDisabled()

    await page.getByPlaceholder(PLACEHOLDER_AI).fill('weekly sync')

    await expect(generate).toBeEnabled()

    await generate.click()

    await expect(panel).toBeHidden()
    await expect(editor(page).locator('h2')).toHaveText(['Summary', 'Decisions', 'Actions'])
    await expect(editor(page)).toContainText('sentences on what "weekly sync" covered.')
    await expect(editor(page).locator('table')).toHaveCount(1)
})

test('the AI asks before replacing an existing layout', async ({ page }) => {
    await row(page, 'Meeting notes').locator('.list-row-main').click()
    await page.getByTitle('Write the layout with AI').click()
    await page.getByPlaceholder(PLACEHOLDER_AI).fill('retro')
    await page.locator('.rich-editor-ai').getByRole('button', { name: 'Generate' }).click()

    const confirm = dialog(page, 'Replace layout')

    await confirm.getByRole('button', { name: 'Cancel' }).click()

    await expect(confirm).toBeHidden()
    await expect(editor(page).locator('h2')).toHaveText(['Summary', 'Decisions', 'To do'])

    await page.locator('.rich-editor-ai').getByRole('button', { name: 'Generate' }).click()
    await confirm.getByRole('button', { name: 'OK' }).click()

    await expect(editor(page).locator('h2')).toHaveText(['Summary', 'Decisions', 'Actions'])
})

test('Escape closes the editor form', async ({ page }) => {
    await page.getByRole('button', { name: 'Add template' }).click()

    await expect(page.getByPlaceholder(PLACEHOLDER_NAME)).toBeVisible()

    await page.keyboard.press('Escape')

    await expect(page.getByPlaceholder(PLACEHOLDER_NAME)).toBeHidden()
    await expect(rows(page)).toHaveCount(2)
})
