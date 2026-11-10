<script setup lang="ts">
import { computed, ref } from 'vue'
import { person_label, person_name_full, use_people } from '../composables/use_people'
import PeoplePicker from './people_picker.vue'
import type { Group, Person } from '../types'


const props = defineProps<{
    group: Group | null
}>()

const emit = defineEmits<{
    cancel: []
    save: [group: Group]
}>()

const HINT_PICKER = 'Tick everyone who belongs to the group. Picking the group on the Meeting '
    + 'step adds all of them at once.'

const { person_by_id } = use_people()
const name = ref(props.group?.name ?? '')
const person_ids = ref<string[]>([...(props.group?.person_ids ?? [])])
const picker_open = ref(false)
const can_save = computed(() => name.value.trim().length > 0)

const members = computed(() =>
    person_ids.value.map(person_by_id).filter((person): person is Person => person !== null))


function member_remove(id: string): void {
    person_ids.value = person_ids.value.filter((selected) => selected !== id)
}

function save_click(): void {
    if (!can_save.value) return

    emit('save', {
        id: props.group?.id ?? crypto.randomUUID(),
        name: name.value.trim(),
        person_ids: members.value.map((person) => person.id),
    })
}
</script>

<template>
    <div class="flex flex-col gap-4 flex-1 min-h-0">
        <div>
            <label class="label">Group name</label>
            <input
                v-model="name"
                type="search"
                class="input"
                maxlength="120"
                placeholder="e.g. Managers, Developers, Floor staff"
            >
        </div>

        <div class="step-field">
            <span class="label">Members</span>
            <div class="meeting-details-people">
                <button type="button" class="meeting-details-add" @click="picker_open = true">
                    + Add
                </button>
                <span v-for="person in members" :key="person.id" class="pill tag-chip">
                    {{ person_label(person) }}
                    <button
                        type="button"
                        class="tag-chip-remove"
                        :aria-label="`Remove ${person_name_full(person)}`"
                        @click="member_remove(person.id)"
                    >
                        <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2.5"
                            stroke-linecap="round"
                            aria-hidden="true"
                        >
                            <path d="M6 6l12 12" />
                            <path d="M18 6L6 18" />
                        </svg>
                    </button>
                </span>
            </div>
        </div>

        <div class="actions-row">
            <button type="button" class="btn-default" @click="emit('cancel')">Cancel</button>
            <button
                type="button"
                class="btn-primary"
                :disabled="!can_save"
                @click="save_click"
            >
                Save
            </button>
        </div>

        <PeoplePicker
            v-if="picker_open"
            v-model:ids_selected="person_ids"
            title="Who is in this group?"
            :hint="HINT_PICKER"
            groups_hidden
            @close="picker_open = false"
        />
    </div>
</template>
