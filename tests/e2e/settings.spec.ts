import { expect, test } from '@playwright/test'
import {
    HAS_TEXT,
    actions_reported,
    actions_watch,
    app_open,
    command_count,
    command_watch,
    nav_to,
    setting,
} from './helpers'


const RECORDINGS_DIRECTORY_DEFAULT = 'C:\\Users\\mock\\Music\\remi'
const RECORDINGS_DIRECTORY_PICKED = '/home/you/Music/meetings'
const CREDIT = 'Powered by Stratus Advanced Technologies'


test.beforeEach(async ({ page }) => {
    await app_open(page)
    await nav_to(page, 'Settings')
})

test('the mode select updates the html class', async ({ page }) => {
    const mode = page.getByLabel('Mode', { exact: true })
    const html = page.locator('html')

    await expect(mode).toHaveValue('dark')
    await expect(html).toHaveClass(/mode-dark/u)

    await mode.selectOption('light')

    await expect(html).toHaveClass(/mode-light/u)
    await expect(html).not.toHaveClass(/mode-dark/u)

    await mode.selectOption('dark')

    await expect(html).toHaveClass(/mode-dark/u)
    await expect(html).not.toHaveClass(/mode-light/u)

    await mode.selectOption('system')

    await expect(mode).toHaveValue('system')
    await expect(html).toHaveClass(/mode-(?:light|dark)/u)
})

test('the colour scheme select updates data-palette', async ({ page }) => {
    const palette = page.getByLabel('Colour scheme', { exact: true })
    const html = page.locator('html')

    await expect(html).toHaveAttribute('data-palette', 'cubist')
    await expect(palette).toHaveValue('cubist')

    await palette.selectOption('nord')

    await expect(html).toHaveAttribute('data-palette', 'nord')
    await expect(palette).toHaveValue('nord')

    await palette.selectOption({ label: 'Dracula' })

    await expect(html).toHaveAttribute('data-palette', 'dracula')
})

test('the theme select switches to Standard and its Graphite colour scheme', async ({ page }) => {
    const theme = page.getByLabel('Theme', { exact: true })
    const palette = page.getByLabel('Colour scheme', { exact: true })
    const html = page.locator('html')

    await expect(theme).toHaveValue('cubism')
    await expect(html).toHaveAttribute('data-theme', 'cubism')

    await palette.selectOption('nord')
    await theme.selectOption({ label: 'Standard' })

    await expect(html).toHaveAttribute('data-theme', 'standard')
    await expect(html).toHaveAttribute('data-palette', 'graphite')
    await expect(palette).toHaveValue('graphite')
    await expect(theme).toHaveValue('standard')

    await theme.selectOption('cubism')

    await expect(html).toHaveAttribute('data-theme', 'cubism')
    await expect(html).toHaveAttribute('data-palette', 'cubist')
})

test('a theme change reports, and a mode or colour scheme change does not', async ({ page }) => {
    const html = page.locator('html')

    await actions_watch(page)
    await page.getByLabel('Mode', { exact: true }).selectOption('light')
    await page.getByLabel('Colour scheme', { exact: true }).selectOption('nord')

    await expect(html).toHaveClass(/mode-light/u)
    await expect(html).toHaveAttribute('data-palette', 'nord')

    const unreported = await actions_reported(page)
    const theme = page.getByLabel('Theme', { exact: true })

    expect(unreported).toEqual([])

    await theme.selectOption('standard')

    await expect(html).toHaveAttribute('data-theme', 'standard')

    await theme.selectOption('cubism')

    await expect(html).toHaveAttribute('data-theme', 'cubism')
    await expect.poll(async () => actions_reported(page)).toEqual(['change-theme', 'change-theme'])
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
    const url = page.url()

    await command_watch(page, 'desktop_website_open')
    await expect(credit).toHaveAttribute('href', 'https://stratusadv.com')
    await credit.click()

    await expect.poll(async () => command_count(page, 'desktop_website_open')).toBe(1)
    await expect(page).toHaveURL(url)
})

test('the General tab is the only tab without an account', async ({ page }) => {
    const general = page.getByRole('tab', { name: 'General' })

    await expect(page.getByRole('tab')).toHaveText(['General'])
    await expect(general).toHaveAttribute('aria-selected', 'true')
})
