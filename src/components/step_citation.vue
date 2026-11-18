<script setup lang="ts">
import { use_pipeline } from '../composables/use_pipeline'


const { citation_return, view_set } = use_pipeline()
</script>

<template>
    <div v-if="citation_return !== null" class="banner step-citation" data-kind="info">
        <p class="step-citation-text">
            <span class="ask-source-number" aria-hidden="true">{{ citation_return.number }}</span>
            <span class="step-citation-label">
                <span class="sr-only">Source {{ citation_return.number }}:</span>
                Cited in your chat
                <q class="step-citation-question" :title="citation_return.question">
                    {{ citation_return.question }}
                </q>
            </span>
        </p>
        <div class="banner-actions">
            <button type="button" class="btn-default" @click="view_set('ask')">
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.75"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                >
                    <path d="M19 12H5" />
                    <path d="M11 6l-6 6 6 6" />
                </svg>
                Back to answer
            </button>
        </div>
    </div>
</template>

<style scoped>
.step-citation {
    flex-wrap: nowrap;
}

.step-citation svg {
    width: 1rem;
    height: 1rem;
}

.step-citation-label {
    overflow: hidden;
    min-width: 0;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.step-citation-question {
    font-weight: 500;
}

.step-citation-text {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    gap: 0.625rem;
    min-width: 0;
    white-space: normal;
}
</style>
