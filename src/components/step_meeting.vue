<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { use_jobs } from '../composables/use_jobs'
import { use_notes_templates } from '../composables/use_notes_templates'
import { person_label, person_name_full, use_people } from '../composables/use_people'
import { use_pipeline } from '../composables/use_pipeline'
import { ipc } from '../lib/ipc'
import NoticeBanner from './notice_banner.vue'
import PeoplePicker from './people_picker.vue'
import StepBar from './step_bar.vue'
import type { JobMetaPatch, Person } from '../types'


type PickerTarget = 'present' | 'mentioned'
type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved'
const AUTOSAVE_DEBOUNCE_MS = 800

const PICKER_HINT_MENTIONED = 'Tick people who came up in conversation but were not there. '
    + 'The AI will recognise them by name and role.'

const PICKER_HINT_PRESENT = 'Tick each person who was there. The AI uses their role and '
    + 'description to tell who is speaking.'

const {
    job_id_current,
    meta_current,
    template_id_selected,
    meta_refresh,
    template_id_ensure,
    view_set,
} = use_pipeline()

const { refresh: jobs_refresh } = use_jobs()
const { person_by_id } = use_people()
const { templates } = use_notes_templates()
const title_input = ref('')
const person_ids_current = ref<string[]>([])
const person_ids_mentioned = ref<string[]>([])
const attendees_legacy = ref<string[]>([])
const picker_target = ref<PickerTarget | null>(null)
const project_input = ref('')
const tags_current = ref<string[]>([])
const status = ref<SaveStatus>('idle')
const error_message = ref<string | null>(null)
let timer_id: ReturnType<typeof setTimeout> | null = null
let job_id_pending: string | null = null
let patch_pending: JobMetaPatch | null = null
let patch_synced = ''


async function autosave_flush(): Promise<void> {
    const job_id = job_id_pending
    const patch = patch_pending

    timer_id = null
    job_id_pending = null
    patch_pending = null

    if (job_id === null || patch === null) return

    status.value = 'saving'
    error_message.value = null

    try {
        const updated = await ipc.job_meta_update(job_id, patch)

        if (job_id_current.value !== job_id || autosave_pending()) return

        meta_current.value = updated
        status.value = 'saved'
    } catch (error) {
        status.value = 'idle'
        error_message.value = String(error)

        await meta_refresh()
    }
}

const people_present = computed(() => people_resolve(person_ids_current.value))
const people_mentioned = computed(() => people_resolve(person_ids_mentioned.value))

const picker_ids = computed({
    get: () => {
        if (picker_target.value === 'mentioned') return person_ids_mentioned.value

        return person_ids_current.value
    },
    set: (ids: string[]) => {
        if (picker_target.value === 'mentioned') {
            person_ids_mentioned.value = ids

            return
        }

        person_ids_current.value = ids
    },
})

const picker_title = computed(() =>
    picker_target.value === 'mentioned' ? 'Who was talked about?' : 'Who was in the meeting?')

const picker_hint = computed(() =>
    picker_target.value === 'mentioned' ? PICKER_HINT_MENTIONED : PICKER_HINT_PRESENT)

const can_continue = computed(
    () => status.value !== 'saving' && template_id_selected.value !== null,
)

onMounted(() => {
    template_id_ensure()
})

onUnmounted(() => {
    if (timer_id === null) return

    clearTimeout(timer_id)

    void autosave_flush().then(jobs_refresh)
})

watch(
    () => meta_current.value,
    (meta) => {
        if (meta === null) {
            title_input.value = ''
            person_ids_current.value = []
            person_ids_mentioned.value = []
            attendees_legacy.value = []
            project_input.value = ''
            tags_current.value = []
            patch_synced = ''

            return
        }

        title_input.value = meta.title ?? ''
        person_ids_current.value = [...meta.person_ids]
        person_ids_mentioned.value = [...meta.person_ids_mentioned]
        attendees_legacy.value = meta.person_ids.length === 0 ? [...meta.attendees] : []
        project_input.value = meta.project ?? ''
        tags_current.value = [...meta.tags]
        patch_synced = JSON.stringify(patch_build())
    },
    { immediate: true },
)

watch(
    [title_input, person_ids_current, person_ids_mentioned, project_input, tags_current],
    () => {
        if (job_id_current.value === null) return
        if (!autosave_pending() && JSON.stringify(patch_build()) === patch_synced) return

        autosave_schedule()
    },
    { deep: true },
)

function autosave_pending(): boolean {
    return timer_id !== null
}

function autosave_schedule(): void {
    status.value = 'pending'
    job_id_pending = job_id_current.value
    patch_pending = patch_build()

    if (timer_id !== null) clearTimeout(timer_id)

    timer_id = setTimeout(() => {
        void autosave_flush()
    }, AUTOSAVE_DEBOUNCE_MS)
}

function back(): void {
    view_set('transcribe')
}

async function next(): Promise<void> {
    if (timer_id !== null) {
        clearTimeout(timer_id)

        await autosave_flush()
    }

    view_set('notes')
}

function patch_build(): JobMetaPatch {
    const people = people_present.value

    return {
        title: title_input.value.trim(),
        attendees: people.length > 0 ? people.map(person_name_full) : attendees_legacy.value,
        person_ids: people.map((person) => person.id),
        person_ids_mentioned: people_mentioned.value.map((person) => person.id),
        project: project_input.value.trim(),
        tags: [...tags_current.value],
    }
}

function people_resolve(ids: string[]): Person[] {
    return ids.map(person_by_id).filter((person): person is Person => person !== null)
}

function person_mentioned_remove(id: string): void {
    person_ids_mentioned.value = person_ids_mentioned.value.filter((selected) => selected !== id)
}

function person_remove(id: string): void {
    person_ids_current.value = person_ids_current.value.filter((selected) => selected !== id)
}
</script>

<template>
    <section class="view-fill step-view">
        <StepBar />

        <NoticeBanner v-if="error_message" @dismiss="error_message = null">
            {{ error_message }}
        </NoticeBanner>

        <div class="step-form flex-1">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div class="step-field">
                    <label class="label" for="details-title">Title</label>
                    <input
                        id="details-title"
                        v-model="title_input"
                        type="search"
                        class="input"
                    >
                </div>

                <div class="step-field">
                    <label class="label" for="details-template">Template</label>
                    <select id="details-template" v-model="template_id_selected" class="input">
                        <option :value="null" disabled>Choose a template</option>
                        <option
                            v-for="template in templates"
                            :key="template.id"
                            :value="template.id"
                        >
                            {{ template.name }}
                        </option>
                    </select>
                    <p v-if="templates.length === 0" class="meta">
                        There are no templates yet.
                        <button type="button" class="underline" @click="view_set('templates')">
                            Add one
                        </button>
                    </p>
                </div>
            </div>

            <div class="step-field">
                <span class="label">In the meeting</span>
                <div class="meeting-details-people">
                    <button
                        type="button"
                        class="meeting-details-add"
                        @click="picker_target = 'present'"
                    >
                        + Add
                    </button>
                    <span v-for="person in people_present" :key="person.id" class="pill tag-chip">
                        {{ person_label(person) }}
                        <button
                            type="button"
                            class="tag-chip-remove"
                            :aria-label="`Remove ${person_name_full(person)}`"
                            @click="person_remove(person.id)"
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
                <p v-if="attendees_legacy.length > 0" class="meta">
                    These names are from before People existed: {{ attendees_legacy.join(', ') }}
                </p>
            </div>

            <div class="step-field">
                <span class="label">Mentioned</span>
                <div class="meeting-details-people">
                    <button
                        type="button"
                        class="meeting-details-add"
                        @click="picker_target = 'mentioned'"
                    >
                        + Add
                    </button>
                    <span v-for="person in people_mentioned" :key="person.id" class="pill tag-chip">
                        {{ person_label(person) }}
                        <button
                            type="button"
                            class="tag-chip-remove"
                            :aria-label="`Remove ${person_name_full(person)}`"
                            @click="person_mentioned_remove(person.id)"
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
        </div>

        <footer class="step-footer">
            <div class="step-footer-start">
                <button class="btn-default" @click="back">Back</button>
            </div>
            <div class="actions-row">
                <button class="btn-primary" :disabled="!can_continue" @click="next">Next</button>
            </div>
        </footer>

        <PeoplePicker
            v-if="picker_target !== null"
            v-model:ids_selected="picker_ids"
            :title="picker_title"
            :hint="picker_hint"
            @close="picker_target = null"
        />
    </section>
</template>
