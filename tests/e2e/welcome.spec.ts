import { expect, test } from '@playwright/test'


const CREDIT = 'Powered by Stratus Advanced Technologies'
const TITLE_CREDIT = 'the welcome screen credits Stratus with a link that opens in the browser'


test(TITLE_CREDIT, async ({ page }) => {
    await page.goto('/?billing=signed-out')

    const credit = page.getByRole('link', { name: CREDIT })

    await expect(credit).toHaveAttribute('href', 'https://stratusadv.com')
    await expect(credit).toHaveAttribute('target', '_blank')
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
