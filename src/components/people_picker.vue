<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { person_label, person_name_full, use_people } from '../composables/use_people'
import { error_dialog_show } from '../lib/errors'
import PersonForm from './person_form.vue'
import type { Group, Person } from '../types'


const props = defineProps<{
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
const filter_input_ref = ref<HTMLInputElement | null>(null)

const people_filtered = computed(() => {
    const needle = filter_text.value.trim().toLowerCase()

    if (needle.length === 0) return people_sorted.value

    return people_sorted.value.filter((person) =>
        `${person_name_full(person)} ${person.role}`.toLowerCase().includes(needle))
})

const groups_shown = computed(() => {
    if (props.groups_hidden) return []

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
    const count = group_members(group).length

    return `${String(count)} ${count === 1 ? 'person' : 'people'}`
}

function group_is_selected(group: Group): boolean {
    return group_members(group).every((person) => is_selected(person.id))
}

function group_toggle(group: Group): void {
    const member_ids = group_members(group).map((person) => person.id)

    const next = group_is_selected(group)
        ? ids_selected.value.filter((selected) => !member_ids.includes(selected))
        : [...ids_selected.value, ...member_ids.filter((id) => !is_selected(id))]

    ids_selected.value = next
}

function is_selected(id: string): boolean {
    return ids_selected.value.includes(id)
}

async function person_create(person: Person): Promise<void> {
    try {
        await save(person)

        if (error_message.value !== null) {
            await error_dialog_show(error_message.value)

            return
        }

        adding.value = false
        filter_text.value = ''
        ids_selected.value = [...ids_selected.value, person.id]
    } catch (error) {
        await error_dialog_show(error)
    }
}

function toggle(id: string): void {
    const next = is_selected(id)
        ? ids_selected.value.filter((selected) => selected !== id)
        : [...ids_selected.value, id]

    ids_selected.value = next
}

onMounted(async () => {
    await refresh()
    filter_input_ref.value?.focus()
})
</script>

<template>
    <Teleport to="body">
        <div
            class="app-dialog-backdrop"
            role="dialog"
            aria-modal="true"
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
                <h3 class="app-dialog-title">{{ props.title }}</h3>
                <p class="app-dialog-message">{{ props.hint }}</p>

                <div v-if="!adding" class="people-picker-body">
                    <input
                        ref="filter_input_ref"
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

                <PersonForm v-else :person="null" @cancel="adding = false" @save="person_create" />
            </div>
        </div>
    </Teleport>
</template>
