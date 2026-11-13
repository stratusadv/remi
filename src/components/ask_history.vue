<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { use_ask } from '../composables/use_ask'
import { use_context_menu } from '../composables/use_context_menu'
import { use_dialog } from '../composables/use_dialog'
import { assert } from '../lib/assert'
import { chats_grouped } from '../lib/chat_groups'
import { error_dialog_show } from '../lib/errors'
import { MENU_ITEM_DELETE } from '../lib/menu'
import MenuIcon from './menu_icon.vue'
import type { ChatSummary } from '../types'


const emit = defineEmits<{
    opened: []
}>()

const PANEL_GAP_PX = 6
const { chat_id, chats, chat_open, chat_remove, chats_refresh } = use_ask()
const { menu: context_menu, open: context_menu_open } = use_context_menu()
const { confirm: dialog_confirm } = use_dialog()
const open = ref(false)
const trigger_ref = ref<HTMLButtonElement | null>(null)
const panel_ref = ref<HTMLElement | null>(null)
const panel_top_px = ref(0)
const panel_right_px = ref(0)
const groups = computed(() => chats_grouped(chats.value, Date.now()))

const panel_style = computed(() => ({
    top: `${String(panel_top_px.value)}px`,
    right: `${String(panel_right_px.value)}px`,
}))


watch(open, (shown) => {
    if (shown) {
        listeners_attach()

        return
    }

    listeners_detach()
})

onBeforeUnmount(listeners_detach)

function chat_context_menu(event: MouseEvent, chat: ChatSummary): void {
    assert(event.type === 'contextmenu')
    assert(open.value)

    context_menu_open(event, [MENU_ITEM_DELETE], chat_menu_select.bind(undefined, chat))
}

async function chat_delete(chat: ChatSummary): Promise<void> {
    assert(chat.id.length > 0)
    assert(chat.title.length > 0)

    open.value = false

    const message = `Delete "${chat.title}"? Its questions and answers are removed. This cannot `
        + 'be undone.'

    return dialog_confirm(message, { title: 'Delete chat', kind: 'warning', ok_label: 'Delete' })
        .then(async (confirmed) => (confirmed ? chat_remove(chat.id) : Promise.resolve()))
        .catch(error_dialog_show)
}

async function chat_menu_select(chat: ChatSummary, id: string): Promise<void> {
    assert(chat.id.length > 0)
    assert(id === MENU_ITEM_DELETE.id)

    return chat_delete(chat)
}

async function chat_pick(chat: ChatSummary): Promise<void> {
    assert(chat.id.length > 0)
    assert(open.value)

    open.value = false

    return chat_open(chat.id)
        .then(() => {
            emit('opened')
        })
        .catch(error_dialog_show)
}

function close_on_escape(event: KeyboardEvent): void {
    assert(event.type === 'keydown')

    if (event.key !== 'Escape') return
    if (context_menu.value !== null) return

    open.value = false
    trigger_ref.value?.focus()
}

function close_on_focus_leave(event: FocusEvent): void {
    assert(event.type === 'focusout')

    const next = event.relatedTarget

    if (context_menu.value !== null) return
    if (!(next instanceof Node)) return
    if (panel_ref.value?.contains(next) === true) return
    if (trigger_ref.value?.contains(next) === true) return

    open.value = false
}

function close_on_outside(event: MouseEvent): void {
    assert(event.type === 'mousedown')

    if (context_menu.value !== null) return
    if (!(event.target instanceof Node)) return
    if (panel_ref.value?.contains(event.target) === true) return
    if (trigger_ref.value?.contains(event.target) === true) return

    open.value = false
}

function close_on_resize(event: UIEvent): void {
    assert(event.type === 'resize')
    assert(trigger_ref.value !== null)

    open.value = false
}

function focus_first(): void {
    const panel = panel_ref.value

    if (panel === null) return

    const current = panel.querySelector<HTMLButtonElement>('[aria-current="true"]')
    const target = current ?? panel.querySelector<HTMLButtonElement>('.ask-history-open')

    assert(target === null || panel.contains(target))

    target?.focus({ preventScroll: true })
}

function listeners_attach(): void {
    assert(open.value)
    assert(trigger_ref.value !== null)

    document.addEventListener('mousedown', close_on_outside, true)
    document.addEventListener('keydown', close_on_escape, true)
    window.addEventListener('resize', close_on_resize)
}

function listeners_detach(): void {
    document.removeEventListener('mousedown', close_on_outside, true)
    document.removeEventListener('keydown', close_on_escape, true)
    window.removeEventListener('resize', close_on_resize)
}

function toggle(): void {
    assert(trigger_ref.value !== null)

    if (open.value) {
        open.value = false

        return
    }

    const rect = trigger_ref.value.getBoundingClientRect()

    panel_top_px.value = rect.bottom + PANEL_GAP_PX
    panel_right_px.value = window.innerWidth - rect.right
    open.value = true

    void chats_refresh()
        .then(nextTick)
        .then(focus_first)
        .catch(error_dialog_show)
}
</script>

<template>
    <button
        ref="trigger_ref"
        type="button"
        class="btn-default"
        aria-haspopup="dialog"
        :aria-expanded="open"
        @click="toggle"
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
        <section
            v-if="open"
            ref="panel_ref"
            class="menu-popover menu-popover-fixed ask-history"
            role="dialog"
            aria-label="Chat history"
            :style="panel_style"
            @focusout="close_on_focus_leave"
        >
            <p v-if="chats.length === 0" class="ask-history-empty">
                Each chat is saved here as you ask, so you can come back to it later.
            </p>
            <section
                v-for="group in groups"
                :key="group.label"
                class="ask-history-group"
                :aria-label="group.label"
            >
                <h3 class="ask-history-label">{{ group.label }}</h3>
                <ul class="ask-history-list">
                    <li
                        v-for="chat in group.chats"
                        :key="chat.id"
                        class="ask-history-row"
                        @contextmenu="chat_context_menu($event, chat)"
                    >
                        <button
                            type="button"
                            class="ask-history-open"
                            :aria-current="chat.id === chat_id ? 'true' : undefined"
                            :title="chat.title"
                            @click="chat_pick(chat)"
                        >
                            {{ chat.title }}
                        </button>
                        <button
                            type="button"
                            class="menu-icon-btn ask-history-delete"
                            :aria-label="`Delete chat: ${chat.title}`"
                            title="Delete chat"
                            @click="chat_delete(chat)"
                        >
                            <MenuIcon name="delete" />
                        </button>
                    </li>
                </ul>
            </section>
        </section>
    </Teleport>
</template>

<style scoped>
.ask-history-icon {
    width: 1rem;
    height: 1rem;
}

.ask-history {
    width: min(22rem, calc(100vw - 2rem));
    max-height: min(28rem, 70vh);
    padding: 0.375rem;
    overflow-y: auto;
    overscroll-behavior: contain;
}

.ask-history-empty {
    margin: 0;
    padding: 0.75rem 0.625rem;
    color: var(--color-content-muted);
    font-size: 0.8125rem;
    line-height: 1.5;
}

.ask-history-group + .ask-history-group {
    margin-top: 0.375rem;
}

.ask-history-label {
    margin: 0;
    padding: 0.375rem 0.625rem 0.25rem;
    color: var(--color-content-subtle);
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
}

.ask-history-list {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
}

.ask-history-row {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    border-radius: var(--radius-sm);
}

.ask-history-row:hover,
.ask-history-row:focus-within {
    background: var(--color-row-hover);
}

.ask-history-open {
    flex: 1;
    min-width: 0;
    padding: 0.4375rem 0.625rem;
    overflow: hidden;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-content);
    font-size: 0.8125rem;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ask-history-open[aria-current="true"] {
    color: var(--color-content-strong);
    font-weight: 600;
}

.ask-history-delete {
    opacity: 0;
}

.ask-history-row:hover .ask-history-delete,
.ask-history-delete:focus-visible {
    opacity: 1;
}
</style>
