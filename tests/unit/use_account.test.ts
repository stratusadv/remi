import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    offer_cards,
    offer_hours,
    offer_price,
    use_account,
} from '../../src/composables/use_account'
import { assert } from '../../src/lib/assert'
import { MESSAGE_UNSHOWN } from '../../src/lib/errors'
import { ipc } from '../../src/lib/ipc'
import { WRITE_TEXT, deferred_new } from './fixtures'
import type { Account, AccountOffer, AccountSignUp } from '../../src/types'


vi.mock('../../src/lib/ipc')

const CHECKOUT_SESSION_ID = 'cs_test_a1B2c3'
const MESSAGE_ASSERTION = 'an assertion failed'
const SIGN_IN_CODE = 'k3Yq_9-wR'

const OFFERS = Object.freeze<AccountOffer[]>([
    { currency: 'cad', hours: 10, price_cents: 300 },
    { currency: 'cad', hours: 50, price_cents: 1000 },
    { currency: 'cad', hours: 200, price_cents: 3000 },
])

const ACCOUNT_SAMPLE = Object.freeze<Account>({
    balance_seconds: 5400,
    email: 'avery@example.com',
    name: 'Avery',
    offers: [...OFFERS],
    payments: true,
    publishable_key: 'pk_test_51Hscribe',
})

const SIGN_UP = Object.freeze<AccountSignUp>({
    email: 'avery@example.com',
    name: 'Avery',
    promo_code: 'WIB2026',
    region: 'CA-AB',
})

const account_state = use_account()

function account_with(balance_seconds: number): Account {
    assert(Number.isSafeInteger(balance_seconds))
    assert(ACCOUNT_SAMPLE.offers.every((offer, index) => offer === OFFERS[index]))

    return { ...ACCOUNT_SAMPLE, balance_seconds }
}

beforeEach(() => {
    vi.resetAllMocks()
    account_state.account.value = null
    account_state.error_message.value = null
    account_state.status.value = { billing: false, signed_in: false }
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('status_load', () => {
    it('drops the account when the build bills but holds no sign-in', async () => {
        account_state.account.value = account_with(60)
        vi.mocked(ipc.account_status).mockResolvedValue({ billing: true, signed_in: false })

        await account_state.status_load()

        expect(account_state.status.value).toEqual({ billing: true, signed_in: false })
        expect(account_state.account.value).toBeNull()
        expect(account_state.sign_up_needed.value).toBe(true)
    })

    it('records an unreachable backend without rejecting, so the app still mounts', async () => {
        const refused = new Error('api error: The account server is down.')

        vi.mocked(ipc.account_status).mockRejectedValue(refused)

        await expect(account_state.status_load()).resolves.toBeUndefined()

        expect(account_state.error_message.value).toBe('The account server is down.')
        expect(account_state.status.value).toEqual({ billing: false, signed_in: false })
    })

    it('refuses a status that claims a sign-in on a build without billing', async () => {
        vi.mocked(ipc.account_status).mockResolvedValue({ billing: false, signed_in: true })

        await expect(account_state.status_load()).rejects.toThrow(MESSAGE_ASSERTION)

        expect(account_state.status.value).toEqual({ billing: false, signed_in: false })
    })
})

describe('refresh', () => {
    it('reloads the status and starts the account read without waiting for it', async () => {
        const read = deferred_new<Account | null>()

        vi.mocked(ipc.account_status).mockResolvedValue({ billing: true, signed_in: true })
        vi.mocked(ipc.account_get).mockReturnValue(read.promise)

        await account_state.refresh()

        expect(account_state.status.value).toEqual({ billing: true, signed_in: true })
        expect(ipc.account_get).toHaveBeenCalledTimes(1)
        expect(account_state.account.value).toBeNull()

        read.resolve(account_with(5400))
        await read.promise

        expect(account_state.account.value).toEqual(account_with(5400))
    })

    it('reads no account when the reloaded status is signed out', async () => {
        vi.mocked(ipc.account_status).mockResolvedValue({ billing: true, signed_in: false })

        await account_state.refresh()

        expect(account_state.sign_up_needed.value).toBe(true)
        expect(ipc.account_get).not.toHaveBeenCalled()
    })
})

describe('account_load', () => {
    it('asks for nothing while the copy is signed out', async () => {
        account_state.status.value = { billing: true, signed_in: false }

        await account_state.account_load()

        expect(ipc.account_get).not.toHaveBeenCalled()
        expect(account_state.account.value).toBeNull()
    })

    it('shows the balance in tenths of an hour', async () => {
        account_state.status.value = { billing: true, signed_in: true }
        vi.mocked(ipc.account_get).mockResolvedValue(account_with(5400))

        await account_state.account_load()

        expect(account_state.balance_text.value).toBe('1.5 hours')
        expect(account_state.account.value?.offers).toHaveLength(3)
        expect(account_state.error_message.value).toBeNull()
    })

    it('refuses an account carrying a secret key in place of the publishable key', async () => {
        const leaked = { ...account_with(5400), publishable_key: 'sk_test_51Hscribe' }

        account_state.status.value = { billing: true, signed_in: true }
        vi.mocked(ipc.account_get).mockResolvedValue(leaked)

        await expect(account_state.account_load()).resolves.toBeUndefined()

        expect(account_state.account.value).toBeNull()
        expect(account_state.error_message.value).toBe(MESSAGE_UNSHOWN)
    })

    it('signs the copy out when the server refuses its token', async () => {
        account_state.status.value = { billing: true, signed_in: true }
        account_state.account.value = account_with(60)
        vi.mocked(ipc.account_get).mockResolvedValue(null)

        await account_state.account_load()

        expect(account_state.account.value).toBeNull()
        expect(account_state.status.value).toEqual({ billing: true, signed_in: false })
        expect(account_state.sign_up_needed.value).toBe(true)
    })

    it('refuses an account whose balance fell below zero', async () => {
        account_state.status.value = { billing: true, signed_in: true }
        vi.mocked(ipc.account_get).mockResolvedValue(account_with(-1))

        await expect(account_state.account_load()).resolves.toBeUndefined()

        expect(account_state.account.value).toBeNull()
        expect(account_state.error_message.value).toBe(MESSAGE_UNSHOWN)
    })

    it('records a failed read and keeps the account it had', async () => {
        account_state.status.value = { billing: true, signed_in: true }
        account_state.account.value = account_with(60)
        vi.mocked(ipc.account_get).mockRejectedValue(new Error('network error: offline'))

        await account_state.account_load()

        expect(account_state.account.value).toEqual(account_with(60))
        expect(account_state.error_message.value).not.toBeNull()
    })
})

describe('a status change during a request', () => {
    it('discards an account read that lands after the build stopped billing', async () => {
        const read = deferred_new<Account | null>()

        account_state.status.value = { billing: true, signed_in: true }
        vi.mocked(ipc.account_get).mockReturnValue(read.promise)
        vi.mocked(ipc.account_status).mockResolvedValue({ billing: false, signed_in: false })

        const loading = account_state.account_load()

        await account_state.status_load()
        read.resolve(account_with(5400))

        await expect(loading).resolves.toBeUndefined()

        expect(account_state.status.value).toEqual({ billing: false, signed_in: false })
        expect(account_state.account.value).toBeNull()
        expect(account_state.error_message.value).toBeNull()
    })

    it('discards an account read that lands after the copy was signed out', async () => {
        const read = deferred_new<Account | null>()

        account_state.status.value = { billing: true, signed_in: true }
        vi.mocked(ipc.account_get).mockReturnValue(read.promise)
        vi.mocked(ipc.account_status).mockResolvedValue({ billing: true, signed_in: false })

        const loading = account_state.account_load()

        await account_state.status_load()
        read.resolve(account_with(5400))

        await expect(loading).resolves.toBeUndefined()

        expect(account_state.status.value).toEqual({ billing: true, signed_in: false })
        expect(account_state.account.value).toBeNull()
        expect(account_state.sign_up_needed.value).toBe(true)
    })

    it('discards a sign-in that lands after the build stopped billing', async () => {
        const signed_in = deferred_new<Account>()

        account_state.status.value = { billing: true, signed_in: false }
        vi.mocked(ipc.account_sign_in).mockReturnValue(signed_in.promise)
        vi.mocked(ipc.account_status).mockResolvedValue({ billing: false, signed_in: false })

        const signing_in = account_state.sign_in(SIGN_IN_CODE)

        await account_state.status_load()
        signed_in.resolve(account_with(5400))

        await expect(signing_in).resolves.toBeUndefined()

        expect(account_state.status.value).toEqual({ billing: false, signed_in: false })
        expect(account_state.account.value).toBeNull()
    })
})

describe('an account read that a write overtakes', () => {
    it('keeps a promo redeemed while an older read was in flight', async () => {
        const read = deferred_new<Account | null>()

        account_state.status.value = { billing: true, signed_in: true }
        account_state.account.value = account_with(5400)
        vi.mocked(ipc.account_get).mockReturnValue(read.promise)
        vi.mocked(ipc.account_promo_redeem).mockResolvedValue(account_with(905_400))

        const loading = account_state.account_load()

        await account_state.promo_redeem('WIB2026')
        read.resolve(account_with(5400))
        await loading

        expect(account_state.account.value).toEqual(account_with(905_400))
        expect(account_state.balance_text.value).toBe('251.5 hours')
    })

    it('drops the failure of a read that a promo overtook', async () => {
        const gate = deferred_new<undefined>()

        const failing = gate.promise.then(() => {
            throw new Error('network error: offline')
        })

        account_state.status.value = { billing: true, signed_in: true }
        account_state.account.value = account_with(5400)
        vi.mocked(ipc.account_get).mockReturnValue(failing)
        vi.mocked(ipc.account_promo_redeem).mockResolvedValue(account_with(905_400))

        const loading = account_state.account_load()

        await account_state.promo_redeem('WIB2026')
        gate.resolve(undefined)
        await loading

        expect(account_state.error_message.value).toBeNull()
        expect(account_state.account.value).toEqual(account_with(905_400))
    })
})

describe('two account reads in flight', () => {
    it('keeps the newer of two reads when the older one lands last', async () => {
        const older = deferred_new<Account | null>()
        const newer = deferred_new<Account | null>()

        account_state.status.value = { billing: true, signed_in: true }
        vi.mocked(ipc.account_get).mockReturnValueOnce(older.promise)
        vi.mocked(ipc.account_get).mockReturnValueOnce(newer.promise)

        const loading = Promise.all([account_state.account_load(), account_state.account_load()])

        newer.resolve(account_with(3600))
        await newer.promise
        older.resolve(account_with(5400))
        await loading

        expect(account_state.account.value).toEqual(account_with(3600))
    })

    it('keeps the newer of two reads when the older one lands first', async () => {
        const older = deferred_new<Account | null>()
        const newer = deferred_new<Account | null>()

        account_state.status.value = { billing: true, signed_in: true }
        vi.mocked(ipc.account_get).mockReturnValueOnce(older.promise)
        vi.mocked(ipc.account_get).mockReturnValueOnce(newer.promise)

        const loading = Promise.all([account_state.account_load(), account_state.account_load()])

        older.resolve(account_with(5400))
        await older.promise
        newer.resolve(account_with(3600))
        await loading

        expect(account_state.account.value).toEqual(account_with(3600))
    })
})

describe('create, sign_in, and promo_redeem', () => {
    it('signs the copy in with the account a sign-up creates', async () => {
        account_state.status.value = { billing: true, signed_in: false }
        vi.mocked(ipc.account_create).mockResolvedValue(account_with(900_000))

        await account_state.create(SIGN_UP)

        expect(ipc.account_create).toHaveBeenCalledWith(SIGN_UP)
        expect(account_state.status.value).toEqual({ billing: true, signed_in: true })
        expect(account_state.sign_up_needed.value).toBe(false)
        expect(account_state.balance_text.value).toBe('250 hours')
    })

    it('sends a sign-in code without the space around it', async () => {
        account_state.status.value = { billing: true, signed_in: false }
        vi.mocked(ipc.account_sign_in).mockResolvedValue(account_with(0))

        await account_state.sign_in(`  ${SIGN_IN_CODE}\n`)

        expect(ipc.account_sign_in).toHaveBeenCalledWith(SIGN_IN_CODE)
        expect(account_state.status.value.signed_in).toBe(true)
        expect(account_state.balance_text.value).toBe('0 minutes')
    })

    it('refuses a sign-up or a sign-in on a build without billing and sends nothing', async () => {
        await expect(account_state.create(SIGN_UP)).rejects.toThrow(MESSAGE_ASSERTION)
        await expect(account_state.sign_in(SIGN_IN_CODE)).rejects.toThrow(MESSAGE_ASSERTION)

        expect(ipc.account_create).not.toHaveBeenCalled()
        expect(ipc.account_sign_in).not.toHaveBeenCalled()
    })

    it('refuses a sign-up without a province or state it knows and sends nothing', async () => {
        const sign_up_blank = { ...SIGN_UP, region: '' }
        const sign_up_unknown = { ...SIGN_UP, region: 'CA-XX' }

        account_state.status.value = { billing: true, signed_in: false }

        await expect(account_state.create(sign_up_blank)).rejects.toThrow(MESSAGE_ASSERTION)
        await expect(account_state.create(sign_up_unknown)).rejects.toThrow(MESSAGE_ASSERTION)

        expect(ipc.account_create).not.toHaveBeenCalled()
    })

    it('sends a promo code without the space around it and shows the new balance', async () => {
        account_state.status.value = { billing: true, signed_in: true }
        account_state.account.value = account_with(5400)
        vi.mocked(ipc.account_promo_redeem).mockResolvedValue(account_with(905_400))

        await account_state.promo_redeem(' wib2026 ')

        expect(ipc.account_promo_redeem).toHaveBeenCalledWith('wib2026')
        expect(account_state.balance_text.value).toBe('251.5 hours')
    })

    it('keeps the account as it was when the server refuses a promo code', async () => {
        const refused = new Error('api error: That promo code is not valid.')

        account_state.status.value = { billing: true, signed_in: true }
        account_state.account.value = account_with(5400)
        vi.mocked(ipc.account_promo_redeem).mockRejectedValue(refused)

        await expect(account_state.promo_redeem('NOPE')).rejects.toThrow('not valid')

        expect(account_state.account.value).toEqual(account_with(5400))
    })
})

describe('checkout', () => {
    it('refuses to start a checkout for a copy that is not signed in', async () => {
        account_state.status.value = { billing: true, signed_in: false }

        await expect(account_state.checkout_start(50)).rejects.toThrow(MESSAGE_ASSERTION)

        expect(ipc.account_checkout_start).not.toHaveBeenCalled()
    })

    it('starts a checkout only for a pack the server offers', async () => {
        const client_secret = `${CHECKOUT_SESSION_ID}_secret_x`
        const started = { client_secret, session_id: CHECKOUT_SESSION_ID }

        account_state.status.value = { billing: true, signed_in: true }
        account_state.account.value = account_with(5400)
        vi.mocked(ipc.account_checkout_start).mockResolvedValue(started)

        await expect(account_state.checkout_start(200)).resolves.toEqual(started)
        await expect(account_state.checkout_start(49)).rejects.toThrow(MESSAGE_ASSERTION)

        expect(ipc.account_checkout_start).toHaveBeenCalledTimes(1)
        expect(ipc.account_checkout_start).toHaveBeenCalledWith(200)
    })

    it('shows the balance the server credited once a paid checkout is finished', async () => {
        const credited = { account: account_with(185_400), paid: true }

        account_state.status.value = { billing: true, signed_in: true }
        account_state.account.value = account_with(5400)
        vi.mocked(ipc.account_checkout_finish).mockResolvedValue(credited)

        const paid = await account_state.checkout_finish(CHECKOUT_SESSION_ID)

        expect(paid).toBe(true)
        expect(ipc.account_checkout_finish).toHaveBeenCalledWith(CHECKOUT_SESSION_ID)
        expect(account_state.balance_text.value).toBe('51.5 hours')
    })
})

describe('code_copy', () => {
    it('copies the sign-in code this copy holds', async () => {
        const write_text = vi.fn().mockResolvedValue(undefined)

        vi.stubGlobal('navigator', { clipboard: { [WRITE_TEXT]: write_text } })
        account_state.status.value = { billing: true, signed_in: true }
        vi.mocked(ipc.account_code_get).mockResolvedValue(SIGN_IN_CODE)

        await account_state.code_copy()

        expect(write_text).toHaveBeenCalledWith(SIGN_IN_CODE)
    })

    it('reports a copy with no sign-in instead of copying nothing', async () => {
        const write_text = vi.fn().mockResolvedValue(undefined)

        vi.stubGlobal('navigator', { clipboard: { [WRITE_TEXT]: write_text } })
        account_state.status.value = { billing: true, signed_in: false }
        vi.mocked(ipc.account_code_get).mockResolvedValue(null)

        await expect(account_state.code_copy()).rejects.toThrow('not signed in to an account')

        expect(write_text).not.toHaveBeenCalled()
    })
})

describe('offer_hours and offer_price', () => {
    it('name the pack and price it in the currency the server names', () => {
        const offer = { currency: 'cad', hours: 50, price_cents: 1000 }

        expect(offer_hours(offer)).toBe('50 hours')
        expect(offer_hours({ ...offer, hours: 1 })).toBe('1 hour')
        expect(offer_price(offer)).toBe('$10.00')
        expect(offer_price({ ...offer, currency: 'usd' })).toBe('US$10.00')
        expect(offer_price({ ...offer, price_cents: 199 })).toBe('$1.99')
    })
})

describe('offer_cards', () => {
    it('prices each pack per hour and marks the cheapest hour as the best value', () => {
        const cards = offer_cards(OFFERS, 5400)

        expect(cards.map((card) => card.rate_text)).toEqual(['$0.30', '$0.20', '$0.15'])
        expect(cards.map((card) => card.saving_percent)).toEqual([0, 33, 50])
        expect(cards.map((card) => card.best)).toEqual([false, false, true])
        expect(cards.map((card) => card.price_text)).toEqual(['$3.00', '$10.00', '$30.00'])

        expect(cards.map((card) => card.balance_after_text)).toEqual([
            '11.5 hours',
            '51.5 hours',
            '201.5 hours',
        ])
    })

    it('never overstates a saving and names no best value without one cheapest hour', () => {
        const thirds = { currency: 'cad', hours: 3, price_cents: 1000 }
        const tied = { currency: 'cad', hours: 100, price_cents: 1500 }
        const tied_twice = { currency: 'cad', hours: 200, price_cents: 3000 }
        const tens = { currency: 'cad', hours: 10, price_cents: 300 }
        const cards = offer_cards([tens, thirds, tied], 0)
        const ties = offer_cards([tied, tied_twice], 0)
        const lone = offer_cards([thirds], 0)

        expect(cards.map((card) => card.saving_percent)).toEqual([91, 0, 95])
        expect(cards.map((card) => card.best)).toEqual([false, false, true])
        expect(ties.map((card) => card.best)).toEqual([false, false])
        expect(ties.map((card) => card.saving_percent)).toEqual([0, 0])
        expect(lone[0]?.best).toBe(false)
        expect(lone[0]?.saving_percent).toBe(0)
        expect(lone[0]?.rate_text).toBe('$3.33')
    })

    it('prices each pack at the dearest hourly rate to show the money it saves', () => {
        const cards = offer_cards(OFFERS, 0)

        expect(cards.map((card) => card.regular_text)).toEqual(['$3.00', '$15.00', '$60.00'])
        expect(cards.map((card) => card.saving_text)).toEqual(['$0.00', '$5.00', '$30.00'])
    })

    it('rounds an uneven regular price to the cent so price and saving still add up', () => {
        const thirds = { currency: 'cad', hours: 3, price_cents: 1000 }
        const tens = { currency: 'cad', hours: 10, price_cents: 300 }
        const tied = { currency: 'cad', hours: 100, price_cents: 1500 }
        const cards = offer_cards([tens, thirds, tied], 0)

        expect(cards.map((card) => card.regular_text)).toEqual(['$33.33', '$10.00', '$333.33'])
        expect(cards.map((card) => card.saving_text)).toEqual(['$30.33', '$0.00', '$318.33'])
    })
})
