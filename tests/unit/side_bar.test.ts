import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import SideBar from '../../src/components/side_bar.vue'
import { use_account } from '../../src/composables/use_account'
import { use_ask } from '../../src/composables/use_ask'
import { use_context_menu } from '../../src/composables/use_context_menu'
import { use_pipeline } from '../../src/composables/use_pipeline'
import { assert } from '../../src/lib/assert'
import { ATTACH_TO, mount_auto_unmount } from './fixtures'
import type { VueWrapper } from '@vue/test-utils'


vi.mock('../../src/lib/ipc')

const account = use_account()
const ask_state = use_ask()
const context_menu = use_context_menu()
const pipeline = use_pipeline()


function menu_labels(): string[] {
    const shown = context_menu.menu.value

    assert(shown !== null)
    assert(shown.items.length > 0)

    return shown.items.map((item) => item.label)
}

function mount_sidebar(): VueWrapper {
    assert(document.body.childElementCount === 0)

    const wrapper = mount_auto_unmount(SideBar, {
        [ATTACH_TO]: document.body,
        global: { stubs: { SidebarFolders: true, TasksPanel: true } },
    })

    assert(wrapper.element instanceof Node)
    assert(document.body.contains(wrapper.element))

    return wrapper
}

async function nav_right_click(wrapper: VueWrapper, label: string): Promise<string[]> {
    assert(!wrapper.vm.$.isUnmounted)
    assert(label.length > 0)

    const button = wrapper.findAll('button').find((candidate) => candidate.text() === label)

    assert(button !== undefined, `the sidebar has no ${label} button`)

    context_menu.close()
    await button.trigger('contextmenu')

    return menu_labels()
}

beforeEach(() => {
    onTestFinished(() => {
        context_menu.close()
        document.body.innerHTML = ''
    })

    pipeline.pipeline_reset()
    account.status.value = { billing: false, signed_in: false }
})

describe('SideBar menus', () => {
    it('offers the add action of each view on its nav item', async () => {
        const wrapper = mount_sidebar()
        const home = await nav_right_click(wrapper, 'Home')
        const ask = await nav_right_click(wrapper, 'Ask')
        const templates = await nav_right_click(wrapper, 'Templates')
        const people = await nav_right_click(wrapper, 'People')

        expect(home).toEqual(['New recording'])
        expect(ask).toEqual(['New chat'])
        expect(templates).toEqual(['Add template'])
        expect(people).toEqual(['Add person', 'Add group'])
    })

    it('lists the Account section under Settings only when billing is on', async () => {
        const wrapper = mount_sidebar()
        const billing_off = await nav_right_click(wrapper, 'Settings')

        account.status.value = { billing: true, signed_in: true }

        const billing_on = await nav_right_click(wrapper, 'Settings')

        expect(billing_off).toEqual(['General'])
        expect(billing_on).toEqual(['General', 'Account'])
    })
})

describe('SideBar menus', () => {
    it('opens the view an item belongs to and hands it the intent', async () => {
        account.status.value = { billing: true, signed_in: true }

        const wrapper = mount_sidebar()

        await nav_right_click(wrapper, 'People')
        await context_menu.choose('group_add')

        expect(pipeline.view_current.value).toBe('people')
        expect(pipeline.view_intent_take()).toBe('group_add')

        await nav_right_click(wrapper, 'Settings')
        await context_menu.choose('settings_account')

        expect(pipeline.view_current.value).toBe('settings')
        expect(pipeline.view_intent_take()).toBe('settings_account')
    })

    it('starts a recording and a fresh chat without leaving an intent behind', async () => {
        const wrapper = mount_sidebar()

        ask_state.scope.value = { kind: 'project', project: 'Remi' }

        await nav_right_click(wrapper, 'Home')
        await context_menu.choose('recording_new')

        expect(pipeline.view_current.value).toBe('transcribe')
        expect(pipeline.job_id_current.value).toBeNull()

        const chat_before = ask_state.chat_id.value

        await nav_right_click(wrapper, 'Ask')
        await context_menu.choose('chat_new')
        await flushPromises()

        expect(ask_state.chat_id.value).not.toBe(chat_before)
        expect(ask_state.scope.value).toEqual({ kind: 'all' })
        expect(pipeline.view_current.value).toBe('ask')
        expect(pipeline.view_intent_take()).toBeNull()
    })
})
