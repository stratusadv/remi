import { expect, test } from '@playwright/test'
import { assert } from '../../src/lib/assert'
import { app_open, dialog, nav_to, row_menu_pick } from './helpers'
import type { Locator, Page } from '@playwright/test'


const PLACEHOLDER_FIRST = 'e.g. John'
const PLACEHOLDER_LAST = 'e.g. Doe'
const PLACEHOLDER_ROLE = 'e.g. project manager, accountant, sales rep'
const PLACEHOLDER_GROUP = 'e.g. Managers, Developers, Floor staff'


function group_rows(page: Page): Locator {
    assert(!page.isClosed())
    assert(page.url().length > 0)

    return page.locator('.list-divider').nth(1).locator('> li')
}

function people_rows(page: Page): Locator {
    assert(!page.isClosed())
    assert(page.url().length > 0)

    return page.locator('.list-divider').first().locator('> li')
}

function row_named(rows_locator: Locator, name: string): Locator {
    assert(!rows_locator.page().isClosed())
    assert(name.length > 0)

    return rows_locator.filter({ has: rows_locator.page().getByText(name, { exact: true }) })
}

test.beforeEach(async ({ page }) => {
    await app_open(page)
    await nav_to(page, 'People')
})

test('the list shows people sorted by last name and the seeded group', async ({ page }) => {
    await expect(people_rows(page).locator('.font-medium')).toHaveText([
        'Jane Doe',
        'John Doe',
        'Sam Smith',
    ])

    await expect(row_named(people_rows(page), 'John Doe')).toContainText('Developer')
    await expect(row_named(people_rows(page), 'Sam Smith')).toContainText('No description')
    await expect(group_rows(page)).toHaveCount(1)
    await expect(group_rows(page)).toContainText('Product team')
    await expect(group_rows(page)).toContainText('2 people')
    await expect(group_rows(page)).toContainText('John Doe, Jane Doe')
})

test('Add person saves a new person', async ({ page }) => {
    await page.getByRole('button', { name: 'Add person' }).click()

    const form = dialog(page, 'New person')
    const save = form.getByRole('button', { name: 'Save' })

    await expect(save).toBeDisabled()

    await form.getByPlaceholder(PLACEHOLDER_FIRST).fill('Ada')
    await form.getByPlaceholder(PLACEHOLDER_LAST).fill('Lovelace')
    await form.getByPlaceholder(PLACEHOLDER_ROLE).fill('Engineer')
    await form.getByRole('textbox').last().fill('Writes the first programs.')

    await expect(save).toBeEnabled()

    await save.click()

    await expect(form).toBeHidden()
    await expect(people_rows(page)).toHaveCount(4)

    await expect(people_rows(page).locator('.font-medium')).toHaveText([
        'Jane Doe',
        'John Doe',
        'Ada Lovelace',
        'Sam Smith',
    ])

    await expect(row_named(people_rows(page), 'Ada Lovelace')).toContainText('Engineer')

    await expect(row_named(people_rows(page), 'Ada Lovelace'))
        .toContainText('Writes the first programs.')
})

test('Enter in a name field saves the person', async ({ page }) => {
    await page.getByRole('button', { name: 'Add person' }).click()

    const form = dialog(page, 'New person')

    await form.getByPlaceholder(PLACEHOLDER_FIRST).fill('Grace')
    await form.getByPlaceholder(PLACEHOLDER_FIRST).press('Enter')

    await expect(form).toBeHidden()
    await expect(row_named(people_rows(page), 'Grace')).toContainText('No role')
})

test('clicking a person edits them', async ({ page }) => {
    await row_named(people_rows(page), 'Sam Smith').locator('.list-row-main').click()

    const form = dialog(page, 'Edit person')

    await expect(form.getByPlaceholder(PLACEHOLDER_FIRST)).toHaveValue('Sam')
    await expect(form.getByPlaceholder(PLACEHOLDER_ROLE)).toHaveValue('Client')

    await form.getByPlaceholder(PLACEHOLDER_ROLE).fill('Customer')
    await form.getByRole('button', { name: 'Save' }).click()

    await expect(form).toBeHidden()
    await expect(row_named(people_rows(page), 'Sam Smith')).toContainText('Customer')
})

test('the row menu edits a person and Cancel keeps the old values', async ({ page }) => {
    await row_menu_pick(page, 'Jane Doe', 'Edit')

    const form = dialog(page, 'Edit person')

    await form.getByPlaceholder(PLACEHOLDER_ROLE).fill('Unsaved')
    await form.getByRole('button', { name: 'Cancel' }).click()

    await expect(form).toBeHidden()
    await expect(row_named(people_rows(page), 'Jane Doe')).toContainText('Product owner')
})

test('removing a person asks first and drops them from groups', async ({ page }) => {
    await row_menu_pick(page, 'John Doe', 'Delete')

    const confirm = dialog(page, 'Remove person')

    await expect(confirm).toContainText('Remove John Doe from People?')

    await confirm.getByRole('button', { name: 'Cancel' }).click()

    await expect(people_rows(page)).toHaveCount(3)

    await row_menu_pick(page, 'John Doe', 'Delete')
    await confirm.getByRole('button', { name: 'OK' }).click()

    await expect(people_rows(page)).toHaveCount(2)
    await expect(page.getByText('John Doe', { exact: true })).toHaveCount(0)
    await expect(group_rows(page)).toContainText('1 person')
    await expect(group_rows(page)).toContainText('Jane Doe')
})

test('Add group picks members and saves', async ({ page }) => {
    await page.getByRole('button', { name: 'Add group' }).click()

    const form = dialog(page, 'New group')
    const save = form.getByRole('button', { name: 'Save' })

    await expect(save).toBeDisabled()

    await form.getByPlaceholder(PLACEHOLDER_GROUP).fill('Clients')

    await expect(save).toBeEnabled()

    await form.getByRole('button', { name: '+ Add' }).click()

    const picker = dialog(page, 'Who is in this group?')

    await expect(picker.getByRole('checkbox')).toHaveCount(3)
    await expect(picker.getByText('Product team')).toHaveCount(0)

    await picker.getByRole('checkbox', { name: 'Sam Smith (Client)' }).check()
    await picker.getByRole('button', { name: 'Done' }).click()

    await expect(picker).toBeHidden()
    await expect(form.locator('.tag-chip')).toHaveText(['Sam Smith (Client)'])

    await save.click()

    await expect(form).toBeHidden()
    await expect(group_rows(page)).toHaveCount(2)
    await expect(row_named(group_rows(page), 'Clients')).toContainText('1 person')
    await expect(row_named(group_rows(page), 'Clients')).toContainText('Sam Smith')
})

test('editing a group changes its members', async ({ page }) => {
    await row_named(group_rows(page), 'Product team').locator('.list-row-main').click()

    const form = dialog(page, 'Edit group')

    await expect(form.getByPlaceholder(PLACEHOLDER_GROUP)).toHaveValue('Product team')

    await expect(form.locator('.tag-chip')).toHaveText([
        'John Doe (Developer)',
        'Jane Doe (Product owner)',
    ])

    await form.getByRole('button', { name: 'Remove John Doe' }).click()

    await expect(form.locator('.tag-chip')).toHaveCount(1)

    await form.getByRole('button', { name: '+ Add' }).click()

    const picker = dialog(page, 'Who is in this group?')

    await picker.getByRole('checkbox', { name: 'Sam Smith (Client)' }).check()
    await picker.getByRole('button', { name: 'Done' }).click()
    await form.getByPlaceholder(PLACEHOLDER_GROUP).fill('Core team')
    await form.getByRole('button', { name: 'Save' }).click()

    await expect(form).toBeHidden()
    await expect(row_named(group_rows(page), 'Core team')).toContainText('2 people')
    await expect(row_named(group_rows(page), 'Core team')).toContainText('Jane Doe, Sam Smith')
})

test('the row menu removes a group after confirmation', async ({ page }) => {
    await row_menu_pick(page, 'Product team', 'Delete')

    const confirm = dialog(page, 'Delete group')

    await expect(confirm).toContainText('Delete the "Product team" group?')

    await confirm.getByRole('button', { name: 'Cancel' }).click()

    await expect(group_rows(page)).toHaveCount(1)

    await row_menu_pick(page, 'Product team', 'Delete')
    await confirm.getByRole('button', { name: 'OK' }).click()

    await expect(page.getByText('There are no groups yet.')).toBeVisible()
    await expect(people_rows(page)).toHaveCount(3)
})

test('Escape closes the person and group dialogs', async ({ page }) => {
    await page.getByRole('button', { name: 'Add person' }).click()

    await expect(dialog(page, 'New person')).toBeVisible()

    await page.keyboard.press('Escape')

    await expect(dialog(page, 'New person')).toBeHidden()

    await page.getByRole('button', { name: 'Add group' }).click()

    await expect(dialog(page, 'New group')).toBeVisible()

    await page.keyboard.press('Escape')

    await expect(dialog(page, 'New group')).toBeHidden()
})
