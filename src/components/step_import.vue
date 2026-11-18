<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { use_jobs } from '../composables/use_jobs'
import { use_pipeline } from '../composables/use_pipeline'
import { use_shortcuts } from '../composables/use_shortcuts'
import { assert } from '../lib/assert'
import { error_dialog_show, error_shown } from '../lib/errors'
import { ipc } from '../lib/ipc'
import NoticeBanner from './notice_banner.vue'
import StepBar from './step_bar.vue'
import type { TranscriptionResult } from '../types'


const {
    job_id_current,
    transcript,
    source_path,
    notes_markdown,
    view_current,
    view_set,
    pipeline_reset,
    meta_refresh,
    notes_refresh,
} = use_pipeline()

const { refresh: jobs_refresh } = use_jobs()
const transcript_input = ref<string>('')
const busy = ref(false)
const error_message = ref<string | null>(null)
const can_import = computed(() => !busy.value && transcript_input.value.trim().length > 0)


onMounted(() => {
    transcript_input.value = ''
    error_message.value = null
})

function cancel(): void {
    const view_previous = view_current.value

    assert(view_previous === 'import')

    if (busy.value) return

    view_set('transcribe')

    assert(view_current.value === 'transcribe')
}

async function import_open(imported: TranscriptionResult): Promise<void> {
    assert(imported.job_id.length > 0)
    assert(imported.transcript.segments.length > 0)
    assert(busy.value)

    pipeline_reset()
    job_id_current.value = imported.job_id
    transcript.value = imported.transcript
    source_path.value = null
    notes_markdown.value = ''

    return meta_refresh()
        .then(notes_refresh)
        .then(jobs_refresh)
        .then(() => {
            view_set('details')
        })
}

async function import_run(): Promise<void> {
    if (!can_import.value) return

    const transcript_text = transcript_input.value.trim()

    assert(transcript_text.length > 0)
    assert(!busy.value)

    busy.value = true
    error_message.value = null

    return ipc.transcript_import('', transcript_text)
        .then(import_open)
        .catch(async (error: unknown) => {
            error_message.value = error_shown(error)

            return error_dialog_show(error)
        })
        .finally(() => {
            busy.value = false
        })
}

function import_shortcut(): void {
    assert(view_current.value === 'import')

    void import_run()
}

use_shortcuts({
    'ctrl+enter': import_shortcut,
    escape: cancel,
})
</script>

<template>
    <section class="view-fill step-view">
        <StepBar />

        <NoticeBanner v-if="error_message" @dismiss="error_message = null">
            {{ error_message }}
        </NoticeBanner>

        <textarea
            v-model="transcript_input"
            class="input import-transcript-textarea"
            placeholder="Paste a transcript"
            aria-label="Transcript"
            :disabled="busy"
            spellcheck="false"
        />

        <footer class="step-footer">
            <div class="step-footer-start">
                <button
                    type="button"
                    class="btn-default"
                    :disabled="busy"
                    @click="cancel"
                >
                    Cancel
                </button>
            </div>
            <div class="actions-row">
                <button
                    type="button"
                    class="btn-primary"
                    :disabled="!can_import"
                    @click="import_run"
                >
                    {{ busy ? 'Importing…' : 'Next' }}
                </button>
            </div>
        </footer>
    </section>
</template>

<style scoped>
.import-transcript-textarea {
    flex: 1;
    min-height: 0;
    resize: none;
    padding: 1rem 1.25rem;
    font-family: "Geist Mono", monospace;
    font-size: 0.9375rem;
    line-height: 1.55;
    scrollbar-gutter: stable;
}
</style>
