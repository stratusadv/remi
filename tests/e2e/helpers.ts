import { expect } from '@playwright/test'
import { assert } from '../../src/lib/assert'
import type { Locator, Page } from '@playwright/test'


export const HAS_TEXT = 'hasText'
export const RECORDING_TITLED = 'Weekly platform sync'
export const RECORDING_UNTITLED = 'discovery-call.wav'
export const STREAM_TIMEOUT_MS = 30_000

const COMMAND_ACTION_REPORT = 'account_action_report'
const COMMAND_CALLS_PREFIX = '__remi_command_calls_'
const CORNER_PIXELS = 4
const DIALOG_ENTERING = '.app-dialog-enter-active'
const DIALOG_LEAVING = '.app-dialog-leave-active'
const SELECTION_SETTLE_MS = 1_000
const TITLE_SELECTION = 'Rewrite the selected text with AI'


type RowLabel = string

export async function actions_reported(page: Page): Promise<string[]> {
    assert(!page.isClosed())
    assert(page.url().length > 0)

    const calls = await command_arguments(page, COMMAND_ACTION_REPORT)

    return calls.map((call) => {
        assert(typeof call === 'object', 'an action report carries no arguments')
        assert(call !== null, 'an action report carries no arguments')

        const action: unknown = Reflect.get(call, 'action')

        assert(typeof action === 'string', 'an action report names no action')

        return action
    })
}

export async function actions_watch(page: Page): Promise<void> {
    assert(!page.isClosed())
    assert(page.url().length > 0)

    await command_watch(page, COMMAND_ACTION_REPORT)
}

export async function app_open(page: Page): Promise<void> {
    assert(!page.isClosed())
    assert(page.url().length > 0)

    await page.goto('/')
    await expect(page.locator('.app-shell[data-ready="true"]')).toBeVisible()
}

async function command_arguments(page: Page, command: string): Promise<unknown[]> {
    assert(!page.isClosed())
    assert(command.length > 0)

    return page.evaluate(
        (key) => {
            const calls: unknown = Reflect.get(window, key)

            if (!Array.isArray(calls)) throw new Error(`${key} is not watched`)

            return Array.from<unknown>(calls)
        },
        `${COMMAND_CALLS_PREFIX}${command}`,
    )
}

export async function command_count(page: Page, command: string): Promise<number> {
    assert(!page.isClosed())
    assert(command.length > 0)

    const calls = await command_arguments(page, command)

    return calls.length
}

export async function command_watch(page: Page, command: string): Promise<void> {
    assert(!page.isClosed())
    assert(command.length > 0)

    await page.evaluate(
        ({ key, name }) => {
            const internals: unknown = Reflect.get(window, '__TAURI_INTERNALS__')

            if (typeof internals !== 'object') throw new Error('the browser mock is not installed')
            if (internals === null) throw new Error('the browser mock is not installed')

            const invoke_mock: unknown = Reflect.get(internals, 'invoke')

            if (typeof invoke_mock !== 'function') throw new Error('the browser mock has no invoke')

            const calls: unknown[] = []

            Reflect.set(window, key, calls)

            Reflect.set(internals, 'invoke', async (called: string, ...rest: unknown[]) => {
                const call = [called, ...rest]

                if (called === name) calls.push(rest[0])

                const reply: unknown = await Reflect.apply(invoke_mock, internals, call)

                return reply
            })
        },
        { key: `${COMMAND_CALLS_PREFIX}${command}`, name: command },
    )
}

export async function corner_click(page: Page, button: 'left' | 'right'): Promise<void> {
    assert(!page.isClosed())
    assert(button.length > 0)

    await page.mouse.click(CORNER_PIXELS, CORNER_PIXELS, { button })
}

export async function corner_drag(page: Page, from: Locator): Promise<void> {
    assert(!page.isClosed())
    assert(from.page() === page)

    await expect(page.locator(DIALOG_ENTERING)).toHaveCount(0)
    await from.hover()

    const box = await from.boundingBox()

    assert(box !== null)

    await page.mouse.move(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2))
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

export function folder_item(page: Page, name: string): Locator {
    assert(!page.isClosed())
    assert(name.length > 0)

    const label = page.getByText(name, { exact: true })

    return page.locator('aside .sidebar-folders li button').filter({ has: label })
}

export async function nav_to(page: Page, label: string): Promise<void> {
    assert(!page.isClosed())
    assert(label.length > 0)

    await page.locator('aside').getByRole('button', { name: label, exact: true }).click()
    await expect(page.getByRole('heading', { name: label })).toBeVisible()
}

export async function network_set(page: Page, state: 'offline' | 'online'): Promise<void> {
    assert(!page.isClosed())
    assert(['offline', 'online'].includes(state))

    const dispatch = state === 'online' ? network_set_online : network_set_offline
    const online = await page.evaluate(dispatch)

    assert(online === (state === 'online'))
}

function network_set_offline(): boolean {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    window.dispatchEvent(new Event('offline'))

    return navigator.onLine
}

function network_set_online(): boolean {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    window.dispatchEvent(new Event('online'))

    return navigator.onLine
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
