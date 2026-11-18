import { expect, test } from '@playwright/test'
import { command_count, command_watch } from './helpers'


const CREDIT = 'Powered by Stratus Advanced Technologies'
const PRIVACY = 'Privacy policy'
const SIGNED_OUT = '/?billing=signed-out'
const TITLE_CREDIT = 'the welcome screen credits Stratus with a link that opens in the browser'
const TITLE_PRIVACY = 'the welcome screen links the privacy policy, which opens in the browser'
const TITLE_SHORT = 'a short screen keeps the sign-up form and its problem in view'
const VIEWPORT_SHORT = Object.freeze({ height: 640, width: 1280 })


test(TITLE_CREDIT, async ({ page }) => {
    await page.goto(SIGNED_OUT)
    await expect(page.getByRole('heading', { name: 'Welcome to remi' })).toBeVisible()
    await command_watch(page, 'desktop_website_open')

    const credit = page.getByRole('link', { name: CREDIT })

    await expect(credit).toHaveAttribute('href', 'https://stratusadv.com')
    await credit.click()

    await expect.poll(async () => command_count(page, 'desktop_website_open')).toBe(1)
    await expect(page).toHaveURL(SIGNED_OUT)
})

test(TITLE_PRIVACY, async ({ page }) => {
    await page.goto(SIGNED_OUT)
    await expect(page.getByRole('heading', { name: 'Welcome to remi' })).toBeVisible()
    await command_watch(page, 'desktop_privacy_open')
    await command_watch(page, 'desktop_website_open')

    const privacy = page.getByRole('link', { name: PRIVACY })

    await expect(privacy).toHaveAttribute('href', 'https://remirememberthat.com/privacy/')
    await privacy.click()

    await expect.poll(async () => command_count(page, 'desktop_privacy_open')).toBe(1)
    await expect.poll(async () => command_count(page, 'desktop_website_open')).toBe(0)
    await expect(page).toHaveURL(SIGNED_OUT)
})

test(TITLE_SHORT, async ({ page }) => {
    await page.setViewportSize(VIEWPORT_SHORT)
    await page.goto(SIGNED_OUT)

    const proceed = page.getByRole('button', { name: 'Get started' })
    const sign_in = page.getByRole('button', { name: 'Have a sign-in code?' })

    await expect(proceed).toBeInViewport({ ratio: 1 })
    await expect(sign_in).toBeInViewport({ ratio: 1 })

    await page.getByLabel('Name', { exact: true }).fill('Avery Quinn')
    await page.getByLabel('Email', { exact: true }).fill('avery@example.com')
    await page.getByLabel('Province or territory').selectOption({ label: 'Alberta' })
    await page.getByLabel('Promo code (optional)').fill('wib2062')
    await proceed.click()

    await expect(page.getByRole('alert')).toHaveText('That promo code is not valid.')
    await expect(page.getByRole('alert')).toBeInViewport({ ratio: 1 })
})

test('a signed-in copy never shows the welcome screen', async ({ page }) => {
    await page.goto('/?billing=signed-in')

    await expect(page.locator('.app-shell[data-ready="true"]')).toBeVisible()
    await expect(page.locator('aside')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Welcome to remi' })).toHaveCount(0)
})

test('a copy built without an account server never shows the welcome screen', async ({ page }) => {
    await page.goto('/')

    await expect(page.locator('.app-shell[data-ready="true"]')).toBeVisible()
    await expect(page.locator('aside')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Welcome to remi' })).toHaveCount(0)
})
