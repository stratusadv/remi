<script setup lang="ts">
type BannerKind = 'error' | 'info' | 'warning'

withDefaults(defineProps<{ kind?: BannerKind }>(), { kind: 'error' })

defineEmits<{ dismiss: [] }>()

const slots = defineSlots<{
    actions?: () => unknown
    default?: () => unknown
}>()
</script>

<template>
    <div class="banner" :data-kind="kind" :role="kind === 'error' ? 'alert' : 'status'">
        <div class="banner-body">
            <p><slot /></p>
            <div v-if="slots.actions !== undefined" class="banner-actions">
                <slot name="actions" />
            </div>
        </div>
        <button
            type="button"
            class="banner-close"
            aria-label="Dismiss"
            @click="$emit('dismiss')"
        >
            <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                aria-hidden="true"
            >
                <path d="M6 6l12 12" />
                <path d="M18 6L6 18" />
            </svg>
        </button>
    </div>
</template>
