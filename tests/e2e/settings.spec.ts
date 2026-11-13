import { expect, test } from '@playwright/test'
import { assert } from '../../src/lib/assert'
import { HAS_TEXT, app_open, nav_to, setting } from './helpers'
import type { Page } from '@playwright/test'


const RECORDINGS_DIRECTORY_DEFAULT = 'C:\\Users\\mock\\Music\\remi'
const RECORDINGS_DIRECTORY_PICKED = '/home/you/Music/meetings'
const API_HOST_BUILTIN = 'https://ai.example.invalid'
const CREDIT = 'Powered by Stratus Advanced Technologies'
const KEY_PLACEHOLDER = 'Paste your key'
const KEY_SEEDED = 'mock-key'
const SEARCH_MODEL_DEFAULT = 'stratus.embed'


async function ai_tab_open(page: Page): Promise<void> {
    assert(!page.isClosed())

    await page.getByRole('tab', { name: 'AI' }).click()
    await expect(page.getByRole('tab', { name: 'AI' })).toHaveAttribute('aria-selected', 'true')
}

async function field_leave(page: Page): Promise<void> {
    assert(!page.isClosed())
    assert(page.url().length > 0)

    await page.getByRole('heading', { name: 'Settings' }).click()
}

async function key_field_check(page: Page, label: string): Promise<void> {
    assert(!page.isClosed())
    assert(label.length > 0)

    const field = setting(page, label)
    const input = field.locator('input[type="password"]')

    await expect(input).toHaveValue(key_mask(KEY_SEEDED))
    await expect(field.getByRole('button', { name: 'Save' })).toHaveCount(0)
    await expect(field.getByRole('button', { name: 'Remove' })).toHaveCount(0)

    await input.fill('a-fresh-key')
    await field_leave(page)

    await expect(input).toHaveValue(key_mask('a-fresh-key'))

    await field.getByRole('button', { name: 'Clear' }).click()

    await expect(input).toHaveValue('')
    await expect(input).toBeFocused()

    await field_leave(page)

    await expect(input).toHaveValue('')
    await expect(input).toHaveAttribute('placeholder', KEY_PLACEHOLDER)

    await input.fill('yet-another-key')
    await input.press('Enter')

    await expect(input).toHaveValue(key_mask('yet-another-key'))
}

function key_mask(key: string): string {
    assert(key.length > 0)
    assert(!key.includes('•'))

    return '•'.repeat(key.length)
}

test.beforeEach(async ({ page }) => {
    await app_open(page)
    await nav_to(page, 'Settings')
})

test('the theme select updates the html class', async ({ page }) => {
    const theme = page.getByRole('combobox').filter({ [HAS_TEXT]: 'Match my computer' })
    const html = page.locator('html')

    await expect(theme).toHaveValue('dark')
    await expect(html).toHaveClass(/theme-dark/)

    await theme.selectOption('light')

    await expect(html).toHaveClass(/theme-light/)
    await expect(html).not.toHaveClass(/theme-dark/)

    await theme.selectOption('dark')

    await expect(html).toHaveClass(/theme-dark/)
    await expect(html).not.toHaveClass(/theme-light/)

    await theme.selectOption('system')

    await expect(theme).toHaveValue('system')
    await expect(html).toHaveClass(/theme-(light|dark)/)
})

test('the palette swatches update data-palette', async ({ page }) => {
    const html = page.locator('html')
    const cubist = page.getByRole('radio', { name: 'Cubist' })
    const nord = page.getByRole('radio', { name: 'Nord' })

    await expect(html).toHaveAttribute('data-palette', 'cubist')
    await expect(cubist).toHaveAttribute('aria-checked', 'true')

    await nord.click()

    await expect(html).toHaveAttribute('data-palette', 'nord')
    await expect(nord).toHaveAttribute('aria-checked', 'true')
    await expect(cubist).toHaveAttribute('aria-checked', 'false')

    await page.getByRole('radio', { name: 'Dracula' }).click()

    await expect(html).toHaveAttribute('data-palette', 'dracula')
})

test('the default template select feeds the Templates page', async ({ page }) => {
    const template = page.getByRole('combobox').filter({ [HAS_TEXT]: 'Ask each time' })

    await expect(template).toHaveValue('default-meeting-notes')

    await template.selectOption({ label: 'Stand-up digest' })

    await expect(template).toHaveValue('default-standup')

    await nav_to(page, 'Templates')

    const row = page.locator('li').filter({ [HAS_TEXT]: 'Stand-up digest' })
    const pill = row.locator('.pill-active')

    await expect(pill).toHaveText('Default')

    await nav_to(page, 'Settings')
    await template.selectOption({ label: 'Ask each time' })

    await expect(template).toHaveValue('')

    await nav_to(page, 'Templates')

    await expect(page.locator('.pill-active')).toHaveCount(0)

    await nav_to(page, 'Home')
    await page.locator('.recording-tile').filter({ [HAS_TEXT]: 'discovery-call.wav' }).click()

    await expect(page.getByLabel('Template').locator('option:checked'))
        .toHaveText('Choose a template')

    await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled()
})

test('the recordings folder can be chosen and reset', async ({ page }) => {
    const field = setting(page, 'Recordings')
    const path = field.getByRole('textbox')
    const reset = field.getByRole('button', { name: 'Use default' })

    await expect(path).toHaveValue(RECORDINGS_DIRECTORY_DEFAULT)
    await expect(reset).toHaveCount(0)

    await field.getByRole('button', { name: 'Choose folder' }).click()

    await expect(path).toHaveValue(RECORDINGS_DIRECTORY_PICKED)

    await reset.click()

    await expect(path).toHaveValue(RECORDINGS_DIRECTORY_DEFAULT)
    await expect(reset).toHaveCount(0)
})

test('About shows the version and checks for updates', async ({ page }) => {
    const about = setting(page, 'About')

    await expect(about).toContainText('remi 0.1.0-browser-mock')

    await about.getByRole('button', { name: 'Check for updates' }).click()

    await expect(about).toContainText('remi is up to date.')
})

test('About credits Stratus with a link that opens in the browser', async ({ page }) => {
    const credit = setting(page, 'About').getByRole('link', { name: CREDIT })

    await expect(credit).toHaveAttribute('href', 'https://stratusadv.com')
    await expect(credit).toHaveAttribute('target', '_blank')
})

test('the API address can be set and removed', async ({ page }) => {
    await ai_tab_open(page)

    const field = setting(page, 'API address')
    const input = field.getByRole('textbox')

    await expect(input).toHaveValue(API_HOST_BUILTIN)

    await input.fill('https://api.example.test')
    await input.press('Enter')

    await nav_to(page, 'Home')
    await nav_to(page, 'Settings')
    await ai_tab_open(page)

    await expect(input).toHaveValue('https://api.example.test')

    await field.getByRole('button', { name: 'Clear' }).click()
    await field_leave(page)

    await expect(input).toHaveValue(API_HOST_BUILTIN)
})

test('the transcription key can be set and removed', async ({ page }) => {
    await ai_tab_open(page)
    await key_field_check(page, 'Transcription key')
})

test('the notes key can be set and removed', async ({ page }) => {
    await ai_tab_open(page)
    await key_field_check(page, 'Notes key')
})

test('removing the notes key blocks note generation until it is back', async ({ page }) => {
    await ai_tab_open(page)

    const field = setting(page, 'Notes key')

    await field.getByRole('button', { name: 'Clear' }).click()
    await field_leave(page)

    await expect(field.locator('input[type="password"]')).toHaveValue('')

    await nav_to(page, 'Home')
    await page.locator('.recording-tile').filter({ [HAS_TEXT]: 'discovery-call.wav' }).click()
    await page.getByRole('button', { name: 'Next' }).click()

    await expect(page.getByText('remi needs the API address and keys set up')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Generate notes' })).toBeDisabled()
})

test('the notes model and thinking selects persist', async ({ page }) => {
    await ai_tab_open(page)

    const model = setting(page, 'Model').getByRole('combobox')
    const thinking = setting(page, 'Thinking').getByRole('combobox')

    await expect(model).toHaveValue('')
    await expect(model.locator('option').first()).toHaveText('Default (stratus.thinking)')
    await expect(model.locator('option')).toHaveCount(4)
    await expect(thinking).toHaveValue('')

    await model.selectOption('stratus.turbo')
    await thinking.selectOption('low')

    await nav_to(page, 'Home')
    await nav_to(page, 'Settings')
    await ai_tab_open(page)

    await expect(model).toHaveValue('stratus.turbo')
    await expect(thinking).toHaveValue('low')

    await model.selectOption('')
    await thinking.selectOption('xhigh')

    await expect(model).toHaveValue('')
    await expect(thinking).toHaveValue('xhigh')
})

test('the search model starts on the default and stays off once cleared', async ({ page }) => {
    await ai_tab_open(page)

    const model = setting(page, 'Search model').first()
    const address = setting(page, 'Search model address')
    const model_input = model.getByRole('textbox')
    const address_input = address.getByRole('textbox')

    await expect(model_input).toHaveValue(SEARCH_MODEL_DEFAULT)
    await expect(address_input).toHaveAttribute('placeholder', API_HOST_BUILTIN)
    await expect(model).toContainText(/Ask can search all \d+ passages by meaning\./)

    await model_input.fill('qwen3-embedding:0.6b')
    await model_input.press('Enter')

    await expect(model).toContainText(/Ask can search all \d+ passages by meaning\./)

    await address_input.fill('http://localhost:11434')
    await field_leave(page)

    await nav_to(page, 'Home')
    await nav_to(page, 'Settings')
    await ai_tab_open(page)

    await expect(model_input).toHaveValue('qwen3-embedding:0.6b')
    await expect(address_input).toHaveValue('http://localhost:11434')

    await model.getByRole('button', { name: 'Clear' }).click()
    await field_leave(page)

    await expect(model_input).toHaveValue('')
    await expect(model_input).toHaveAttribute('placeholder', 'Off')
    await expect(model).not.toContainText('by meaning')

    await nav_to(page, 'Home')
    await nav_to(page, 'Settings')
    await ai_tab_open(page)

    await expect(model_input).toHaveValue('')
    await expect(model).not.toContainText('by meaning')
})

test('the tabs switch between General and AI', async ({ page }) => {
    const general = page.getByRole('tab', { name: 'General' })

    await expect(general).toHaveAttribute('aria-selected', 'true')
    await expect(setting(page, 'Appearance')).toBeVisible()
    await expect(setting(page, 'API address')).toHaveCount(0)

    await ai_tab_open(page)

    await expect(setting(page, 'API address')).toBeVisible()
    await expect(setting(page, 'Appearance')).toHaveCount(0)

    await page.getByRole('tab', { name: 'General' }).click()

    await expect(setting(page, 'Appearance')).toBeVisible()
})
