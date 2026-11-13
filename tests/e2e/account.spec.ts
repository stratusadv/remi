import { expect, test } from '@playwright/test'
import { assert } from '../../src/lib/assert'
import {
    STREAM_TIMEOUT_MS,
    dialog,
    nav_to,
    setting,
    step_current,
    transcript_rows,
} from './helpers'
import type { Locator, Page } from '@playwright/test'


const BALANCE_LINE_SIGNED_IN = '250 hours of transcription left'
const BILLING_EMPTY = '/?billing=empty'
const BILLING_SIGNED_IN = '/?billing=signed-in'
const BILLING_SIGNED_OUT = '/?billing=signed-out'
const LABEL_SIGN_IN_CODE = 'Sign-in code'
const PLACEHOLDER_PROMO = 'Enter a promo code'

const MESSAGE_BALANCE = 'This recording needs 3 minutes of transcription and the account has '
    + '0 minutes left. Buy more hours to transcribe it.'

const STRIPE_STANDIN = `
window.Stripe = function () {
    return {
        createPaymentMethod: function () {
            return Promise.resolve({ paymentMethod: { id: 'pm_standin' } })
        },
        initCheckoutElementsSdk: function () {
            var handlers = {}
            var total = { amount: '$10.00', minorUnitsAmount: 1000 }
            var session = {
                currency: 'cad',
                email: 'avery@example.com',
                minorUnitsAmountDivisor: 100,
                total: { total: total },
            }

            var actions = {
                confirm: function () { return Promise.resolve({ type: 'success', session }) },
                getSession: function () { return session },
            }

            var element = {
                destroy: function () {},
                mount: function (host) {
                    host.innerHTML = '<input aria-label="Card number" value="4242 4242 4242 4242">'
                    setTimeout(function () { handlers.ready({ elementType: 'payment' }) }, 0)
                },
                on: function (event, handler) { handlers[event] = handler; return element },
            }

            return {
                changeAppearance: function () {},
                createPaymentElement: function () { return element },
                loadActions: function () { return Promise.resolve({ type: 'success', actions }) },
            }
        },
    }
}

window.Stripe.version = 'endive'
`

const STRIPE_STANDIN_HEADERS = Object.freeze({ 'content-type': 'application/javascript' })

const TITLE_BUY = 'the buy hours page pays for the pack chosen and lets the account buy again'
const TITLE_CHARGE = 'a transcription takes its started seconds from the balance the sidebar shows'


async function account_tab_open(page: Page): Promise<void> {
    assert(!page.isClosed())
    assert(page.url().includes('billing='))

    await nav_to(page, 'Settings')
    await page.getByRole('tab', { name: 'Account' }).click()
}

async function billing_open(page: Page, path: string): Promise<void> {
    assert(!page.isClosed())
    assert(path.startsWith('/?billing='))

    await page.goto(path)
    await expect(page.locator('.app-shell[data-ready="true"]')).toBeVisible()
}

function sidebar_balance(page: Page): Locator {
    assert(!page.isClosed())
    assert(page.url().includes('billing='))

    return page.locator('.sidebar-balance-text')
}

async function stripe_standin_route(page: Page): Promise<void> {
    assert(!page.isClosed())
    assert(STRIPE_STANDIN.includes('initCheckoutElementsSdk'))

    await page.route('https://js.stripe.com/**', async (route) => {
        await route.fulfill({ body: STRIPE_STANDIN, headers: STRIPE_STANDIN_HEADERS })
    })
}

async function transcribe_picked(page: Page): Promise<void> {
    assert(!page.isClosed())
    assert(page.url().includes('billing='))

    await page.getByRole('button', { name: 'New recording' }).first().click()
    await expect(step_current(page)).toHaveText('Transcript')
    await page.getByRole('button', { name: 'Open or drop a recording' }).click()
    await page.getByRole('button', { name: 'Transcribe' }).click()
}

test('a copy with no account signs up and is credited its promo code', async ({ page }) => {
    await billing_open(page, BILLING_SIGNED_OUT)

    await expect(page.getByRole('heading', { name: 'Welcome to remi' })).toBeVisible()
    await expect(page.locator('aside')).toHaveCount(0)

    await page.getByLabel('Name', { exact: true }).fill('Avery Quinn')
    await page.getByLabel('Email', { exact: true }).fill('avery@example.com')
    await page.getByLabel('Promo code (optional)').fill(' wib2026 ')
    await page.getByRole('button', { name: 'Get started' }).click()

    await expect(sidebar_balance(page)).toHaveText('250 hours left')
    await expect(page.getByRole('heading', { name: 'Welcome to remi' })).toHaveCount(0)
})

test('a sign-in code from another computer signs the copy in', async ({ page }) => {
    await billing_open(page, BILLING_SIGNED_OUT)
    await page.getByRole('button', { name: 'Have a sign-in code?' }).click()

    const code = page.getByLabel(LABEL_SIGN_IN_CODE, { exact: true })
    const proceed = page.getByRole('button', { name: 'Sign in', exact: true })

    await code.fill('not-the-code')
    await proceed.click()

    await expect(page.getByRole('alert')).toHaveText('That sign-in code is not valid.')
    await expect(page.locator('aside')).toHaveCount(0)

    await code.fill('mock-sign-in-code')
    await proceed.click()

    await expect(sidebar_balance(page)).toHaveText('250 hours left')
})

test('the account tab refuses a promo code this email already redeemed', async ({ page }) => {
    await billing_open(page, BILLING_SIGNED_IN)
    await account_tab_open(page)

    const promo = setting(page, 'Promo code')

    await promo.getByPlaceholder(PLACEHOLDER_PROMO).fill('wib2026')
    await promo.getByRole('button', { name: 'Redeem' }).click()

    await expect(promo.getByRole('alert')).toHaveText(
        'That promo code was already redeemed with this email address.',
    )

    await expect(page.getByText(BALANCE_LINE_SIGNED_IN)).toBeVisible()
    await expect(sidebar_balance(page)).toHaveText('250 hours left')
})

test(TITLE_BUY, async ({ page }) => {
    await stripe_standin_route(page)
    await billing_open(page, BILLING_SIGNED_IN)
    await page.getByRole('button', { name: 'Buy hours', exact: true }).click()

    await expect(page.getByRole('heading', { name: 'Buy hours' })).toBeVisible()
    await expect(page.getByText(BALANCE_LINE_SIGNED_IN)).toBeVisible()
    await expect(page.locator('.offer')).toHaveCount(3)
    await expect(page.locator('.offer[data-best="true"]')).toContainText('Best value')
    await expect(page.locator('.offer[data-best="true"]')).toContainText('Save 50%')

    await page.getByRole('button', { name: 'Buy 50 hours' }).click()

    await expect(page.getByLabel('Card number')).toBeVisible()
    await expect(page.locator('.checkout-order')).toContainText('300 hours')

    await page.getByRole('button', { name: 'Pay $10.00' }).click()

    await expect(page.getByText('You now have 300 hours of transcription.')).toBeVisible()
    await expect(page.getByText('300 hours of transcription left')).toBeVisible()
    await expect(sidebar_balance(page)).toHaveText('300 hours left')

    await page.getByRole('button', { name: 'Buy more hours' }).click()
    await page.getByRole('button', { name: 'Buy 200 hours' }).click()

    await expect(page.locator('.checkout-order')).toContainText('$30.00')
    await expect(page.locator('.checkout-order')).toContainText('500 hours')

    await page.getByRole('button', { name: 'All packs' }).click()
    await page.getByRole('button', { name: 'Buy 50 hours' }).click()

    await expect(page.getByLabel('Card number')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Pay $10.00' })).toBeEnabled()
})

test('a test card pays the open checkout in one click', async ({ page }) => {
    await stripe_standin_route(page)
    await billing_open(page, BILLING_SIGNED_IN)
    await page.getByRole('button', { name: 'Buy hours', exact: true }).click()
    await page.getByRole('button', { name: 'Buy 50 hours' }).click()

    const test_cards = page.locator('.checkout-test')

    await expect(test_cards).toContainText('Nothing real is charged.')

    await test_cards.getByRole('button', { name: 'Succeeds (4242)' }).click()

    await expect(page.getByText('You now have 300 hours of transcription.')).toBeVisible()
    await expect(sidebar_balance(page)).toHaveText('300 hours left')
})

test('the account tab sends a purchase to the buy hours page', async ({ page }) => {
    await stripe_standin_route(page)
    await billing_open(page, BILLING_SIGNED_IN)
    await account_tab_open(page)
    await setting(page, 'Balance').getByRole('button', { name: 'Buy hours' }).click()

    await expect(page.getByRole('heading', { name: 'Buy hours' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Buy 50 hours' })).toBeEnabled()
})

test(TITLE_CHARGE, async ({ page }) => {
    await billing_open(page, BILLING_SIGNED_IN)
    await transcribe_picked(page)

    await expect(transcript_rows(page)).toHaveCount(8, { timeout: STREAM_TIMEOUT_MS })
    await expect(sidebar_balance(page)).toHaveText('249.9 hours left')
})

test('a recording longer than the balance is refused with the time it needs', async ({ page }) => {
    await billing_open(page, BILLING_EMPTY)

    await expect(sidebar_balance(page)).toHaveText('0 minutes left')

    await transcribe_picked(page)

    await expect(dialog(page, 'The server rejected the request')).toContainText(MESSAGE_BALANCE)
    await expect(transcript_rows(page)).toHaveCount(0)
    await expect(sidebar_balance(page)).toHaveText('0 minutes left')
})
