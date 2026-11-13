<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { use_jobs } from '../composables/use_jobs'
import { use_pipeline } from '../composables/use_pipeline'
import { use_shortcuts } from '../composables/use_shortcuts'
import { error_dialog_show } from '../lib/errors'
import { ipc } from '../lib/ipc'
import NoticeBanner from './notice_banner.vue'
import StepBar from './step_bar.vue'


const {
    job_id_current,
    transcript,
    source_path,
    notes_markdown,
    view_set,
    pipeline_reset,
    meta_refresh,
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
    view_set('transcribe')
}

async function import_run(): Promise<void> {
    if (!can_import.value) return

    const transcript_for_call = transcript_input.value.trim()

    busy.value = true
    error_message.value = null

    try {
        const result = await ipc.transcript_import('', transcript_for_call)

        pipeline_reset()
        job_id_current.value = result.job_id
        transcript.value = result.transcript
        source_path.value = null
        notes_markdown.value = ''

        await meta_refresh()
        await jobs_refresh()
        view_set('details')
    } catch (error) {
        error_message.value = String(error)

        await error_dialog_show(error)
    } finally {
        busy.value = false
    }
}

use_shortcuts({
    'ctrl+enter': () => { if (can_import.value) void import_run() },
    escape: () => { if (!busy.value) cancel() },
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
                <button class="btn-default" :disabled="busy" @click="cancel">Cancel</button>
            </div>
            <div class="actions-row">
                <button class="btn-primary" :disabled="!can_import" @click="import_run">
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
