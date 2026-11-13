import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsManager from '../../src/components/settings_manager.vue'
import { use_account } from '../../src/composables/use_account'
import { use_pipeline } from '../../src/composables/use_pipeline'
import { use_settings } from '../../src/composables/use_settings'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import { ATTACH_TO } from './fixtures'
import type { VueWrapper } from '@vue/test-utils'
import type { ServiceStatus } from '../../src/types'


vi.mock('../../src/lib/ipc')

const account = use_account()
const mounted = new Set<VueWrapper>()
const pipeline = use_pipeline()
const settings_state = use_settings()


async function mount_settings(): Promise<VueWrapper> {
    assert(mounted.size === 0)

    const wrapper = mount(SettingsManager, {
        [ATTACH_TO]: document.body,
        global: { stubs: { SearchSettings: true } },
    })

    mounted.add(wrapper)
    await flushPromises()

    return wrapper
}

function service_status_build(): ServiceStatus {
    const status = {
        host: { builtin: false, user: false },
        notes: { builtin: false, length: 0, user: false },
        transcription: { builtin: false, length: 0, user: false },
    }

    assert(!status.host.builtin)
    assert(!status.host.user)
    assert(status.notes.length === 0)

    return status
}

function tab_selected(wrapper: VueWrapper): string {
    assert(mounted.has(wrapper))

    const tabs = wrapper.findAll('[role="tab"][aria-selected="true"]')

    assert(tabs.length === 1, `expected one selected tab, found ${String(tabs.length)}`)

    return tabs[0]?.text() ?? ''
}

beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(ipc.recordings_directory_default).mockResolvedValue('/tmp/recordings')
    vi.mocked(ipc.service_status).mockResolvedValue(service_status_build())
    vi.mocked(ipc.settings_get).mockResolvedValue({ ...settings_state.settings.value })
    pipeline.pipeline_reset()
    account.status.value = { billing: false, signed_in: false }
})

afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount()

    mounted.clear()
    document.body.innerHTML = ''
})

describe('SettingsManager', () => {
    it('opens on General when the view is opened plainly', async () => {
        pipeline.view_reopen('settings')

        const wrapper = await mount_settings()

        expect(tab_selected(wrapper)).toBe('General')
    })

    it('opens the AI tab when AI was chosen from the sidebar', async () => {
        pipeline.view_intent_open('settings_ai')

        const wrapper = await mount_settings()

        expect(tab_selected(wrapper)).toBe('AI')
        expect(pipeline.view_intent_take()).toBeNull()
    })

    it('opens the Account tab when Account was chosen while billing is on', async () => {
        account.status.value = { billing: true, signed_in: false }
        pipeline.view_intent_open('settings_account')

        const wrapper = await mount_settings()

        expect(tab_selected(wrapper)).toBe('Account')
    })

    it('stays on General when Account was chosen but billing has since turned off', async () => {
        pipeline.view_intent_open('settings_account')

        const wrapper = await mount_settings()

        expect(wrapper.findAll('[role="tab"]').map((tab) => tab.text())).toEqual(['General', 'AI'])
        expect(tab_selected(wrapper)).toBe('General')
    })
})
