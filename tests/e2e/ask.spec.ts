import { expect, test } from '@playwright/test'
import { assert } from '../../src/lib/assert'
import {
    HAS_TEXT,
    RECORDING_TITLED,
    STREAM_TIMEOUT_MS,
    actions_reported,
    actions_watch,
    app_open,
    folder_item,
    nav_to,
    recording_open,
    step_current,
    tiles,
} from './helpers'
import type { Locator, Page } from '@playwright/test'


const ANSWER = 'The team agreed to ship the transcription retry work this week'
const ANSWER_BANNER = 'Sam is drafting the offline banner copy'
const ANSWER_SUMMARY_FIRST = 'The last meeting covered three things:'
const ANSWER_SUMMARY_LAST = 'Everyone checks the rollout numbers again at the next sync'
const CLIPBOARD_COPIED = `${ANSWER} [1].\n\nSources:\n[1] ${RECORDING_TITLED}, `
const HISTORY_EMPTY = 'Each chat is saved here as you ask'

const NOTICE_PACED = 'You have asked a lot this month, so remi answers one question every '
    + '5 minutes.'

const QUESTION = 'What did we agree to ship?'
const QUESTION_BANNER = 'Who is drafting the banner copy?'
const QUESTION_FOLLOW_UP = 'When is it due?'
const SPOKEN_RETRY = 'The retry work is close'
const SUGGESTION_SUMMARY = 'Summarize my last meeting'
const TITLE_BACK = 'Back to answer returns from a source to the same place in the chat'
const TITLE_CITED = 'a question streams an answer with numbered citations and opens the meeting'
const TITLE_COPY = 'Copy puts the answer and its numbered sources on the clipboard'
const TITLE_FOLLOW_UP = 'a follow-up question is answered with the conversation before it'
const TITLE_HISTORY = 'History lists past chats by day, and opening one continues it'
const TITLE_HISTORY_BULK = 'History deletes several chats after one confirmation inside it'
const TITLE_HISTORY_DELETE = 'deleting the open chat from History asks first and starts a new one'
const TITLE_JUMP = 'scrolling up offers a jump back to the latest answer'
const TITLE_MOMENT = 'a transcript citation opens the transcript at the moment it cites'
const TITLE_NEW_CHAT = 'New chat clears the conversation and returns to the suggestions'
const TITLE_PACED = 'a paced question shows its wait, then answers with the pace noted under it'
const TITLE_REPORT_ALL = 'a new chat reports its first question, and Ask again reports nothing'
const TITLE_REPORT_SCOPED = 'a question about a folder or a meeting reports its own scope'
const TITLE_SCOPE = 'asking about a folder scopes the chat to it until the chip is cleared'
const TITLE_STOP = 'Stop keeps what arrived and Ask again answers the question in full'
const TITLE_SUGGESTION = 'a suggestion asks at once and Enter asks the next question in the thread'


test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

test.beforeEach(async ({ page }) => {
    await app_open(page)
    await nav_to(page, 'Ask')
})

async function background_opaque(target: Locator): Promise<boolean> {
    assert(!target.page().isClosed())
    assert(target.page().url().length > 0)

    const color = await target.evaluate((element) => getComputedStyle(element).backgroundColor)

    return color.startsWith('rgb(')
}

async function citation_steps_walk(page: Page, source: Locator): Promise<void> {
    assert(!page.isClosed())
    assert(source.page() === page)

    const citation = page.locator('main').locator('.step-citation')

    await source.click()

    await expect(step_current(page)).toHaveText('Transcript')
    await expect(citation.locator('.ask-source-number')).toHaveText('1')
    await expect(citation).toContainText(`Cited in your chat ${QUESTION_BANNER}`)

    await page.getByRole('button', { name: 'Meeting' }).click()

    await expect(step_current(page)).toHaveText('Meeting')
    await expect(citation).toContainText(QUESTION_BANNER)

    await page.getByRole('button', { name: 'Notes', exact: true }).click()

    await expect(step_current(page)).toHaveText('Notes')
    await expect(citation).toContainText(QUESTION_BANNER)
}

function exchanges(page: Page): Locator {
    assert(!page.isClosed())
    assert(page.url().length > 0)

    return page.locator('main .ask-exchange')
}

function history_panel(page: Page): Locator {
    assert(!page.isClosed())
    assert(page.url().length > 0)

    return page.getByRole('dialog', { name: 'Chat history' })
}

function question_box(page: Page): Locator {
    assert(!page.isClosed())
    assert(page.url().length > 0)

    return page.locator('main').getByRole('textbox', { name: 'Question' })
}

async function question_send(page: Page, question: string): Promise<void> {
    assert(!page.isClosed())
    assert(question.trim().length > 0)

    const box = question_box(page)

    await box.fill(question)
    await box.press('Enter')
    await expect(box).toHaveValue('')
}

async function settled(exchange: Locator): Promise<void> {
    assert(!exchange.page().isClosed())
    assert(exchange.page().url().length > 0)

    await expect(exchange.getByRole('button', { name: 'Copy', exact: true })).toBeVisible({
        timeout: STREAM_TIMEOUT_MS,
    })
}

async function sources_open(exchange: Locator): Promise<Locator> {
    assert(!exchange.page().isClosed())
    assert(exchange.page().url().length > 0)

    const toggle = exchange.locator('.ask-sources-toggle')
    const sources = exchange.locator('.ask-source')

    await expect(sources.first()).toBeHidden()
    await toggle.click()
    await expect(sources.first()).toBeVisible()

    return sources
}

test(TITLE_CITED, async ({ page }) => {
    const main = page.locator('main')
    const send = main.getByRole('button', { name: 'Send', exact: true })

    await expect(send).toBeDisabled()

    await question_box(page).fill(QUESTION)
    await send.click()

    await expect(main.locator('.ask-question')).toHaveText(QUESTION)
    await expect(main.locator('.ask-answer')).toContainText(ANSWER, { timeout: STREAM_TIMEOUT_MS })
    await expect(main.locator('.ask-cite')).toHaveText('1')
    await expect(main.locator('.ask-cite')).toHaveAccessibleName(/^Source 1: Weekly platform sync/u)

    await main.locator('.ask-cite').hover()
    await expect(page.locator('.ask-preview')).toContainText(RECORDING_TITLED)

    const preview_opaque = await background_opaque(page.locator('.ask-preview'))

    expect(preview_opaque).toBe(true)

    await expect(main.locator('.ask-sources-toggle')).toHaveText('1 source')

    const sources = await sources_open(exchanges(page).first())
    const source = sources.filter({ [HAS_TEXT]: RECORDING_TITLED })

    await expect(source).toHaveCount(1)
    await expect(source.locator('.ask-source-number')).toHaveText('1')

    await source.hover()

    await expect(main.locator('.ask-cite')).toHaveAttribute('data-hovered', 'true')

    await source.click()

    const focused = page.locator('.transcript-pane-row[data-highlighted="true"]')

    await expect(step_current(page)).toHaveText('Transcript')
    await expect(focused).toHaveCount(1)
    await expect(focused).toContainText(SPOKEN_RETRY)
    await expect(focused).toBeInViewport()
})

test(TITLE_COPY, async ({ page }) => {
    await question_send(page, QUESTION)
    await settled(exchanges(page).first())

    const exchange = exchanges(page).first()

    await exchange.getByRole('button', { name: 'Copy', exact: true }).click()

    await expect(exchange.getByRole('button', { name: 'Copied', exact: true })).toBeVisible()

    await expect
        .poll(async () => page.evaluate(async () => navigator.clipboard.readText()))
        .toContain(CLIPBOARD_COPIED)
})

test(TITLE_FOLLOW_UP, async ({ page }) => {
    await question_send(page, QUESTION_BANNER)
    await settled(exchanges(page).first())
    await question_send(page, QUESTION_FOLLOW_UP)

    const follow_up = exchanges(page).nth(1)

    await expect(follow_up.locator('.ask-question')).toHaveText(QUESTION_FOLLOW_UP)

    await expect(follow_up.locator('.ask-answer')).toContainText(ANSWER_BANNER, {
        timeout: STREAM_TIMEOUT_MS,
    })

    await expect(follow_up.locator('.ask-source-where')).toHaveText('2:06')
})

test(TITLE_JUMP, async ({ page }) => {
    await page.locator('main').getByRole('button', { name: SUGGESTION_SUMMARY }).click()
    await settled(exchanges(page).first())
    await question_send(page, SUGGESTION_SUMMARY)
    await settled(exchanges(page).nth(1))

    const jump = page.locator('main').getByRole('button', { name: 'Jump to latest' })

    await expect(jump).toHaveCount(0)

    await page.locator('main .ask-scroll').evaluate((element) => {
        element.scrollTo({ top: 0 })
    })

    await expect(jump).toBeVisible()

    const jump_opaque = await background_opaque(jump)

    expect(jump_opaque).toBe(true)

    await jump.click()

    const latest = exchanges(page).nth(1).getByRole('button', { name: 'Copy', exact: true })

    await expect(jump).toHaveCount(0)
    await expect(latest).toBeInViewport()
    await expect(question_box(page)).toBeFocused()
})

test(TITLE_MOMENT, async ({ page }) => {
    await question_send(page, QUESTION_BANNER)
    await settled(exchanges(page).first())

    await expect(page.locator('main .ask-answer')).toContainText(ANSWER_BANNER)

    const source = await sources_open(exchanges(page).first())

    await expect(source).toHaveCount(1)
    await expect(source).toContainText(RECORDING_TITLED)
    await expect(source.locator('.ask-source-where')).toHaveText('2:06')

    await source.click()

    const focused = page.locator('.transcript-pane-row[data-highlighted="true"]')

    await expect(step_current(page)).toHaveText('Transcript')
    await expect(focused).toHaveCount(1)
    await expect(focused).toContainText(ANSWER_BANNER)
    await expect(focused).toBeInViewport()
})

test(TITLE_NEW_CHAT, async ({ page }) => {
    const main = page.locator('main')

    await question_send(page, QUESTION)
    await settled(exchanges(page).first())
    await main.getByRole('button', { name: 'New chat' }).click()

    await expect(exchanges(page)).toHaveCount(0)
    await expect(main.getByRole('heading', { name: 'What do you want to know?' })).toBeVisible()
    await expect(main.getByRole('button', { name: SUGGESTION_SUMMARY })).toBeEnabled()
    await expect(main.getByRole('button', { name: 'New chat' })).toHaveCount(0)
    await expect(question_box(page)).toBeFocused()
})

test(TITLE_PACED, async ({ page }) => {
    await page.goto('/?ask=paced')
    await expect(page.locator('.app-shell[data-ready="true"]')).toBeVisible()
    await nav_to(page, 'Ask')
    await question_send(page, QUESTION)

    const exchange = exchanges(page).first()
    const waiting = `${NOTICE_PACED} This answer starts in under a minute.`

    await expect(exchange.locator('.ask-status')).toHaveText(waiting)
    await settled(exchange)
    await expect(exchange.locator('.ask-answer')).toContainText(ANSWER)
    await expect(exchange.locator('.ask-notice')).toHaveText(NOTICE_PACED)
    await expect(exchange.locator('.ask-status')).toHaveCount(0)
})

test(TITLE_REPORT_ALL, async ({ page }) => {
    const main = page.locator('main')
    const answer = main.locator('.ask-answer')

    await actions_watch(page)
    await main.getByRole('button', { name: SUGGESTION_SUMMARY }).click()

    await expect(answer).toContainText(ANSWER_SUMMARY_FIRST, { timeout: STREAM_TIMEOUT_MS })

    await main.getByRole('button', { name: 'Stop' }).click()
    await main.getByRole('button', { name: 'Ask again' }).click()

    await expect(answer).toContainText(ANSWER_SUMMARY_LAST, { timeout: STREAM_TIMEOUT_MS })

    await expect.poll(async () => actions_reported(page)).toEqual([
        'new-chat',
        'ask-library-question',
    ])

    await question_send(page, QUESTION_FOLLOW_UP)
    await settled(exchanges(page).nth(1))
    await main.getByRole('button', { name: 'New chat' }).click()
    await question_send(page, QUESTION)
    await settled(exchanges(page).first())

    await expect.poll(async () => actions_reported(page)).toEqual([
        'new-chat',
        'ask-library-question',
        'ask-library-question',
        'new-chat',
        'ask-library-question',
    ])
})

test(TITLE_REPORT_SCOPED, async ({ page }) => {
    const main = page.locator('main')

    await actions_watch(page)
    await folder_item(page, 'Remi').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Ask about this folder' }).click()
    await question_send(page, QUESTION)

    await expect(main.locator('.ask-answer')).toContainText(ANSWER, { timeout: STREAM_TIMEOUT_MS })

    await nav_to(page, 'Home')
    await tiles(page).filter({ [HAS_TEXT]: RECORDING_TITLED }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Ask about this meeting' }).click()
    await question_send(page, QUESTION)

    await expect.poll(async () => actions_reported(page)).toEqual([
        'new-chat',
        'ask-folder-question',
        'new-chat',
        'ask-note-question',
    ])
})

test(TITLE_SCOPE, async ({ page }) => {
    const main = page.locator('main')
    const chip = main.locator('.ask-scope')

    await expect(main.getByRole('combobox')).toHaveCount(0)
    await expect(chip).toHaveCount(0)

    await folder_item(page, 'Remi').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Ask about this folder' }).click()

    await expect(chip).toHaveText('Remi')
    await expect(chip).toHaveAttribute('data-kind', 'folder')
    await expect(question_box(page)).toHaveAttribute('placeholder', 'Ask about this folder')
    await expect(main.getByRole('button', { name: 'Summarize these meetings' })).toBeVisible()

    await question_send(page, QUESTION)

    await expect(main.locator('.ask-scope-label')).toHaveText('In Remi')
    await expect(main.locator('.ask-answer')).toContainText(ANSWER, { timeout: STREAM_TIMEOUT_MS })
    await expect(chip).toHaveText('Remi')

    await chip.getByRole('button', { name: 'Ask about all meetings' }).click()

    await expect(chip).toHaveCount(0)
    await expect(question_box(page)).toHaveAttribute('placeholder', 'Ask about your meetings')
    await expect(question_box(page)).toBeFocused()
})

test(TITLE_STOP, async ({ page }) => {
    const main = page.locator('main')
    const answer = main.locator('.ask-answer')

    await main.getByRole('button', { name: SUGGESTION_SUMMARY }).click()

    await expect(answer).toContainText(ANSWER_SUMMARY_FIRST, { timeout: STREAM_TIMEOUT_MS })

    await main.getByRole('button', { name: 'Stop' }).click()

    await expect(main.locator('.ask-stopped')).toHaveText('Stopped')
    await expect(answer).not.toContainText(ANSWER_SUMMARY_LAST)
    await expect(main.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
    await expect(question_box(page)).toBeFocused()

    await main.getByRole('button', { name: 'Ask again' }).click()

    await expect(answer).toContainText(ANSWER_SUMMARY_LAST, { timeout: STREAM_TIMEOUT_MS })
    await expect(answer.locator('li')).toHaveCount(3)
    await expect(exchanges(page)).toHaveCount(1)
    await expect(main.locator('.ask-stopped')).toHaveCount(0)
})

test(TITLE_SUGGESTION, async ({ page }) => {
    const main = page.locator('main')

    await main.getByRole('button', { name: SUGGESTION_SUMMARY }).click()

    await expect(exchanges(page).first().locator('.ask-question')).toHaveText(SUGGESTION_SUMMARY)

    await expect(exchanges(page).first().locator('.ask-answer li')).toHaveCount(3, {
        timeout: STREAM_TIMEOUT_MS,
    })

    await settled(exchanges(page).first())
    await question_send(page, QUESTION)

    await expect(exchanges(page)).toHaveCount(2)
    await expect(exchanges(page).nth(1).locator('.ask-question')).toHaveText(QUESTION)

    await expect(exchanges(page).nth(1).locator('.ask-answer')).toContainText(ANSWER, {
        timeout: STREAM_TIMEOUT_MS,
    })
})

test(TITLE_HISTORY, async ({ page }) => {
    const main = page.locator('main')
    const history = main.getByRole('button', { name: 'History' })

    await history.click()
    await expect(history_panel(page)).toContainText(HISTORY_EMPTY)
    await page.keyboard.press('Escape')
    await expect(history_panel(page)).toHaveCount(0)

    await question_send(page, QUESTION_BANNER)
    await settled(exchanges(page).first())
    await main.getByRole('button', { name: 'New chat' }).click()
    await question_send(page, QUESTION)
    await settled(exchanges(page).first())
    await history.click()

    const today = history_panel(page).getByRole('region', { name: 'Today' })

    await expect(today.locator('.ask-history-open')).toHaveText([QUESTION, QUESTION_BANNER])
    await expect(today.locator('[aria-current="true"]')).toHaveText(QUESTION)

    await today.getByRole('button', { name: QUESTION_BANNER, exact: true }).click()

    await expect(history_panel(page)).toHaveCount(0)
    await expect(exchanges(page)).toHaveCount(1)
    await expect(main.locator('.ask-answer')).toContainText(ANSWER_BANNER)
    await expect(question_box(page)).toBeFocused()

    await question_send(page, QUESTION_FOLLOW_UP)

    await expect(exchanges(page).nth(1).locator('.ask-answer')).toContainText(ANSWER_BANNER, {
        timeout: STREAM_TIMEOUT_MS,
    })

    await settled(exchanges(page).nth(1))
    await history.click()

    await expect(today.locator('.ask-history-open')).toHaveText([QUESTION_BANNER, QUESTION])
    await expect(today.locator('[aria-current="true"]')).toHaveText(QUESTION_BANNER)
})

test(TITLE_HISTORY_DELETE, async ({ page }) => {
    const main = page.locator('main')
    const history = main.getByRole('button', { name: 'History' })
    const panel = history_panel(page)
    const remove = panel.getByRole('button', { name: `Delete chat: ${QUESTION}` })

    await question_send(page, QUESTION)
    await settled(exchanges(page).first())
    await history.click()
    await remove.click()

    const confirm = panel.getByRole('button', { name: 'Delete', exact: true })

    await expect(panel).toContainText(`Delete "${QUESTION}"? This cannot be undone.`)
    await expect(confirm).toBeFocused()
    await expect(page.getByRole('dialog')).toHaveCount(1)

    await panel.getByRole('button', { name: 'Cancel' }).click()

    await expect(confirm).toHaveCount(0)

    await page.keyboard.press('Escape')

    await expect(panel).toHaveCount(0)
    await expect(exchanges(page)).toHaveCount(1)

    await history.click()
    await remove.click()
    await confirm.click()

    await expect(panel).toContainText(HISTORY_EMPTY)
    await expect(exchanges(page)).toHaveCount(0)
    await expect(main.getByRole('heading', { name: 'What do you want to know?' })).toBeVisible()

    await page.keyboard.press('Escape')

    await expect(panel).toHaveCount(0)
})

test(TITLE_HISTORY_BULK, async ({ page }) => {
    const main = page.locator('main')

    await question_send(page, QUESTION_BANNER)
    await settled(exchanges(page).first())
    await main.getByRole('button', { name: 'New chat' }).click()
    await question_send(page, QUESTION)
    await settled(exchanges(page).first())
    await main.getByRole('button', { name: 'History' }).click()

    const panel = history_panel(page)
    const selected = panel.getByRole('button', { name: 'Delete selected' })

    await expect(selected).toBeDisabled()

    await panel.getByRole('checkbox', { name: 'Select all' }).check()

    await expect(panel.getByRole('checkbox', { name: `Select chat: ${QUESTION}` })).toBeChecked()

    await expect(
        panel.getByRole('checkbox', { name: `Select chat: ${QUESTION_BANNER}` }),
    ).toBeChecked()

    await selected.click()

    await expect(panel).toContainText('Delete 2 chats? This cannot be undone.')
    await expect(page.getByRole('dialog')).toHaveCount(1)

    await panel.getByRole('button', { name: 'Delete', exact: true }).click()

    await expect(panel).toContainText(HISTORY_EMPTY)
    await expect(exchanges(page)).toHaveCount(0)
})

test(TITLE_BACK, async ({ page }) => {
    await question_send(page, QUESTION_BANNER)
    await settled(exchanges(page).first())
    await question_send(page, QUESTION)
    await settled(exchanges(page).nth(1))
    await question_send(page, QUESTION_FOLLOW_UP)
    await settled(exchanges(page).nth(2))

    const source = (await sources_open(exchanges(page).first())).first()

    await source.scrollIntoViewIfNeeded()

    const main = page.locator('main')

    await expect(main.getByRole('button', { name: 'Jump to latest' })).toBeVisible()

    const scroller = main.locator('.ask-scroll')
    const top = await scroller.evaluate((element) => element.scrollTop)
    const back = main.getByRole('button', { name: 'Back to answer' })

    await citation_steps_walk(page, source)
    await back.click()

    await expect(exchanges(page)).toHaveCount(3)
    await expect(source).toBeVisible()
    await expect.poll(async () => scroller.evaluate((element) => element.scrollTop)).toBe(top)
    await expect(back).toHaveCount(0)

    await nav_to(page, 'Home')
    await recording_open(page, RECORDING_TITLED)

    await expect(main.locator('.step-citation')).toHaveCount(0)
})
