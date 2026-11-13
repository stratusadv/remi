import { expect, test } from '@playwright/test'
import { assert } from '../../src/lib/assert'
import {
    HAS_TEXT,
    RECORDING_TITLED,
    RECORDING_UNTITLED,
    app_open,
    dialog,
    nav_to,
    recording_open,
    row_menu_pick,
    step_current,
    tiles,
} from './helpers'
import type { Locator, Page } from '@playwright/test'


const COLUMNS = Object.freeze(['Title', 'Participants', 'Date', 'Duration', 'Status'])


function column_header(page: Page, label: string): Locator {
    assert(!page.isClosed())
    assert(label.length > 0)

    return page.locator('th').filter({ has: page.getByRole('button', { name: label }) })
}

async function list_view_open(page: Page): Promise<void> {
    assert(!page.isClosed())

    await page.getByRole('button', { name: 'List' }).click()
    await expect(page.locator('.recording-table')).toBeVisible()
}

function row_titles(page: Page): Locator {
    assert(!page.isClosed())
    assert(page.url().length > 0)

    return page.locator('.recording-table-title')
}

test.beforeEach(async ({ page }) => {
    await app_open(page)
})

test('the home screen lists the mock recordings', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible()
    await expect(tiles(page)).toHaveCount(2)
})

test('the layout switch toggles grid and list and survives navigation', async ({ page }) => {
    const grid_button = page.getByRole('button', { name: 'Grid' })
    const list_button = page.getByRole('button', { name: 'List' })

    await expect(grid_button).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.recording-grid')).toBeVisible()

    await list_view_open(page)

    await expect(list_button).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.recording-table-row')).toHaveCount(2)

    await nav_to(page, 'Settings')
    await nav_to(page, 'Home')

    await expect(page.locator('.recording-table')).toBeVisible()
    await expect(list_button).toHaveAttribute('aria-pressed', 'true')

    await grid_button.click()

    await expect(page.locator('.recording-grid')).toBeVisible()
    await expect(grid_button).toHaveAttribute('aria-pressed', 'true')
})

test('the list columns are unsorted by default', async ({ page }) => {
    await list_view_open(page)

    await Promise.all(COLUMNS.map(async (label) => {
        await expect(column_header(page, label)).toHaveAttribute('aria-sort', 'none')
    }))

    await expect(page.locator('.recording-table-sort-mark')).toHaveText(['', '', '', '', ''])
})

test('Title sorts ascending first and flips on a second click', async ({ page }) => {
    await list_view_open(page)

    const header = column_header(page, 'Title')

    await header.getByRole('button').click()

    await expect(header).toHaveAttribute('aria-sort', 'ascending')
    await expect(header.locator('.recording-table-sort-mark')).toHaveText('↑')
    await expect(row_titles(page)).toHaveText([RECORDING_UNTITLED, RECORDING_TITLED])

    await header.getByRole('button').click()

    await expect(header).toHaveAttribute('aria-sort', 'descending')
    await expect(header.locator('.recording-table-sort-mark')).toHaveText('↓')
    await expect(row_titles(page)).toHaveText([RECORDING_TITLED, RECORDING_UNTITLED])
})

test('Participants sorts ascending first and flips on a second click', async ({ page }) => {
    await list_view_open(page)

    const header = column_header(page, 'Participants')

    await header.getByRole('button').click()

    await expect(header).toHaveAttribute('aria-sort', 'ascending')
    await expect(row_titles(page)).toHaveText([RECORDING_UNTITLED, RECORDING_TITLED])

    await header.getByRole('button').click()

    await expect(header).toHaveAttribute('aria-sort', 'descending')
    await expect(row_titles(page)).toHaveText([RECORDING_TITLED, RECORDING_UNTITLED])
})

test('Date sorts descending first and flips on a second click', async ({ page }) => {
    await list_view_open(page)

    const header = column_header(page, 'Date')

    await header.getByRole('button').click()

    await expect(header).toHaveAttribute('aria-sort', 'descending')
    await expect(header.locator('.recording-table-sort-mark')).toHaveText('↓')
    await expect(row_titles(page)).toHaveText([RECORDING_TITLED, RECORDING_UNTITLED])

    await header.getByRole('button').click()

    await expect(header).toHaveAttribute('aria-sort', 'ascending')
    await expect(header.locator('.recording-table-sort-mark')).toHaveText('↑')
    await expect(row_titles(page)).toHaveText([RECORDING_UNTITLED, RECORDING_TITLED])
})

test('Duration sorts descending first and ties fall back to newest', async ({ page }) => {
    await list_view_open(page)

    const header = column_header(page, 'Duration')

    await header.getByRole('button').click()

    await expect(header).toHaveAttribute('aria-sort', 'descending')
    await expect(row_titles(page)).toHaveText([RECORDING_TITLED, RECORDING_UNTITLED])

    await header.getByRole('button').click()

    await expect(header).toHaveAttribute('aria-sort', 'ascending')
    await expect(row_titles(page)).toHaveText([RECORDING_TITLED, RECORDING_UNTITLED])
})

test('Status sorts ascending first and flips on a second click', async ({ page }) => {
    await list_view_open(page)

    const header = column_header(page, 'Status')

    await header.getByRole('button').click()

    await expect(header).toHaveAttribute('aria-sort', 'ascending')
    await expect(row_titles(page)).toHaveText([RECORDING_TITLED, RECORDING_UNTITLED])

    await header.getByRole('button').click()

    await expect(header).toHaveAttribute('aria-sort', 'descending')
    await expect(row_titles(page)).toHaveText([RECORDING_UNTITLED, RECORDING_TITLED])
})

test('sorting a new column resets the direction of the old one', async ({ page }) => {
    await list_view_open(page)

    await column_header(page, 'Title').getByRole('button').click()
    await column_header(page, 'Date').getByRole('button').click()

    await expect(column_header(page, 'Title')).toHaveAttribute('aria-sort', 'none')
    await expect(column_header(page, 'Date')).toHaveAttribute('aria-sort', 'descending')
})

test('the default order puts favourites first and then the newest', async ({ page }) => {
    await expect(tiles(page).locator('.recording-tile-title')).toHaveText([
        RECORDING_TITLED,
        RECORDING_UNTITLED,
    ])

    await page.getByRole('button', { name: `Remove ${RECORDING_TITLED} from favourites` }).click()
    await page.getByRole('button', { name: `Add ${RECORDING_UNTITLED} to favourites` }).click()

    await expect(tiles(page).locator('.recording-tile-title')).toHaveText([
        RECORDING_UNTITLED,
        RECORDING_TITLED,
    ])

    await page.getByRole('button', { name: `Remove ${RECORDING_UNTITLED} from favourites` }).click()

    await expect(tiles(page).locator('.recording-tile-title')).toHaveText([
        RECORDING_TITLED,
        RECORDING_UNTITLED,
    ])
})

test('the star toggles a favourite', async ({ page }) => {
    const star = page.getByRole('button', { name: `Add ${RECORDING_UNTITLED} to favourites` })

    await expect(star).toHaveAttribute('aria-pressed', 'false')

    await star.click()

    const starred = page.getByRole('button', {
        name: `Remove ${RECORDING_UNTITLED} from favourites`,
    })

    await expect(starred).toHaveAttribute('aria-pressed', 'true')

    await starred.click()

    await expect(star).toHaveAttribute('aria-pressed', 'false')
})

test('a transcript search hit opens the recording at that moment', async ({ page }) => {
    const search = page.getByRole('searchbox', {
        name: 'Search recordings, notes, and transcripts',
    })

    await search.fill('nobody writes')

    await expect(tiles(page)).toHaveCount(1)
    await expect(tiles(page).locator('.recording-tile-people')).toContainText('0:18 ·')

    await tiles(page).click()

    const focused = page.locator('.transcript-pane-row[data-highlighted="true"]')

    await expect(step_current(page)).toHaveText('Transcript')
    await expect(focused).toHaveCount(1)
    await expect(focused).toContainText('nobody writes it up')
})

test('search matches titles, notes, and transcripts with a snippet', async ({ page }) => {
    const search = page.getByRole('searchbox', {
        name: 'Search recordings, notes, and transcripts',
    })

    await search.fill('retry')

    await expect(tiles(page)).toHaveCount(1)
    await expect(tiles(page)).toContainText(RECORDING_TITLED)
    await expect(tiles(page).locator('.recording-tile-people')).toContainText('In notes:')
    await expect(tiles(page).locator('.recording-tile-people')).toContainText('retry')

    await search.fill('nobody writes')

    await expect(tiles(page)).toHaveCount(1)
    await expect(tiles(page)).toContainText(RECORDING_UNTITLED)
    await expect(tiles(page).locator('.recording-tile-people')).toContainText('In transcript:')
    await expect(tiles(page).locator('.recording-tile-people')).toContainText('nobody writes')

    await search.fill('discovery')

    await expect(tiles(page)).toHaveCount(1)
    await expect(tiles(page)).toContainText(RECORDING_UNTITLED)

    await search.fill('zzzz')

    await expect(page.getByRole('heading', { name: 'No matches' })).toBeVisible()
    await expect(page.getByText('Nothing matches “zzzz”.')).toBeVisible()

    await search.fill('')

    await expect(tiles(page)).toHaveCount(2)
})

test('the row menu renames a recording', async ({ page }) => {
    await row_menu_pick(page, RECORDING_UNTITLED, 'Rename')

    const rename = dialog(page, 'Rename recording')
    const input = rename.getByRole('searchbox')

    await expect(input).toHaveValue(RECORDING_UNTITLED)

    await input.fill('')
    await rename.getByRole('button', { name: 'Save' }).click()

    await expect(rename.getByText('Title cannot be empty.')).toBeVisible()

    await input.fill('Kickoff call')
    await input.press('Enter')

    await expect(rename).toBeHidden()
    await expect(tiles(page).locator('.recording-tile-title')).toContainText(['Kickoff call'])
})

test('the rename dialog closes without saving on Cancel', async ({ page }) => {
    await row_menu_pick(page, RECORDING_UNTITLED, 'Rename')

    const rename = dialog(page, 'Rename recording')

    await rename.getByRole('searchbox').fill('Dropped')
    await rename.getByRole('button', { name: 'Cancel' }).click()

    await expect(rename).toBeHidden()
    await expect(tiles(page)).toContainText([RECORDING_TITLED, RECORDING_UNTITLED])
})

test('the row menu deletes a recording after confirmation', async ({ page }) => {
    await row_menu_pick(page, RECORDING_UNTITLED, 'Delete')

    const confirm = dialog(page, 'Delete recording')

    await expect(confirm).toContainText(`Delete "${RECORDING_UNTITLED}"?`)

    await confirm.getByRole('button', { name: 'Cancel' }).click()

    await expect(confirm).toBeHidden()
    await expect(tiles(page)).toHaveCount(2)

    await row_menu_pick(page, RECORDING_UNTITLED, 'Delete')
    await page.keyboard.press('Escape')

    await expect(confirm).toBeHidden()
    await expect(tiles(page)).toHaveCount(2)

    await row_menu_pick(page, RECORDING_UNTITLED, 'Delete')
    await confirm.getByRole('button', { name: 'OK' }).click()

    await expect(confirm).toBeHidden()
    await expect(tiles(page)).toHaveCount(1)
    await expect(tiles(page)).toContainText(RECORDING_TITLED)
})

test('Enter confirms the delete dialog', async ({ page }) => {
    await row_menu_pick(page, RECORDING_TITLED, 'Delete')
    await expect(dialog(page, 'Delete recording')).toBeVisible()
    await page.keyboard.press('Enter')

    await expect(tiles(page)).toHaveCount(1)
    await expect(tiles(page)).toContainText(RECORDING_UNTITLED)
})

test('the row menu also works in the list view', async ({ page }) => {
    await list_view_open(page)
    await row_menu_pick(page, RECORDING_TITLED, 'Delete')
    await dialog(page, 'Delete recording').getByRole('button', { name: 'OK' }).click()

    await expect(page.locator('.recording-table-row')).toHaveCount(1)
    await expect(row_titles(page)).toHaveText([RECORDING_UNTITLED])
})

test('New recording opens an empty Transcript step', async ({ page }) => {
    await page.getByRole('button', { name: 'New recording' }).first().click()

    await expect(step_current(page)).toHaveText('Transcript')
    await expect(page.getByRole('button', { name: 'Open or drop a recording' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Record with the microphone' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Transcribe' })).toBeDisabled()
})

test('a recording with notes opens on the Notes step', async ({ page }) => {
    await recording_open(page, RECORDING_TITLED)

    await expect(step_current(page)).toHaveText('Notes')
    await expect(page.locator('.rich-editor-content')).toContainText(RECORDING_TITLED)
})

test('a recording with only a transcript opens on the Meeting step', async ({ page }) => {
    await recording_open(page, RECORDING_UNTITLED)

    await expect(step_current(page)).toHaveText('Meeting')
})

test('a recording opens from the list view too', async ({ page }) => {
    await list_view_open(page)
    await page.locator('.recording-table-row').filter({ [HAS_TEXT]: RECORDING_TITLED }).click()

    await expect(step_current(page)).toHaveText('Notes')
})

test('the tiles show duration and status', async ({ page }) => {
    const titled = tiles(page).filter({ [HAS_TEXT]: RECORDING_TITLED })
    const untitled = tiles(page).filter({ [HAS_TEXT]: RECORDING_UNTITLED })

    await expect(titled.locator('.recording-tile-status')).toHaveText('Notes ready')
    await expect(titled.locator('.recording-tile-duration')).toHaveText('2:24')
    await expect(titled.locator('.recording-tile-people')).toHaveText('Jane Doe, John Doe')
    await expect(untitled.locator('.recording-tile-status')).toHaveText('Transcribed')
    await expect(untitled.locator('.recording-tile-people')).toHaveText('No participants')
})

test('the speech bubble on a card asks about that meeting', async ({ page }) => {
    const titled = tiles(page).filter({ [HAS_TEXT]: RECORDING_TITLED })
    const main = page.locator('main')

    await titled.hover()
    await titled.getByRole('button', { name: `Ask about ${RECORDING_TITLED}` }).click()

    await expect(main.getByRole('heading', { name: 'Ask', level: 2 })).toBeVisible()
    await expect(main.locator('.ask-scope[data-kind="meeting"]')).toHaveText(RECORDING_TITLED)
})
