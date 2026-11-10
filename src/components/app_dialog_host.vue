<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue'
import { use_dialog } from '../composables/use_dialog'


const { current, input, close } = use_dialog()


function on_backdrop_press(): void {
    if (current.value === null) return

    close(false)
}

function on_keydown(event: KeyboardEvent): void {
    if (current.value === null) return

    if (event.key === 'Escape') {
        event.preventDefault()
        close(false)

        return
    }

    if (event.key === 'Enter') {
        event.preventDefault()
        close(true)
    }
}

onMounted(() => {
    window.addEventListener('keydown', on_keydown)
})

onBeforeUnmount(() => {
    window.removeEventListener('keydown', on_keydown)
})

watch(current, (next) => {
    if (typeof document === 'undefined') return

    document.body.style.overflow = next !== null ? 'hidden' : ''
})
</script>

<template>
    <Teleport to="body">
        <Transition name="app-dialog">
            <div
                v-if="current"
                class="app-dialog-backdrop"
                role="dialog"
                aria-modal="true"
                @mousedown.left.self.prevent="on_backdrop_press"
            >
                <div
                    class="app-dialog"
                    :data-kind="current.kind"
                    role="document"
                >
                    <button
                        type="button"
                        class="app-dialog-close"
                        aria-label="Close"
                        title="Close"
                        @click="close(false)"
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
                    <div class="app-dialog-icon">
                        <svg
                            v-if="current.kind === 'warning'"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.6"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            aria-hidden="true"
                        >
                            <path d="M12 9v4" />
                            <path d="M12 17h.01" />
                            <path
                                d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3
                                   L13.71 3.86a2 2 0 0 0-3.42 0Z"
                            />
                        </svg>
                        <svg
                            v-else-if="current.kind === 'error'"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.6"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            aria-hidden="true"
                        >
                            <circle cx="12" cy="12" r="9" />
                            <path d="M15 9l-6 6" />
                            <path d="M9 9l6 6" />
                        </svg>
                        <svg
                            v-else
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.6"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            aria-hidden="true"
                        >
                            <circle cx="12" cy="12" r="9" />
                            <path d="M12 8h.01" />
                            <path d="M11 12h1v4h1" />
                        </svg>
                    </div>
                    <h3 class="app-dialog-title">{{ current.title }}</h3>
                    <p class="app-dialog-message">{{ current.message }}</p>
                    <input
                        v-if="current.input_shown"
                        v-model="input"
                        class="input app-dialog-input"
                        type="text"
                        autocomplete="off"
                        spellcheck="false"
                        :aria-label="current.message"
                    >
                    <div class="app-dialog-actions">
                        <button
                            v-if="current.cancel_label"
                            type="button"
                            class="btn-default"
                            @click="close(false)"
                        >
                            {{ current.cancel_label }}
                        </button>
                        <button
                            type="button"
                            :class="current.danger ? 'btn-danger' : 'btn-primary'"
                            @click="close(true)"
                        >
                            {{ current.ok_label }}
                        </button>
                    </div>
                </div>
            </div>
        </Transition>
    </Teleport>
</template>
