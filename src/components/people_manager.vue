<script setup lang="ts">
import { computed, ref } from 'vue'
import { use_context_menu } from '../composables/use_context_menu'
import { use_dialog } from '../composables/use_dialog'
import { person_name_full, use_people } from '../composables/use_people'
import { use_pipeline } from '../composables/use_pipeline'
import { use_shortcuts } from '../composables/use_shortcuts'
import { assert } from '../lib/assert'
import { error_dialog_show } from '../lib/errors'
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

const MENU_ITEMS: MenuItem[] = [
    { id: 'edit', label: 'Edit', icon: 'edit' },
    { id: 'delete', label: 'Delete', icon: 'delete', danger: true },
]

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

const dialog_title = computed(() => {
    if (edit.value !== null) return edit.value.person !== null ? 'Edit person' : 'New person'
    if (group_edit.value === null) return ''

    return group_edit.value.group !== null ? 'Edit group' : 'New group'
})


function add_click(): void {
    edit.value = { person: null }
}

function cancel_click(): void {
    edit.value = null
    group_edit.value = null
}

async function delete_click(person: Person): Promise<void> {
    const ok = await dialog_confirm(
        `Remove ${person_name_full(person)} from People? ${MESSAGE_REMOVE}`,
        { title: 'Remove person', kind: 'warning' },
    )

    if (!ok) return

    try {
        await remove(person.id)

        if (error_message.value !== null) await error_dialog_show(error_message.value)
    } catch (error) {
        await error_dialog_show(error)
    }
}

function edit_click(person: Person): void {
    edit.value = { person }
}

function group_add_click(): void {
    group_edit.value = { group: null }
}

function group_context_menu(event: MouseEvent, group: Group): void {
    assert(event.type === 'contextmenu')
    assert(group.id.length > 0)

    context_menu_open(event, MENU_ITEMS, group_menu_select.bind(undefined, group))
}

async function group_delete_click(group: Group): Promise<void> {
    const ok = await dialog_confirm(
        `Delete the "${group.name}" group? The people in it stay in People.`,
        { title: 'Delete group', kind: 'warning' },
    )

    if (!ok) return

    try {
        await group_remove(group.id)

        if (error_message.value !== null) await error_dialog_show(error_message.value)
    } catch (error) {
        await error_dialog_show(error)
    }
}

function group_edit_click(group: Group): void {
    group_edit.value = { group }
}

function group_members_text(group: Group): string {
    const names = group_members(group).map(person_name_full)

    return names.length > 0 ? names.join(', ') : 'No members yet'
}

async function group_menu_select(group: Group, id: string): Promise<void> {
    if (id === 'edit') {
        group_edit_click(group)

        return
    }

    if (id === 'delete') await group_delete_click(group)
}

async function group_save_click(group: Group): Promise<void> {
    try {
        await group_save(group)

        if (error_message.value !== null) {
            await error_dialog_show(error_message.value)

            return
        }

        group_edit.value = null
    } catch (error) {
        await error_dialog_show(error)
    }
}

function intent_apply(): void {
    const intent = view_intent_take()

    assert(intent === null || intent === 'group_add' || intent === 'person_add')
    assert(edit.value === null)
    assert(group_edit.value === null)

    if (intent === 'group_add') group_add_click()
    if (intent === 'person_add') add_click()
}

async function menu_select(person: Person, id: string): Promise<void> {
    if (id === 'edit') {
        edit_click(person)

        return
    }

    if (id === 'delete') await delete_click(person)
}

function person_context_menu(event: MouseEvent, person: Person): void {
    assert(event.type === 'contextmenu')
    assert(person.id.length > 0)

    context_menu_open(event, MENU_ITEMS, menu_select.bind(undefined, person))
}

async function save_click(person: Person): Promise<void> {
    try {
        await save(person)

        if (error_message.value !== null) {
            await error_dialog_show(error_message.value)

            return
        }

        edit.value = null
    } catch (error) {
        await error_dialog_show(error)
    }
}

intent_apply()

use_shortcuts({
    escape: () => { if (edit.value !== null || group_edit.value !== null) cancel_click() },
})
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
                <button class="btn-default" @click="group_add_click">Add group</button>
                <button class="btn-primary" @click="add_click">Add person</button>
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
                    <button type="button" class="list-row-main" @click="edit_click(person)">
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
                    <button type="button" class="list-row-main" @click="group_edit_click(group)">
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
            <Transition name="app-dialog">
                <div
                    v-if="edit || group_edit"
                    class="app-dialog-backdrop"
                    role="dialog"
                    aria-modal="true"
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
