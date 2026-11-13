<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { use_settings } from '../composables/use_settings'
import { assert } from '../lib/assert'
import { error_friendly } from '../lib/errors'
import { ipc } from '../lib/ipc'
import ClearableInput from './clearable_input.vue'
import InfoHint from './info_hint.vue'
import type { SearchStatus } from '../types'


const props = defineProps<{
    api_host: string
}>()

const HINT_SEARCH_HOST = 'This is the web address of the service that runs the search model. '
    + 'Leave it empty to use the API address.'

const HINT_SEARCH_MODEL = 'This AI model lets Ask find passages by meaning as well as by their '
    + 'words. Leave it empty to search by words alone.'

const STATUS_POLL_MS = 1500
const { settings, error_message, update } = use_settings()
const host_input = ref('')
const model_input = ref('')
const status = ref<SearchStatus | null>(null)
let status_loading = false
let status_timer: ReturnType<typeof setInterval> | null = null
const host_placeholder = computed(() => props.api_host === '' ? 'https://' : props.api_host)

const status_line = computed<string | null>(() => {
    const current = status.value

    if (current === null) return null
    if (current.model === null) return null
    if (current.error !== null) return null
    if (current.passages === 0) return 'There are no transcripts to search yet.'

    const ready = String(current.passages_embedded)
    const total = String(current.passages)

    if (current.passages_embedded < current.passages) {
        return `Ask can search ${ready} of ${total} passages by meaning. The rest are being `
            + 'prepared.'
    }

    return `Ask can search all ${total} passages by meaning.`
})

const status_problem = computed<string | null>(() => {
    const failure = status.value?.error ?? null

    if (failure === null) return null

    return `The search model could not prepare passages. ${error_friendly(failure).message}`
})

watch(() => settings.value.embeddings_host, (saved) => {
    host_input.value = saved ?? ''
}, { immediate: true })

watch(() => settings.value.embeddings_model, (saved) => {
    model_input.value = saved ?? ''
}, { immediate: true })

onMounted(() => {
    status_timer = setInterval(status_tick, STATUS_POLL_MS)

    void status_refresh()
})

onBeforeUnmount(status_stop)

async function host_save(): Promise<void> {
    const host = host_input.value.trim()
    const saved = settings.value.embeddings_host ?? ''

    host_input.value = host

    if (host === saved) return

    await update({ embeddings_host: host === '' ? null : host })
    await status_refresh()
}

function input_leave(event: KeyboardEvent): void {
    if (event.target instanceof HTMLInputElement) event.target.blur()
}

async function model_save(): Promise<void> {
    const model = model_input.value.trim()
    const saved = settings.value.embeddings_model ?? ''

    model_input.value = model

    if (model === saved) return

    await update({ embeddings_model: model === '' ? null : model })
    await status_refresh()
}

async function status_refresh(): Promise<void> {
    if (status_loading) return

    status_loading = true

    return ipc.search_status()
        .then((fetched) => {
            assert(fetched.passages_embedded <= fetched.passages)
            assert(fetched.model !== null || fetched.passages_embedded === 0)

            status.value = fetched
        })
        .catch((error: unknown) => {
            status_stop()
            error_message.value = String(error)
        })
        .finally(() => {
            status_loading = false
        })
}

function status_stop(): void {
    if (status_timer !== null) clearInterval(status_timer)

    status_timer = null
}

function status_tick(): void {
    if (settings.value.embeddings_model === null) return

    void status_refresh()
}

async function vectors_refresh(): Promise<void> {
    assert(status.value !== null)
    assert(status.value.error !== null)

    status.value = { ...status.value, error: null }

    try {
        await ipc.search_vectors_refresh()
    } catch (error) {
        error_message.value = String(error)
    }
}
</script>

<template>
    <div>
        <h3 class="mb-3 flex items-center">
            Search model
            <InfoHint :text="HINT_SEARCH_MODEL" />
        </h3>
        <ClearableInput
            v-model="model_input"
            type="text"
            class="input"
            placeholder="Off"
            autocomplete="off"
            spellcheck="false"
            @blur="model_save"
            @keydown.enter.prevent="input_leave"
        />
        <p v-if="status_line !== null" class="meta mt-2">{{ status_line }}</p>
        <div v-if="status_problem !== null" class="flex gap-2 flex-wrap items-center mt-2">
            <p class="meta flex-1" role="alert">{{ status_problem }}</p>
            <div class="actions-row">
                <button type="button" class="btn-default" @click="vectors_refresh">
                    Try again
                </button>
            </div>
        </div>
    </div>

    <div>
        <h3 class="mb-3 flex items-center">
            Search model address
            <InfoHint :text="HINT_SEARCH_HOST" />
        </h3>
        <ClearableInput
            v-model="host_input"
            type="url"
            class="input"
            :placeholder="host_placeholder"
            autocomplete="off"
            spellcheck="false"
            @blur="host_save"
            @keydown.enter.prevent="input_leave"
        />
    </div>
</template>
