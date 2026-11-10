import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import GroupForm from '../../src/components/group_form.vue'
import { use_people } from '../../src/composables/use_people'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import { ATTACH_TO, PROPERTIES, group_build, person_build } from './fixtures'
import type { VueWrapper } from '@vue/test-utils'
import type { Group } from '../../src/types'


vi.mock('../../src/lib/ipc')

const JOHN = person_build({ id: 'john', name_first: 'John', name_last: 'Doe', role: 'Developer' })
const JANE = person_build({ id: 'jane', name_first: 'Jane', name_last: 'Doe', role: '' })
const mounted = new Set<VueWrapper>()
const people_state = use_people()

function chips(wrapper: VueWrapper): string[] {
    assert(wrapper.exists())
    assert(mounted.has(wrapper))

    return wrapper.findAll('.tag-chip').map((chip) => chip.text())
}

function mount_form(group: Group | null): VueWrapper {
    assert(group === null || group.id.length > 0)
    assert(mounted.size >= 0)

    const wrapper = mount(GroupForm, { [PROPERTIES]: { group }, [ATTACH_TO]: document.body })

    mounted.add(wrapper)

    return wrapper
}

beforeEach(() => {
    vi.resetAllMocks()
    people_state.people.value = [JOHN, JANE]
    people_state.groups.value = []
    vi.mocked(ipc.people_list).mockResolvedValue([JOHN, JANE])
    vi.mocked(ipc.groups_list).mockResolvedValue([])
})

afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount()

    mounted.clear()
    document.body.innerHTML = ''
})

describe('GroupForm', () => {
    it('starts empty with save disabled for a new group', () => {
        const wrapper = mount_form(null)

        expect(wrapper.get('input').element.value).toBe('')
        expect(chips(wrapper)).toEqual([])
        expect(wrapper.get('.btn-primary').attributes('disabled')).toBeDefined()
    })

    it('prefills the name and lists known members with their roles', () => {
        const group = group_build({ name: 'Core', person_ids: ['john', 'ghost', 'jane'] })
        const wrapper = mount_form(group)

        expect(wrapper.get('input').element.value).toBe('Core')
        expect(chips(wrapper)).toEqual(['John Doe (Developer)', 'Jane Doe'])
    })

    it('removes a member from its chip', async () => {
        const group = group_build({ person_ids: ['john', 'jane'] })
        const wrapper = mount_form(group)

        await wrapper.get('[aria-label="Remove John Doe"]').trigger('click')

        expect(chips(wrapper)).toEqual(['Jane Doe'])
    })

    it('emits a trimmed group with only the resolvable member ids', async () => {
        const group = group_build({ id: 'g-1', person_ids: ['john', 'ghost'] })
        const wrapper = mount_form(group)

        await wrapper.get('input').setValue('  Core team  ')
        await wrapper.get('.btn-primary').trigger('click')

        expect(wrapper.emitted<Group[]>('save')?.[0]?.[0]).toEqual({
            id: 'g-1',
            name: 'Core team',
            person_ids: ['john'],
        })
    })

    it('mints an id for a new group', async () => {
        const wrapper = mount_form(null)

        await wrapper.get('input').setValue('Fresh')
        await wrapper.get('.btn-primary').trigger('click')

        expect(wrapper.emitted<Group[]>('save')?.[0]?.[0]?.id).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('emits cancel', async () => {
        const wrapper = mount_form(null)

        await wrapper.get('.btn-default').trigger('click')

        expect(wrapper.emitted('cancel')).toHaveLength(1)
    })
})

describe('GroupForm', () => {
    it('opens the picker without groups and adds a ticked person as a member', async () => {
        const wrapper = mount_form(null)

        expect(document.body.querySelector('.people-picker')).toBeNull()

        await wrapper.get('.meeting-details-add').trigger('click')
        await flushPromises()

        const picker = document.body.querySelector('.people-picker')
        const boxes = picker?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? []

        expect(picker?.querySelector('.app-dialog-title')?.textContent)
            .toBe('Who is in this group?')

        expect(boxes).toHaveLength(2)

        boxes[1]?.click()
        await flushPromises()

        expect(chips(wrapper)).toEqual(['John Doe (Developer)'])

        picker?.querySelector('.btn-primary')?.dispatchEvent(new MouseEvent('click'))
        await flushPromises()

        expect(document.body.querySelector('.people-picker')).toBeNull()
        expect(chips(wrapper)).toEqual(['John Doe (Developer)'])
    })
})
