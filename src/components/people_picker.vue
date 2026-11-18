<script setup lang="ts">
import { computed, onMounted, ref, useTemplateRef } from 'vue'
import { use_modal } from '../composables/use_modal'
import { person_label, person_name_full, use_people } from '../composables/use_people'
import { assert } from '../lib/assert'
import { error_dialog_sentence_show, error_dialog_show } from '../lib/errors'
import PersonForm from './person_form.vue'
import type { Group, Person } from '../types'


const properties = defineProps<{
    title: string
    hint: string
    groups_hidden?: boolean
}>()

const emit = defineEmits<{
    close: []
}>()

const ids_selected = defineModel<string[]>('ids_selected', { required: true })

const { people_sorted, groups_sorted, error_message, group_members, refresh, save } = use_people()
const filter_text = ref('')
const adding = ref(false)
const filter_input_element = useTemplateRef<HTMLInputElement>('filter_input_element')
const covered = use_modal('dialog', () => true)

const people_filtered = computed(() => {
    const needle = filter_text.value.trim().toLowerCase()

    if (needle.length === 0) return people_sorted.value

    return people_sorted.value.filter((person) =>
        `${person_name_full(person)} ${person.role}`.toLowerCase().includes(needle))
})

const groups_shown = computed(() => {
    if (properties.groups_hidden) return []

    const needle = filter_text.value.trim().toLowerCase()

    return groups_sorted.value.filter(
        (group) => group_members(group).length > 0 && group.name.toLowerCase().includes(needle),
    )
})

const empty_text = computed(() =>
    people_sorted.value.length === 0
        ? 'No people yet. Add the first one below.'
        : 'Nobody matches that name.')


function group_count_text(group: Group): string {
    assert(!properties.groups_hidden)

    const count = group_members(group).length

    assert(count > 0)

    return `${String(count)} ${count === 1 ? 'person' : 'people'}`
}

function group_is_selected(group: Group): boolean {
    assert(!properties.groups_hidden)

    const members = group_members(group)

    assert(members.length > 0)

    return members.every((person) => is_selected(person.id))
}

function group_toggle(group: Group): void {
    assert(!properties.groups_hidden)

    const member_ids = group_members(group).map((person) => person.id)
    const selected_before = group_is_selected(group)

    assert(member_ids.length > 0)

    const next = selected_before
        ? ids_selected.value.filter((selected) => !member_ids.includes(selected))
        : [...ids_selected.value, ...member_ids.filter((id) => !is_selected(id))]

    assert(member_ids.every((id) => next.includes(id)) !== selected_before)

    ids_selected.value = next
}

function is_selected(id: string): boolean {
    assert(id.length > 0)

    return ids_selected.value.includes(id)
}

async function person_create(person: Person): Promise<void> {
    assert(person.id.length > 0)
    assert(!ids_selected.value.includes(person.id))

    return save(person)
        .then(async () => {
            if (error_message.value !== null) {
                await error_dialog_sentence_show(error_message.value)

                return
            }

            adding.value = false
            filter_text.value = ''
            ids_selected.value = [...ids_selected.value, person.id]
        })
        .catch(error_dialog_show)
}

function toggle(id: string): void {
    assert(id.length > 0)
    assert(people_sorted.value.some((person) => person.id === id))

    const selected_before = is_selected(id)

    const next = selected_before
        ? ids_selected.value.filter((selected) => selected !== id)
        : [...ids_selected.value, id]

    assert(next.includes(id) !== selected_before)

    ids_selected.value = next
}

onMounted(async () => {
    filter_input_element.value?.focus()
    await refresh()
})
</script>

<template>
    <Teleport to="body">
        <div
            class="app-dialog-backdrop"
            role="dialog"
            aria-modal="true"
            tabindex="-1"
            :inert="covered"
            @mousedown.left.self.prevent="emit('close')"
            @keydown.esc="emit('close')"
        >
            <div class="app-dialog people-picker">
                <button
                    type="button"
                    class="app-dialog-close"
                    aria-label="Close"
                    title="Close"
                    @click="emit('close')"
                >
                    <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.75"
                        stroke-linecap="round"
                        aria-hidden="true"
                    >
                        <path d="M6 6l12 12" />
                        <path d="M18 6L6 18" />
                    </svg>
                </button>
                <h3 class="app-dialog-title">{{ properties.title }}</h3>
                <p class="app-dialog-message">{{ properties.hint }}</p>

                <PersonForm
                    v-if="adding"
                    :person="null"
                    @cancel="adding = false"
                    @save="person_create"
                />

                <div v-else class="people-picker-body">
                    <input
                        ref="filter_input_element"
                        v-model="filter_text"
                        type="search"
                        class="input"
                        placeholder="Type a name to find someone"
                        aria-label="Find a person"
                    >

                    <ul
                        v-if="people_filtered.length > 0 || groups_shown.length > 0"
                        class="people-picker-list"
                    >
                        <li v-for="group in groups_shown" :key="group.id">
                            <label class="people-picker-row">
                                <input
                                    type="checkbox"
                                    :checked="group_is_selected(group)"
                                    @change="group_toggle(group)"
                                >
                                <span class="flex-1 min-w-0 flex items-center gap-2">
                                    <span class="font-medium truncate">{{ group.name }}</span>
                                    <span class="pill shrink-0">{{ group_count_text(group) }}</span>
                                </span>
                            </label>
                        </li>
                        <li
                            v-if="groups_shown.length > 0 && people_filtered.length > 0"
                            class="people-picker-divider"
                            aria-hidden="true"
                        />
                        <li v-for="person in people_filtered" :key="person.id">
                            <label class="people-picker-row">
                                <input
                                    type="checkbox"
                                    :checked="is_selected(person.id)"
                                    @change="toggle(person.id)"
                                >
                                <span class="flex-1 min-w-0">
                                    {{ person_label(person) }}
                                </span>
                            </label>
                        </li>
                    </ul>
                    <p v-else class="meta py-3 flex-1">{{ empty_text }}</p>

                    <div class="app-dialog-actions">
                        <button type="button" class="btn-default" @click="adding = true">
                            New person
                        </button>
                        <button type="button" class="btn-primary" @click="emit('close')">
                            Done
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </Teleport>
</template>

<style scoped>
.app-dialog-backdrop:focus {
    outline: none;
}
</style>
