import { expect, test } from '@playwright/test'
import { assert } from '../../src/lib/assert'
import {
    HAS_TEXT,
    RECORDING_TITLED,
    RECORDING_UNTITLED,
    STREAM_TIMEOUT_MS,
    app_open,
    dialog,
    nav_to,
    row_menu_pick,
    selection_text,
    step_current,
    tiles,
    transcript_rows,
    transcript_step_open,
} from './helpers'
import type { Locator, Page } from '@playwright/test'


const ANSWER = 'The team agreed to ship the transcription retry work this week'
const CLIPBOARD_COPIED = `${ANSWER} [1].\n\nSources:\n[1] ${RECORDING_TITLED}, `
const CORNER_INSET_PX = 4
const HEADING_EMPTY = 'What do you want to know?'
const ITEM_ASK = 'Ask about this meeting'
const MOUSE_BUTTON_MIDDLE = 1
const QUESTION = 'What did we agree to ship?'
const TEMPLATE = 'Stand-up digest'
const TITLE_ANSWER = 'an answer copies with its sources, and a citation opens its meeting'
const TITLE_DIALOG = 'Copy works on text selected inside a dialog'
const TITLE_HISTORY = 'a chat deletes from its menu while History stays open behind it'
const TITLE_NATIVE = 'a middle click and Select All act only inside text fields'
const TITLE_SIDEBAR = 'the sidebar menus open an add form or a Settings section directly'


test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

test.beforeEach(async ({ page }) => {
    await app_open(page)
})

async function answer_receive(page: Page): Promise<void> {
    assert(!page.isClosed())
    assert(page.url().length > 0)

    const main = page.locator('main')
    const question = main.getByRole('textbox', { name: 'Question' })

    await nav_to(page, 'Ask')
    await question.fill(QUESTION)
    await question.press('Enter')

    await expect(main.getByRole('button', { name: 'Copy', exact: true })).toBeVisible({
        timeout: STREAM_TIMEOUT_MS,
    })
}

async function clipboard_read(page: Page): Promise<string> {
    assert(!page.isClosed())
    assert(page.url().length > 0)

    return page.evaluate(async () => navigator.clipboard.readText())
}

function context_menu(page: Page): Locator {
    assert(!page.isClosed())
    assert(page.url().length > 0)

    return page.getByRole('menu')
}

async function native_menu_prevented(target: Locator): Promise<boolean> {
    assert(!target.page().isClosed())
    assert(target.page().url().length > 0)

    return target.evaluate((element) => {
        const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })

        element.dispatchEvent(event)

        return event.defaultPrevented
    })
}

async function field_selection_length(field: Locator): Promise<number> {
    assert(!field.page().isClosed())
    assert(field.page().url().length > 0)

    return field.evaluate((element) => {
        if (element instanceof HTMLTextAreaElement) {
            return element.selectionEnd - element.selectionStart
        }

        if (element instanceof HTMLInputElement) {
            return (element.selectionEnd ?? 0) - (element.selectionStart ?? 0)
        }

        return -1
    })
}

async function middle_press_prevented(target: Locator): Promise<boolean> {
    assert(!target.page().isClosed())
    assert(target.page().url().length > 0)

    return target.evaluate(
        (element, button) => {
            const event = new MouseEvent('mousedown', { bubbles: true, button, cancelable: true })

            element.dispatchEvent(event)

            return event.defaultPrevented
        },
        MOUSE_BUTTON_MIDDLE,
    )
}

function scope_chip(page: Page): Locator {
    assert(!page.isClosed())
    assert(page.url().length > 0)

    return page.locator('main .ask-scope[data-kind="meeting"]')
}

test('right-clicking a recording asks about it in a chat of its own', async ({ page }) => {
    const tile = tiles(page).filter({ [HAS_TEXT]: RECORDING_TITLED })
    const menu = context_menu(page)

    await tile.click({ button: 'right' })

    await expect(menu.getByRole('menuitem')).toHaveText([
        ITEM_ASK,
        'Rename',
        'Move to folder',
        'Delete',
    ])

    await expect(menu.getByRole('menuitem', { name: ITEM_ASK })).toBeFocused()

    await page.keyboard.press('ArrowDown')
    await expect(menu.getByRole('menuitem', { name: 'Rename' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)

    await tile.click({ button: 'right' })
    await page.keyboard.press('Enter')

    const main = page.locator('main')

    await expect(main.getByRole('heading', { name: 'Ask', level: 2 })).toBeVisible()
    await expect(scope_chip(page)).toHaveText(RECORDING_TITLED)
    await expect(main.getByRole('button', { name: 'Summarize this meeting' })).toBeVisible()
    await expect(main.getByRole('textbox', { name: 'Question' })).toBeFocused()
})

test('right-clicking a transcript line asks about the open meeting', async ({ page }) => {
    await transcript_step_open(page)

    const line = transcript_rows(page).first().locator('.transcript-pane-row-text')

    await line.click({ button: 'right' })
    await context_menu(page).getByRole('menuitem', { name: ITEM_ASK }).click()

    await expect(scope_chip(page)).toHaveText(RECORDING_UNTITLED)
    await expect(page.locator('main .ask-exchange')).toHaveCount(0)
})

test('the browser menu never shows outside text fields, nor an empty menu', async ({ page }) => {
    await nav_to(page, 'Ask')

    const question = page.locator('main').getByRole('textbox', { name: 'Question' })

    const aside = await native_menu_prevented(page.locator('aside'))
    const main = await native_menu_prevented(page.locator('main'))
    const field = await native_menu_prevented(question)

    expect([aside, main, field]).toEqual([true, true, false])

    const heading = page.locator('main').getByRole('heading', { name: HEADING_EMPTY })

    await heading.click({ button: 'right' })

    await expect(context_menu(page)).toHaveCount(0)
})

test('Copy appears for selected text and copies exactly that text', async ({ page }) => {
    await nav_to(page, 'Ask')

    const question = page.locator('main').getByRole('textbox', { name: 'Question' })
    const answer = page.locator('main .ask-answer')

    await question.fill(QUESTION)
    await question.press('Enter')
    await expect(answer).toContainText(ANSWER, { timeout: STREAM_TIMEOUT_MS })
    await answer.selectText()

    const selected = (await selection_text(page)).trim()
    const box = await answer.boundingBox()

    expect(selected).toContain(ANSWER)
    assert(box !== null)

    await page.mouse.click(box.x + CORNER_INSET_PX, box.y + CORNER_INSET_PX, { button: 'right' })

    await expect(context_menu(page).getByRole('menuitem')).toHaveText([
        'Copy',
        'Copy answer',
        'Ask again',
    ])

    await context_menu(page).getByRole('menuitem', { name: 'Copy', exact: true }).click()

    await expect(context_menu(page)).toHaveCount(0)

    await expect
        .poll(async () => page.evaluate(async () => navigator.clipboard.readText()))
        .toBe(selected)
})

test(TITLE_SIDEBAR, async ({ page }) => {
    const aside = page.locator('aside')
    const group = dialog(page, 'New group')

    await aside.getByRole('button', { name: 'People', exact: true }).click({ button: 'right' })

    await expect(context_menu(page).getByRole('menuitem')).toHaveText(['Add person', 'Add group'])

    await context_menu(page).getByRole('menuitem', { name: 'Add group' }).click()

    await expect(group).toBeVisible()

    await group.getByRole('button', { name: 'Close' }).click()
    await expect(group).toHaveCount(0)
    await aside.getByRole('button', { name: 'Settings', exact: true }).click({ button: 'right' })
    await context_menu(page).getByRole('menuitem', { name: 'AI', exact: true }).click()

    await expect(page.getByRole('tab', { name: 'AI', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
    )
})

test(TITLE_ANSWER, async ({ page }) => {
    await answer_receive(page)

    const main = page.locator('main')

    await main.locator('.ask-question').click({ button: 'right' })

    await expect(context_menu(page).getByRole('menuitem')).toHaveText(['Copy answer', 'Ask again'])

    await context_menu(page).getByRole('menuitem', { name: 'Copy answer' }).click()

    await expect.poll(async () => clipboard_read(page)).toContain(CLIPBOARD_COPIED)

    await main.locator('.ask-cite').click({ button: 'right' })

    await expect(context_menu(page).getByRole('menuitem')).toHaveText(['Open meeting', ITEM_ASK])

    await context_menu(page).getByRole('menuitem', { name: 'Open meeting' }).click()

    await expect(step_current(page)).toHaveText('Notes')
})

test(TITLE_HISTORY, async ({ page }) => {
    await answer_receive(page)

    const main = page.locator('main')
    const history = page.getByRole('dialog', { name: 'Chat history' })

    await main.getByRole('button', { name: 'History' }).click()
    await history.locator('.ask-history-open').click({ button: 'right' })

    await expect(context_menu(page).getByRole('menuitem')).toHaveText(['Delete'])
    await expect(history).toBeVisible()

    await page.keyboard.press('Escape')

    await expect(context_menu(page)).toHaveCount(0)
    await expect(history).toBeVisible()

    await history.locator('.ask-history-open').click({ button: 'right' })
    await context_menu(page).getByRole('menuitem', { name: 'Delete' }).hover()
    await page.mouse.down()

    await expect(history).toBeVisible()

    await page.mouse.up()
    await dialog(page, 'Delete chat').getByRole('button', { name: 'Delete' }).click()

    await expect(main.locator('.ask-exchange')).toHaveCount(0)
})

test(TITLE_NATIVE, async ({ page }) => {
    await answer_receive(page)

    const main = page.locator('main')
    const question = main.getByRole('textbox', { name: 'Question' })

    const aside = await middle_press_prevented(page.locator('aside'))
    const field = await middle_press_prevented(question)

    expect([aside, field]).toEqual([true, false])

    await question.fill(QUESTION)
    await question.press('ControlOrMeta+a')

    const field_selected = await field_selection_length(question)

    expect(field_selected).toBe(QUESTION.length)

    await main.getByRole('heading', { name: 'Ask', level: 2 }).click()
    await page.keyboard.press('ControlOrMeta+a')

    const page_selected = await selection_text(page)

    expect(page_selected).toBe('')
})

test(TITLE_DIALOG, async ({ page }) => {
    await nav_to(page, 'Templates')
    await row_menu_pick(page, TEMPLATE, 'Delete')

    const message = dialog(page, 'Delete template').locator('.app-dialog-message')

    await message.selectText()

    const selected = (await selection_text(page)).trim()
    const box = await message.boundingBox()

    expect(selected).toContain(`Delete the "${TEMPLATE}" template?`)
    assert(box !== null)

    await page.mouse.click(box.x + CORNER_INSET_PX, box.y + CORNER_INSET_PX, { button: 'right' })
    await context_menu(page).getByRole('menuitem', { name: 'Copy', exact: true }).click()

    await expect.poll(async () => clipboard_read(page)).toBe(selected)
})
