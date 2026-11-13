<script setup lang="ts">
import { MENU_ICON_PATHS } from '../lib/menu'
import type { MenuIconName } from '../lib/menu'


const props = defineProps<{ name: MenuIconName }>()
</script>

<template>
    <svg
        class="menu-item-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
    >
        <path
            v-for="(path_data, index) in MENU_ICON_PATHS[props.name]"
            :key="index"
            :d="path_data"
        />
    </svg>
</template>
