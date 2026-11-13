<script setup lang="ts">
import {
    ICON_PATH_BUBBLE,
    ICON_PATH_FOLDER,
    ICON_PATH_GEAR,
    ICON_PATH_PERSON_BODY,
    ICON_PATH_PERSON_HEAD,
} from '../lib/menu'


export type IconName =
    | 'ask'
    | 'folder'
    | 'jobs'
    | 'templates'
    | 'people'
    | 'settings'

const props = defineProps<{ name: IconName }>()

const ICON_PATHS: Record<IconName, string[]> = {
    ask: ['M7.5 8.25h9', 'M7.5 11.25H12', ICON_PATH_BUBBLE],
    folder: [ICON_PATH_FOLDER],
    jobs: ['M3 11l9-7 9 7', 'M5 10v10h14V10', 'M10 20v-6h4v6'],
    templates: [
        'M4.5 4.5h15v15h-15Z',
        'M4.5 9.75h15',
        'M9.75 9.75v9.75',
    ],
    people: [ICON_PATH_PERSON_HEAD, ICON_PATH_PERSON_BODY],
    settings: [
        ICON_PATH_GEAR,
        'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
    ],
}
</script>

<template>
    <svg
        class="sidebar-nav-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
    >
        <path v-for="path_data in ICON_PATHS[props.name]" :key="path_data" :d="path_data" />
    </svg>
</template>
