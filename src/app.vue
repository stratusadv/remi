<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import AppDialogHost from './components/app_dialog_host.vue'
import AskView from './components/ask_view.vue'
import CheckoutView from './components/checkout_view.vue'
import ContextMenu from './components/context_menu.vue'
import JobsManager from './components/jobs_manager.vue'
import NoticeBanner from './components/notice_banner.vue'
import PeopleManager from './components/people_manager.vue'
import SettingsManager from './components/settings_manager.vue'
import Sidebar from './components/side_bar.vue'
import StepImport from './components/step_import.vue'
import StepMeeting from './components/step_meeting.vue'
import StepNotes from './components/step_notes.vue'
import StepTranscribe from './components/step_transcribe.vue'
import TemplatesManager from './components/templates_manager.vue'
import WelcomeScreen from './components/welcome_screen.vue'
import { use_account } from './composables/use_account'
import { use_drag_drop } from './composables/use_drag_drop'
import { use_endpoints } from './composables/use_endpoints'
import { use_folders } from './composables/use_folders'
import { use_jobs } from './composables/use_jobs'
import { use_network } from './composables/use_network'
import { use_notes_templates } from './composables/use_notes_templates'
import { use_people } from './composables/use_people'
import { use_pipeline } from './composables/use_pipeline'
import { use_service } from './composables/use_service'
import { use_settings } from './composables/use_settings'
import { use_theme } from './composables/use_theme'
import { use_update } from './composables/use_update'
import { log_warn } from './lib/log'


const { view_current, view_reopen_count } = use_pipeline()
const { refresh: endpoints_refresh } = use_endpoints()
const { refresh: templates_refresh } = use_notes_templates()
const { refresh: people_refresh } = use_people()
const { refresh: jobs_refresh } = use_jobs()
const { refresh: folders_refresh } = use_folders()
const { refresh: settings_refresh } = use_settings()
const { notes_ready, refresh: service_refresh, transcription_ready } = use_service()

const {
    account_load,
    sign_up_needed,
    status_load: account_status_load,
} = use_account()

const { online } = use_network()
const { dragging_over } = use_drag_drop()
const { phase: update_phase, status_text: update_status_text, update_check_startup } = use_update()


use_theme()

const offline_banner_dismissed = ref(false)
const update_banner_dismissed = ref(false)

const update_banner_visible = computed(
    () => update_phase.value === 'downloading' || update_phase.value === 'installing',
)

const ready = ref<boolean>(false)

const view_components = {
    ask: AskView,
    checkout: CheckoutView,
    jobs: JobsManager,
    transcribe: StepTranscribe,
    import: StepImport,
    details: StepMeeting,
    notes: StepNotes,
    templates: TemplatesManager,
    people: PeopleManager,
    settings: SettingsManager,
}

const current_component = computed(() => view_components[view_current.value])

const configured = computed(() => transcription_ready.value && notes_ready.value)

const welcome = ref(false)

watch([configured, sign_up_needed], ([done, needed]) => {
    if (needed) {
        welcome.value = true

        return
    }

    if (done) welcome.value = false
})

const view_key = computed(() => `${view_current.value}-${String(view_reopen_count.value)}`)

watch(online, () => {
    offline_banner_dismissed.value = false
})

watch(update_banner_visible, () => {
    update_banner_dismissed.value = false
})

function editor_load(): void {
    import('./components/rich_editor.vue').catch((error: unknown) => {
        log_warn('[app] editor prefetch failed', error)
    })
}

function editor_prefetch(): void {
    if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(editor_load)

        return
    }

    setTimeout(editor_load, 0)
}

onMounted(async () => {
    await Promise.all([
        settings_refresh(),
        service_refresh(),
        endpoints_refresh(),
        templates_refresh(),
        people_refresh(),
        jobs_refresh(),
        folders_refresh(),
        account_status_load(),
        document.fonts.load('1em "Geist"'),
        document.fonts.load('italic 1em "Geist"'),
        document.fonts.load('1em "Geist Mono"'),
    ])

    welcome.value = !configured.value || sign_up_needed.value
    ready.value = true

    editor_prefetch()

    void account_load()

    void update_check_startup()
})
</script>

<template>
    <div
        class="flex flex-col h-screen overflow-hidden app-shell"
        :data-ready="ready ? 'true' : 'false'"
    >
        <NoticeBanner
            v-if="!online && !offline_banner_dismissed"
            kind="warning"
            class="banner-shell"
            @dismiss="offline_banner_dismissed = true"
        >
            You appear to be offline. An internet connection is needed to transcribe and to
            write notes.
        </NoticeBanner>
        <NoticeBanner
            v-if="update_banner_visible && !update_banner_dismissed"
            kind="info"
            class="banner-shell"
            @dismiss="update_banner_dismissed = true"
        >
            {{ update_status_text }}
        </NoticeBanner>
        <Transition name="welcome" mode="out-in">
            <WelcomeScreen v-if="ready && welcome" key="welcome" />
            <div v-else key="app" class="flex flex-1 overflow-hidden">
                <Sidebar />
                <main class="flex-1 overflow-y-auto">
                    <div class="app-content px-5 py-6 sm:px-8 sm:py-8 lg:px-12 lg:py-10">
                        <KeepAlive include="StepNotes">
                            <component :is="current_component" :key="view_key" />
                        </KeepAlive>
                    </div>
                </main>
            </div>
        </Transition>
        <div v-if="dragging_over" class="drop-overlay">
            Drop audio or video files. A single file opens for review, and several files are
            transcribed in a batch.
        </div>
        <ContextMenu />
        <AppDialogHost />
    </div>
</template>

<style scoped>
.welcome-enter-active,
.welcome-leave-active {
    transition: opacity 180ms ease;
}

.welcome-enter-from,
.welcome-leave-to {
    opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
    .welcome-enter-active,
    .welcome-leave-active {
        transition: none;
    }
}
</style>
