import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import WelcomeScreen from '../../src/components/welcome_screen.vue'
import { use_account } from '../../src/composables/use_account'
import { use_dialog } from '../../src/composables/use_dialog'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import { REGIONS_CANADA } from '../../src/lib/regions'
import { ATTACH_TO, mount_auto_unmount } from './fixtures'
import type { VueWrapper } from '@vue/test-utils'
import type { Account } from '../../src/types'


vi.mock('../../src/lib/ipc')

const ACCOUNT = Object.freeze<Account>({
    balance_seconds: 5400,
    checkout_hours_max: 1000,
    email: 'avery@example.com',
    name: 'Avery',
    payments: true,
    price_currency: 'cad',
    price_hour_cents: 100,
    publishable_key: 'pk_test_51Hscribe',
})

const account_state = use_account()
const dialog_state = use_dialog()


async function sign_up_fill(wrapper: VueWrapper, promo_code: string): Promise<void> {
    assert(!wrapper.vm.$.isUnmounted)
    assert(promo_code.length <= 64)

    await wrapper.find('input[autocomplete="name"]').setValue('Avery')
    await wrapper.find('input[type="email"]').setValue('avery@example.com')
    await wrapper.find('select').setValue('CA-AB')
    await wrapper.find('input[autocomplete="off"]').setValue(promo_code)
}

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
        dialog_state.close(false)
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
    it('offers each province and territory of Canada and waits for one', async () => {
        const wrapper = await sign_up_mount()
        const select = wrapper.find('select')
        const options = select.findAll('option')
        const values = options.map((option) => (option.element as HTMLOptionElement).value)

        await wrapper.find('input[autocomplete="name"]').setValue('Avery')
        await wrapper.find('input[type="email"]').setValue('avery@example.com')

        expect(values).toEqual(Object.keys(REGIONS_CANADA))
        expect(values).toHaveLength(13)
        expect(values.every((value) => value.startsWith('CA-'))).toBe(true)
        expect(select.findAll('optgroup')).toHaveLength(0)

        const labels = wrapper.findAll('.welcome-label').map((element) => element.text())
        const submit = wrapper.find('button[type="submit"]')

        expect(labels).toContain('Province or territory')
        expect((select.element as HTMLSelectElement).value).toBe('')
        expect(submit.attributes('disabled')).toBeDefined()

        await select.setValue('CA-QC')

        expect(submit.attributes('disabled')).toBeUndefined()
    })

    it('sends the province chosen with the trimmed name and email', async () => {
        vi.mocked(ipc.account_create).mockResolvedValue(ACCOUNT)

        const wrapper = await sign_up_mount()

        await wrapper.find('input[autocomplete="name"]').setValue('  Avery ')
        await wrapper.find('input[type="email"]').setValue(' avery@example.com ')
        await wrapper.find('select').setValue('CA-QC')
        await wrapper.find('form').trigger('submit')
        await flushPromises()

        expect(ipc.account_create).toHaveBeenCalledWith({
            email: 'avery@example.com',
            name: 'Avery',
            promo_code: '',
            region: 'CA-QC',
        })

        expect(account_state.account.value).toEqual(ACCOUNT)
    })
})

describe('WelcomeScreen welcome', () => {
    it('welcomes the new account and says its promo code was applied', async () => {
        vi.mocked(ipc.account_create).mockResolvedValue(ACCOUNT)

        const wrapper = await sign_up_mount()

        await sign_up_fill(wrapper, ' WIB2026 ')
        await wrapper.find('form').trigger('submit')
        await flushPromises()

        const shown = dialog_state.current.value

        expect(ipc.account_create).toHaveBeenCalledWith(expect.objectContaining({
            promo_code: 'WIB2026',
        }))

        expect(shown?.title).toBe('Welcome to remi')
        expect(shown?.kind).toBe('success')
        expect(shown?.cancel_label).toBeNull()

        const message = [
            'Your promo code WIB2026 has been applied.',
            'You have 1.5 hours of transcription to start.',
        ].join(' ')

        expect(shown?.message).toBe(message)
    })

    it('welcomes an account made without a promo code and points to buying hours', async () => {
        const empty = { ...ACCOUNT, balance_seconds: 0 }

        vi.mocked(ipc.account_create).mockResolvedValue(empty)

        const wrapper = await sign_up_mount()

        await sign_up_fill(wrapper, '')
        await wrapper.find('form').trigger('submit')
        await flushPromises()

        expect(dialog_state.current.value?.title).toBe('Welcome to remi')

        expect(dialog_state.current.value?.message).toBe(
            'Your account is ready. Buy hours to start transcribing.',
        )
    })
})

describe('WelcomeScreen without a welcome', () => {
    it('shows no welcome when the server refuses the sign-up', async () => {
        const refused = new Error('api error: That promo code is not valid.')

        vi.mocked(ipc.account_create).mockRejectedValue(refused)

        const wrapper = await sign_up_mount()

        await sign_up_fill(wrapper, 'NOPE')
        await wrapper.find('form').trigger('submit')
        await flushPromises()

        expect(dialog_state.current.value).toBeNull()
        expect(wrapper.find('.welcome-problem').text()).toContain('That promo code is not valid.')
        expect(account_state.account.value).toBeNull()
    })

    it('shows no welcome when an existing account signs in', async () => {
        vi.mocked(ipc.account_sign_in).mockResolvedValue(ACCOUNT)

        const wrapper = await sign_up_mount()

        await wrapper.get('.welcome-switch').trigger('click')
        await wrapper.find('input[type="password"]').setValue('k3Yq_9-wR')
        await wrapper.find('form').trigger('submit')
        await flushPromises()

        expect(ipc.account_sign_in).toHaveBeenCalledWith('k3Yq_9-wR')
        expect(account_state.account.value).toEqual(ACCOUNT)
        expect(dialog_state.current.value).toBeNull()
    })
})
