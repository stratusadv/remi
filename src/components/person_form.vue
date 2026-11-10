<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Person } from '../types'


const props = defineProps<{
    person: Person | null
}>()

const emit = defineEmits<{
    cancel: []
    save: [person: Person]
}>()

const PLACEHOLDER_DESCRIPTION = 'Say what the AI should know: what they look after, how they '
    + 'relate to the project, and how they usually come up in meetings.'

const name_first = ref(props.person?.name_first ?? '')
const name_last = ref(props.person?.name_last ?? '')
const role = ref(props.person?.role ?? '')
const description = ref(props.person?.description ?? '')
const can_save = computed(() => name_first.value.trim().length > 0)


function save_click(): void {
    if (!can_save.value) return

    emit('save', {
        id: props.person?.id ?? crypto.randomUUID(),
        name_first: name_first.value.trim(),
        name_last: name_last.value.trim(),
        role: role.value.trim(),
        description: description.value.trim(),
    })
}
</script>

<template>
    <div class="flex flex-col gap-4 flex-1 min-h-0">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
                <label class="label">First name</label>
                <input
                    v-model="name_first"
                    type="search"
                    class="input"
                    maxlength="120"
                    placeholder="e.g. John"
                    @keydown.enter.prevent="save_click"
                >
            </div>
            <div>
                <label class="label">Last name</label>
                <input
                    v-model="name_last"
                    type="search"
                    class="input"
                    maxlength="120"
                    placeholder="e.g. Doe"
                    @keydown.enter.prevent="save_click"
                >
            </div>
        </div>

        <div>
            <label class="label">Role</label>
            <input
                v-model="role"
                type="search"
                class="input"
                maxlength="120"
                placeholder="e.g. project manager, accountant, sales rep"
                @keydown.enter.prevent="save_click"
            >
        </div>

        <div class="flex flex-col flex-1 min-h-0">
            <label class="label">Description</label>
            <textarea
                v-model="description"
                rows="3"
                class="input flex-1 min-h-0 resize-none"
                maxlength="2000"
                :placeholder="PLACEHOLDER_DESCRIPTION"
            />
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
    </div>
</template>
