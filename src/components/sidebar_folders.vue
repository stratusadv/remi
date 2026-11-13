<script setup lang="ts">
import { use_context_menu } from '../composables/use_context_menu'
import { use_folders } from '../composables/use_folders'
import { use_job_drag } from '../composables/use_job_drag'
import { use_pipeline } from '../composables/use_pipeline'
import { assert } from '../lib/assert'
import { error_dialog_show } from '../lib/errors'
import { folder_key } from '../lib/folders'
import SidebarIcon from './sidebar_icon.vue'
import type { FolderName } from '../types'


const { open: context_menu_open } = use_context_menu()
const { drag_target, drop_blocked } = use_job_drag()
const { view_current } = use_pipeline()

const {
    error_message,
    folder_count,
    folder_create,
    folder_current,
    folder_menu_items,
    folder_menu_select,
    folder_open,
    folders,
} = use_folders()


function folder_active(name: FolderName): boolean {
    assert(name.length > 0)

    if (view_current.value !== 'jobs') return false

    return folder_key(folder_current.value ?? '') === folder_key(name)
}

function folder_menu(event: MouseEvent, name: FolderName): void {
    assert(event.type === 'contextmenu')
    assert(name.length > 0)

    context_menu_open(event, folder_menu_items(name), folder_menu_select.bind(undefined, name))
}

async function folder_new(): Promise<void> {
    try {
        await folder_create()
    } catch (error) {
        await error_dialog_show(error)
    }
}
</script>

<template>
    <section class="sidebar-folders" aria-labelledby="sidebar-folders-title">
        <div class="sidebar-section-header">
            <h2 id="sidebar-folders-title" class="sidebar-section-title">Folders</h2>
            <button
                type="button"
                class="sidebar-icon-btn"
                aria-label="New folder"
                title="New folder"
                @click="folder_new"
            >
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.75"
                    stroke-linecap="round"
                    aria-hidden="true"
                >
                    <path d="M12 5.25v13.5" />
                    <path d="M5.25 12h13.5" />
                </svg>
            </button>
        </div>

        <p v-if="error_message !== null" class="sidebar-folders-note" role="alert">
            {{ error_message }}
        </p>

        <ul v-if="folders.length > 0" class="flex flex-col gap-0.5">
            <li v-for="folder in folders" :key="folder">
                <button
                    type="button"
                    :class="folder_active(folder) ? 'sidebar-nav-item-active' : 'sidebar-nav-item'"
                    :aria-current="folder_active(folder) ? 'page' : undefined"
                    :data-drop-blocked="drop_blocked(folder) ? 'true' : 'false'"
                    :data-drop-target="drag_target === folder ? 'true' : 'false'"
                    :data-folder-drop="folder"
                    :title="folder"
                    @click="folder_open(folder)"
                    @contextmenu="folder_menu($event, folder)"
                >
                    <SidebarIcon name="folder" />
                    <span class="sidebar-folder-name">{{ folder }}</span>
                    <span class="sidebar-folder-count">{{ folder_count(folder) }}</span>
                </button>
            </li>
        </ul>

        <p v-else class="sidebar-folders-note">No folders yet</p>
    </section>
</template>

<style scoped>
.sidebar-folders {
    display: grid;
    gap: 0.25rem;
    margin-top: 1.25rem;
}

.sidebar-section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-left: 0.625rem;
}

.sidebar-section-title {
    margin: 0;
    color: var(--color-content-meta);
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-weight: 500;
    letter-spacing: 0.2em;
    text-transform: uppercase;
}

.sidebar-folders button[data-drop-blocked="true"] {
    cursor: not-allowed;
}

.sidebar-folders button[data-drop-target="true"] {
    background-color: var(--color-accent-soft);
    box-shadow: inset 0 0 0 1px var(--color-accent);
    color: var(--color-content-strong);
}

.sidebar-folder-name {
    flex: 1 1 auto;
}

.sidebar-folder-count {
    flex: none;
    color: var(--color-content-meta);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
}

.sidebar-folders-note {
    margin: 0;
    padding: 0.25rem 0.625rem;
    color: var(--color-content-meta);
    font-size: 0.8125rem;
}
</style>
