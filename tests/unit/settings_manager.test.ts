import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import SettingsManager from '../../src/components/settings_manager.vue'
import { use_account } from '../../src/composables/use_account'
import { use_pipeline } from '../../src/composables/use_pipeline'
import { use_settings } from '../../src/composables/use_settings'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import { ATTACH_TO, mount_auto_unmount } from './fixtures'
import type { VueWrapper } from '@vue/test-utils'


vi.mock('../../src/lib/ipc')

const account = use_account()
const pipeline = use_pipeline()
const settings_state = use_settings()


async function mount_settings(): Promise<VueWrapper> {
    assert(document.body.childElementCount === 0)

    const wrapper = mount_auto_unmount(SettingsManager, {
        [ATTACH_TO]: document.body,
        global: { stubs: { SearchIndexStatus: true } },
    })

    await flushPromises()

    return wrapper
}

function tab_labels(wrapper: VueWrapper): string[] {
    assert(!wrapper.vm.$.isUnmounted)

    const labels = wrapper.findAll('[role="tab"]').map((tab) => tab.text())

    assert(labels.length <= 2)

    return labels
}

function tab_selected(wrapper: VueWrapper): string {
    assert(!wrapper.vm.$.isUnmounted)

    const tabs = wrapper.findAll('[role="tab"][aria-selected="true"]')

    assert(tabs.length === 1, `expected one selected tab, found ${String(tabs.length)}`)

    return tabs[0]?.text() ?? ''
}

beforeEach(() => {
    onTestFinished(() => {
        document.body.innerHTML = ''
    })

    vi.resetAllMocks()
    vi.mocked(ipc.recordings_directory_default).mockResolvedValue('/tmp/recordings')
    vi.mocked(ipc.settings_get).mockResolvedValue({ ...settings_state.settings.value })
    pipeline.pipeline_reset()
    account.status.value = { billing: false, signed_in: false }
})

describe('SettingsManager', () => {
    it('opens on General with the search status when the view is opened plainly', async () => {
        pipeline.view_reopen('settings')

        const wrapper = await mount_settings()

        expect(tab_selected(wrapper)).toBe('General')
        expect(wrapper.find('search-index-status-stub').exists()).toBe(true)
    })

    it('opens the Account tab when Account was chosen while billing is on', async () => {
        account.status.value = { billing: true, signed_in: false }
        pipeline.view_intent_open('settings_account')

        const wrapper = await mount_settings()

        expect(tab_labels(wrapper)).toEqual(['General', 'Account'])
        expect(tab_selected(wrapper)).toBe('Account')
        expect(wrapper.find('search-index-status-stub').exists()).toBe(false)
    })

    it('stays on General when Account was chosen but billing has since turned off', async () => {
        pipeline.view_intent_open('settings_account')

        const wrapper = await mount_settings()

        expect(tab_labels(wrapper)).toEqual(['General'])
        expect(tab_selected(wrapper)).toBe('General')
        expect(pipeline.view_intent_take()).toBeNull()
    })
})
