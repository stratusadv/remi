import { expect, test } from '@playwright/test'
import { assert } from '../../src/lib/assert'
import {
    HAS_TEXT,
    RECORDING_TITLED,
    RECORDING_UNTITLED,
    app_open,
    dialog,
    folder_item,
    nav_to,
    recording_open,
    step_current,
    tiles,
} from './helpers'
import type { Locator, Page } from '@playwright/test'


interface ScreenPoint {
    x_px: number
    y_px: number
}

const ATTRIBUTE_BLOCKED = 'data-drop-blocked'
const ATTRIBUTE_TARGET = 'data-drop-target'
const CURSOR_BLOCKED = 'not-allowed'
const DRAG_NUDGE_PX = 30
const DRAG_STEPS = 8
const FOLDER_NEW = 'Acme Mining'
const FOLDER_RENAMED = 'Acme Corp'
const FOLDER_SEEDED = 'Remi'
const PROMPT_LABEL = 'Folder name'
const SELECTOR_GHOST = '.job-drag-ghost'
const SELECTOR_ROW = '.recording-table-row'


test.beforeEach(async ({ page }) => {
    await app_open(page)
})

async function cursor_at(page: Page, point: ScreenPoint): Promise<string> {
    assert(!page.isClosed())
    assert(Number.isFinite(point.x_px))

    return page.evaluate(
        ({ x_px, y_px }) => {
            const element = document.elementFromPoint(x_px, y_px)

            return element === null ? '' : getComputedStyle(element).cursor
        },
        point,
    )
}

async function drag_over(page: Page, target: Locator): Promise<ScreenPoint> {
    assert(!page.isClosed())
    assert(target.page() === page)

    const box = await target.boundingBox()

    assert(box !== null, 'the drop target is not on screen')

    const point = { x_px: box.x + box.width / 2, y_px: box.y + box.height / 2 }

    await page.mouse.move(point.x_px, point.y_px, { steps: DRAG_STEPS })

    return point
}

async function folder_create(page: Page, name: string): Promise<void> {
    assert(!page.isClosed())
    assert(name.length > 0)

    await page.locator('aside').getByRole('button', { name: 'New folder' }).click()
    await prompt_focused(page, 'New folder')
    await page.keyboard.type(name)
    await page.keyboard.press('Enter')
    await expect(folder_item(page, name)).toBeVisible()
}

async function prompt_focused(page: Page, title: string): Promise<void> {
    assert(!page.isClosed())
    assert(title.length > 0)

    const field = dialog(page, title).getByRole('textbox', { name: PROMPT_LABEL })

    await expect(field).toBeFocused()
}

test('a folder is created, refused when repeated, renamed, and opened', async ({ page }) => {
    const heading = page.getByRole('heading', { level: 2, name: FOLDER_RENAMED })

    await expect(folder_item(page, FOLDER_SEEDED)).toContainText('1')

    await folder_create(page, FOLDER_NEW)

    await expect(folder_item(page, FOLDER_NEW)).toContainText('0')
    await expect(page.getByRole('heading', { level: 2, name: 'Home' })).toBeVisible()

    await page.locator('aside').getByRole('button', { name: 'New folder' }).click()
    await prompt_focused(page, 'New folder')
    await page.keyboard.type(' acme mining ')
    await page.keyboard.press('Enter')

    await expect(dialog(page, 'New folder')).toContainText('already exists')

    await page.keyboard.press('Enter')
    await folder_item(page, FOLDER_NEW).click({ button: 'right' })

    await expect(page.getByRole('menuitem')).toHaveText(['Rename', 'Delete'])

    await page.getByRole('menuitem', { name: 'Rename' }).click()
    await prompt_focused(page, 'Rename folder')

    await expect(dialog(page, 'Rename folder').getByRole('textbox')).toHaveValue(FOLDER_NEW)

    await page.keyboard.type(FOLDER_RENAMED)
    await page.keyboard.press('Enter')

    await expect(folder_item(page, FOLDER_NEW)).toHaveCount(0)

    await folder_item(page, FOLDER_RENAMED).click()

    await expect(heading).toBeVisible()
    await expect(folder_item(page, FOLDER_RENAMED)).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('main')).toContainText('This folder is empty')
    await expect(page.locator('main').getByRole('button', { name: 'New recording' })).toHaveCount(0)
})

test('a recording moves into a new folder and the folder shows only it', async ({ page }) => {
    const mover = dialog(page, 'Move to folder')
    const tile = tiles(page).filter({ [HAS_TEXT]: RECORDING_UNTITLED })

    await tile.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move to folder' }).click()

    await expect(mover.locator('.folder-move-option')).toHaveText(['No folder', FOLDER_SEEDED])
    await expect(mover.getByRole('button', { name: 'No folder' })).toBeFocused()

    await mover.getByRole('button', { name: 'New folder' }).click()
    await prompt_focused(page, 'New folder')
    await page.keyboard.type(FOLDER_NEW)
    await page.keyboard.press('Enter')

    await expect(mover).toHaveCount(0)
    await expect(folder_item(page, FOLDER_NEW)).toContainText('1')

    await folder_item(page, FOLDER_NEW).click()

    const main = page.locator('main')

    await expect(main.getByRole('heading', { level: 2, name: FOLDER_NEW })).toBeVisible()
    await expect(tiles(page)).toHaveCount(1)
    await expect(tiles(page)).toContainText(RECORDING_UNTITLED)
    await expect(main.locator('.recording-tile-new')).toHaveCount(0)

    await main.getByRole('button', { name: 'Home', exact: true }).click()

    await expect(main.getByRole('heading', { level: 2, name: 'Home' })).toBeVisible()
    await expect(tiles(page)).toHaveCount(2)
})

test('a recording dragged onto a folder moves into it and stays closed', async ({ page }) => {
    const ghost = page.locator(SELECTOR_GHOST)
    const seeded = folder_item(page, FOLDER_SEEDED)

    await tiles(page).filter({ [HAS_TEXT]: RECORDING_UNTITLED }).hover()
    await page.mouse.down()
    await drag_over(page, seeded)

    await expect(ghost).toHaveText(RECORDING_UNTITLED)
    await expect(seeded).toHaveAttribute(ATTRIBUTE_BLOCKED, 'false')
    await expect(seeded).toHaveAttribute(ATTRIBUTE_TARGET, 'true')

    await page.mouse.up()

    await expect(seeded).toContainText('2')
    await expect(seeded).toHaveAttribute(ATTRIBUTE_TARGET, 'false')
    await expect(ghost).toHaveCount(0)
    await expect(step_current(page)).toHaveCount(0)
    await expect(page.getByRole('heading', { level: 2, name: 'Home' })).toBeVisible()
})

test('a dragged row is refused by its own folder and drops into another', async ({ page }) => {
    const seeded = folder_item(page, FOLDER_SEEDED)

    await folder_create(page, FOLDER_NEW)
    await page.getByRole('button', { name: 'List' }).click()
    await page.locator(SELECTOR_ROW).filter({ [HAS_TEXT]: RECORDING_TITLED }).hover()
    await page.mouse.down()

    const point = await drag_over(page, seeded)

    await expect(page.locator(SELECTOR_GHOST)).toHaveText(RECORDING_TITLED)
    await expect(seeded).toHaveAttribute(ATTRIBUTE_BLOCKED, 'true')
    await expect(seeded).toHaveAttribute(ATTRIBUTE_TARGET, 'false')
    await expect.poll(async () => cursor_at(page, point)).toBe(CURSOR_BLOCKED)

    const created = folder_item(page, FOLDER_NEW)

    await drag_over(page, created)

    await expect(created).toHaveAttribute(ATTRIBUTE_BLOCKED, 'false')
    await expect(created).toHaveAttribute(ATTRIBUTE_TARGET, 'true')

    await page.mouse.up()

    await expect(created).toContainText('1')
    await expect(seeded).toHaveCount(0)
})

test('a drag released off every folder moves nothing and opens nothing', async ({ page }) => {
    const tile = tiles(page).filter({ [HAS_TEXT]: RECORDING_TITLED })
    const box = await tile.boundingBox()

    assert(box !== null, 'the recording is not on screen')

    await tile.hover()
    await page.mouse.down()

    await page.mouse.move(
        box.x + box.width / 2,
        box.y + box.height / 2 + DRAG_NUDGE_PX,
        { steps: DRAG_STEPS },
    )

    const seeded = folder_item(page, FOLDER_SEEDED)

    await expect(page.locator(SELECTOR_GHOST)).toBeVisible()
    await expect(seeded).toHaveAttribute(ATTRIBUTE_BLOCKED, 'true')

    await page.mouse.up()

    await expect(page.locator(SELECTOR_GHOST)).toHaveCount(0)
    await expect(seeded).toHaveAttribute(ATTRIBUTE_BLOCKED, 'false')
    await expect(step_current(page)).toHaveCount(0)
    await expect(seeded).toContainText('1')

    await recording_open(page, RECORDING_TITLED)
})

test('deleting a folder keeps its recording and clears its Ask scope', async ({ page }) => {
    const chip = page.locator('main .ask-scope')

    await folder_item(page, FOLDER_SEEDED).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Ask about this folder' }).click()

    await expect(chip).toHaveText(FOLDER_SEEDED)

    await folder_item(page, FOLDER_SEEDED).click()
    await page.locator('main').getByRole('button', { name: `Options for ${FOLDER_SEEDED}` }).click()

    await expect(page.getByRole('menuitem')).toHaveText([
        'Ask about this folder',
        'Rename',
        'Delete',
    ])

    await page.getByRole('menuitem', { name: 'Delete' }).click()

    const confirm = dialog(page, 'Delete folder')

    await expect(confirm).toContainText(
        `Delete the folder "${FOLDER_SEEDED}"? The recording in it stays in Home.`,
    )

    await confirm.getByRole('button', { name: 'Delete' }).click()

    await expect(folder_item(page, FOLDER_SEEDED)).toHaveCount(0)
    await expect(page.locator('aside')).toContainText('No folders yet')
    await expect(page.getByRole('heading', { level: 2, name: 'Home' })).toBeVisible()
    await expect(tiles(page).filter({ [HAS_TEXT]: RECORDING_TITLED })).toHaveCount(1)

    await nav_to(page, 'Ask')

    await expect(chip).toHaveCount(0)
})
