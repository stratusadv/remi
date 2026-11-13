<script setup lang="ts">
import { computed } from 'vue'


const props = defineProps<{
    favourite: boolean
    title: string
}>()

const emit = defineEmits<{
    toggle: []
}>()

const label = computed(() =>
    props.favourite
        ? `Remove ${props.title} from favourites`
        : `Add ${props.title} to favourites`)
</script>

<template>
    <button
        type="button"
        class="recording-tile-star"
        :aria-pressed="props.favourite"
        :aria-label="label"
        :title="props.favourite ? 'Remove from favourites' : 'Add to favourites'"
        @click="emit('toggle')"
    >
        <svg
            viewBox="0 0 24 24"
            :fill="props.favourite ? 'currentColor' : 'none'"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linejoin="round"
            aria-hidden="true"
        >
            <path
                d="M11.48 3.5a.56.56 0 0 1 1.04 0l2.12 5.11a.56.56 0 0 0 .48.35l5.52.44
                   c.5.04.7.66.32.99l-4.2 3.6a.56.56 0 0 0-.18.56l1.28 5.39
                   a.56.56 0 0 1-.84.61l-4.73-2.89a.56.56 0 0 0-.58 0l-4.73 2.89
                   a.56.56 0 0 1-.84-.61l1.28-5.39a.56.56 0 0 0-.18-.56l-4.2-3.6
                   a.56.56 0 0 1 .32-.99l5.52-.44a.56.56 0 0 0 .48-.35L11.48 3.5Z"
            />
        </svg>
    </button>
</template>
