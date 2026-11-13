<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { use_folders } from '../composables/use_folders'
import { assert } from '../lib/assert'
import { error_dialog_show } from '../lib/errors'
import { folder_key } from '../lib/folders'
import { job_title } from '../lib/job_status'
import SidebarIcon from './sidebar_icon.vue'
import type { FolderName, JobMeta } from '../types'


const job = defineModel<JobMeta | null>('job', { required: true })

const { folder_create, folder_move, folders } = use_folders()
const busy = ref(false)
const list_ref = ref<HTMLElement | null>(null)
const key_current = computed(() => folder_key(job.value?.project ?? ''))


watch(job, (shown) => {
    if (shown === null) return

    void nextTick(option_focus)
})

async function choose(name: FolderName | null): Promise<void> {
    const target = job.value

    if (target === null) return
    if (busy.value) return

    if (folder_key(name ?? '') === key_current.value) {
        close()

        return
    }

    busy.value = true

    await move_persist(target, name).finally(() => {
        busy.value = false
    })
}

function close(): void {
    if (busy.value) return

    job.value = null

    assert(!busy.value)
}

async function create(): Promise<void> {
    const target = job.value

    if (target === null) return
    if (busy.value) return

    job.value = null

    try {
        const created = await folder_create()

        if (created === null) return

        await folder_move(target, created)
    } catch (error) {
        await error_dialog_show(error)
    }
}

function current(name: FolderName | null): boolean {
    assert(name === null || name.length > 0)

    return folder_key(name ?? '') === key_current.value
}

async function move_persist(target: JobMeta, name: FolderName | null): Promise<void> {
    assert(target.id.length > 0)

    try {
        await folder_move(target, name)

        job.value = null
    } catch (error) {
        await error_dialog_show(error)
    }
}

function option_focus(): void {
    const list = list_ref.value

    if (list === null) return

    const chosen = list.querySelector<HTMLElement>('[aria-current="true"]')
    const target = chosen ?? list.querySelector<HTMLElement>('button')

    target?.focus()
}
</script>

<template>
    <Teleport to="body">
        <Transition name="app-dialog">
            <div
                v-if="job"
                class="app-dialog-backdrop"
                role="dialog"
                aria-modal="true"
                aria-labelledby="folder-move-title"
                @mousedown.left.self.prevent="close"
                @keydown.esc="close"
            >
                <div class="app-dialog">
                    <button
                        type="button"
                        class="app-dialog-close"
                        aria-label="Close"
                        title="Close"
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
                    <h3 id="folder-move-title" class="app-dialog-title">Move to folder</h3>
                    <p class="folder-move-subject">{{ job_title(job) }}</p>

                    <ul ref="list_ref" class="folder-move-list" aria-label="Folders">
                        <li>
                            <button
                                type="button"
                                class="folder-move-option"
                                :aria-current="current(null) ? 'true' : undefined"
                                :disabled="busy"
                                @click="choose(null)"
                            >
                                <span class="folder-move-spacer" aria-hidden="true" />
                                <span class="folder-move-name">No folder</span>
                                <svg
                                    v-if="current(null)"
                                    class="folder-move-check"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    stroke-width="2"
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                    aria-hidden="true"
                                >
                                    <path d="M5 12.5l4.5 4.5L19 7.5" />
                                </svg>
                            </button>
                        </li>
                        <li v-for="folder in folders" :key="folder">
                            <button
                                type="button"
                                class="folder-move-option"
                                :aria-current="current(folder) ? 'true' : undefined"
                                :disabled="busy"
                                @click="choose(folder)"
                            >
                                <SidebarIcon name="folder" />
                                <span class="folder-move-name">{{ folder }}</span>
                                <svg
                                    v-if="current(folder)"
                                    class="folder-move-check"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    stroke-width="2"
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                    aria-hidden="true"
                                >
                                    <path d="M5 12.5l4.5 4.5L19 7.5" />
                                </svg>
                            </button>
                        </li>
                    </ul>

                    <div class="folder-move-actions">
                        <button
                            type="button"
                            class="btn-default"
                            :disabled="busy"
                            @click="create"
                        >
                            New folder
                        </button>
                        <button
                            type="button"
                            class="btn-default"
                            :disabled="busy"
                            @click="close"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
.folder-move-subject {
    margin: 0;
    overflow: hidden;
    color: var(--color-content-muted);
    font-size: 0.875rem;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.folder-move-list {
    display: grid;
    gap: 0.125rem;
    max-height: 18rem;
    margin: 1rem 0 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;
}

.folder-move-option {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    width: 100%;
    padding: 0.5rem 0.625rem;
    border-radius: var(--radius-md);
    color: var(--color-content);
    font-size: 0.875rem;
    text-align: left;
    transition: background-color 100ms ease;
}

.folder-move-option:hover:not(:disabled) {
    background: var(--color-row-hover);
}

.folder-move-option[aria-current="true"] {
    background: var(--color-row-active);
    color: var(--color-content-strong);
    font-weight: 500;
}

.folder-move-option:disabled {
    opacity: 0.6;
    cursor: default;
}

.folder-move-spacer {
    flex: none;
    width: 1rem;
}

.folder-move-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.folder-move-check {
    flex: none;
    width: 1rem;
    height: 1rem;
    color: var(--color-accent);
}

.folder-move-actions {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    margin-top: 1.25rem;
}
</style>
