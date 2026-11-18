<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef } from 'vue'
import { use_ask } from '../composables/use_ask'
import { use_context_menu } from '../composables/use_context_menu'
import { use_modal } from '../composables/use_modal'
import { assert } from '../lib/assert'
import { chats_grouped } from '../lib/chat_groups'
import { error_dialog_show } from '../lib/errors'
import { MENU_ITEM_DELETE } from '../lib/menu'
import { transition_leave_inert } from '../lib/transition'
import MenuIcon from './menu_icon.vue'
import type { ChatID, ChatSummary } from '../types'


const emit = defineEmits<{
    opened: []
}>()

const { chat_id, chats, chat_open, chat_remove, chats_refresh } = use_ask()
const { open: context_menu_open } = use_context_menu()
const busy = ref(false)
const open = ref(false)
const pending = ref<ChatID[]>([])
const selected = ref<ChatID[]>([])
const confirm_button = useTemplateRef<HTMLButtonElement>('confirm_button')
const dialog_element = useTemplateRef<HTMLElement>('dialog_element')
const trigger_button = useTemplateRef<HTMLButtonElement>('trigger_button')
const groups = computed(() => chats_grouped(chats.value, Date.now()))
const covered = use_modal('dialog', () => open.value)

const selected_all = computed(() => (
    chats.value.length > 0 && selected.value.length === chats.value.length
))

const selected_some = computed(() => selected.value.length > 0 && !selected_all.value)

const pending_text = computed(() => {
    const count = pending.value.length

    if (count === 1) {
        const [first] = pending.value
        const chat = chats.value.find((candidate) => candidate.id === first)

        if (chat !== undefined) return `Delete "${chat.title}"? This cannot be undone.`
    }

    return `Delete ${String(count)} chat${count === 1 ? '' : 's'}? This cannot be undone.`
})


function chat_context_menu(event: MouseEvent, chat: ChatSummary): void {
    assert(event.type === 'contextmenu')
    assert(chat.id.length > 0)
    assert(open.value)

    if (busy.value) return

    context_menu_open(event, [MENU_ITEM_DELETE], chat_menu_select.bind(undefined, chat))
}

async function chat_menu_select(chat: ChatSummary, id: string): Promise<void> {
    assert(chat.id.length > 0)
    assert(id === MENU_ITEM_DELETE.id, `the chat has no action for ${id}`)

    return delete_request([chat.id])
}

async function chat_pick(chat: ChatSummary): Promise<void> {
    assert(chat.id.length > 0)
    assert(!busy.value)

    close()

    return chat_open(chat.id)
        .then(() => {
            emit('opened')
        })
        .catch(error_dialog_show)
}

function chat_toggle(chat: ChatSummary, event: Event): void {
    assert(chat.id.length > 0)
    assert(event.currentTarget instanceof HTMLInputElement)

    const box = event.currentTarget
    const others = selected.value.filter((id) => id !== chat.id)

    selected.value = box.checked ? [...others, chat.id] : others
    pending.value = []
}

function close(): void {
    assert(trigger_button.value !== null)

    if (!open.value) return
    if (busy.value) return

    open.value = false
    pending.value = []
    selected.value = []

    void nextTick(trigger_focus)
}

function delete_cancel(): void {
    assert(pending.value.length > 0)
    assert(!busy.value)

    pending.value = []
    dialog_element.value?.focus()
}

async function delete_confirm(): Promise<void> {
    const doomed = pending.value

    assert(doomed.length > 0)
    assert(!busy.value)

    busy.value = true

    return Promise.allSettled(doomed.map(async (id) => chat_remove(id)))
        .then(async (results) => delete_settle(doomed, results))
}

async function delete_settle(
    doomed: readonly ChatID[],
    results: readonly PromiseSettledResult<void>[],
): Promise<void> {
    assert(busy.value)
    assert(results.length === doomed.length)

    const failure = results.find((result) => result.status === 'rejected')

    selected.value = selected.value.filter((id) => !doomed.includes(id))
    pending.value = []
    busy.value = false
    dialog_element.value?.focus()

    if (failure === undefined) return

    return chats_refresh()
        .catch(error_dialog_show)
        .then(async () => error_dialog_show(failure.reason))
}

async function delete_request(ids: readonly ChatID[]): Promise<void> {
    assert(ids.length > 0)
    assert(ids.every((id) => chats.value.some((chat) => chat.id === id)))

    pending.value = [...ids]

    return nextTick().then(() => {
        confirm_button.value?.focus()
    })
}

function escape_press(event: KeyboardEvent): void {
    assert(event.key === 'Escape')
    assert(trigger_button.value !== null)

    if (busy.value) return

    if (pending.value.length > 0) {
        delete_cancel()

        return
    }

    close()
}

function focus_first(): void {
    const dialog = dialog_element.value

    if (dialog === null) return

    assert(dialog.isConnected)

    const current = dialog.querySelector<HTMLElement>('.ask-history-open[aria-current="true"]')
    const target = current ?? dialog.querySelector<HTMLElement>('.ask-history-open') ?? dialog

    assert(dialog.contains(target))

    target.focus()
}

async function history_open(): Promise<void> {
    assert(!open.value)
    assert(!busy.value)

    pending.value = []
    selected.value = []
    open.value = true

    void nextTick(focus_first)

    return chats_refresh()
        .then(nextTick)
        .then(focus_first)
        .catch(error_dialog_show)
}

function selection_toggle(): void {
    assert(chats.value.length > 0)
    assert(!busy.value)

    selected.value = selected_all.value ? [] : chats.value.map((chat) => chat.id)
    pending.value = []
}

function trigger_focus(): void {
    assert(!open.value)
    assert(!busy.value)

    trigger_button.value?.focus()
}
</script>

<template>
    <button
        ref="trigger_button"
        type="button"
        class="btn-default"
        aria-haspopup="dialog"
        :aria-expanded="open"
        @click="history_open"
    >
        <svg
            class="ask-history-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
        >
            <path d="M12 7.5V12l3 2" />
            <path d="M3.75 12a8.25 8.25 0 1 0 2.42-5.83" />
            <path d="M3.75 4.5v3.75H7.5" />
        </svg>
        History
    </button>
    <Teleport to="body">
        <Transition name="app-dialog" @before-leave="transition_leave_inert">
            <div
                v-if="open"
                ref="dialog_element"
                class="app-dialog-backdrop ask-history-backdrop"
                role="dialog"
                aria-modal="true"
                aria-labelledby="ask-history-title"
                tabindex="-1"
                :inert="covered"
                @mousedown.left.self.prevent="close"
                @keydown.esc="escape_press"
            >
                <section class="app-dialog ask-history">
                    <button
                        type="button"
                        class="app-dialog-close"
                        aria-label="Close"
                        title="Close"
                        :disabled="busy"
                        @click="close"
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
                    <h3 id="ask-history-title" class="app-dialog-title">Chat history</h3>

                    <p v-if="chats.length === 0" class="app-dialog-message">
                        Each chat is saved here as you ask, so you can come back to it later.
                    </p>

                    <template v-else>
                        <p class="app-dialog-message">
                            Open a chat to pick it up again, or select chats to delete them.
                        </p>

                        <div class="ask-history-list">
                            <section
                                v-for="group in groups"
                                :key="group.label"
                                class="ask-history-group"
                                :aria-label="group.label"
                            >
                                <h4 class="ask-history-label">{{ group.label }}</h4>
                                <ul class="ask-history-rows">
                                    <li
                                        v-for="chat in group.chats"
                                        :key="chat.id"
                                        class="ask-history-row"
                                        :data-selected="selected.includes(chat.id)"
                                        :data-pending="pending.includes(chat.id)"
                                        @contextmenu="chat_context_menu($event, chat)"
                                    >
                                        <label class="ask-history-pick">
                                            <input
                                                type="checkbox"
                                                :checked="selected.includes(chat.id)"
                                                :aria-label="`Select chat: ${chat.title}`"
                                                :disabled="busy"
                                                @change="chat_toggle(chat, $event)"
                                            >
                                        </label>
                                        <button
                                            type="button"
                                            class="ask-history-open"
                                            :aria-current="chat.id === chat_id ? 'true' : undefined"
                                            :title="chat.title"
                                            :disabled="busy"
                                            @click="chat_pick(chat)"
                                        >
                                            {{ chat.title }}
                                        </button>
                                        <button
                                            type="button"
                                            class="menu-icon-btn ask-history-delete"
                                            :aria-label="`Delete chat: ${chat.title}`"
                                            title="Delete chat"
                                            :disabled="busy"
                                            @click="delete_request([chat.id])"
                                        >
                                            <MenuIcon name="delete" />
                                        </button>
                                    </li>
                                </ul>
                            </section>
                        </div>

                        <div v-if="pending.length > 0" class="ask-history-footer">
                            <p id="ask-history-question" class="ask-history-question">
                                {{ pending_text }}
                            </p>
                            <div class="app-dialog-actions">
                                <button
                                    type="button"
                                    class="btn-default"
                                    :disabled="busy"
                                    @click="delete_cancel"
                                >
                                    Cancel
                                </button>
                                <button
                                    ref="confirm_button"
                                    type="button"
                                    class="btn-danger"
                                    aria-describedby="ask-history-question"
                                    :disabled="busy"
                                    @click="delete_confirm"
                                >
                                    Delete
                                </button>
                            </div>
                        </div>

                        <div v-else class="ask-history-footer">
                            <div class="ask-history-selection">
                                <label class="ask-history-all">
                                    <input
                                        type="checkbox"
                                        :checked="selected_all"
                                        :indeterminate="selected_some"
                                        @change="selection_toggle"
                                    >
                                    Select all
                                </label>
                                <span v-if="selected.length > 0" class="ask-history-count">
                                    {{ selected.length }} of {{ chats.length }} selected
                                </span>
                            </div>
                            <button
                                type="button"
                                class="btn-danger"
                                :disabled="selected.length === 0"
                                @click="delete_request(selected)"
                            >
                                Delete selected
                            </button>
                        </div>
                    </template>
                </section>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
.ask-history-icon {
    width: 1rem;
    height: 1rem;
}

.ask-history-backdrop:focus {
    outline: none;
}

.ask-history {
    max-width: 40rem;
    max-height: min(42rem, 88vh);
}

.ask-history-list {
    flex: 1 1 auto;
    min-height: 0;
    padding: 0.375rem;
    overflow-y: auto;
    overscroll-behavior: contain;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    scrollbar-gutter: stable;
}

.ask-history-group + .ask-history-group {
    margin-top: 0.5rem;
}

.ask-history-label {
    margin: 0;
    padding: 0.5rem 0.625rem 0.25rem;
    color: var(--color-content-subtle);
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
}

.ask-history-rows {
    display: grid;
    gap: 0.125rem;
    margin: 0;
    padding: 0;
    list-style: none;
}

.ask-history-row {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    padding-right: 0.25rem;
    border-radius: var(--radius-sm);
    transition: background-color 100ms ease, box-shadow 100ms ease;
}

.ask-history-row:hover,
.ask-history-row:focus-within {
    background: var(--color-row-hover);
}

.ask-history-row[data-selected="true"] {
    background: var(--color-row-active);
}

.ask-history-row[data-pending="true"] {
    background: var(--color-danger);
    box-shadow: inset 2px 0 0 var(--color-danger-text);
}

.ask-history-pick {
    display: inline-flex;
    flex: none;
    align-items: center;
    padding: 0.5rem 0.375rem 0.5rem 0.625rem;
    cursor: pointer;
}

.ask-history-open {
    flex: 1;
    min-width: 0;
    padding: 0.5rem 0.375rem;
    overflow: hidden;
    border-radius: var(--radius-sm);
    color: var(--color-content);
    font-size: 0.875rem;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ask-history-open:hover:enabled {
    color: var(--color-content-strong);
}

.ask-history-open[aria-current="true"] {
    color: var(--color-content-strong);
    font-weight: 600;
}

.ask-history-delete {
    flex: none;
}

.ask-history-delete:hover:enabled {
    color: var(--color-danger-text);
}

.ask-history-footer {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    min-height: var(--control-height);
    margin-top: 1rem;
}

.ask-history-footer .app-dialog-actions {
    margin: 0;
}

.ask-history-selection {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
}

.ask-history-all {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--color-content);
    font-size: 0.875rem;
    cursor: pointer;
}

.ask-history-count {
    color: var(--color-content-muted);
    font-size: 0.8125rem;
}

.ask-history-count::before {
    margin-right: 0.5rem;
    color: var(--color-content-subtle);
    content: "\00b7";
}

.ask-history-question {
    min-width: 0;
    margin: 0;
    color: var(--color-content-strong);
    font-size: 0.875rem;
    line-height: 1.45;
}
</style>
