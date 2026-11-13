import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PeopleManager from '../../src/components/people_manager.vue'
import { use_context_menu } from '../../src/composables/use_context_menu'
import { use_people } from '../../src/composables/use_people'
import { use_pipeline } from '../../src/composables/use_pipeline'
import { assert } from '../../src/lib/assert'
import { ATTACH_TO, group_build, person_build } from './fixtures'
import type { VueWrapper } from '@vue/test-utils'


vi.mock('../../src/lib/ipc')

const context_menu = use_context_menu()
const mounted = new Set<VueWrapper>()
const people_state = use_people()
const pipeline = use_pipeline()


async function dialog_close(): Promise<void> {
    const close = document.querySelector<HTMLButtonElement>('.app-dialog-close')

    assert(mounted.size > 0)
    assert(close !== null, 'no dialog is open to close')

    close.click()
    await flushPromises()
}

function dialog_title(): string | null {
    assert(mounted.size > 0)

    const title = document.querySelector('.app-dialog-title')

    assert(document.querySelectorAll('.app-dialog-title').length <= 1)

    return title === null ? null : title.textContent.trim()
}

function menu_ids(): string[] {
    const shown = context_menu.menu.value

    assert(shown !== null)
    assert(shown.items.length > 0)

    return shown.items.map((item) => item.id)
}

async function mount_people(): Promise<VueWrapper> {
    assert(mounted.size === 0)

    const wrapper = mount(PeopleManager, { [ATTACH_TO]: document.body })

    mounted.add(wrapper)
    await flushPromises()

    assert(wrapper.element instanceof Node)
    assert(document.body.contains(wrapper.element))

    return wrapper
}

beforeEach(() => {
    pipeline.pipeline_reset()
    people_state.people.value = [person_build()]
    people_state.groups.value = [group_build({ person_ids: ['person-john'] })]
})

afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount()

    mounted.clear()
    context_menu.close()
    people_state.people.value = []
    people_state.groups.value = []
    document.body.innerHTML = ''
})

describe('PeopleManager', () => {
    it('opens the new person form when Add person was chosen from the sidebar', async () => {
        pipeline.view_intent_open('person_add')

        await mount_people()

        expect(dialog_title()).toBe('New person')
        expect(pipeline.view_intent_take()).toBeNull()
    })

    it('opens the new group form when Add group was chosen from the sidebar', async () => {
        pipeline.view_intent_open('group_add')

        await mount_people()

        expect(dialog_title()).toBe('New group')
    })

    it('opens no form when the view is opened plainly', async () => {
        pipeline.view_reopen('people')

        await mount_people()

        expect(dialog_title()).toBeNull()
    })

    it('offers Edit and Delete on a right-clicked person and group', async () => {
        const wrapper = await mount_people()
        const rows = wrapper.findAll('li')

        expect(rows).toHaveLength(2)

        await rows[0]?.trigger('contextmenu')

        expect(menu_ids()).toEqual(['edit', 'delete'])

        await context_menu.choose('edit')

        expect(dialog_title()).toBe('Edit person')

        await dialog_close()

        expect(dialog_title()).toBeNull()

        await rows[1]?.trigger('contextmenu')

        expect(menu_ids()).toEqual(['edit', 'delete'])

        await context_menu.choose('edit')

        expect(dialog_title()).toBe('Edit group')
    })
})
