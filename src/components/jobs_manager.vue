<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { use_dialog } from '../composables/use_dialog'
import { use_jobs } from '../composables/use_jobs'
import { person_name_full, use_people } from '../composables/use_people'
import { use_pipeline } from '../composables/use_pipeline'
import { use_settings } from '../composables/use_settings'
import { error_dialog_show } from '../lib/errors'
import { ipc } from '../lib/ipc'
import { job_duration_text, job_status } from '../lib/job_status'
import { path_file_stem } from '../lib/paths'
import NoticeBanner from './notice_banner.vue'
import RecordingTile from './recording_tile.vue'
import RowMenu from './row_menu.vue'
import StarButton from './star_button.vue'
import type { JobListing, JobMeta, JobSearchHit, JobsViewChoice } from '../types'
import type { RowMenuItem } from './row_menu.vue'


type SortKey = 'date' | 'duration' | 'people' | 'status' | 'title'

interface SortColumn {
    key: SortKey
    label: string
    descending_first: boolean
}

const DURATION_TEXT_NONE = '-:--'

const MESSAGE_DELETE = 'The transcript, the notes, and the copy of the audio kept by scribe are '
    + 'removed. Any original file, including a microphone recording, stays where it is. '
    + 'This cannot be undone.'

const SEARCH_DEBOUNCE_MS = 250
const SEARCH_QUERY_LENGTH_MIN = 2
const MILLISECONDS_PER_SECOND = 1000
const MILLISECONDS_PER_DAY = 24 * 3600 * MILLISECONDS_PER_SECOND

const ROW_MENU_ITEMS: RowMenuItem[] = [
    { id: 'rename', label: 'Rename', icon: 'edit' },
    { id: 'delete', label: 'Delete', icon: 'delete', danger: true },
]

const SORT_COLUMNS: SortColumn[] = [
    { key: 'title', label: 'Title', descending_first: false },
    { key: 'people', label: 'Participants', descending_first: false },
    { key: 'date', label: 'Date', descending_first: true },
    { key: 'duration', label: 'Duration', descending_first: true },
    { key: 'status', label: 'Status', descending_first: false },
]

const { confirm: dialog_confirm } = use_dialog()
const { jobs, error_message, favourite_set, refresh, remove } = use_jobs()
const { person_by_id } = use_people()
const { job_open, job_start_new } = use_pipeline()
const { settings, update: settings_update } = use_settings()
const jobs_view = computed<JobsViewChoice>(() => settings.value.jobs_view ?? 'grid')

function date_format(unix: number): string {
    const date = new Date(unix * MILLISECONDS_PER_SECOND)
    const now = new Date()
    const yesterday = new Date(now.getTime() - MILLISECONDS_PER_DAY)
    const day_is_today = date.toDateString() === now.toDateString()
    const day_is_yesterday = date.toDateString() === yesterday.toDateString()
    const year_is_current = date.getFullYear() === now.getFullYear()
    const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

    if (day_is_today) return `Today, ${time}`
    if (day_is_yesterday) return `Yesterday, ${time}`

    const day_label = date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: year_is_current ? undefined : 'numeric',
    })

    return `${day_label}, ${time}`
}

async function delete_click(job: JobMeta): Promise<void> {
    const ok = await dialog_confirm(
        `Delete "${title_for(job)}"? ${MESSAGE_DELETE}`,
        { title: 'Delete recording', kind: 'warning' },
    )

    if (!ok) return

    try {
        await remove(job.id)
    } catch (error) {
        await error_dialog_show(error)
    }
}

const search_query = ref<string>('')
const sort_key = ref<SortKey | null>(null)
const sort_descending = ref<boolean>(false)
const search_hits = ref<Map<string, JobSearchHit>>(new Map())
const rename_target = ref<JobMeta | null>(null)
const rename_input_value = ref<string>('')
const rename_input_ref = ref<HTMLInputElement | null>(null)
const rename_busy = ref<boolean>(false)
const rename_error = ref<string | null>(null)
let search_timer_id: ReturnType<typeof setTimeout> | null = null
let search_request_token = 0


onMounted(refresh)

onUnmounted(() => {
    if (search_timer_id !== null) {
        clearTimeout(search_timer_id)
        search_timer_id = null
    }
})

watch(search_query, (query) => {
    if (search_timer_id !== null) clearTimeout(search_timer_id)

    search_request_token += 1

    if (query.trim().length < SEARCH_QUERY_LENGTH_MIN) {
        search_hits.value = new Map()
        search_timer_id = null

        return
    }

    const token = search_request_token

    search_timer_id = setTimeout(() => {
        search_timer_id = null

        void search_run(query.trim(), token)
    }, SEARCH_DEBOUNCE_MS)
})

async function favourite_toggle(job: JobMeta): Promise<void> {
    await favourite_set(job.id, !job.favourite)
}

function job_matches(job: JobListing, needle: string): boolean {
    if (search_hits.value.has(job.id)) return true

    const haystack = [job.title, job.label, job.source_path, job.project, ...job.tags]
        .filter((value): value is string => typeof value === 'string')
        .join(' ')
        .toLowerCase()

    return haystack.includes(needle)
}

const jobs_filtered = computed<JobListing[]>(() => {
    const needle = search_query.value.trim().toLowerCase()

    const base = needle.length === 0
        ? jobs.value.slice()
        : jobs.value.filter((job) => job_matches(job, needle))

    return base.sort(sort_compare)
})

function jobs_view_set(view: JobsViewChoice): void {
    void settings_update({ jobs_view: view })
}

async function open(meta: JobMeta): Promise<void> {
    try {
        await job_open(meta, null)
    } catch (error) {
        await error_dialog_show(error)
    }
}

function people_cell_for(job: JobListing): string {
    return search_snippet_for(job) ?? people_text_for(job) ?? 'No participants'
}

function people_text_for(job: JobMeta): string | null {
    const names = job.person_ids
        .map((id) => person_by_id(id))
        .filter((person): person is NonNullable<typeof person> => person !== null)
        .map(person_name_full)

    const listed = names.length > 0 ? names : job.attendees

    if (listed.length === 0) return null

    return listed
        .slice()
        .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
        .join(', ')
}

function rename_close(): void {
    if (rename_busy.value) return

    rename_target.value = null
    rename_input_value.value = ''
    rename_error.value = null
}

function rename_open(job: JobMeta): void {
    rename_target.value = job
    rename_input_value.value = title_for(job)
    rename_error.value = null

    void nextTick(() => {
        rename_input_ref.value?.focus()
        rename_input_ref.value?.select()
    })
}

async function rename_persist(target: JobMeta, title: string): Promise<void> {
    try {
        await ipc.job_meta_update(target.id, { title })
        await refresh()

        rename_target.value = null
        rename_input_value.value = ''
    } catch (error) {
        rename_error.value = String(error)

        await error_dialog_show(error)
    }
}

async function rename_save(): Promise<void> {
    const target = rename_target.value

    if (target === null || rename_busy.value) return

    const next = rename_input_value.value.trim()

    if (next.length === 0) {
        rename_error.value = 'Title cannot be empty.'

        return
    }

    if (next === title_for(target)) {
        rename_close()

        return
    }

    rename_busy.value = true
    rename_error.value = null

    await rename_persist(target, next).finally(() => {
        rename_busy.value = false
    })
}

async function row_menu_select(job: JobMeta, id: string): Promise<void> {
    if (id === 'rename') {
        rename_open(job)

        return
    }

    if (id === 'delete') await delete_click(job)
}

async function search_run(query: string, token: number): Promise<void> {
    try {
        const hits = await ipc.jobs_search(query)

        if (token !== search_request_token) return

        search_hits.value = new Map(hits.map((hit) => [hit.job_id, hit]))
    } catch (error) {
        if (token !== search_request_token) return

        error_message.value = String(error)
    }
}

function search_snippet_for(job: JobMeta): string | null {
    const hit = search_hits.value.get(job.id)

    if (hit === undefined || hit.source === 'title') return null

    return `${hit.source === 'notes' ? 'In notes' : 'In transcript'}: ${hit.snippet}`
}

function sort_aria(column: SortColumn): 'ascending' | 'descending' | 'none' {
    if (sort_key.value !== column.key) return 'none'

    return sort_descending.value ? 'descending' : 'ascending'
}

function sort_compare(left: JobListing, right: JobListing): number {
    const key = sort_key.value
    const by_newest = right.created_at_unix - left.created_at_unix

    if (key === null) {
        const by_favourite = Number(right.favourite) - Number(left.favourite)

        return by_favourite !== 0 ? by_favourite : by_newest
    }

    const value_left = sort_value_of(left, key)
    const value_right = sort_value_of(right, key)

    const order = typeof value_left === 'number' && typeof value_right === 'number'
        ? value_left - value_right
        : String(value_left).localeCompare(String(value_right))

    if (order === 0) return by_newest

    return sort_descending.value ? -order : order
}

function sort_mark(key: SortKey): string {
    if (sort_key.value !== key) return ''

    return sort_descending.value ? '↓' : '↑'
}

function sort_set(column: SortColumn): void {
    if (sort_key.value === column.key) {
        sort_descending.value = !sort_descending.value

        return
    }

    sort_key.value = column.key
    sort_descending.value = column.descending_first
}

function sort_value_of(job: JobListing, key: SortKey): number | string {
    switch (key) {
        case 'date': return job.created_at_unix
        case 'duration': return job.duration_seconds ?? -1
        case 'people': return (people_text_for(job) ?? '').toLowerCase()
        case 'status': return job_status(job).text
        case 'title': return title_for(job).toLowerCase()
    }
}

function title_for(job: JobMeta): string {
    const title = job.title ?? ''
    const label = job.label ?? ''

    if (title.length > 0) return title
    if (label.length > 0) return label

    return path_file_stem(job.source_path)
}
</script>

<template>
    <section class="view-fill">
        <header class="page-header">
            <h2 class="!mb-1">Home</h2>
            <div v-if="jobs.length > 0" class="flex items-center gap-4">
                <button
                    type="button"
                    class="btn-primary"
                    @click="job_start_new"
                >
                    New recording
                </button>
                <div class="view-switch" role="group" aria-label="Layout">
                    <button
                        type="button"
                        class="view-switch-btn"
                        title="Grid"
                        :aria-pressed="jobs_view === 'grid'"
                        @click="jobs_view_set('grid')"
                    >
                        <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.75"
                            aria-hidden="true"
                        >
                            <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
                            <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
                            <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
                            <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
                        </svg>
                    </button>
                    <button
                        type="button"
                        class="view-switch-btn"
                        title="List"
                        :aria-pressed="jobs_view === 'list'"
                        @click="jobs_view_set('list')"
                    >
                        <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.75"
                            stroke-linecap="round"
                            aria-hidden="true"
                        >
                            <path d="M5 7h14" />
                            <path d="M5 12h14" />
                            <path d="M5 17h14" />
                        </svg>
                    </button>
                </div>
            </div>
        </header>

        <NoticeBanner v-if="error_message" class="mb-6" @dismiss="error_message = null">
            {{ error_message }}
        </NoticeBanner>

        <div v-if="jobs.length > 0" class="mb-4">
            <input
                v-model="search_query"
                type="search"
                placeholder="Search"
                aria-label="Search recordings, notes, and transcripts"
                class="input"
            >
        </div>

        <div v-if="jobs.length > 0 && jobs_filtered.length === 0" class="empty-state card">
            <h3>No matches</h3>
            <p class="meta">Nothing matches “{{ search_query }}”.</p>
        </div>

        <div v-else-if="jobs_view === 'list'" class="recording-table-wrap">
            <table class="recording-table">
                <thead>
                    <tr>
                        <th
                            v-for="column in SORT_COLUMNS"
                            :key="column.key"
                            :aria-sort="sort_aria(column)"
                        >
                            <button
                                type="button"
                                class="recording-table-sort"
                                :data-active="sort_key === column.key ? 'true' : 'false'"
                                @click="sort_set(column)"
                            >
                                {{ column.label }}
                                <span class="recording-table-sort-mark" aria-hidden="true">
                                    {{ sort_mark(column.key) }}
                                </span>
                            </button>
                        </th>
                        <th><span class="sr-only">Actions</span></th>
                    </tr>
                </thead>
                <tbody>
                    <tr
                        v-for="job in jobs_filtered"
                        :key="job.id"
                        class="recording-table-row"
                        tabindex="0"
                        @click="open(job)"
                        @keydown.enter="open(job)"
                    >
                        <td class="recording-table-title">{{ title_for(job) }}</td>
                        <td class="recording-table-muted">
                            {{ people_cell_for(job) }}
                        </td>
                        <td class="recording-table-muted recording-table-nowrap">
                            {{ date_format(job.created_at_unix) }}
                        </td>
                        <td class="recording-table-muted recording-table-nowrap">
                            {{ job_duration_text(job) ?? DURATION_TEXT_NONE }}
                        </td>
                        <td class="recording-table-nowrap">
                            <span
                                class="pill recording-tile-status"
                                :data-state="job_status(job).state"
                            >
                                {{ job_status(job).text }}
                            </span>
                        </td>
                        <td @click.stop @keydown.enter.stop>
                            <div class="recording-table-actions">
                                <StarButton
                                    :favourite="job.favourite"
                                    :title="title_for(job)"
                                    @toggle="favourite_toggle(job)"
                                />
                                <span class="recording-tile-menu">
                                    <RowMenu
                                        :label="title_for(job)"
                                        :items="ROW_MENU_ITEMS"
                                        @select="row_menu_select(job, $event)"
                                    />
                                </span>
                            </div>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>

        <div v-else class="recording-grid">
            <button type="button" class="recording-tile recording-tile-new" @click="job_start_new">
                <span class="recording-tile-new-icon" aria-hidden="true">
                    <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.75"
                        stroke-linecap="round"
                    >
                        <path d="M12 5v14" />
                        <path d="M5 12h14" />
                    </svg>
                </span>
                <span>New recording</span>
            </button>
            <RecordingTile
                v-for="job in jobs_filtered"
                :key="job.id"
                :job="job"
                :title="title_for(job)"
                :when="date_format(job.created_at_unix)"
                :people="people_text_for(job)"
                :snippet="search_snippet_for(job)"
                :menu_items="ROW_MENU_ITEMS"
                @open="open(job)"
                @favourite="favourite_toggle(job)"
                @menu="row_menu_select(job, $event)"
            />
        </div>

        <Teleport to="body">
            <Transition name="app-dialog">
                <div
                    v-if="rename_target"
                    class="app-dialog-backdrop"
                    role="dialog"
                    aria-modal="true"
                    @mousedown.left.self.prevent="rename_close"
                    @keydown.esc="rename_close"
                >
                    <div class="app-dialog">
                        <button
                            type="button"
                            class="app-dialog-close"
                            aria-label="Close"
                            title="Close"
                            @click="rename_close"
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
                        <h3 class="app-dialog-title">Rename recording</h3>
                        <label class="label">Title</label>
                        <input
                            ref="rename_input_ref"
                            v-model="rename_input_value"
                            type="search"
                            class="input"
                            :disabled="rename_busy"
                            @keydown.enter.prevent="rename_save"
                            @keydown.esc.prevent="rename_close"
                        >
                        <p v-if="rename_error" class="error text-sm mt-3">
                            {{ rename_error }}
                        </p>
                        <div class="app-dialog-actions">
                            <button
                                class="btn-default"
                                :disabled="rename_busy"
                                @click="rename_close"
                            >
                                Cancel
                            </button>
                            <button
                                class="btn-primary"
                                :disabled="rename_busy"
                                @click="rename_save"
                            >
                                {{ rename_busy ? 'Saving...' : 'Save' }}
                            </button>
                        </div>
                    </div>
                </div>
            </Transition>
        </Teleport>
    </section>
</template>
