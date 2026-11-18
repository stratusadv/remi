import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import WelcomeScreen from '../../src/components/welcome_screen.vue'
import { use_account } from '../../src/composables/use_account'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import { REGIONS_CANADA, REGIONS_UNITED_STATES, REGION_OUTSIDE } from '../../src/lib/regions'
import { ATTACH_TO, mount_auto_unmount } from './fixtures'
import type { VueWrapper } from '@vue/test-utils'
import type { Account } from '../../src/types'


vi.mock('../../src/lib/ipc')

const ACCOUNT = Object.freeze<Account>({
    balance_seconds: 5400,
    email: 'avery@example.com',
    name: 'Avery',
    offers: [],
    payments: true,
    publishable_key: 'pk_test_51Hscribe',
})

const account_state = use_account()


async function sign_up_mount(): Promise<VueWrapper> {
    assert(document.body.childElementCount === 0)

    account_state.status.value = { billing: true, signed_in: false }

    assert(account_state.sign_up_needed.value)

    const wrapper = mount_auto_unmount(WelcomeScreen, { [ATTACH_TO]: document.body })

    await flushPromises()

    return wrapper
}

beforeEach(() => {
    onTestFinished(() => {
        account_state.account.value = null
        account_state.status.value = { billing: false, signed_in: false }
        document.body.innerHTML = ''
    })

    vi.resetAllMocks()
})

describe('WelcomeScreen steps', () => {
    it('opens on sign-up and switches to a sign-in code and back', async () => {
        const wrapper = await sign_up_mount()
        const submit = wrapper.find('button[type="submit"]')

        expect(submit.text()).toBe('Get started')
        expect(wrapper.find('input[type="password"]').exists()).toBe(false)

        await wrapper.get('.welcome-switch').trigger('click')

        expect(submit.text()).toBe('Sign in')
        expect(wrapper.findAll('input[type="password"]')).toHaveLength(1)

        await wrapper.get('.welcome-switch').trigger('click')

        expect(submit.text()).toBe('Get started')
    })
})

describe('WelcomeScreen sign up', () => {
    it('offers each province and state, then outside, and waits for one', async () => {
        const wrapper = await sign_up_mount()
        const select = wrapper.find('select')
        const submit = wrapper.find('button[type="submit"]')
        const options = select.findAll('option')
        const values = options.map((option) => (option.element as HTMLOptionElement).value)

        const expected = [
            ...Object.keys(REGIONS_CANADA),
            ...Object.keys(REGIONS_UNITED_STATES),
            REGION_OUTSIDE,
        ]

        await wrapper.find('input[autocomplete="name"]').setValue('Avery')
        await wrapper.find('input[type="email"]').setValue('avery@example.com')

        expect(values).toEqual(expected)
        expect((select.element as HTMLSelectElement).value).toBe('')
        expect(submit.attributes('disabled')).toBeDefined()

        await select.setValue('CA-QC')

        expect(submit.attributes('disabled')).toBeUndefined()
    })

    it('sends the province or state chosen with the trimmed name and email', async () => {
        vi.mocked(ipc.account_create).mockResolvedValue(ACCOUNT)

        const wrapper = await sign_up_mount()

        await wrapper.find('input[autocomplete="name"]').setValue('  Avery ')
        await wrapper.find('input[type="email"]').setValue(' avery@example.com ')
        await wrapper.find('select').setValue('US-NY')
        await wrapper.find('form').trigger('submit')
        await flushPromises()

        expect(ipc.account_create).toHaveBeenCalledWith({
            email: 'avery@example.com',
            name: 'Avery',
            promo_code: '',
            region: 'US-NY',
        })

        expect(account_state.account.value).toEqual(ACCOUNT)
    })
})
