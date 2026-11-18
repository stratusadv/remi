<script setup lang="ts">
import { ICON_PATH_FOLDER } from '../lib/menu'
import type { FolderName } from '../types'


defineProps<{
    name: FolderName | null
}>()
</script>

<template>
    <span v-if="name !== null" class="folder-tag" :title="name">
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
        >
            <path :d="ICON_PATH_FOLDER" />
        </svg>
        <span class="sr-only">Folder </span>
        <span class="folder-tag-name">{{ name }}</span>
    </span>
</template>

<style scoped>
.folder-tag {
    display: inline-flex;
    flex: 0 1 auto;
    align-items: center;
    gap: 0.25rem;
    min-width: 0;
    max-width: 12rem;
    padding: 0 0.4375rem 0 0.3125rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background-color: var(--color-surface);
    color: var(--color-content-muted);
    font-size: 0.6875rem;
    font-weight: 500;
    line-height: 1rem;
    white-space: nowrap;
}

.folder-tag svg {
    flex: none;
    width: 0.8125rem;
    height: 0.8125rem;
}

.folder-tag-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
}
</style>
