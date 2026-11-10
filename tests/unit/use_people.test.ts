import { beforeEach, describe, expect, it, vi } from 'vitest'
import { person_name_full, use_people } from '../../src/composables/use_people'
import { ipc } from '../../src/lib/ipc'
import { group_build, person_build } from './fixtures'


vi.mock('../../src/lib/ipc')

const JOHN = person_build({ id: 'john', name_first: 'John', name_last: 'Doe' })
const JANE = person_build({ id: 'jane', name_first: 'Jane', name_last: 'Doe' })
const SAM = person_build({ id: 'sam', name_first: 'Sam', name_last: 'Adams' })
const people_state = use_people()

beforeEach(() => {
    vi.resetAllMocks()
    people_state.people.value = []
    people_state.groups.value = []
    people_state.error_message.value = null
})

describe('person_name_full', () => {
    it('joins first and last name with a space', () => {
        expect(person_name_full(JOHN)).toBe('John Doe')
    })

    it('trims when a name part is missing', () => {
        expect(person_name_full(person_build({ name_first: 'Cher', name_last: '' }))).toBe('Cher')
        expect(person_name_full(person_build({ name_first: '', name_last: 'Doe' }))).toBe('Doe')
    })
})

describe('people_sorted', () => {
    it('orders by last name then first name', () => {
        people_state.people.value = [JOHN, SAM, JANE]

        expect(people_state.people_sorted.value.map((person) => person.id)).toEqual([
            'sam',
            'jane',
            'john',
        ])
    })
})

describe('groups_sorted', () => {
    it('orders groups by name', () => {
        people_state.groups.value = [
            group_build({ id: 'z', name: 'Zebras' }),
            group_build({ id: 'a', name: 'Admins' }),
        ]

        expect(people_state.groups_sorted.value.map((group) => group.id)).toEqual(['a', 'z'])
    })
})

describe('person_by_id', () => {
    it('finds a person or returns null', () => {
        people_state.people.value = [JOHN]

        expect(people_state.person_by_id('john')).toEqual(JOHN)
        expect(people_state.person_by_id('ghost')).toBeNull()
    })
})

describe('group_members', () => {
    it('resolves member ids in order and drops unknown ids', () => {
        people_state.people.value = [JOHN, JANE]

        const group = group_build({ person_ids: ['jane', 'ghost', 'john'] })

        expect(people_state.group_members(group)).toEqual([JANE, JOHN])
    })
})

describe('refresh', () => {
    it('loads people and groups together', async () => {
        vi.mocked(ipc.people_list).mockResolvedValue([JOHN])
        vi.mocked(ipc.groups_list).mockResolvedValue([group_build()])

        await people_state.refresh()

        expect(people_state.people.value).toEqual([JOHN])
        expect(people_state.groups.value).toEqual([group_build()])
    })

    it('records the failure when either list fails', async () => {
        vi.mocked(ipc.people_list).mockResolvedValue([JOHN])
        vi.mocked(ipc.groups_list).mockRejectedValue(new Error('groups gone'))

        await people_state.refresh()

        expect(people_state.people.value).toEqual([])
        expect(people_state.error_message.value).toBe('Error: groups gone')
    })
})

describe('save and remove', () => {
    beforeEach(() => {
        vi.mocked(ipc.people_list).mockResolvedValue([JOHN])
        vi.mocked(ipc.groups_list).mockResolvedValue([])
    })

    it('saves a person then refreshes', async () => {
        vi.mocked(ipc.person_save).mockResolvedValue(undefined)

        await people_state.save(JOHN)

        expect(ipc.person_save).toHaveBeenCalledWith(JOHN)
        expect(people_state.people.value).toEqual([JOHN])
    })

    it('removes a person then refreshes', async () => {
        vi.mocked(ipc.person_remove).mockResolvedValue(undefined)

        await people_state.remove('jane')

        expect(ipc.person_remove).toHaveBeenCalledWith('jane')
        expect(ipc.people_list).toHaveBeenCalledTimes(1)
    })

    it('records a save failure without refreshing', async () => {
        vi.mocked(ipc.person_save).mockRejectedValue(new Error('duplicate'))

        await people_state.save(JOHN)

        expect(people_state.error_message.value).toBe('Error: duplicate')
        expect(ipc.people_list).not.toHaveBeenCalled()
    })
})

describe('group_save and group_remove', () => {
    beforeEach(() => {
        vi.mocked(ipc.people_list).mockResolvedValue([])
        vi.mocked(ipc.groups_list).mockResolvedValue([group_build()])
    })

    it('saves a group then refreshes', async () => {
        vi.mocked(ipc.group_save).mockResolvedValue(undefined)

        await people_state.group_save(group_build())

        expect(ipc.group_save).toHaveBeenCalledWith(group_build())
        expect(people_state.groups.value).toEqual([group_build()])
    })

    it('removes a group then refreshes', async () => {
        vi.mocked(ipc.group_remove).mockResolvedValue(undefined)

        await people_state.group_remove('group-team')

        expect(ipc.group_remove).toHaveBeenCalledWith('group-team')
        expect(ipc.groups_list).toHaveBeenCalledTimes(1)
    })

    it('records a removal failure without refreshing', async () => {
        vi.mocked(ipc.group_remove).mockRejectedValue(new Error('missing'))

        await people_state.group_remove('group-team')

        expect(people_state.error_message.value).toBe('Error: missing')
        expect(ipc.groups_list).not.toHaveBeenCalled()
    })
})
