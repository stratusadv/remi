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


interface CheckoutPanels {
    card_below: boolean
    card_left: boolean
    edges_aligned: boolean
}

const BALANCE_LINE_SIGNED_IN = '250 hours of transcription left'
const BILLING_EMPTY = '/?billing=empty'
const BILLING_SIGNED_IN = '/?billing=signed-in'
const BILLING_SIGNED_OUT = '/?billing=signed-out'
const LABEL_SIGN_IN_CODE = 'Sign-in code'
const PANELS_BESIDE = Object.freeze({ card_below: false, card_left: true, edges_aligned: true })
const PANELS_STACKED = Object.freeze({ card_below: true, card_left: false, edges_aligned: false })
const PLACEHOLDER_PROMO = 'Enter a promo code'
const THANKS_PAID = 'Your payment went through. You now have 260 hours of transcription.'
const VIEWPORT_SHORT = Object.freeze({ height: 800, width: 1280 })
const VIEWPORT_STACKED = Object.freeze({ height: 720, width: 1000 })
const VIEWPORT_TALL = Object.freeze({ height: 900, width: 1280 })

const MESSAGE_BALANCE = 'This recording needs 3 minutes of transcription and the account has '
    + '0 minutes left. Buy more hours to transcribe it.'

const POINTS = Object.freeze([
    '$1.00 per hour of transcription',
    'Unlimited notes and Ask questions for monthly active users',
    'One-time payment, no subscription',
])

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

const TITLE_BUY = 'the buy hours page pays for the hours typed and lets the account buy again'
const TITLE_CHARGE = 'a transcription takes its started seconds from the balance the sidebar shows'
const TITLE_PANELS = 'the hours card sits left of the points and below them when narrow'
const TITLE_PANELS_TALL = 'the hours card and the points grow with the height of the window'
const TITLE_SIGN_UP = 'a copy with no account signs up and is welcomed with its promo code applied'

const WELCOME_PROMO = 'Your promo code wib2026 has been applied. '
    + 'You have 250 hours of transcription to start.'


async function account_tab_open(page: Page): Promise<void> {
    assert(!page.isClosed())
    assert(page.url().includes('billing='))

    await nav_to(page, 'Settings')
    await page.getByRole('tab', { name: 'Account' }).click()
}

async function hours_buy(page: Page): Promise<void> {
    assert(!page.isClosed())
    assert(page.url().includes('billing='))

    await hours_card(page).getByRole('button', { name: 'Buy hours' }).click()
}

function hours_card(page: Page): Locator {
    assert(!page.isClosed())
    assert(page.url().includes('billing='))

    return page.locator('.hours-card')
}

async function billing_open(page: Page, path: string): Promise<void> {
    assert(!page.isClosed())
    assert(path.startsWith('/?billing='))

    await page.goto(path)
    await expect(page.locator('.app-shell[data-ready="true"]')).toBeVisible()
}

async function card_height(page: Page): Promise<number | null> {
    assert(!page.isClosed())
    assert(page.url().includes('billing='))

    return page.evaluate(() => {
        const card = document.querySelector('.hours-card')?.getBoundingClientRect()

        if (card === undefined) return null

        return Math.round(card.height)
    })
}

async function checkout_panels(page: Page): Promise<CheckoutPanels | null> {
    assert(!page.isClosed())
    assert(page.url().includes('billing='))

    return page.evaluate(() => {
        const card = document.querySelector('.hours-card')?.getBoundingClientRect()
        const header = document.querySelector('.checkout-header')?.getBoundingClientRect()

        if (card === undefined) return null
        if (header === undefined) return null

        const bottom_same = Math.abs(card.bottom - header.bottom) < 1
        const top_same = Math.abs(card.top - header.top) < 1

        return {
            card_below: card.top > header.bottom,
            card_left: card.right < header.left,
            edges_aligned: bottom_same && top_same,
        }
    })
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

test(TITLE_SIGN_UP, async ({ page }) => {
    await billing_open(page, BILLING_SIGNED_OUT)

    await expect(page.getByRole('heading', { name: 'Welcome to remi' })).toBeVisible()
    await expect(page.locator('aside')).toHaveCount(0)

    await page.getByLabel('Name', { exact: true }).fill('Avery Quinn')
    await page.getByLabel('Email', { exact: true }).fill('avery@example.com')
    await page.getByLabel('Promo code (optional)').fill(' wib2026 ')
    await expect(page.getByRole('button', { name: 'Get started' })).toBeDisabled()
    await page.getByLabel('Province or territory').selectOption({ label: 'Alberta' })
    await page.getByRole('button', { name: 'Get started' }).click()

    const welcome = dialog(page, 'Welcome to remi')

    await expect(welcome).toContainText(WELCOME_PROMO)
    await expect(sidebar_balance(page)).toHaveText('250 hours left')
    await expect(page.locator('.welcome')).toHaveCount(0)

    await welcome.getByRole('button', { name: 'OK' }).click()

    await expect(welcome).toHaveCount(0)
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

    const hours = hours_card(page).getByLabel('How many hours?')

    await expect(page.getByRole('heading', { name: 'Buy hours' })).toBeVisible()
    await expect(page.getByText(BALANCE_LINE_SIGNED_IN)).toBeVisible()
    await expect(page.locator('.checkout-points li')).toHaveText(POINTS)
    await expect(hours).toHaveValue('10')
    await expect(hours_card(page)).toContainText('260 hours')
    await expect(hours_card(page)).toContainText('$10.00')

    await hours_buy(page)

    const order = page.locator('.checkout-order')

    await expect(page.getByLabel('Card number')).toBeVisible()
    await expect(order).toContainText('260 hours')

    await page.getByRole('button', { name: 'Pay $10.00' }).click()

    const thanks = dialog(page, 'Thank you')

    await expect(thanks).toContainText(THANKS_PAID)
    await expect(sidebar_balance(page)).toHaveText('260 hours left')

    await thanks.getByRole('button', { name: 'OK' }).click()

    await expect(thanks).toHaveCount(0)
    await expect(page.getByText('260 hours of transcription left')).toBeVisible()

    await hours.fill('200')

    await expect(hours_card(page)).toContainText('460 hours')
    await expect(hours_card(page)).toContainText('$200.00')

    await hours_buy(page)

    await expect(order).toContainText('$200.00')
    await expect(order).toContainText('460 hours')

    await page.getByRole('button', { name: 'Change hours' }).click()

    await expect(hours).toHaveValue('200')

    await hours.fill('10')
    await hours_buy(page)

    await expect(page.getByLabel('Card number')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Pay $10.00' })).toBeEnabled()
})

test('the buy hours page refuses hours it does not sell', async ({ page }) => {
    await billing_open(page, BILLING_SIGNED_IN)
    await page.getByRole('button', { name: 'Buy hours', exact: true }).click()

    const buy = hours_card(page).getByRole('button', { name: 'Buy hours' })
    const hint = hours_card(page).locator('.hours-card-hint')
    const hours = hours_card(page).getByLabel('How many hours?')

    await expect(hint).toHaveText('Choose from 1 to 1000 hours.')
    await expect(hint).toHaveAttribute('data-invalid', 'false')

    await hours.fill('0')

    await expect(buy).toBeDisabled()
    await expect(hint).toHaveAttribute('data-invalid', 'true')

    await hours.fill('1001')

    await expect(buy).toBeDisabled()
    await expect(hint).toHaveAttribute('data-invalid', 'true')
    await expect(page.getByLabel('Card number')).toHaveCount(0)
})

test(TITLE_PANELS, async ({ page }) => {
    await billing_open(page, BILLING_SIGNED_IN)
    await page.getByRole('button', { name: 'Buy hours', exact: true }).click()

    await expect.poll(async () => checkout_panels(page)).toEqual(PANELS_BESIDE)

    await page.setViewportSize(VIEWPORT_STACKED)

    await expect.poll(async () => checkout_panels(page)).toEqual(PANELS_STACKED)
})

test(TITLE_PANELS_TALL, async ({ page }) => {
    await page.setViewportSize(VIEWPORT_SHORT)
    await billing_open(page, BILLING_SIGNED_IN)
    await page.getByRole('button', { name: 'Buy hours', exact: true }).click()

    await expect.poll(async () => checkout_panels(page)).toEqual(PANELS_BESIDE)

    const height_short = await card_height(page)

    assert(height_short !== null)

    const height_tall = height_short + VIEWPORT_TALL.height - VIEWPORT_SHORT.height

    await page.setViewportSize(VIEWPORT_TALL)

    await expect.poll(async () => card_height(page)).toBe(height_tall)
    await expect.poll(async () => checkout_panels(page)).toEqual(PANELS_BESIDE)
})

test('a test card pays the open checkout in one click', async ({ page }) => {
    await stripe_standin_route(page)
    await billing_open(page, BILLING_SIGNED_IN)
    await page.getByRole('button', { name: 'Buy hours', exact: true }).click()
    await hours_buy(page)

    const test_cards = page.locator('.checkout-test')

    await expect(test_cards).toContainText('Nothing real is charged.')

    await test_cards.getByRole('button', { name: 'Succeeds (4242)' }).click()

    await expect(dialog(page, 'Thank you')).toContainText(THANKS_PAID)
    await expect(sidebar_balance(page)).toHaveText('260 hours left')
})

test('the account tab sends a purchase to the buy hours page', async ({ page }) => {
    await stripe_standin_route(page)
    await billing_open(page, BILLING_SIGNED_IN)
    await account_tab_open(page)
    await setting(page, 'Balance').getByRole('button', { name: 'Buy hours' }).click()

    await expect(page.getByRole('heading', { name: 'Buy hours' })).toBeVisible()
    await expect(hours_card(page).getByRole('button', { name: 'Buy hours' })).toBeEnabled()
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
