import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PeoplePicker from '../../src/components/people_picker.vue'
import { use_dialog } from '../../src/composables/use_dialog'
import { use_people } from '../../src/composables/use_people'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import { ATTACH_TO, PROPERTIES, group_build, person_build } from './fixtures'
import type { VueWrapper } from '@vue/test-utils'
import type { Group, Person } from '../../src/types'


vi.mock('../../src/lib/ipc')

const JOHN = person_build({ id: 'john', name_first: 'John', name_last: 'Doe', role: 'Developer' })
const JANE = person_build({ id: 'jane', name_first: 'Jane', name_last: 'Doe', role: 'Owner' })
const SAM = person_build({ id: 'sam', name_first: 'Sam', name_last: 'Adams', role: '' })
const TEAM = group_build({ id: 'team', name: 'Product team', person_ids: ['john', 'jane'] })
const EMPTY = group_build({ id: 'empty', name: 'Alumni', person_ids: ['ghost'] })
const EVENT_UPDATE_IDS = 'onUpdate:ids_selected'
const FILTER_INPUT = 'input[aria-label="Find a person"]'
const NAME_FIRST_INPUT = 'input[placeholder="e.g. John"]'
const mounted = new Set<VueWrapper>()
const people_state = use_people()
const dialog = use_dialog()

function checkbox_at(index: number): HTMLInputElement | null {
    assert(index >= 0)
    assert(mounted.size > 0)

    return rows()[index]?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null
}

function click(target: Element | null | undefined): void {
    assert(target === undefined || typeof target === 'object')
    assert(document.body.isConnected)

    target?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function press(target: Element | null | undefined): void {
    assert(target === undefined || typeof target === 'object')
    assert(document.body.isConnected)

    target?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
}

function emitted_ids(wrapper: VueWrapper): (string[] | undefined)[] | undefined {
    assert(wrapper.exists())
    assert(mounted.has(wrapper))

    return wrapper.emitted<string[][]>('update:ids_selected')?.map((call) => call[0])
}

async function mount_picker(
    ids_selected: string[] = [],
    people: Person[] = [JOHN, JANE, SAM],
    groups: Group[] = [TEAM, EMPTY],
    groups_hidden = false,
): Promise<VueWrapper> {
    assert(Array.isArray(ids_selected))
    assert(Array.isArray(people))
    assert(Array.isArray(groups))
    assert(typeof groups_hidden === 'boolean')

    vi.mocked(ipc.people_list).mockResolvedValue(people)
    vi.mocked(ipc.groups_list).mockResolvedValue(groups)

    const wrapper = mount(PeoplePicker, {
        [PROPERTIES]: {
            ids_selected,
            title: 'Who was there?',
            hint: 'Tick everyone.',
            groups_hidden,
            [EVENT_UPDATE_IDS]: vi.fn(),
        },
        [ATTACH_TO]: document.body,
    })

    mounted.add(wrapper)
    await flushPromises()

    return wrapper
}

function root(): Element | null {
    assert(document.body.isConnected)
    assert(mounted.size > 0)

    return document.body.querySelector('.people-picker')
}

function row_texts(): string[] {
    assert(document.body.isConnected)
    assert(mounted.size > 0)

    return rows().map((row) =>
        Array.from(row.querySelectorAll('span'))
            .filter((span) => span.children.length === 0)
            .map((span) => span.textContent.trim())
            .join(' '))
}

function rows(): Element[] {
    assert(document.body.isConnected)
    assert(mounted.size > 0)

    return Array.from(root()?.querySelectorAll('.people-picker-row') ?? [])
}

beforeEach(() => {
    vi.resetAllMocks()
    people_state.people.value = []
    people_state.groups.value = []
    people_state.error_message.value = null
})

afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount()

    mounted.clear()
    dialog.close(false)
    document.body.innerHTML = ''
})

describe('PeoplePicker', () => {
    it('loads people and groups on mount and lists non-empty groups first', async () => {
        await mount_picker()

        expect(ipc.people_list).toHaveBeenCalledTimes(1)
        expect(ipc.groups_list).toHaveBeenCalledTimes(1)
        expect(root()?.querySelector('.app-dialog-title')?.textContent).toBe('Who was there?')
        expect(root()?.querySelector('.app-dialog-message')?.textContent).toBe('Tick everyone.')

        expect(row_texts()).toEqual([
            'Product team 2 people',
            'Sam Adams',
            'Jane Doe (Owner)',
            'John Doe (Developer)',
        ])

        expect(root()?.querySelector('.people-picker-divider')).not.toBeNull()
    })

    it('hides groups when asked', async () => {
        await mount_picker([], [JOHN], [TEAM], true)

        expect(row_texts()).toEqual(['John Doe (Developer)'])
        expect(root()?.querySelector('.people-picker-divider')).toBeNull()
    })

    it('reflects the selected ids in the checkboxes', async () => {
        await mount_picker(['jane'])

        expect(checkbox_at(0)?.checked).toBe(false)
        expect(checkbox_at(2)?.checked).toBe(true)
        expect(checkbox_at(3)?.checked).toBe(false)
    })

    it('ticks a group when every member is selected', async () => {
        await mount_picker(['john', 'jane'])

        expect(checkbox_at(0)?.checked).toBe(true)
    })

    it('emits the id added or removed when a person is toggled', async () => {
        const wrapper = await mount_picker(['sam'])

        checkbox_at(3)?.click()
        await flushPromises()

        expect(emitted_ids(wrapper)?.[0]).toEqual(['sam', 'john'])

        checkbox_at(1)?.click()
        await flushPromises()

        expect(emitted_ids(wrapper)?.[1]).toEqual([])
    })

    it('stays open when a drag only ends on the backdrop', async () => {
        const wrapper = await mount_picker()

        assert(wrapper.exists())

        click(document.body.querySelector('.app-dialog-backdrop'))

        expect(wrapper.emitted('close')).toBeUndefined()
    })
})

describe('PeoplePicker', () => {
    it('adds the missing members of a group and removes them all when ticked again', async () => {
        const wrapper = await mount_picker(['john', 'sam'])

        checkbox_at(0)?.click()
        await flushPromises()

        expect(emitted_ids(wrapper)?.[0]).toEqual(['john', 'sam', 'jane'])

        await wrapper.setProps({ ids_selected: ['john', 'sam', 'jane'] })
        checkbox_at(0)?.click()
        await flushPromises()

        expect(emitted_ids(wrapper)?.[1]).toEqual(['sam'])
    })

    it('filters people by name or role and groups by name', async () => {
        await mount_picker()

        const filter = root()?.querySelector<HTMLInputElement>(FILTER_INPUT) ?? null

        if (filter === null) throw new Error('filter input missing')

        filter.value = 'owner'
        filter.dispatchEvent(new Event('input'))
        await flushPromises()

        expect(row_texts()).toEqual(['Jane Doe (Owner)'])

        filter.value = 'product'
        filter.dispatchEvent(new Event('input'))
        await flushPromises()

        expect(row_texts()).toEqual(['Product team 2 people'])

        filter.value = 'zzz'
        filter.dispatchEvent(new Event('input'))
        await flushPromises()

        expect(rows()).toHaveLength(0)
        expect(root()?.querySelector('.meta')?.textContent).toBe('Nobody matches that name.')
    })

    it('explains when there are no people at all', async () => {
        await mount_picker([], [], [])

        expect(root()?.querySelector('.meta')?.textContent).toBe(
            'No people yet. Add the first one below.',
        )
    })

    it('emits close from done, the close button, the backdrop and escape', async () => {
        const wrapper = await mount_picker()

        assert(wrapper.exists())

        click(root()?.querySelector('.btn-primary'))
        click(root()?.querySelector('.app-dialog-close'))
        press(document.body.querySelector('.app-dialog-backdrop'))
        click(root())

        document.body.querySelector('.app-dialog-backdrop')?.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        )

        expect(wrapper.emitted('close')).toHaveLength(4)
    })
})

describe('PeoplePicker', () => {
    it('creates a person, selects them and returns to the list', async () => {
        const wrapper = await mount_picker(['sam'])

        assert(wrapper.exists())

        vi.mocked(ipc.person_save).mockResolvedValue(undefined)
        click(root()?.querySelector('.btn-default'))
        await flushPromises()

        const name_first = root()?.querySelector<HTMLInputElement>(NAME_FIRST_INPUT) ?? null

        if (name_first === null) throw new Error('person form missing')

        expect(root()?.querySelector('input[aria-label="Find a person"]')).toBeNull()

        name_first.value = 'Ada'
        name_first.dispatchEvent(new Event('input'))
        await flushPromises()

        vi.mocked(ipc.people_list).mockResolvedValue([
            JOHN,
            JANE,
            SAM,
            person_build({ id: 'ada', name_first: 'Ada', name_last: '' }),
        ])

        click(root()?.querySelector('.btn-primary'))
        await flushPromises()

        const saved = vi.mocked(ipc.person_save).mock.calls[0]?.[0]

        expect(saved?.name_first).toBe('Ada')
        expect(emitted_ids(wrapper)?.[0]).toEqual(['sam', saved?.id])
        expect(root()?.querySelector('input[aria-label="Find a person"]')).not.toBeNull()
        expect(dialog.current.value).toBeNull()
    })

    it('shows an error dialog and stays on the form when saving fails', async () => {
        await mount_picker()

        vi.mocked(ipc.person_save).mockRejectedValue(new Error('duplicate'))
        click(root()?.querySelector('.btn-default'))
        await flushPromises()

        const name_first = root()?.querySelector<HTMLInputElement>(NAME_FIRST_INPUT) ?? null

        if (name_first === null) throw new Error('person form missing')

        name_first.value = 'Ada'
        name_first.dispatchEvent(new Event('input'))
        await flushPromises()
        click(root()?.querySelector('.btn-primary'))
        await flushPromises()

        expect(dialog.current.value?.message).toBe('Error: duplicate')
        expect(root()?.querySelector('input[placeholder="e.g. John"]')).not.toBeNull()
    })
})
