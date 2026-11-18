<script setup lang="ts">
import {
    computed,
    nextTick,
    onMounted,
    onUnmounted,
    ref,
    shallowRef,
    useTemplateRef,
    watch,
} from 'vue'
import { use_ask } from '../composables/use_ask'
import { use_context_menu } from '../composables/use_context_menu'
import { use_dialog } from '../composables/use_dialog'
import { use_folders } from '../composables/use_folders'
import { use_job_drag } from '../composables/use_job_drag'
import { use_jobs } from '../composables/use_jobs'
import { use_modal } from '../composables/use_modal'
import { person_name_full, use_people } from '../composables/use_people'
import { use_pipeline } from '../composables/use_pipeline'
import { use_settings } from '../composables/use_settings'
import { assert } from '../lib/assert'
import { seconds_to_clock_hours } from '../lib/duration'
import { error_dialog_show, error_shown } from '../lib/errors'
import { FOLDERS_LISTED_MAX, folder_key } from '../lib/folders'
import { ipc } from '../lib/ipc'
import { job_askable, job_duration_text, job_title } from '../lib/job_status'
import {
    MENU_ITEM_ASK,
    MENU_ITEM_DELETE,
    MENU_ITEM_FOLDER_LEAVE,
    MENU_ITEM_MOVE,
    MENU_ITEM_RENAME,
} from '../lib/menu'
import { transition_leave_inert } from '../lib/transition'
import AskButton from './ask_button.vue'
import FolderMoveDialog from './folder_move_dialog.vue'
import FolderTag from './folder_tag.vue'
import JobDragGhost from './job_drag_ghost.vue'
import NoticeBanner from './notice_banner.vue'
import RecordingTile from './recording_tile.vue'
import RowMenu from './row_menu.vue'
import SidebarIcon from './sidebar_icon.vue'
import StarButton from './star_button.vue'
import type { MenuItem } from '../lib/menu'
import type { FolderName, JobListing, JobMeta, JobSearchHit, JobsViewChoice } from '../types'


type SortKey = 'date' | 'duration' | 'people' | 'title'

interface SortColumn {
    key: SortKey
    label: string
    descending_first: boolean
}

const DURATION_TEXT_NONE = '-:--'

const MESSAGE_DELETE = 'The transcript, the notes, and the copy of the audio kept by remi are '
    + 'removed. Any original file, including a microphone recording, stays where it is. '
    + 'This cannot be undone.'

const SEARCH_DEBOUNCE_MS = 250
const SEARCH_QUERY_LENGTH_MIN = 2
const MILLISECONDS_PER_SECOND = 1000
const MILLISECONDS_PER_DAY = 24 * 3600 * MILLISECONDS_PER_SECOND

const ROW_MENU_ITEMS = Object.freeze<MenuItem[]>([
    MENU_ITEM_RENAME,
    MENU_ITEM_MOVE,
    MENU_ITEM_FOLDER_LEAVE,
    MENU_ITEM_DELETE,
])

const SORT_COLUMNS = Object.freeze<SortColumn[]>([
    { key: 'title', label: 'Title', descending_first: false },
    { key: 'people', label: 'Participants', descending_first: false },
    { key: 'date', label: 'Date', descending_first: true },
    { key: 'duration', label: 'Duration', descending_first: true },
])

const { folder_ask, meeting_ask } = use_ask()
const { open: context_menu_open } = use_context_menu()
const { confirm: dialog_confirm } = use_dialog()
const { drag_press } = use_job_drag()
const { jobs, error_message, favourite_set, refresh, remove } = use_jobs()
const { person_by_id } = use_people()
const { job_open, job_open_at, job_start_new, view_reopen } = use_pipeline()

const {
    folder_close,
    folder_current,
    folder_jobs,
    folder_menu_items,
    folder_menu_select,
    folder_move,
    folders,
} = use_folders()

const { settings, update: settings_update } = use_settings()
const jobs_view = computed<JobsViewChoice>(() => settings.value.jobs_view ?? 'grid')

function date_format(unix: number): string {
    assert(Number.isSafeInteger(unix))
    assert(unix >= 0)

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
    assert(job.id.length > 0)

    const question = `Delete "${job_title(job)}"? ${MESSAGE_DELETE}`

    return dialog_confirm(question, { title: 'Delete recording', kind: 'warning' })
        .then(async (ok) => {
            if (!ok) return

            await remove(job.id).catch(error_dialog_show)
        })
}

const search_query = ref<string>('')
const sort_key = ref<SortKey | null>(null)
const sort_descending = ref<boolean>(false)
const search_hits = ref<Map<string, JobSearchHit>>(new Map())
const rename_target = ref<JobMeta | null>(null)
const rename_input_value = ref<string>('')
const rename_input_element = useTemplateRef<HTMLInputElement>('rename_input_element')
const rename_busy = ref<boolean>(false)
const rename_error = ref<string | null>(null)
const move_target = ref<JobMeta | null>(null)
const rename_covered = use_modal('dialog', () => rename_target.value !== null)

const folder_names = computed(() => {
    const names = new Map(folders.value.map((folder) => [folder_key(folder), folder]))

    assert(names.size <= FOLDERS_LISTED_MAX)

    return names
})

const jobs_shown = computed<JobListing[]>(() => {
    const folder = folder_current.value

    return folder === null ? jobs.value : folder_jobs(folder)
})

const search_timer_id = shallowRef<ReturnType<typeof setTimeout> | null>(null)
const search_request_token = shallowRef(0)


onMounted(refresh)

onUnmounted(() => {
    if (search_timer_id.value !== null) {
        clearTimeout(search_timer_id.value)
        search_timer_id.value = null
    }
})

watch(search_query, (query) => {
    assert(query === search_query.value)

    if (search_timer_id.value !== null) clearTimeout(search_timer_id.value)

    search_request_token.value += 1

    if (query.trim().length < SEARCH_QUERY_LENGTH_MIN) {
        search_hits.value = new Map()
        search_timer_id.value = null

        return
    }

    const fire = search_fire.bind(undefined, query.trim(), search_request_token.value)

    search_timer_id.value = setTimeout(fire, SEARCH_DEBOUNCE_MS)
})

async function favourite_toggle(job: JobMeta): Promise<void> {
    assert(job.id.length > 0)
    assert(jobs_filtered.value.some((shown) => shown.id === job.id))

    return favourite_set(job.id, !job.favourite)
}

async function folder_action(id: string): Promise<void> {
    assert(id.length > 0)

    const folder = folder_current.value

    if (folder === null) return

    assert(folder_menu_items(folder).some((item) => item.id === id))

    return folder_menu_select(folder, id).catch(error_dialog_show)
}

function folder_context_menu(event: MouseEvent): void {
    assert(event.type === 'contextmenu')

    const folder = folder_current.value

    if (folder === null) return

    context_menu_open(event, folder_menu_items(folder), folder_menu_select.bind(undefined, folder))
}

async function folder_leave(job: JobMeta): Promise<void> {
    assert(job.id.length > 0)
    assert(folder_key(job.project ?? '').length > 0)

    return folder_move(job, null).catch(error_dialog_show)
}

function folder_tag_for(job: JobListing): FolderName | null {
    assert(job.id.length > 0)
    assert(job.project === null || typeof job.project === 'string')

    if (folder_current.value !== null) return null

    const project = job.project?.trim() ?? ''

    if (project.length === 0) return null

    return folder_names.value.get(folder_key(project)) ?? project
}

function home_open(): void {
    assert(folder_current.value !== null)

    folder_close()

    assert(jobs_shown.value === jobs.value)

    view_reopen('jobs')
}

function job_matches(job: JobListing, needle: string): boolean {
    assert(job.id.length > 0)
    assert(needle.length > 0)
    assert(needle === search_query.value.trim().toLowerCase())

    if (search_hits.value.has(job.id)) return true

    const fields = [
        job.title,
        job.label,
        job.source_path,
        job.project,
        ...job.tags,
        ...job.attendees,
        ...person_names_of([...job.person_ids, ...job.person_ids_mentioned]),
    ]

    const haystack = fields
        .filter((value): value is string => typeof value === 'string')
        .join(' ')
        .toLowerCase()

    return haystack.includes(needle)
}

const jobs_filtered = computed<JobListing[]>(() => {
    const needle = search_query.value.trim().toLowerCase()

    const base = needle.length === 0
        ? jobs_shown.value.slice()
        : jobs_shown.value.filter((job) => job_matches(job, needle))

    return base.sort(sort_compare)
})

function jobs_view_set(view: JobsViewChoice): void {
    assert(view.length > 0)
    assert(jobs_shown.value.length > 0)

    void settings_update({ jobs_view: view })
}

async function open(meta: JobMeta): Promise<void> {
    assert(meta.id.length > 0)

    const hit = search_hits.value.get(meta.id)

    assert(hit === undefined || hit.job_id === meta.id)
    assert(hit === undefined || search_query.value.trim().length >= SEARCH_QUERY_LENGTH_MIN)

    const opening = hit === undefined ? job_open(meta, null) : job_open_at(meta, hit)

    return opening.catch(error_dialog_show)
}

function people_cell_for(job: JobListing): string {
    assert(job.id.length > 0)

    return search_snippet_for(job) ?? people_text_for(job) ?? 'No participants'
}

function people_text_for(job: JobMeta): string | null {
    assert(job.id.length > 0)

    const names = person_names_of(job.person_ids)
    const listed = names.length > 0 ? names : job.attendees

    if (listed.length === 0) return null

    return listed
        .slice()
        .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
        .join(', ')
}

function person_names_of(ids: string[]): string[] {
    assert(ids.every((id) => id.length > 0))

    const names = ids
        .map((id) => person_by_id(id))
        .filter((person): person is NonNullable<typeof person> => person !== null)
        .map(person_name_full)

    assert(names.length <= ids.length)

    return names
}

function rename_close(): void {
    assert(!rename_busy.value || rename_target.value !== null)

    if (rename_busy.value) return

    rename_target.value = null
    rename_input_value.value = ''
    rename_error.value = null
}

function rename_open(job: JobMeta): void {
    assert(job.id.length > 0)

    rename_target.value = job
    rename_input_value.value = job_title(job)
    rename_error.value = null

    void nextTick(() => {
        rename_input_element.value?.focus()
        rename_input_element.value?.select()
    })
}

async function rename_persist(target: JobMeta, title: string): Promise<void> {
    assert(target.id.length > 0)
    assert(title.length > 0)
    assert(title === title.trim())
    assert(rename_busy.value)

    return ipc.job_meta_update(target.id, { title })
        .then(refresh)
        .then(() => {
            rename_target.value = null
            rename_input_value.value = ''
        })
        .catch(async (error: unknown) => {
            rename_error.value = error_shown(error)

            await error_dialog_show(error)
        })
}

async function rename_save(): Promise<void> {
    const target = rename_target.value

    if (target === null) return
    if (rename_busy.value) return

    assert(target.id.length > 0)

    const next = rename_input_value.value.trim()

    if (next.length === 0) {
        rename_error.value = 'Title cannot be empty.'

        return
    }

    if (next === job_title(target)) {
        rename_close()

        return
    }

    rename_busy.value = true
    rename_error.value = null

    return rename_persist(target, next).finally(() => {
        rename_busy.value = false
    })
}

function row_context_menu(event: MouseEvent, job: JobListing): void {
    assert(event.type === 'contextmenu')
    assert(job.id.length > 0)

    context_menu_open(event, row_menu_items(job), row_menu_select.bind(undefined, job))
}

function row_menu_items(job: JobListing): MenuItem[] {
    assert(job.id.length > 0)
    assert(ROW_MENU_ITEMS.every((item) => item.id !== MENU_ITEM_ASK.id))

    const filed = folder_key(job.project ?? '').length > 0
    const items = ROW_MENU_ITEMS.filter((item) => filed || item.id !== MENU_ITEM_FOLDER_LEAVE.id)

    return job_askable(job) ? [MENU_ITEM_ASK, ...items] : items
}

async function row_menu_select(job: JobMeta, id: string): Promise<void> {
    assert(job.id.length > 0)
    assert(id === MENU_ITEM_ASK.id || ROW_MENU_ITEMS.some((item) => item.id === id))

    if (id === MENU_ITEM_ASK.id) return meeting_ask(job.id)
    if (id === MENU_ITEM_FOLDER_LEAVE.id) return folder_leave(job)

    if (id === MENU_ITEM_RENAME.id) {
        rename_open(job)

        return
    }

    if (id === MENU_ITEM_MOVE.id) {
        move_target.value = job

        return
    }

    assert(id === MENU_ITEM_DELETE.id, `no row action is named ${id}`)

    return delete_click(job)
}

function search_fire(query: string, token: number): void {
    assert(query.length >= SEARCH_QUERY_LENGTH_MIN)
    assert(token === search_request_token.value)

    search_timer_id.value = null

    void search_run(query, token)
}

async function search_run(query: string, token: number): Promise<void> {
    assert(query.length >= SEARCH_QUERY_LENGTH_MIN)
    assert(query === query.trim())
    assert(token <= search_request_token.value)

    return ipc.jobs_search(query)
        .then((hits) => {
            if (token !== search_request_token.value) return

            search_hits.value = new Map(hits.map((hit) => [hit.job_id, hit]))
        })
        .catch((error: unknown) => {
            if (token !== search_request_token.value) return

            error_message.value = error_shown(error)
        })
}

function search_snippet_for(job: JobMeta): string | null {
    assert(job.id.length > 0)

    const hit = search_hits.value.get(job.id)

    if (hit === undefined) return null

    assert(hit.job_id === job.id)
    assert(search_query.value.trim().length >= SEARCH_QUERY_LENGTH_MIN)

    if (hit.source === 'notes') return `In notes: ${hit.snippet}`
    if (hit.start_seconds === null) return `In transcript: ${hit.snippet}`

    return `In transcript: ${seconds_to_clock_hours(hit.start_seconds)} · ${hit.snippet}`
}

function sort_aria(column: SortColumn): 'ascending' | 'descending' | 'none' {
    assert(SORT_COLUMNS.includes(column))

    if (sort_key.value !== column.key) return 'none'

    return sort_descending.value ? 'descending' : 'ascending'
}

function sort_compare(left: JobListing, right: JobListing): number {
    assert(Number.isSafeInteger(left.created_at_unix))
    assert(Number.isSafeInteger(right.created_at_unix))

    const key = sort_key.value
    const by_newest = right.created_at_unix - left.created_at_unix

    assert(Number.isSafeInteger(by_newest))

    if (key === null) {
        const by_favourite = Number(right.favourite) - Number(left.favourite)

        return by_favourite === 0 ? by_newest : by_favourite
    }

    const value_left = sort_value_of(left, key)
    const value_right = sort_value_of(right, key)

    const order = typeof value_left === 'number' && typeof value_right === 'number'
        ? value_left - value_right
        : String(value_left).localeCompare(String(value_right))

    assert(Number.isFinite(order))

    if (order === 0) return by_newest

    return sort_descending.value ? -order : order
}

function sort_mark(key: SortKey): string {
    assert(SORT_COLUMNS.some((column) => column.key === key))

    if (sort_key.value !== key) return ''

    return sort_descending.value ? '↓' : '↑'
}

function sort_set(column: SortColumn): void {
    assert(SORT_COLUMNS.includes(column))

    if (sort_key.value === column.key) {
        sort_descending.value = !sort_descending.value

        return
    }

    sort_key.value = column.key
    sort_descending.value = column.descending_first

    assert(sort_aria(column) !== 'none')
}

function sort_value_of(job: JobListing, key: SortKey): number | string {
    assert(job.duration_seconds === null || job.duration_seconds >= 0)
    assert(key === sort_key.value)

    switch (key) {
        case 'date': return job.created_at_unix
        case 'duration': return job.duration_seconds ?? -1
        case 'people': return (people_text_for(job) ?? '').toLowerCase()
        case 'title': return job_title(job).toLowerCase()
    }
}
</script>

<template>
    <section class="view-fill">
        <header class="page-header">
            <div class="min-w-0">
                <p class="eyebrow page-eyebrow">
                    {{ folder_current === null ? 'Your meetings' : 'Folder' }}
                </p>
                <h2 v-if="folder_current === null" class="!mb-1">Home</h2>
                <div
                    v-else
                    class="folder-heading"
                    @contextmenu="folder_context_menu"
                >
                    <button type="button" class="folder-crumb" @click="home_open">Home</button>
                    <svg
                        class="folder-crumb-separator"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.75"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                    >
                        <path d="M9 6l6 6-6 6" />
                    </svg>
                    <SidebarIcon name="folder" />
                    <h2 class="folder-heading-title !mb-0">{{ folder_current }}</h2>
                    <RowMenu
                        :label="folder_current"
                        :items="folder_menu_items(folder_current)"
                        @select="folder_action"
                    />
                </div>
            </div>
            <div v-if="jobs_shown.length > 0" class="flex items-center gap-4">
                <button
                    v-if="folder_current === null"
                    type="button"
                    class="btn-primary"
                    @click="job_start_new"
                >
                    New recording
                </button>
                <button
                    v-else-if="jobs_shown.some(job_askable)"
                    type="button"
                    class="btn-primary"
                    @click="folder_ask(folder_current)"
                >
                    Ask about this folder
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

        <div v-if="jobs_shown.length > 0" class="mb-4">
            <input
                v-model="search_query"
                type="search"
                placeholder="Search"
                aria-label="Search recordings, notes, and transcripts"
                class="input"
            >
        </div>

        <div
            v-if="folder_current !== null && jobs_shown.length === 0"
            class="empty-state card"
        >
            <span class="empty-state-icon" aria-hidden="true">
                <SidebarIcon name="folder" />
            </span>
            <h3>This folder is empty</h3>
            <p class="meta">
                Drag a recording from Home onto this folder in the sidebar, or right-click it
                and choose Move to folder.
            </p>
        </div>

        <div
            v-else-if="jobs_shown.length > 0 && jobs_filtered.length === 0"
            class="empty-state card"
        >
            <h3>No matches</h3>
            <p class="meta">Nothing matches “{{ search_query }}”.</p>
        </div>

        <div
            v-else-if="jobs_view === 'list' && jobs_shown.length > 0"
            class="recording-table-wrap"
        >
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
                        @contextmenu="row_context_menu($event, job)"
                        @keydown.enter="open(job)"
                        @pointerdown="drag_press($event, job)"
                    >
                        <td>
                            <div class="recording-table-name">
                                <span class="recording-table-title">{{ job_title(job) }}</span>
                                <FolderTag :name="folder_tag_for(job)" />
                            </div>
                        </td>
                        <td class="recording-table-muted">
                            {{ people_cell_for(job) }}
                        </td>
                        <td class="recording-table-muted recording-table-nowrap">
                            {{ date_format(job.created_at_unix) }}
                        </td>
                        <td class="recording-table-muted recording-table-nowrap">
                            {{ job_duration_text(job) ?? DURATION_TEXT_NONE }}
                        </td>
                        <td @click.stop @keydown.enter.stop>
                            <div class="recording-table-actions">
                                <StarButton
                                    :favourite="job.favourite"
                                    :title="job_title(job)"
                                    @toggle="favourite_toggle(job)"
                                />
                                <AskButton
                                    v-if="job_askable(job)"
                                    :title="job_title(job)"
                                    @ask="meeting_ask(job.id)"
                                />
                                <span class="recording-tile-menu">
                                    <RowMenu
                                        :label="job_title(job)"
                                        :items="row_menu_items(job)"
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
            <button
                v-if="folder_current === null"
                type="button"
                class="recording-tile recording-tile-new"
                @click="job_start_new"
            >
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
                :folder="folder_tag_for(job)"
                :job="job"
                :title="job_title(job)"
                :when="date_format(job.created_at_unix)"
                :people="people_text_for(job)"
                :snippet="search_snippet_for(job)"
                :menu_items="row_menu_items(job)"
                @open="open(job)"
                @favourite="favourite_toggle(job)"
                @ask="meeting_ask(job.id)"
                @menu="row_menu_select(job, $event)"
                @contextmenu="row_context_menu($event, job)"
                @pointerdown="drag_press($event, job)"
            />
        </div>

        <Teleport to="body">
            <Transition name="app-dialog" @before-leave="transition_leave_inert">
                <div
                    v-if="rename_target"
                    class="app-dialog-backdrop"
                    role="dialog"
                    aria-modal="true"
                    tabindex="-1"
                    :inert="rename_covered"
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
                            ref="rename_input_element"
                            v-model="rename_input_value"
                            type="search"
                            class="input"
                            :disabled="rename_busy"
                            @keydown.enter.prevent="rename_save"
                            @keydown.esc.prevent="rename_close"
                        >
                        <NoticeBanner
                            v-if="rename_error"
                            class="mt-3"
                            @dismiss="rename_error = null"
                        >
                            {{ rename_error }}
                        </NoticeBanner>
                        <div class="app-dialog-actions">
                            <button
                                type="button"
                                class="btn-default"
                                :disabled="rename_busy"
                                @click="rename_close"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
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

        <FolderMoveDialog v-model:job="move_target" />
        <JobDragGhost />
    </section>
</template>

<style scoped>
.app-dialog-backdrop:focus {
    outline: none;
}

.folder-heading {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
}

.folder-crumb {
    color: var(--color-content-muted);
    font-size: 1.25rem;
    font-weight: 600;
    letter-spacing: -0.015em;
}

.folder-crumb:hover {
    color: var(--color-content-strong);
}

.folder-crumb-separator {
    flex: none;
    width: 1rem;
    height: 1rem;
    color: var(--color-content-subtle);
}

.folder-heading-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
</style>
