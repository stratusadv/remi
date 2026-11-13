<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'


defineProps<{
    text: string
    label?: string
}>()

const open = ref(false)
const root = ref<HTMLElement | null>(null)

function close_on_outside(event: MouseEvent): void {
    if (!open.value) return
    if (root.value === null) return
    if (event.target instanceof Node && root.value.contains(event.target)) return

    open.value = false
}

function toggle(): void {
    open.value = !open.value
}

onMounted(() => {
    document.addEventListener('click', close_on_outside, true)
})

onBeforeUnmount(() => {
    document.removeEventListener('click', close_on_outside, true)
})
</script>

<template>
    <span ref="root" class="info-hint">
        <button
            type="button"
            class="info-hint-trigger"
            :aria-label="label ?? 'More information'"
            :aria-expanded="open"
            @click.stop="toggle"
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
                <circle cx="12" cy="12" r="9" />
                <path d="M12 11v5" />
                <circle cx="12" cy="8" r="0.5" fill="currentColor" />
            </svg>
        </button>
        <span v-if="open" class="info-hint-popover" role="note">{{ text }}</span>
    </span>
</template>
