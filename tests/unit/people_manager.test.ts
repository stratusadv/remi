import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import PeopleManager from '../../src/components/people_manager.vue'
import { use_context_menu } from '../../src/composables/use_context_menu'
import { use_modal_shown } from '../../src/composables/use_modal'
import { use_people } from '../../src/composables/use_people'
import { use_pipeline } from '../../src/composables/use_pipeline'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import { ATTACH_TO, group_build, mount_auto_unmount, person_build } from './fixtures'
import { escape_press, pointer_press } from './modal'
import type { VueWrapper } from '@vue/test-utils'


vi.mock('../../src/lib/ipc')

const context_menu = use_context_menu()
const modal_shown = use_modal_shown()
const people_state = use_people()
const pipeline = use_pipeline()


async function dialog_close(): Promise<void> {
    const close = document.querySelector<HTMLButtonElement>('.app-dialog-close')

    assert(document.body.querySelector('.view-fill') !== null)
    assert(close !== null, 'no dialog is open to close')

    close.click()
    await flushPromises()
}

function dialog_title(): string | null {
    assert(document.body.querySelector('.view-fill') !== null)

    const title = document.querySelector('.app-dialog-title')

    assert(document.querySelectorAll('.app-dialog-title').length <= 1)

    return title === null ? null : title.textContent.trim()
}

function form_backdrop(): HTMLElement {
    const backdrop = document.body.querySelector('.people-form-dialog')?.parentElement ?? null

    assert(backdrop !== null, 'the person or group form is not open')
    assert(backdrop.classList.contains('app-dialog-backdrop'))

    return backdrop
}

function menu_ids(): string[] {
    const shown = context_menu.menu.value

    assert(shown !== null)
    assert(shown.items.length > 0)

    return shown.items.map((item) => item.id)
}

async function mount_people(animated = false): Promise<VueWrapper> {
    assert(document.body.childElementCount === 0)
    assert(typeof animated === 'boolean')

    const wrapper = mount_auto_unmount(PeopleManager, {
        [ATTACH_TO]: document.body,
        global: { stubs: { transition: !animated } },
    })

    await flushPromises()

    assert(wrapper.element instanceof Node)
    assert(document.body.contains(wrapper.element))

    return wrapper
}

function picker(): HTMLElement | null {
    assert(document.body.querySelector('.view-fill') !== null)
    assert(document.body.querySelectorAll('.people-picker').length <= 1)

    return document.body.querySelector<HTMLElement>('.people-picker')
}

beforeEach(() => {
    onTestFinished(() => {
        context_menu.close()
        people_state.people.value = []
        people_state.groups.value = []
        document.body.innerHTML = ''
    })

    pipeline.pipeline_reset()
    people_state.people.value = [person_build()]
    people_state.groups.value = [group_build({ person_ids: ['person-john'] })]
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

describe('PeopleManager form dialog', () => {
    it('makes the app inert while it is open and lets go of it as it fades out', async () => {
        pipeline.view_intent_open('person_add')
        await mount_people(true)

        const leaving = form_backdrop()

        expect(modal_shown.value).toBe(true)
        expect(leaving.inert).toBe(false)

        leaving.querySelector<HTMLButtonElement>('.app-dialog-close')?.click()
        await nextTick()

        expect(modal_shown.value).toBe(false)
        expect(leaving.isConnected).toBe(true)
        expect(leaving.inert).toBe(true)
    })

    it('puts focus in the form when it opens so Escape closes it', async () => {
        const wrapper = await mount_people()

        await wrapper.get('.page-header-actions .btn-primary').trigger('click')
        await flushPromises()

        expect(form_backdrop().contains(document.activeElement)).toBe(true)

        escape_press()
        await flushPromises()

        expect(dialog_title()).toBeNull()
    })

    it('closes on Escape after a click on a part of it that takes no focus', async () => {
        pipeline.view_intent_open('group_add')
        await mount_people()

        const title = form_backdrop().querySelector('.app-dialog-title')

        assert(title !== null)

        pointer_press(title)
        escape_press()
        await flushPromises()

        expect(dialog_title()).toBeNull()
    })
})

describe('PeopleManager under the people picker', () => {
    it('closes only the picker on Escape and keeps the group form open', async () => {
        vi.mocked(ipc.people_list).mockResolvedValue([person_build()])
        vi.mocked(ipc.groups_list).mockResolvedValue([])
        pipeline.view_intent_open('group_add')
        await mount_people()

        form_backdrop().querySelector<HTMLButtonElement>('.meeting-details-add')?.click()
        await flushPromises()

        const checkbox = picker()?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null

        assert(checkbox !== null, 'the picker lists nobody to tick')

        expect(form_backdrop().inert).toBe(true)

        checkbox.focus()
        escape_press()
        await flushPromises()

        expect(picker()).toBeNull()
        expect(dialog_title()).toBe('New group')
        expect(form_backdrop().inert).toBe(false)
    })
})
