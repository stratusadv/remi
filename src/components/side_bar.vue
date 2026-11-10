<script setup lang="ts">
import { ref } from 'vue'
import { use_pipeline } from '../composables/use_pipeline'
import SidebarIcon from './sidebar_icon.vue'
import TasksPanel from './tasks_panel.vue'
import type { View } from '../composables/use_pipeline'
import type { IconName } from './sidebar_icon.vue'


interface NavItem {
    id: View
    label: string
    icon: IconName
}

const COLLAPSED_STORAGE_KEY = 'scribe.sidebar.collapsed'
const { view_current, view_reopen, pipeline_reset } = use_pipeline()

const collapsed = ref<boolean>(
    typeof localStorage !== 'undefined' && localStorage.getItem(COLLAPSED_STORAGE_KEY) === '1',
)

const workflow_items: NavItem[] = [
    { id: 'jobs', label: 'Home', icon: 'jobs' },
    { id: 'templates', label: 'Templates', icon: 'templates' },
    { id: 'people', label: 'People', icon: 'people' },
]

function collapse_toggle(): void {
    collapsed.value = !collapsed.value

    if (typeof localStorage !== 'undefined') {
        localStorage.setItem(COLLAPSED_STORAGE_KEY, collapsed.value ? '1' : '0')
    }
}

function nav_button_class(item_id: View): string {
    return view_current.value === item_id ? 'sidebar-nav-item-active' : 'sidebar-nav-item'
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
                @click="pipeline_reset"
            >
                <span>scribe</span>
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
                        @click="view_reopen(item.id)"
                    >
                        <SidebarIcon :name="item.icon" />
                        <span v-if="!collapsed">{{ item.label }}</span>
                    </button>
                </li>
            </ul>
        </nav>

        <TasksPanel v-if="!collapsed" />

        <div class="sidebar-divider sidebar-footer-actions border-t">
            <button
                :class="nav_button_class('settings')"
                :title="collapsed ? 'Settings' : undefined"
                @click="view_reopen('settings')"
            >
                <SidebarIcon name="settings" />
                <span v-if="!collapsed">Settings</span>
            </button>
        </div>
    </aside>
</template>
