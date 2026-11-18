<script setup lang="ts">
import { computed, ref } from 'vue'
import { use_context_menu } from '../composables/use_context_menu'
import { use_dialog } from '../composables/use_dialog'
import { use_notes_templates } from '../composables/use_notes_templates'
import { use_pipeline } from '../composables/use_pipeline'
import { use_settings } from '../composables/use_settings'
import { use_shortcuts } from '../composables/use_shortcuts'
import { assert } from '../lib/assert'
import { error_dialog_sentence_show, error_dialog_show } from '../lib/errors'
import InfoHint from './info_hint.vue'
import MonogramTile from './monogram_tile.vue'
import NoticeBanner from './notice_banner.vue'
import { rich_editor_async as RichEditorAsync } from './rich_editor_async'
import RowMenu from './row_menu.vue'
import type { MenuItem } from '../lib/menu'
import type { NotesTemplate } from '../types'


interface EditState {
    template: NotesTemplate
}

const HINT_LAYOUT = 'Lay the notes out the way you want them: headings, bullet lists, tables, and '
    + 'checklists. Under each heading, write a line saying what goes there. The AI fills it in '
    + 'from the recording.'

const HINT_TEMPLATES = 'A template is the layout of a document: the headings, lists, and tables '
    + 'you want, with a note under each saying what goes there. The AI fills it in from a '
    + 'recording. Make one for each kind of document you need.'

const MESSAGE_DELETE = 'The notes you already made with it are kept.'

const PLACEHOLDER_INSTRUCTIONS = 'Add a heading for each part of the notes, and under it say what '
    + 'goes there.'

const { open: context_menu_open } = use_context_menu()
const { confirm: dialog_confirm } = use_dialog()
const { templates, error_message, save, remove, generate } = use_notes_templates()
const { view_intent_take } = use_pipeline()

const {
    settings,
    error_message: settings_error_message,
    update: settings_update,
} = use_settings()

const edit = ref<EditState | null>(null)

const can_save = computed(() => {
    if (edit.value === null) return false

    const { name, instructions } = edit.value.template

    return name.trim().length > 0 && instructions.trim().length > 0
})


function add_click(): void {
    assert(edit.value === null)

    edit.value = { template: template_new() }
}

function cancel_click(): void {
    edit.value = null
}

async function default_set(id: string | null): Promise<void> {
    assert(id === null || id.length > 0)
    assert(id === null || templates.value.some((template) => template.id === id))

    return settings_update({ notes_template_id_default: id })
        .then(async () => {
            if (settings_error_message.value !== null) {
                await error_dialog_sentence_show(settings_error_message.value)
            }
        })
}

async function delete_click(template: NotesTemplate): Promise<void> {
    assert(template.id.length > 0)
    assert(templates.value.some((known) => known.id === template.id))
    assert(edit.value === null)

    const question = `Delete the "${template.name}" template? ${MESSAGE_DELETE}`

    return dialog_confirm(question, { title: 'Delete template', kind: 'warning' })
        .then(async (ok) => {
            if (!ok) return

            await remove(template.id)
                .then(async () => {
                    if (settings.value.notes_template_id_default === template.id) {
                        await default_set(null)
                    }
                })
                .catch(error_dialog_show)
        })
}

function edit_click(template: NotesTemplate): void {
    assert(template.id.length > 0)
    assert(edit.value === null)

    edit.value = { template: { ...template } }
}

function intent_apply(): void {
    const intent = view_intent_take()

    assert(intent === null || intent === 'template_add')
    assert(edit.value === null)

    if (intent === 'template_add') add_click()
}

function menu_items_for(template: NotesTemplate): MenuItem[] {
    assert(template.id.length > 0)
    assert(templates.value.includes(template))
    assert(edit.value === null)

    const items: MenuItem[] = []

    if (settings.value.notes_template_id_default !== template.id) {
        items.push({ id: 'default', label: 'Make default', icon: 'star' })
    }

    items.push({ id: 'edit', label: 'Edit', icon: 'edit' })
    items.push({ id: 'delete', label: 'Delete', icon: 'delete', danger: true })

    return items
}

async function menu_select(template: NotesTemplate, id: string): Promise<void> {
    assert(template.id.length > 0)
    assert(id === 'default' || id === 'edit' || id === 'delete')
    assert(edit.value === null)

    if (id === 'default') return default_set(template.id)

    if (id === 'edit') {
        edit_click(template)

        return
    }

    return delete_click(template)
}

async function save_click(): Promise<void> {
    if (edit.value === null) return
    if (!can_save.value) return

    const { template } = edit.value

    assert(template.id.length > 0)
    assert(!templates.value.includes(template))

    return save(template)
        .then(() => {
            edit.value = null
        })
        .catch(error_dialog_show)
}

function template_context_menu(event: MouseEvent, template: NotesTemplate): void {
    assert(event.type === 'contextmenu')
    assert(template.id.length > 0)
    assert(edit.value === null)

    context_menu_open(event, menu_items_for(template), menu_select.bind(undefined, template))
}

function template_new(): NotesTemplate {
    const template: NotesTemplate = {
        id: crypto.randomUUID(),
        name: '',
        description: '',
        instructions: '',
        edited: true,
    }

    assert(!templates.value.some((known) => known.id === template.id))

    return template
}

intent_apply()

use_shortcuts({ escape: cancel_click })
</script>

<template>
    <section class="view-fill">
        <header class="page-header">
            <div>
                <p class="eyebrow page-eyebrow">Note formats</p>
                <h2 class="!mb-1 flex items-center">
                    Templates
                    <InfoHint :text="HINT_TEMPLATES" />
                </h2>
            </div>
            <div v-if="!edit" class="page-header-actions">
                <button type="button" class="btn-primary" @click="add_click">Add template</button>
            </div>
        </header>

        <NoticeBanner v-if="error_message" class="mb-6" @dismiss="error_message = null">
            {{ error_message }}
        </NoticeBanner>

        <div v-if="edit" class="flex flex-col gap-4 flex-1 min-h-0">
            <div>
                <label class="label">Name</label>
                <input
                    v-model="edit.template.name"
                    type="search"
                    class="input"
                    maxlength="120"
                    placeholder="e.g. Meeting notes"
                >
            </div>

            <div>
                <label class="label">Description</label>
                <input
                    v-model="edit.template.description"
                    type="search"
                    class="input"
                    maxlength="240"
                    placeholder="One line on what this template is for"
                >
            </div>

            <div class="flex flex-col flex-1 min-h-0">
                <label class="label flex items-center">
                    What should the notes look like?
                    <InfoHint :text="HINT_LAYOUT" />
                </label>
                <RichEditorAsync
                    v-model="edit.template.instructions"
                    class="flex-1 min-h-0"
                    :placeholder="PLACEHOLDER_INSTRUCTIONS"
                    :ai_generate="generate"
                />
            </div>

            <div class="actions-row">
                <button type="button" class="btn-default" @click="cancel_click">Cancel</button>
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

        <ul v-else-if="templates.length > 0" class="list-divider list-fill">
            <li
                v-for="template in templates"
                :key="template.id"
                class="flex justify-between items-center py-3 gap-4"
                @contextmenu="template_context_menu($event, template)"
            >
                <MonogramTile :text="template.name" />
                <button type="button" class="list-row-main" @click="edit_click(template)">
                    <span class="flex items-center gap-2 min-w-0">
                        <span class="font-medium truncate">{{ template.name }}</span>
                        <span
                            v-if="settings.notes_template_id_default === template.id"
                            class="pill-active shrink-0"
                        >
                            Default
                        </span>
                    </span>
                    <span class="meta truncate mt-0.5">
                        {{ template.description || 'No description' }}
                    </span>
                </button>
                <RowMenu
                    :label="template.name"
                    :items="menu_items_for(template)"
                    @select="menu_select(template, $event)"
                />
            </li>
        </ul>
        <p v-else class="meta">
            There are no templates yet. Click Add template to make your first one.
        </p>
    </section>
</template>
