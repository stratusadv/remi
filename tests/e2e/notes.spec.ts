import { expect, test } from '@playwright/test'
import { assert } from '../../src/lib/assert'
import {
    HAS_TEXT,
    RECORDING_TITLED,
    RECORDING_UNTITLED,
    STREAM_TIMEOUT_MS,
    app_open,
    dialog,
    editor,
    editor_content_set,
    editor_line_select,
    nav_to,
    recording_open,
    step_current,
    tiles,
    transcript_rows,
} from './helpers'
import type { Locator, Page } from '@playwright/test'


const MARKDOWN_SAMPLE = 'Alpha beta\n\nGamma delta'
const LINE_FIRST = 'Alpha beta'
const LINE_SECOND = 'Gamma delta'
const EXPORT_PATH = '/home/you/Documents/notes.docx'
const PRINT_STUB = 'window.print = () => { document.body.dataset.printed = "true" }'

const TITLE_SELECTION_COUNT = 'the selection count follows the selection '
    + 'and resets when it is cleared'


function ai_input(page: Page): Locator {
    assert(!page.isClosed())
    assert(page.url().length > 0)

    return page.getByPlaceholder('Custom instruction (e.g. \'rewrite as bullet points\')')
}

function ai_panel(page: Page): Locator {
    assert(!page.isClosed())
    assert(page.url().length > 0)

    return page.locator('.rich-editor-ai')
}

async function generation_wait(page: Page): Promise<void> {
    await expect(page.locator('.notes-stream-pane')).toBeVisible()
    await expect(page.locator('.streaming-status')).toHaveText('Writing notes')
    await expect(editor(page)).toBeVisible({ timeout: STREAM_TIMEOUT_MS })
    await expect(editor(page).locator('h1')).toHaveText(RECORDING_TITLED)
}

async function notes_empty_open(page: Page): Promise<void> {
    assert(!page.isClosed())

    await recording_open(page, RECORDING_UNTITLED)
    await page.getByRole('button', { name: 'Next' }).click()
    await expect(step_current(page)).toHaveText('Notes')
    await expect(page.locator('.notes-empty')).toBeVisible()
}

async function notes_open(page: Page): Promise<void> {
    assert(!page.isClosed())

    await recording_open(page, RECORDING_TITLED)
    await expect(editor(page)).toContainText(RECORDING_TITLED)
    await editor_content_set(page, MARKDOWN_SAMPLE)
}

function toolbar_button(page: Page, title: string): Locator {
    assert(!page.isClosed())
    assert(title.length > 0)

    return page.locator('.rich-editor-toolbar').getByTitle(title)
}

test.beforeEach(async ({ page }) => {
    await app_open(page)
})

test('Generate notes streams and lands in the editor', async ({ page }) => {
    await notes_empty_open(page)

    const generate = page.getByRole('button', { name: 'Generate notes' })

    await expect(generate).toBeEnabled()

    await generate.click()
    await generation_wait(page)

    await expect(editor(page).locator('h2')).toHaveText(['Summary', 'Decisions', 'Action items'])
    await expect(editor(page).locator('ul[data-type="taskList"] li')).toHaveCount(2)
    await expect(page.getByRole('button', { name: 'Regenerate notes' })).toBeVisible()

    await nav_to(page, 'Home')

    const tile = tiles(page).filter({ [HAS_TEXT]: RECORDING_UNTITLED })

    await expect(tile.locator('.recording-tile-status')).toHaveText('Notes ready')
})

test('Regenerate asks before overwriting', async ({ page }) => {
    await notes_open(page)
    await page.getByRole('button', { name: 'Regenerate notes' }).click()

    const confirm = dialog(page, 'Overwrite notes')

    await expect(confirm).toContainText('This will overwrite the current notes. Continue?')

    await confirm.getByRole('button', { name: 'Cancel' }).click()

    await expect(confirm).toBeHidden()
    await expect(editor(page)).toContainText(LINE_FIRST)

    await page.getByRole('button', { name: 'Regenerate notes' }).click()
    await confirm.getByRole('button', { name: 'OK' }).click()
    await generation_wait(page)

    await expect(editor(page)).not.toContainText(LINE_FIRST)
})

test('Link asks for the address in the app and applies it to the selection', async ({ page }) => {
    await notes_open(page)
    await editor_line_select(page, LINE_SECOND)
    await toolbar_button(page, 'Link').click()

    const prompt = dialog(page, 'Add a link')

    await prompt.getByRole('textbox').fill('https://example.com')
    await prompt.getByRole('button', { name: 'OK' }).click()

    await expect(editor(page).getByRole('link', { name: LINE_SECOND })).toHaveAttribute(
        'href',
        'https://example.com',
    )
})

test('Cancelling the link prompt leaves the selection unlinked', async ({ page }) => {
    await notes_open(page)
    await editor_line_select(page, LINE_SECOND)
    await toolbar_button(page, 'Link').click()
    await dialog(page, 'Add a link').getByRole('button', { name: 'Cancel' }).click()

    await expect(editor(page).getByRole('link')).toHaveCount(0)
})

test('Bold applies on the first click and removes on the second', async ({ page }) => {
    await notes_open(page)
    await editor_line_select(page, LINE_SECOND)
    await toolbar_button(page, 'Bold (Ctrl+B)').click()

    await expect(editor(page).locator('strong')).toHaveText(LINE_SECOND)
    await expect(toolbar_button(page, 'Bold (Ctrl+B)')).toHaveClass(/rich-tb-btn-active/)

    await toolbar_button(page, 'Bold (Ctrl+B)').click()

    await expect(editor(page).locator('strong')).toHaveCount(0)
    await expect(toolbar_button(page, 'Bold (Ctrl+B)')).not.toHaveClass(/rich-tb-btn-active/)
})

test('Italic applies on the first click and removes on the second', async ({ page }) => {
    await notes_open(page)
    await editor_line_select(page, LINE_SECOND)
    await toolbar_button(page, 'Italic (Ctrl+I)').click()

    await expect(editor(page).locator('em')).toHaveText(LINE_SECOND)

    await toolbar_button(page, 'Italic (Ctrl+I)').click()

    await expect(editor(page).locator('em')).toHaveCount(0)
})

test('Strikethrough and inline code toggle', async ({ page }) => {
    await notes_open(page)
    await editor_line_select(page, LINE_SECOND)
    await toolbar_button(page, 'Strikethrough').click()

    await expect(editor(page).locator('s')).toHaveText(LINE_SECOND)

    await toolbar_button(page, 'Strikethrough').click()

    await expect(editor(page).locator('s')).toHaveCount(0)

    await toolbar_button(page, 'Inline code').click()

    await expect(editor(page).locator('code')).toHaveText(LINE_SECOND)

    await toolbar_button(page, 'Inline code').click()

    await expect(editor(page).locator('code')).toHaveCount(0)
})

test('the inline code button only reads as on inside inline code', async ({ page }) => {
    await notes_open(page)
    await editor(page).getByText(LINE_FIRST).click()

    const button = toolbar_button(page, 'Inline code')

    await expect(button).not.toHaveClass(/rich-tb-btn-active/)
    await expect(button.locator('code')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')

    await editor_line_select(page, LINE_SECOND)
    await button.click()

    await expect(button).toHaveClass(/rich-tb-btn-active/)
})

test('the heading select changes the block type', async ({ page }) => {
    await notes_open(page)

    const heading = page.locator('.rich-tb-select')

    await editor(page).getByText(LINE_SECOND).click()

    await expect(heading).toHaveValue('')

    await heading.selectOption('2')

    await expect(editor(page).locator('h2')).toHaveText(LINE_SECOND)
    await expect(heading).toHaveValue('2')

    await heading.selectOption('1')

    await expect(editor(page).locator('h1')).toHaveText(LINE_SECOND)

    await heading.selectOption('3')

    await expect(editor(page).locator('h3')).toHaveText(LINE_SECOND)

    await heading.selectOption('')

    await expect(editor(page).locator('h1, h2, h3')).toHaveCount(0)

    await expect(editor(page).locator('p').filter({ [HAS_TEXT]: /\S/ }))
        .toHaveText([LINE_FIRST, LINE_SECOND])
})

test('bullet, numbered, and task lists toggle', async ({ page }) => {
    await notes_open(page)
    await editor(page).getByText(LINE_SECOND).click()
    await toolbar_button(page, 'Bullet list').click()

    await expect(editor(page).locator('ul:not([data-type="taskList"]) li')).toHaveText(LINE_SECOND)

    await toolbar_button(page, 'Numbered list').click()

    await expect(editor(page).locator('ul')).toHaveCount(0)
    await expect(editor(page).locator('ol li')).toHaveText(LINE_SECOND)

    await toolbar_button(page, 'Checklist').click()

    await expect(editor(page).locator('ol')).toHaveCount(0)
    await expect(editor(page).locator('ul[data-type="taskList"] li p')).toHaveText(LINE_SECOND)

    await expect(editor(page).locator('ul[data-type="taskList"] input[type="checkbox"]'))
        .toHaveCount(1)

    await toolbar_button(page, 'Checklist').click()

    await expect(editor(page).locator('ul, ol')).toHaveCount(0)
})

test('quote, code block, and horizontal rule insert', async ({ page }) => {
    await notes_open(page)
    await editor(page).getByText(LINE_SECOND).click()
    await toolbar_button(page, 'Quote').click()

    await expect(editor(page).locator('blockquote')).toContainText(LINE_SECOND)

    await toolbar_button(page, 'Quote').click()

    await expect(editor(page).locator('blockquote')).toHaveCount(0)

    await toolbar_button(page, 'Code block').click()

    await expect(editor(page).locator('pre code')).toHaveText(LINE_SECOND)

    await toolbar_button(page, 'Code block').click()

    await expect(editor(page).locator('pre')).toHaveCount(0)

    await toolbar_button(page, 'Horizontal rule').click()

    await expect(editor(page).locator('hr')).toHaveCount(1)
})

test('Table inserts a 3 by 3 table and the table bar edits it', async ({ page }) => {
    await notes_open(page)
    await editor(page).getByText(LINE_SECOND).click()

    const bar = page.locator('.rich-editor-context-bar')

    await expect(bar).toBeHidden()

    await toolbar_button(page, 'Insert table').click()

    const table = editor(page).locator('table')

    await expect(table).toHaveCount(1)
    await expect(table.locator('tr')).toHaveCount(3)
    await expect(table.locator('th')).toHaveCount(3)
    await expect(bar).toBeVisible()
    await expect(bar).toContainText('Table')

    await bar.getByRole('button', { name: '+ Row below' }).click()

    await expect(table.locator('tr')).toHaveCount(4)

    await bar.getByRole('button', { name: '+ Column right' }).click()

    await expect(table.locator('tr').first().locator('th')).toHaveCount(4)

    await bar.getByRole('button', { name: 'Delete row' }).click()

    await expect(table.locator('tr')).toHaveCount(3)

    await bar.getByRole('button', { name: 'Close table tools' }).click()

    await expect(bar).toBeHidden()

    await toolbar_button(page, 'Show table tools').click()

    await expect(bar).toBeVisible()

    await bar.getByRole('button', { name: 'Delete table' }).click()

    await expect(table).toHaveCount(0)
    await expect(bar).toBeHidden()
})

test('undo and redo through the keyboard', async ({ page }) => {
    await recording_open(page, RECORDING_TITLED)
    await editor(page).getByText('Chunked upload stays capped').click()
    await page.keyboard.press('End')
    await page.keyboard.type(' Typed epsilon.')

    await expect(editor(page)).toContainText('[2:05] Typed epsilon.')

    await page.keyboard.press('Control+z')

    await expect(editor(page)).not.toContainText('Typed epsilon.')
    await expect(editor(page)).toContainText('Chunked upload stays capped at eight parallel')

    await page.keyboard.press('Control+Shift+z')

    await expect(editor(page)).toContainText('[2:05] Typed epsilon.')
})

test('source mode round-trips markdown', async ({ page }) => {
    await notes_open(page)
    await page.getByRole('button', { name: 'Markdown', exact: true }).click()

    const source = page.locator('.rich-editor-source')

    await expect(source).toHaveValue(MARKDOWN_SAMPLE)
    await expect(editor(page)).toBeHidden()
    await expect(toolbar_button(page, 'Bold (Ctrl+B)')).toBeDisabled()

    await source.fill('## Heading here\n\n- one\n- two\n\n**bold** text')
    await page.getByRole('button', { name: 'Rich editor' }).click()

    await expect(editor(page).locator('h2')).toHaveText('Heading here')
    await expect(editor(page).locator('li')).toHaveText(['one', 'two'])
    await expect(editor(page).locator('strong')).toHaveText('bold')

    await page.getByRole('button', { name: 'Markdown', exact: true }).click()

    await expect(source).toHaveValue(/^## Heading here\n\n- one\n- two\n\n\*\*bold\*\* text$/)
})

test('the word and character counts follow the content', async ({ page }) => {
    await notes_open(page)

    const stats = page.locator('.rich-editor-stats')

    await expect(stats).toContainText('4 words')
    await expect(stats).toContainText(/\d+ characters/)

    await editor(page).getByText(LINE_SECOND).click()
    await page.keyboard.press('End')
    await page.keyboard.type(' epsilon')

    await expect(stats).toContainText('5 words')
})

test('Fullscreen expands the editor and Exit restores it', async ({ page }) => {
    await notes_open(page)

    const root = page.locator('.rich-editor')

    await expect(root).toHaveAttribute('data-fullscreen', 'false')

    await toolbar_button(page, 'Fullscreen').click()

    await expect(root).toHaveAttribute('data-fullscreen', 'true')

    await toolbar_button(page, 'Exit fullscreen').click()

    await expect(root).toHaveAttribute('data-fullscreen', 'false')
})

test('the AI panel opens with the selection count and closes', async ({ page }) => {
    await notes_open(page)
    await editor_line_select(page, LINE_SECOND)

    const ai_button = toolbar_button(page, 'Rewrite the selected text with AI')

    await ai_button.click()

    await expect(ai_panel(page)).toBeVisible()
    await expect(ai_panel(page)).toContainText('AI rewrite')
    await expect(ai_panel(page)).toContainText('11 characters selected')
    await expect(ai_button).toHaveAttribute('aria-expanded', 'true')

    await ai_panel(page).getByRole('button', { name: 'Close AI panel' }).click()

    await expect(ai_panel(page)).toBeHidden()
    await expect(ai_button).toHaveAttribute('aria-expanded', 'false')
})

test(TITLE_SELECTION_COUNT, async ({ page }) => {
    await notes_open(page)
    await editor_line_select(page, LINE_SECOND)
    await toolbar_button(page, 'Rewrite the selected text with AI').click()

    await expect(ai_panel(page)).toContainText('11 characters selected')

    await editor(page).getByText(LINE_FIRST).click()

    await expect(ai_panel(page)).toContainText('Whole document')

    await editor_line_select(page, LINE_FIRST)

    await expect(ai_panel(page)).toContainText('10 characters selected')

    await page.locator('.notes-controls-toggle').click()

    await expect(ai_panel(page)).toContainText('Whole document')
    await expect(editor(page).locator('.selection-inactive')).toHaveCount(0)
})

test('a quick action rewrites only the selection', async ({ page }) => {
    await notes_open(page)
    await editor_line_select(page, LINE_SECOND)
    await toolbar_button(page, 'Rewrite the selected text with AI').click()
    await ai_panel(page).getByRole('button', { name: 'Rewrite', exact: true }).click()

    await expect(editor(page))
        .toContainText(LINE_SECOND.toUpperCase(), { timeout: STREAM_TIMEOUT_MS })

    await expect(editor(page)).toContainText(LINE_FIRST)
    await expect(editor(page).locator('p')).toHaveText([LINE_FIRST, LINE_SECOND.toUpperCase()])
})

test('a custom instruction rewrites only the selection', async ({ page }) => {
    await notes_open(page)
    await editor_line_select(page, LINE_FIRST)
    await toolbar_button(page, 'Rewrite the selected text with AI').click()

    const apply = ai_panel(page).getByRole('button', { name: 'Apply' })

    await expect(apply).toBeDisabled()

    await ai_input(page).fill('shout it')

    await expect(apply).toBeEnabled()

    await apply.click()

    await expect(editor(page))
        .toContainText(LINE_FIRST.toUpperCase(), { timeout: STREAM_TIMEOUT_MS })

    await expect(editor(page).locator('p')).toHaveText([LINE_FIRST.toUpperCase(), LINE_SECOND])
})

test('with no selection the AI rewrites the whole document', async ({ page }) => {
    await notes_open(page)
    await editor(page).getByText(LINE_FIRST).click()
    await page.keyboard.press('End')
    await toolbar_button(page, 'Rewrite the whole document with AI').click()

    await expect(ai_panel(page)).toContainText('Whole document')

    await ai_input(page).fill('shout it')
    await ai_input(page).press('Enter')

    await expect(editor(page).locator('p')).toHaveText(
        [LINE_FIRST.toUpperCase(), LINE_SECOND.toUpperCase()],
        { timeout: STREAM_TIMEOUT_MS },
    )
})

test('the selection stays highlighted while the AI input has focus', async ({ page }) => {
    await notes_open(page)
    await editor_line_select(page, LINE_SECOND)
    await toolbar_button(page, 'Rewrite the selected text with AI').click()

    await expect(editor(page).locator('.selection-inactive')).toHaveCount(0)

    await ai_input(page).click()

    await expect(editor(page).locator('.selection-inactive')).toHaveText(LINE_SECOND)

    await ai_input(page).fill('shout it')
    await ai_input(page).press('Enter')

    await expect(editor(page).locator('p')).toHaveText(
        [LINE_FIRST, LINE_SECOND.toUpperCase()],
        { timeout: STREAM_TIMEOUT_MS },
    )
})

test('Export as Markdown saves through the dialog and offers the file', async ({ page }) => {
    await notes_open(page)
    await page.getByRole('button', { name: 'Export' }).click()
    await page.getByRole('menuitem', { name: 'Markdown' }).click()

    const exported = dialog(page, 'Notes exported')

    await expect(exported)
        .toContainText(`The notes were exported to ${EXPORT_PATH}. Open the file now?`)

    await exported.getByRole('button', { name: 'Cancel' }).click()

    await expect(exported).toBeHidden()
    await expect(page.getByRole('button', { name: 'Export' })).toBeEnabled()
})

test('Export as Word saves through the dialog and can open the file', async ({ page }) => {
    await notes_open(page)
    await page.getByRole('button', { name: 'Export' }).click()

    await expect(page.getByRole('menu')).toBeVisible()

    await page.getByRole('menuitem', { name: 'Word' }).click()

    const exported = dialog(page, 'Notes exported')

    await expect(exported).toContainText(EXPORT_PATH)

    await exported.getByRole('button', { name: 'OK' }).click()

    await expect(exported).toBeHidden()
    await expect(page.getByRole('menu')).toBeHidden()
})

test('Export as PDF prints the notes', async ({ page }) => {
    await notes_open(page)

    await page.evaluate(PRINT_STUB)

    await page.getByRole('button', { name: 'Export' }).click()
    await page.getByRole('menuitem', { name: 'PDF' }).click()

    await expect(page.locator('body')).toHaveAttribute('data-printed', 'true')
})

test('the Transcript toggle shows the transcript beside the notes', async ({ page }) => {
    await recording_open(page, RECORDING_TITLED)

    const toggle = page.locator('.notes-controls-toggle')
    const split = page.locator('.notes-split')

    await expect(toggle).toHaveAttribute('data-active', 'false')
    await expect(split).toHaveAttribute('data-side-by-side', 'false')
    await expect(page.locator('.transcript-pane')).toBeHidden()

    await toggle.click()

    await expect(toggle).toHaveAttribute('data-active', 'true')
    await expect(split).toHaveAttribute('data-side-by-side', 'true')
    await expect(transcript_rows(page)).toHaveCount(8)

    await toggle.click()

    await expect(page.locator('.transcript-pane')).toBeHidden()
})

test('Done saves the edits and reopening shows them', async ({ page }) => {
    await notes_open(page)
    await page.getByRole('button', { name: 'Done' }).click()

    await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible()

    await recording_open(page, RECORDING_TITLED)

    await expect(editor(page).locator('p')).toHaveText([LINE_FIRST, LINE_SECOND])
})

test('Done returns home and Back returns to Meeting', async ({ page }) => {
    await recording_open(page, RECORDING_TITLED)
    await page.getByRole('button', { name: 'Back' }).click()

    await expect(step_current(page)).toHaveText('Meeting')

    await page.getByRole('button', { name: 'Next' }).click()
    await page.getByRole('button', { name: 'Done' }).click()

    await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible()
})
