import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    hours_is_valid,
    hours_quote,
    price_hour_text,
    use_account,
} from '../../src/composables/use_account'
import { assert } from '../../src/lib/assert'
import { MESSAGE_UNSHOWN } from '../../src/lib/errors'
import { ipc } from '../../src/lib/ipc'
import { WRITE_TEXT, deferred_new } from './fixtures'
import type { Account, AccountSignUp } from '../../src/types'


vi.mock('../../src/lib/ipc')

const CHECKOUT_HOURS_MAX = 1000
const CHECKOUT_SESSION_ID = 'cs_test_a1B2c3'
const MESSAGE_ASSERTION = 'an assertion failed'
const PRICE_HOUR_CENTS = 60
const SIGN_IN_CODE = 'k3Yq_9-wR'

const ACCOUNT_SAMPLE = Object.freeze<Account>({
    balance_seconds: 5400,
    checkout_hours_max: CHECKOUT_HOURS_MAX,
    email: 'avery@example.com',
    name: 'Avery',
    payments: true,
    price_currency: 'cad',
    price_hour_cents: PRICE_HOUR_CENTS,
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
    assert(ACCOUNT_SAMPLE.price_hour_cents === PRICE_HOUR_CENTS)

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
        expect(account_state.account.value?.price_hour_cents).toBe(PRICE_HOUR_CENTS)
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

    it('starts a checkout only for whole hours from one to the most the server sells', async () => {
        const client_secret = `${CHECKOUT_SESSION_ID}_secret_x`
        const started = { client_secret, session_id: CHECKOUT_SESSION_ID }

        account_state.status.value = { billing: true, signed_in: true }
        account_state.account.value = account_with(5400)
        vi.mocked(ipc.account_checkout_start).mockResolvedValue(started)

        const accepted = [1, 200, CHECKOUT_HOURS_MAX].map(async (hours) =>
            expect(account_state.checkout_start(hours)).resolves.toEqual(started))

        const refused = [0, 2.5, CHECKOUT_HOURS_MAX + 1].map(async (hours) =>
            expect(account_state.checkout_start(hours)).rejects.toThrow(MESSAGE_ASSERTION))

        await Promise.all([...accepted, ...refused])

        expect(vi.mocked(ipc.account_checkout_start).mock.calls).toEqual([
            [1],
            [200],
            [CHECKOUT_HOURS_MAX],
        ])
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

describe('hours_is_valid', () => {
    it('takes whole hours from one to the most the server sells and nothing else', () => {
        const account = account_with(0)
        const accepted = [1, 7, CHECKOUT_HOURS_MAX - 1, CHECKOUT_HOURS_MAX]

        const refused = [
            0,
            -1,
            CHECKOUT_HOURS_MAX + 1,
            2.5,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            '50',
            '',
            null,
        ]

        expect(accepted.map((hours) => hours_is_valid(account, hours))).toEqual([
            true,
            true,
            true,
            true,
        ])

        expect(refused.some((hours) => hours_is_valid(account, hours))).toBe(false)
        expect(hours_is_valid({ ...account, checkout_hours_max: 20 }, 21)).toBe(false)
    })
})

describe('hours_quote and price_hour_text', () => {
    it('prices the hours at the hourly rate in the currency the server names', () => {
        const account = account_with(5400)
        const dollar = { ...account, price_hour_cents: 100 }
        const american = { ...account, price_currency: 'usd' }
        const single = { balance_after_text: '2.5 hours', price_text: '$0.60' }

        expect(price_hour_text(account)).toBe('$0.60')
        expect(price_hour_text(dollar)).toBe('$1.00')
        expect(price_hour_text(american)).toBe('US$0.60')
        expect(hours_quote(account, 1)).toEqual(single)
        expect(hours_quote(dollar, 50).price_text).toBe('$50.00')
        expect(hours_quote(account, 50).balance_after_text).toBe('51.5 hours')
        expect(hours_quote(account, CHECKOUT_HOURS_MAX).price_text).toBe('$600.00')
    })

    it('shows the exact cents the hours cost at every count it sells', () => {
        const account = { ...account_with(0), price_hour_cents: 29 }

        for (let hours = 1; hours <= account.checkout_hours_max; hours += 1) {
            const digits = hours_quote(account, hours).price_text.replaceAll(/\D/gu, '')

            expect(Number(digits)).toBe(hours * 29)
        }
    })

    it('refuses to quote hours the server does not sell', () => {
        const account = account_with(0)

        expect(() => hours_quote(account, 0)).toThrow(MESSAGE_ASSERTION)
        expect(() => hours_quote(account, CHECKOUT_HOURS_MAX + 1)).toThrow(MESSAGE_ASSERTION)
    })
})
