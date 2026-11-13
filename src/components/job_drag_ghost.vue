<script setup lang="ts">
import { computed } from 'vue'
import { use_job_drag } from '../composables/use_job_drag'
import { job_title } from '../lib/job_status'
import type { CSSProperties } from 'vue'


const { drag_job, drag_point } = use_job_drag()

const position = computed<CSSProperties>(() => ({
    left: `${String(drag_point.value.x_px)}px`,
    top: `${String(drag_point.value.y_px)}px`,
}))
</script>

<template>
    <Teleport to="body">
        <div v-if="drag_job !== null" class="job-drag-ghost" :style="position" aria-hidden="true">
            {{ job_title(drag_job) }}
        </div>
    </Teleport>
</template>

<style scoped>
.job-drag-ghost {
    position: fixed;
    z-index: 60;
    max-width: 16rem;
    padding: 0.375rem 0.625rem;
    overflow: hidden;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background-color: var(--color-panel);
    box-shadow: var(--shadow-elevated);
    color: var(--color-content-strong);
    font-size: 0.8125rem;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
    pointer-events: none;
    transform: translate(0.75rem, 0.75rem);
}
</style>
