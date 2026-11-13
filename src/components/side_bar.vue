<script setup lang="ts">
import { ref } from 'vue'
import { use_account } from '../composables/use_account'
import { use_ask } from '../composables/use_ask'
import { use_context_menu } from '../composables/use_context_menu'
import { use_folders } from '../composables/use_folders'
import { use_pipeline } from '../composables/use_pipeline'
import { assert } from '../lib/assert'
import RemiMark from './remi_mark.vue'
import SidebarFolders from './sidebar_folders.vue'
import SidebarIcon from './sidebar_icon.vue'
import TasksPanel from './tasks_panel.vue'
import type { View } from '../composables/use_pipeline'
import type { MenuItem } from '../lib/menu'
import type { IconName } from './sidebar_icon.vue'


interface NavItem {
    id: View
    label: string
    icon: IconName
}

const COLLAPSED_STORAGE_KEY = 'remi.sidebar.collapsed'

const NAV_MENU_ITEMS: Readonly<Partial<Record<View, readonly MenuItem[]>>> = Object.freeze({
    ask: [{ id: 'chat_new', label: 'New chat', icon: 'add' }],
    jobs: [{ id: 'recording_new', label: 'New recording', icon: 'add' }],
    people: [
        { id: 'person_add', label: 'Add person', icon: 'add' },
        { id: 'group_add', label: 'Add group', icon: 'add' },
    ],
    settings: [
        { id: 'settings_general', label: 'General', icon: 'settings' },
        { id: 'settings_ai', label: 'AI', icon: 'sparkles' },
        { id: 'settings_account', label: 'Account', icon: 'person' },
    ],
    templates: [{ id: 'template_add', label: 'Add template', icon: 'add' }],
})

const { account, balance_text, status: account_status } = use_account()
const { clear: chat_clear } = use_ask()
const { open: context_menu_open } = use_context_menu()
const { folder_close, folder_current } = use_folders()

const {
    view_current,
    view_intent_open,
    view_reopen,
    job_start_new,
    pipeline_reset,
} = use_pipeline()

const collapsed = ref<boolean>(
    typeof localStorage !== 'undefined' && localStorage.getItem(COLLAPSED_STORAGE_KEY) === '1',
)

const workflow_items: NavItem[] = [
    { id: 'jobs', label: 'Home', icon: 'jobs' },
    { id: 'ask', label: 'Ask', icon: 'ask' },
    { id: 'templates', label: 'Templates', icon: 'templates' },
    { id: 'people', label: 'People', icon: 'people' },
]

function brand_click(): void {
    assert(view_current.value.length > 0)

    folder_close()
    pipeline_reset()

    assert(folder_current.value === null)
}

async function chat_new(): Promise<void> {
    assert(view_current.value.length > 0)

    await chat_clear()
    view_reopen('ask')

    assert(view_current.value === 'ask')
}

function collapse_toggle(): void {
    collapsed.value = !collapsed.value

    if (typeof localStorage !== 'undefined') {
        localStorage.setItem(COLLAPSED_STORAGE_KEY, collapsed.value ? '1' : '0')
    }
}

function nav_button_class(item_id: View): string {
    const current = view_current.value === item_id
    const folder_shown = [item_id === 'jobs', folder_current.value !== null].every(Boolean)

    return current && !folder_shown ? 'sidebar-nav-item-active' : 'sidebar-nav-item'
}

function nav_click(item_id: View): void {
    assert(item_id.length > 0)

    if (item_id === 'jobs') folder_close()

    view_reopen(item_id)

    assert(view_current.value === item_id)
}

function nav_menu(event: MouseEvent, item_id: View): void {
    assert(event.type === 'contextmenu')

    const billing = account_status.value.billing
    const items = NAV_MENU_ITEMS[item_id]

    assert(items !== undefined, `the sidebar has no menu for ${item_id}`)

    const shown = items.filter((item) => billing || item.id !== 'settings_account')

    context_menu_open(event, shown, nav_menu_select)
}

async function nav_menu_select(id: string): Promise<void> {
    assert(id.length > 0)

    switch (id) {
        case 'chat_new':
            return chat_new()
        case 'recording_new':
            job_start_new()

            return
        case 'group_add':
        case 'person_add':
        case 'settings_account':
        case 'settings_ai':
        case 'settings_general':
        case 'template_add':
            view_intent_open(id)

            return
        default:
            throw new Error(`The sidebar has no action for the menu item ${id}.`)
    }
}
</script>

<template>
    <aside
        class="sidebar shrink-0 border-r flex flex-col"
        :data-collapsed="collapsed ? 'true' : 'false'"
    >
        <div class="sidebar-header">
            <button
                v-if="!collapsed"
                class="sidebar-brand"
                title="Reset and go to recordings"
                aria-label="Remi"
                @click="brand_click"
            >
                <RemiMark class="sidebar-brand-lockup" lockup small />
            </button>
            <button
                class="sidebar-icon-btn"
                :title="collapsed ? 'Expand sidebar' : 'Collapse sidebar'"
                @click="collapse_toggle"
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                >
                    <path v-if="collapsed" d="M9 6l6 6-6 6" />
                    <path v-else d="M15 6l-6 6 6 6" />
                </svg>
            </button>
        </div>

        <nav class="flex-1 px-2.5 pb-3 overflow-y-auto">
            <ul class="flex flex-col gap-0.5">
                <li v-for="item in workflow_items" :key="item.id">
                    <button
                        :class="nav_button_class(item.id)"
                        :title="collapsed ? item.label : undefined"
                        @click="nav_click(item.id)"
                        @contextmenu="nav_menu($event, item.id)"
                    >
                        <SidebarIcon :name="item.icon" />
                        <span v-if="!collapsed">{{ item.label }}</span>
                    </button>
                </li>
            </ul>

            <SidebarFolders v-if="!collapsed" />
        </nav>

        <TasksPanel v-if="!collapsed" />

        <div v-if="account !== null && !collapsed" class="sidebar-balance sidebar-divider border-t">
            <span class="sidebar-balance-text">{{ balance_text }} left</span>
            <button type="button" class="sidebar-balance-buy" @click="view_reopen('checkout')">
                Buy hours
            </button>
        </div>

        <div class="sidebar-divider sidebar-footer-actions border-t">
            <button
                :class="nav_button_class('settings')"
                :title="collapsed ? 'Settings' : undefined"
                @click="view_reopen('settings')"
                @contextmenu="nav_menu($event, 'settings')"
            >
                <SidebarIcon name="settings" />
                <span v-if="!collapsed">Settings</span>
            </button>
        </div>
    </aside>
</template>
