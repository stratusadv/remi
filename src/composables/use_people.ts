import { computed, ref } from 'vue'
import { assert } from '../lib/assert'
import { ipc } from '../lib/ipc'
import type { Group, Person, RecordID } from '../types'


const people = ref<Person[]>([])
const groups = ref<Group[]>([])
const error_message = ref<string | null>(null)

const people_sorted = computed(() => [...people.value].sort(people_order))

const groups_sorted = computed(() =>
    [...groups.value].sort((left, right) => left.name.localeCompare(right.name)))

const api = Object.freeze({
    people,
    people_sorted,
    groups,
    groups_sorted,
    error_message,
    person_by_id,
    group_members,
    refresh,
    save,
    remove,
    group_save,
    group_remove,
})


export function person_label(person: Person): string {
    assert(typeof person.role === 'string')
    assert(typeof person.name_first === 'string')

    const name = person_name_full(person)

    return person.role.length > 0 ? `${name} (${person.role})` : name
}

export function person_name_full(person: Person): string {
    assert(typeof person.name_first === 'string')
    assert(typeof person.name_last === 'string')

    return `${person.name_first} ${person.name_last}`.trim()
}

export function use_people(): typeof api {
    assert(Object.isFrozen(api))
    assert(Array.isArray(people.value))

    return api
}

function group_members(group: Group): Person[] {
    assert(Array.isArray(group.person_ids))

    const members = group.person_ids
        .map(person_by_id)
        .filter((person): person is Person => person !== null)

    assert(members.length <= group.person_ids.length)

    return members
}

async function group_remove(id: RecordID): Promise<void> {
    assert(typeof id === 'string')
    assert(Array.isArray(groups.value))

    error_message.value = null

    return ipc.group_remove(id)
        .then(refresh)
        .catch((error: unknown) => {
            error_message.value = String(error)
        })
}

async function group_save(group: Group): Promise<void> {
    assert(typeof group.id === 'string')
    assert(Array.isArray(group.person_ids))

    error_message.value = null

    return ipc.group_save(group)
        .then(refresh)
        .catch((error: unknown) => {
            error_message.value = String(error)
        })
}

function people_order(left: Person, right: Person): number {
    assert(typeof left.name_last === 'string')
    assert(typeof right.name_last === 'string')

    const by_last = left.name_last.localeCompare(right.name_last)

    return by_last === 0 ? left.name_first.localeCompare(right.name_first) : by_last
}

function person_by_id(id: RecordID): Person | null {
    assert(typeof id === 'string')

    const found = people.value.find((person) => person.id === id) ?? null

    assert(found === null || found.id === id)

    return found
}

async function refresh(): Promise<void> {
    error_message.value = null

    try {
        const [people_loaded, groups_loaded] = await Promise.all([
            ipc.people_list(),
            ipc.groups_list(),
        ])

        assert(Array.isArray(people_loaded))
        assert(Array.isArray(groups_loaded))

        people.value = people_loaded
        groups.value = groups_loaded
    } catch (error) {
        error_message.value = String(error)
    }
}

async function remove(id: RecordID): Promise<void> {
    assert(typeof id === 'string')
    assert(Array.isArray(people.value))

    error_message.value = null

    return ipc.person_remove(id)
        .then(refresh)
        .catch((error: unknown) => {
            error_message.value = String(error)
        })
}

async function save(person: Person): Promise<void> {
    assert(typeof person.id === 'string')
    assert(typeof person.name_first === 'string')

    error_message.value = null

    return ipc.person_save(person)
        .then(refresh)
        .catch((error: unknown) => {
            error_message.value = String(error)
        })
}
