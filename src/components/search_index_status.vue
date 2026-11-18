<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { use_settings } from '../composables/use_settings'
import { assert } from '../lib/assert'
import { error_friendly, error_shown } from '../lib/errors'
import { ipc } from '../lib/ipc'
import InfoHint from './info_hint.vue'
import type { SearchStatus } from '../types'


const HINT_SEARCH = 'Ask finds passages by meaning as well as by their words. Each new transcript '
    + 'is prepared for this in the background.'

const STATUS_POLL_MS = 1500
const { error_message } = use_settings()
const status = ref<SearchStatus | null>(null)
const status_loading = shallowRef(false)
const status_timer = shallowRef<ReturnType<typeof setInterval> | null>(null)

const status_line = computed<string | null>(() => {
    const current = status.value

    if (current === null) return null
    if (current.error !== null) return null
    if (current.passages_embedded === current.passages) return null

    const ready = String(current.passages_embedded)
    const total = String(current.passages)

    return `Ask can search ${ready} of ${total} passages by meaning. The rest are being prepared.`
})

const status_problem = computed<string | null>(() => {
    const failure = status.value?.error ?? null

    if (failure === null) return null

    return `The search model could not prepare passages. ${error_friendly(failure).message}`
})

onMounted(() => {
    status_timer.value = setInterval(status_tick, STATUS_POLL_MS)

    void status_refresh()
})

onBeforeUnmount(status_stop)

async function status_refresh(): Promise<void> {
    if (status_loading.value) return

    status_loading.value = true

    return ipc.search_status()
        .then((fetched) => {
            assert(fetched.passages_embedded >= 0)
            assert(fetched.passages_embedded <= fetched.passages)

            status.value = fetched
        })
        .catch((error: unknown) => {
            status_stop()
            error_message.value = error_shown(error)

            assert(status_timer.value === null)
        })
        .finally(() => {
            assert(status_loading.value)

            status_loading.value = false
        })
}

function status_stop(): void {
    if (status_timer.value !== null) clearInterval(status_timer.value)

    status_timer.value = null
}

function status_tick(): void {
    assert(status_timer.value !== null)

    void status_refresh()
}

async function vectors_refresh(): Promise<void> {
    assert(status.value !== null)
    assert(status.value.error !== null)

    status.value = { ...status.value, error: null }

    assert(status_problem.value === null)

    return ipc.search_vectors_refresh()
        .catch((error: unknown) => {
            error_message.value = error_shown(error)
        })
}
</script>

<template>
    <div v-if="status_line !== null || status_problem !== null">
        <h3 class="mb-3 flex items-center">
            Search
            <InfoHint :text="HINT_SEARCH" />
        </h3>
        <p v-if="status_line !== null" class="meta">{{ status_line }}</p>
        <div v-if="status_problem !== null" class="flex gap-2 flex-wrap items-center">
            <p class="meta flex-1" role="alert">{{ status_problem }}</p>
            <div class="actions-row">
                <button type="button" class="btn-default" @click="vectors_refresh">
                    Try again
                </button>
            </div>
        </div>
    </div>
</template>
