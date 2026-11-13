<script setup lang="ts">
import { MENU_ICON_PATHS } from '../lib/menu'


const props = defineProps<{
    title: string
}>()

const emit = defineEmits<{
    ask: []
}>()
</script>

<template>
    <button
        type="button"
        class="recording-tile-ask"
        :aria-label="`Ask about ${props.title}`"
        title="Ask about this meeting"
        @click="emit('ask')"
    >
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
        >
            <path v-for="path_data in MENU_ICON_PATHS.ask" :key="path_data" :d="path_data" />
        </svg>
    </button>
</template>
