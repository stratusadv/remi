<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef } from 'vue'
import { use_context_menu } from '../composables/use_context_menu'
import { use_dialog } from '../composables/use_dialog'
import { use_modal } from '../composables/use_modal'
import { person_name_full, use_people } from '../composables/use_people'
import { use_pipeline } from '../composables/use_pipeline'
import { use_shortcuts } from '../composables/use_shortcuts'
import { assert } from '../lib/assert'
import { error_dialog_sentence_show, error_dialog_show } from '../lib/errors'
import { transition_leave_inert } from '../lib/transition'
import GroupForm from './group_form.vue'
import InfoHint from './info_hint.vue'
import MonogramTile from './monogram_tile.vue'
import NoticeBanner from './notice_banner.vue'
import PersonForm from './person_form.vue'
import RowMenu from './row_menu.vue'
import type { MenuItem } from '../lib/menu'
import type { Group, Person } from '../types'


interface EditState {
    person: Person | null
}

interface GroupEditState {
    group: Group | null
}

const HINT_GROUPS = 'A group is a set of people you often add together, such as the managers or '
    + 'the floor staff. The Meeting step ticks each person in the group when the group is picked.'

const HINT_PEOPLE = 'These are the people who turn up in your meetings. Add each one once with '
    + 'their role and a short description, then pick them from a list on the Meeting step so the '
    + 'AI knows who was there and who does what.'

const MESSAGE_REMOVE = 'The meetings they were added to keep their notes.'

const MENU_ITEMS = Object.freeze<MenuItem[]>([
    { id: 'edit', label: 'Edit', icon: 'edit' },
    { id: 'delete', label: 'Delete', icon: 'delete', danger: true },
])

const { open: context_menu_open } = use_context_menu()
const { confirm: dialog_confirm } = use_dialog()
const { view_intent_take } = use_pipeline()

const {
    people_sorted,
    groups_sorted,
    error_message,
    group_members,
    save,
    remove,
    group_save,
    group_remove,
} = use_people()

const edit = ref<EditState | null>(null)
const group_edit = ref<GroupEditState | null>(null)
const form_element = useTemplateRef<HTMLElement>('form_element')
const covered = use_modal('dialog', () => edit.value !== null || group_edit.value !== null)

const dialog_title = computed(() => {
    if (edit.value !== null) return edit.value.person === null ? 'New person' : 'Edit person'
    if (group_edit.value === null) return ''

    return group_edit.value.group === null ? 'New group' : 'Edit group'
})


function cancel_click(): void {
    edit.value = null
    group_edit.value = null
}

async function delete_click(person: Person): Promise<void> {
    assert(person.id.length > 0)

    const question = `Remove ${person_name_full(person)} from People? ${MESSAGE_REMOVE}`

    return dialog_confirm(question, { title: 'Remove person', kind: 'warning' })
        .then(async (ok) => {
            if (!ok) return

            await remove(person.id)
                .then(async () => {
                    if (error_message.value !== null) {
                        await error_dialog_sentence_show(error_message.value)
                    }
                })
                .catch(error_dialog_show)
        })
}

function edit_open(person: Person | null): void {
    assert(person === null || person.id.length > 0)

    edit.value = { person }

    void nextTick(form_focus)
}

function form_focus(): void {
    assert(edit.value === null || group_edit.value === null)
    assert(form_element.value === null || form_element.value.isConnected)

    form_element.value?.querySelector('input')?.focus()
}

function group_context_menu(event: MouseEvent, group: Group): void {
    assert(event.type === 'contextmenu')
    assert(group.id.length > 0)

    context_menu_open(event, MENU_ITEMS, group_menu_select.bind(undefined, group))
}

async function group_delete_click(group: Group): Promise<void> {
    assert(group.id.length > 0)

    const question = `Delete the "${group.name}" group? The people in it stay in People.`

    return dialog_confirm(question, { title: 'Delete group', kind: 'warning' })
        .then(async (ok) => {
            if (!ok) return

            await group_remove(group.id)
                .then(async () => {
                    if (error_message.value !== null) {
                        await error_dialog_sentence_show(error_message.value)
                    }
                })
                .catch(error_dialog_show)
        })
}

function group_edit_open(group: Group | null): void {
    assert(group === null || group.id.length > 0)

    group_edit.value = { group }

    void nextTick(form_focus)
}

function group_members_text(group: Group): string {
    assert(group.id.length > 0)
    assert(groups_sorted.value.includes(group))

    const names = group_members(group).map(person_name_full)

    assert(names.length <= group.person_ids.length)

    return names.length > 0 ? names.join(', ') : 'No members yet'
}

async function group_menu_select(group: Group, id: string): Promise<void> {
    assert(group.id.length > 0)
    assert(MENU_ITEMS.some((item) => item.id === id))

    if (id === 'edit') {
        group_edit_open(group)

        return
    }

    if (id === 'delete') return group_delete_click(group)
}

async function group_save_click(group: Group): Promise<void> {
    assert(group.id.length > 0)
    assert(group.name.length > 0)
    assert(group.name === group.name.trim())

    const group_edited = group_edit.value?.group ?? null

    assert(group_edited === null || group_edited.id === group.id)

    return group_save(group)
        .then(async () => {
            if (error_message.value !== null) {
                await error_dialog_sentence_show(error_message.value)

                return
            }

            group_edit.value = null
        })
        .catch(error_dialog_show)
}

function intent_apply(): void {
    const intent = view_intent_take()

    assert(intent === null || intent === 'group_add' || intent === 'person_add')
    assert(edit.value === null)
    assert(group_edit.value === null)

    if (intent === 'group_add') group_edit_open(null)
    if (intent === 'person_add') edit_open(null)
}

async function menu_select(person: Person, id: string): Promise<void> {
    assert(person.id.length > 0)
    assert(MENU_ITEMS.some((item) => item.id === id))

    if (id === 'edit') {
        edit_open(person)

        return
    }

    if (id === 'delete') return delete_click(person)
}

function person_context_menu(event: MouseEvent, person: Person): void {
    assert(event.type === 'contextmenu')
    assert(person.id.length > 0)

    context_menu_open(event, MENU_ITEMS, menu_select.bind(undefined, person))
}

async function save_click(person: Person): Promise<void> {
    assert(person.id.length > 0)
    assert(person.name_first.length > 0)
    assert(person.name_first === person.name_first.trim())

    const person_edited = edit.value?.person ?? null

    assert(person_edited === null || person_edited.id === person.id)

    return save(person)
        .then(async () => {
            if (error_message.value !== null) {
                await error_dialog_sentence_show(error_message.value)

                return
            }

            edit.value = null
        })
        .catch(error_dialog_show)
}

intent_apply()

use_shortcuts({ escape: cancel_click })
</script>

<template>
    <section class="view-fill">
        <header class="page-header">
            <div>
                <p class="eyebrow page-eyebrow">Meeting participants</p>
                <h2 class="!mb-1 flex items-center">
                    People
                    <InfoHint :text="HINT_PEOPLE" />
                </h2>
            </div>
            <div class="page-header-actions">
                <button
                    type="button"
                    class="btn-default"
                    @click="group_edit_open(null)"
                >
                    Add group
                </button>
                <button
                    type="button"
                    class="btn-primary"
                    @click="edit_open(null)"
                >
                    Add person
                </button>
            </div>
        </header>

        <NoticeBanner v-if="error_message" class="mb-6" @dismiss="error_message = null">
            {{ error_message }}
        </NoticeBanner>

        <div class="list-fill flex flex-col">
            <ul v-if="people_sorted.length > 0" class="list-divider">
                <li
                    v-for="person in people_sorted"
                    :key="person.id"
                    class="flex justify-between items-center py-3 gap-4"
                    @contextmenu="person_context_menu($event, person)"
                >
                    <MonogramTile :text="person_name_full(person)" />
                    <button type="button" class="list-row-main" @click="edit_open(person)">
                        <span class="flex items-center gap-2 min-w-0">
                            <span class="font-medium truncate">{{ person_name_full(person) }}</span>
                            <span class="pill shrink-0">{{ person.role || 'No role' }}</span>
                        </span>
                        <span class="meta truncate mt-0.5">
                            {{ person.description || 'No description' }}
                        </span>
                    </button>
                    <RowMenu
                        :label="person_name_full(person)"
                        :items="MENU_ITEMS"
                        @select="menu_select(person, $event)"
                    />
                </li>
            </ul>
            <p v-else class="meta">
                There are no people yet. Click Add person to add the first one.
            </p>

            <header class="page-header section-next">
                <div>
                    <h2 class="!mb-1 flex items-center">
                        Groups
                        <InfoHint :text="HINT_GROUPS" />
                    </h2>
                </div>
            </header>
            <ul v-if="groups_sorted.length > 0" class="list-divider">
                <li
                    v-for="group in groups_sorted"
                    :key="group.id"
                    class="flex justify-between items-center py-3 gap-4"
                    @contextmenu="group_context_menu($event, group)"
                >
                    <MonogramTile :text="group.name" />
                    <button type="button" class="list-row-main" @click="group_edit_open(group)">
                        <span class="flex items-center gap-2 min-w-0">
                            <span class="font-medium truncate">{{ group.name }}</span>
                            <span class="pill shrink-0">
                                {{ group.person_ids.length }}
                                {{ group.person_ids.length === 1 ? 'person' : 'people' }}
                            </span>
                        </span>
                        <span class="meta truncate mt-0.5">{{ group_members_text(group) }}</span>
                    </button>
                    <RowMenu
                        :label="group.name"
                        :items="MENU_ITEMS"
                        @select="group_menu_select(group, $event)"
                    />
                </li>
            </ul>
            <p v-else class="meta">
                There are no groups yet. Click Add group to put people who are usually together in
                one.
            </p>
        </div>

        <Teleport to="body">
            <Transition name="app-dialog" @before-leave="transition_leave_inert">
                <div
                    v-if="edit || group_edit"
                    ref="form_element"
                    class="app-dialog-backdrop"
                    role="dialog"
                    aria-modal="true"
                    tabindex="-1"
                    :inert="covered"
                    @mousedown.left.self.prevent="cancel_click"
                    @keydown.esc="cancel_click"
                >
                    <div class="app-dialog people-form-dialog">
                        <button
                            type="button"
                            class="app-dialog-close"
                            aria-label="Close"
                            title="Close"
                            @click="cancel_click"
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
                        <h3 class="app-dialog-title">{{ dialog_title }}</h3>
                        <PersonForm
                            v-if="edit"
                            :person="edit.person"
                            @cancel="cancel_click"
                            @save="save_click"
                        />
                        <GroupForm
                            v-else-if="group_edit"
                            :group="group_edit.group"
                            @cancel="cancel_click"
                            @save="group_save_click"
                        />
                    </div>
                </div>
            </Transition>
        </Teleport>
    </section>
</template>

<style scoped>
.app-dialog-backdrop:focus {
    outline: none;
}
</style>
