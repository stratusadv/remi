import { expect, test } from '@playwright/test'
import { assert } from '../../src/lib/assert'
import {
    HAS_TEXT,
    STREAM_TIMEOUT_MS,
    actions_reported,
    actions_watch,
    app_open,
    step_current,
    transcript_rows,
    transcript_step_open,
} from './helpers'
import type { ConsoleMessage, Page } from '@playwright/test'


interface CommandFailure {
    readonly command: string
    readonly raw: string
}

const CLIPBOARD_READ = 'navigator.clipboard.readText()'
const HIGHLIGHT_NAME = 'transcript-filter'
const LINE_FIRST = 'Thanks for making time. Tell me about your current note taking.'
const LINE_FIRST_EDITED = 'Thanks for making time today.'
const LINE_SECOND = 'We record everything and then nobody writes it up.'
const MESSAGE_UNSHOWN = 'remi ran into a problem it cannot show here. The details are in its log.'

const TRACEBACK_CHARGE = 'api error: 500 transcription charge: Traceback (most recent call last):\n'
    + '  File "/app/server/app/account/services/processor_service.py", line 187\n'
    + 'psycopg.errors.UndefinedColumn: column "account"."is_complimentary" does not exist'

const FAILURE_CHARGE: CommandFailure = Object.freeze({
    command: 'transcription_remote',
    raw: TRACEBACK_CHARGE,
})


test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

async function command_fail(page: Page, failure: CommandFailure): Promise<void> {
    assert(!page.isClosed())
    assert(failure.command.length > 0)

    await page.evaluate(
        ({ command, raw }) => {
            const internals: unknown = Reflect.get(window, '__TAURI_INTERNALS__')

            if (typeof internals !== 'object') throw new Error('the browser mock is not installed')
            if (internals === null) throw new Error('the browser mock is not installed')

            const invoke_mock: unknown = Reflect.get(internals, 'invoke')

            if (typeof invoke_mock !== 'function') throw new Error('the browser mock has no invoke')

            Reflect.set(internals, 'invoke', async (name: string, ...rest: unknown[]) => {
                if (name === command) throw new Error(raw)

                const reply: unknown = await Reflect.apply(invoke_mock, internals, [name, ...rest])

                return reply
            })
        },
        failure,
    )
}

function console_traceback_is(message: ConsoleMessage): boolean {
    assert(message.page() !== null)
    assert(message.type().length > 0)

    return message.type() === 'warning' && message.text().includes('UndefinedColumn')
}

async function highlight_count(page: Page): Promise<number> {
    assert(!page.isClosed())
    assert(HIGHLIGHT_NAME.length > 0)

    return page.evaluate(
        (name) => CSS.highlights.get(name)?.size ?? 0,
        HIGHLIGHT_NAME,
    )
}

async function new_recording_open(page: Page): Promise<void> {
    assert(!page.isClosed())

    await page.getByRole('button', { name: 'New recording' }).first().click()
    await expect(step_current(page)).toHaveText('Transcript')
}

test.beforeEach(async ({ page }) => {
    await app_open(page)
})

test('a pasted transcript imports and moves to the Meeting step', async ({ page }) => {
    await new_recording_open(page)
    await page.getByRole('button', { name: 'Paste a transcript' }).click()

    const textarea = page.getByRole('textbox', { name: 'Transcript' })
    const next = page.getByRole('button', { name: 'Next' })

    await expect(next).toBeDisabled()

    await textarea.fill('First line here.\n\nSecond line here.\nThird line here.')

    await expect(next).toBeEnabled()

    await next.click()

    await expect(step_current(page)).toHaveText('Meeting')

    await page.getByRole('button', { name: 'Transcript', exact: true }).click()

    await expect(transcript_rows(page)).toHaveCount(3)

    await expect(transcript_rows(page).locator('.transcript-pane-row-text')).toHaveText([
        'First line here.',
        'Second line here.',
        'Third line here.',
    ])
})

test('the paste step cancels back to the file picker', async ({ page }) => {
    await new_recording_open(page)
    await page.getByRole('button', { name: 'Paste a transcript' }).click()
    await page.getByRole('button', { name: 'Cancel' }).click()

    await expect(page.getByRole('button', { name: 'Open or drop a recording' })).toBeVisible()
})

test('a picked file transcribes with a streaming preview', async ({ page }) => {
    await new_recording_open(page)
    await page.getByRole('button', { name: 'Open or drop a recording' }).click()

    await expect(page.locator('.file-picker-name')).toHaveText('weekly-sync.m4a')
    await expect(page.getByRole('button', { name: 'Replace' })).toBeVisible()

    await page.getByRole('button', { name: 'Transcribe' }).click()

    await expect(page.locator('.streaming-display')).toBeVisible()
    await expect(page.locator('.streaming-status')).toContainText('Receiving transcript')
    await expect(transcript_rows(page)).toHaveCount(8, { timeout: STREAM_TIMEOUT_MS })
    await expect(transcript_rows(page).first()).toContainText('Alright, everyone is here')
    await expect(page.getByRole('button', { name: 'Next' })).toBeVisible()
})

test('a picked file reports one upload, and its transcription none', async ({ page }) => {
    await actions_watch(page)
    await new_recording_open(page)
    await page.getByRole('button', { name: 'Open or drop a recording' }).click()

    await expect(page.locator('.file-picker-name')).toHaveText('weekly-sync.m4a')
    await expect.poll(async () => actions_reported(page)).toEqual(['upload-recording'])

    await page.getByRole('button', { name: 'Transcribe' }).click()

    await expect(transcript_rows(page)).toHaveCount(8, { timeout: STREAM_TIMEOUT_MS })

    const reported = await actions_reported(page)

    expect(reported).toEqual(['upload-recording'])
})

test('a failed transcription shows a short message and logs the traceback', async ({ page }) => {
    await new_recording_open(page)
    await page.getByRole('button', { name: 'Open or drop a recording' }).click()
    await command_fail(page, FAILURE_CHARGE)

    const logged = page.waitForEvent('console', { predicate: console_traceback_is })

    await page.getByRole('button', { name: 'Transcribe' }).click()
    await logged

    await expect(page.getByRole('alert').filter({ [HAS_TEXT]: MESSAGE_UNSHOWN })).toBeVisible()
    await expect(page.locator('body')).not.toContainText('Traceback')
    await expect(page.locator('body')).not.toContainText('UndefinedColumn')
})

test('Cancel on the Transcript step returns home', async ({ page }) => {
    await new_recording_open(page)
    await page.getByRole('button', { name: 'Cancel' }).click()

    await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible()
})

test('the filter narrows rows and registers one highlight per match', async ({ page }) => {
    await transcript_step_open(page)

    const filter = page.getByPlaceholder('Filter…')

    await filter.fill('record')

    await expect(transcript_rows(page)).toHaveCount(1)
    await expect(transcript_rows(page)).toContainText(LINE_SECOND)
    await expect.poll(async () => highlight_count(page)).toBe(1)

    await filter.fill('the')

    await expect(transcript_rows(page)).toHaveCount(2)
    await expect.poll(async () => highlight_count(page)).toBe(2)

    await filter.fill('nothing matches this')

    await expect(transcript_rows(page)).toHaveCount(0)
    await expect(page.getByText('No segments match.')).toBeVisible()

    await filter.fill('')

    await expect(transcript_rows(page)).toHaveCount(3)
    await expect.poll(async () => highlight_count(page)).toBe(0)
})

test('clicking a line copies it and flashes Copied', async ({ page }) => {
    await transcript_step_open(page)

    const row = transcript_rows(page).nth(1)

    await row.click()

    await expect(row).toHaveAttribute('data-copied', 'true')
    await expect(row.getByText('Copied')).toBeVisible()
    await expect.poll(async () => page.evaluate(CLIPBOARD_READ)).toBe(LINE_SECOND)
    await expect(row).toHaveAttribute('data-copied', 'false')
})

test('Copy transcript copies the whole text and swaps the label', async ({ page }) => {
    await transcript_step_open(page)

    const swap = page.locator('.btn-label-swap')

    await expect(swap).toHaveAttribute('data-swapped', 'false')

    await page.getByRole('button', { name: 'Copy transcript' }).click()

    await expect(swap).toHaveAttribute('data-swapped', 'true')
    await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible()

    await expect
        .poll(async () => page.evaluate(async () => navigator.clipboard.readText()))
        .toContain('Thanks for making time.')

    await expect(swap).toHaveAttribute('data-swapped', 'false')
})

test('the pencil edits a line and Enter commits it', async ({ page }) => {
    await transcript_step_open(page)

    const row = transcript_rows(page).first()

    await row.getByRole('button', { name: 'Correct this line' }).click()

    await expect(row).toHaveAttribute('data-editing', 'true')

    const line = row.getByRole('textbox', { name: 'Transcript line' })

    await expect(line).toHaveValue(LINE_FIRST)

    await line.fill(LINE_FIRST_EDITED)
    await line.press('Enter')

    await expect(row).toHaveAttribute('data-editing', 'false')
    await expect(row.locator('.transcript-pane-row-text')).toHaveText(LINE_FIRST_EDITED)

    await page.getByRole('button', { name: 'Meeting' }).click()
    await page.getByRole('button', { name: 'Transcript', exact: true }).click()

    await expect(transcript_rows(page).first()).toContainText(LINE_FIRST_EDITED)
})

test('Escape abandons a line edit', async ({ page }) => {
    await transcript_step_open(page)

    const row = transcript_rows(page).first()

    await row.getByRole('button', { name: 'Correct this line' }).click()

    const line = row.getByRole('textbox', { name: 'Transcript line' })

    await line.fill('Thrown away')
    await line.press('Escape')

    await expect(row).toHaveAttribute('data-editing', 'false')
    await expect(row.locator('.transcript-pane-row-text')).toContainText('Thanks for making time.')
})

test('the correction bar applies the returned corrections', async ({ page }) => {
    await transcript_step_open(page)

    const instruction = page.getByRole('searchbox', { name: 'Correction instruction' })
    const apply = page.getByRole('button', { name: 'Apply' })

    await expect(apply).toBeDisabled()

    await instruction.fill('record')

    await expect(apply).toBeEnabled()

    await apply.click()

    const corrected = transcript_rows(page).nth(1)

    await expect(corrected.locator('.transcript-pane-row-text'))
        .toHaveText(LINE_SECOND.toUpperCase())

    await expect(corrected).toHaveAttribute('data-highlighted', 'true')
    await expect(transcript_rows(page).first()).toHaveAttribute('data-highlighted', 'false')
    await expect(instruction).toHaveValue('record')

    await instruction.fill('')

    await expect(instruction).toHaveValue('')
    await expect(apply).toBeDisabled()

    await page.getByRole('button', { name: 'Undo' }).click()

    await expect(corrected.locator('.transcript-pane-row-text')).toHaveText(LINE_SECOND)
    await expect(corrected).toHaveAttribute('data-highlighted', 'false')
    await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0)
})

test('Next moves the step bar to Meeting', async ({ page }) => {
    await transcript_step_open(page)

    await expect(step_current(page)).toHaveText('Transcript')

    await page.getByRole('button', { name: 'Next' }).click()

    await expect(step_current(page)).toHaveText('Meeting')
})
