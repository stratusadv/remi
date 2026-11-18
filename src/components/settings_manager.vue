<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue'
import { open as dialog_open } from '@tauri-apps/plugin-dialog'
import { use_account } from '../composables/use_account'
import { use_notes_templates } from '../composables/use_notes_templates'
import { use_pipeline } from '../composables/use_pipeline'
import { use_settings } from '../composables/use_settings'
import { PALETTES, THEMES, use_theme } from '../composables/use_theme'
import { use_update } from '../composables/use_update'
import { assert } from '../lib/assert'
import { error_dialog_show, error_shown } from '../lib/errors'
import { ipc } from '../lib/ipc'
import ClearableInput from './clearable_input.vue'
import InfoHint from './info_hint.vue'
import NoticeBanner from './notice_banner.vue'
import RemiMark from './remi_mark.vue'
import SearchIndexStatus from './search_index_status.vue'
import StratusCredit from './stratus_credit.vue'
import type { ViewIntent } from '../composables/use_pipeline'
import type { ModeChoice, PaletteChoice, ThemeChoice } from '../types'


type SettingsTab = 'general' | 'account'

interface SettingsTabItem {
    id: SettingsTab
    label: string
}

interface ModeChoiceItem {
    value: ModeChoice
    label: string
}

const SETTINGS_TABS = Object.freeze<SettingsTabItem[]>([{ id: 'general', label: 'General' }])

const SETTINGS_TAB_ACCOUNT = Object.freeze<SettingsTabItem>({ id: 'account', label: 'Account' })

const SETTINGS_TAB_OF_INTENT: Readonly<Partial<Record<ViewIntent, SettingsTab>>> = Object.freeze({
    settings_account: 'account',
    settings_general: 'general',
})

const MODE_CHOICES = Object.freeze<ModeChoiceItem[]>([
    { value: 'system', label: 'Match my computer' },
    { value: 'dark', label: 'Dark' },
    { value: 'light', label: 'Light' },
])

const HINT_PAGE = 'This page covers how remi looks, where it saves recordings, and your account.'

const HINT_PROMO = 'A promo code adds free transcription hours to your account. Each code works '
    + 'once per email address.'

const HINT_SIGN_IN_CODE = 'This code signs in to your account on another computer. Keep it '
    + 'private, like a password.'

const HINT_TEMPLATE_DEFAULT = 'This template is picked for each new recording. You can still '
    + 'choose another before generating.'

const COPIED_FLASH_MS = 1500
const KEY_DEFAULT_PATH = 'defaultPath'
const { settings, error_message, refresh, update } = use_settings()

const {
    account,
    account_load,
    balance_text,
    code_copy,
    error_message: account_error,
    promo_redeem,
    status: account_status,
} = use_account()

const { templates } = use_notes_templates()
const { view_intent_take, view_reopen } = use_pipeline()
const { mode_set, palette_effective, palette_set, theme_effective, theme_set } = use_theme()

const {
    phase: update_phase,
    app_version,
    status_text: update_status_text,
    update_check_manual,
    update_install,
} = use_update()

const tab_current = ref<SettingsTab>('general')
const recordings_directory_default = ref('')
const code_copied = ref(false)
const promo_busy = ref(false)
const promo_input = ref('')
const promo_notice = ref<string | null>(null)
const promo_problem = ref<string | null>(null)
const code_copied_timer = shallowRef<ReturnType<typeof setTimeout> | null>(null)

const update_busy = computed(() =>
    update_phase.value === 'checking'
    || update_phase.value === 'downloading'
    || update_phase.value === 'installing')

const update_button_label = computed(() => {
    switch (update_phase.value) {
        case 'checking': return 'Checking…'
        case 'available': return 'Install update'
        case 'downloading': return 'Downloading…'
        case 'installing': return 'Installing…'
        case 'idle':
        case 'none':
        case 'error':
        default: return 'Check for updates'
    }
})

const balance_line = computed(() =>
    account.value === null ? 'Loading…' : `${balance_text.value} of transcription left`)

const settings_tabs = computed<readonly SettingsTabItem[]>(() =>
    account_status.value.billing ? [...SETTINGS_TABS, SETTINGS_TAB_ACCOUNT] : SETTINGS_TABS)

const mode_selected = computed<ModeChoice>(() => settings.value.mode ?? 'system')


async function account_code_copy(): Promise<void> {
    assert(tab_current.value === 'account')
    assert(code_copied.value === (code_copied_timer.value !== null))

    return code_copy()
        .then(() => {
            assert(code_copied.value === (code_copied_timer.value !== null))

            code_copied.value = true

            if (code_copied_timer.value !== null) clearTimeout(code_copied_timer.value)

            code_copied_timer.value = setTimeout(code_copied_clear, COPIED_FLASH_MS)
        })
        .catch(error_dialog_show)
}

async function account_promo_redeem(): Promise<void> {
    assert(tab_current.value === 'account')
    assert(promo_notice.value === null || promo_problem.value === null)

    const code = promo_input.value.trim()

    if (code === '') return
    if (promo_busy.value) return

    promo_busy.value = true
    promo_notice.value = null
    promo_problem.value = null

    return promo_redeem(code)
        .then(() => {
            assert(promo_problem.value === null)

            promo_input.value = ''
            promo_notice.value = `${code} was redeemed. You now have ${balance_text.value}.`
        })
        .catch((error: unknown) => {
            assert(promo_notice.value === null)

            promo_problem.value = error_shown(error)
        })
        .finally(() => {
            assert(promo_busy.value)

            promo_busy.value = false
        })
}

intent_apply()

onMounted(async () => {
    await refresh()

    try {
        recordings_directory_default.value = await ipc.recordings_directory_default()
    } catch (error) {
        error_message.value = error_shown(error)
    }

    void account_load()
})

function code_copied_clear(): void {
    assert(code_copied.value)
    assert(code_copied_timer.value !== null)

    code_copied.value = false
    code_copied_timer.value = null
}

function mode_change(event: Event): void {
    assert(event.type === 'change')
    assert(event.currentTarget instanceof HTMLSelectElement)

    const value = select_value(event)

    assert(value.length > 0)

    if (mode_choice_is(value)) mode_set(value)
}

function mode_choice_is(value: string): value is ModeChoice {
    assert(value.length > 0)

    return MODE_CHOICES.some((choice) => choice.value === value)
}

function intent_apply(): void {
    const intent = view_intent_take()

    if (intent === null) return

    const tab = SETTINGS_TAB_OF_INTENT[intent]

    assert(tab !== undefined, `the Settings view cannot open ${intent}`)
    assert(tab_current.value === 'general')

    if (settings_tabs.value.some((item) => item.id === tab)) tab_current.value = tab

    assert(settings_tabs.value.some((item) => item.id === tab_current.value))
}

function notes_template_default_change(event: Event): void {
    assert(event.type === 'change')
    assert(event.currentTarget instanceof HTMLSelectElement)

    const value = select_value(event)

    assert(value.length === 0 || templates.value.some((template) => template.id === value))

    void update({ notes_template_id_default: value.length > 0 ? value : null })
}

function palette_change(event: Event): void {
    assert(event.type === 'change')
    assert(event.currentTarget instanceof HTMLSelectElement)

    const value = select_value(event)

    assert(value.length > 0)

    if (palette_choice_is(value)) palette_set(value)
}

function palette_choice_is(value: string): value is PaletteChoice {
    assert(value.length > 0)

    return PALETTES.some((palette) => palette.id === value)
}

async function recordings_directory_choose(): Promise<void> {
    assert(tab_current.value === 'general')

    const directory_current = settings.value.recordings_directory
        ?? recordings_directory_default.value

    return dialog_open({ directory: true, [KEY_DEFAULT_PATH]: directory_current })
        .then(async (selected) => {
            if (typeof selected === 'string') await update({ recordings_directory: selected })
        })
        .catch(error_dialog_show)
}

function recordings_directory_reset(): void {
    assert(tab_current.value === 'general')
    assert(settings.value.recordings_directory !== null)

    void update({ recordings_directory: null })
}

function select_value(event: Event): string {
    assert(event.type === 'change')
    assert(event.currentTarget instanceof HTMLSelectElement)

    return event.target instanceof HTMLSelectElement ? event.target.value : ''
}

function theme_change(event: Event): void {
    assert(event.type === 'change')
    assert(event.currentTarget instanceof HTMLSelectElement)

    const value = select_value(event)

    assert(value.length > 0)

    if (theme_choice_is(value)) theme_set(value)
}

function theme_choice_is(value: string): value is ThemeChoice {
    assert(value.length > 0)

    return THEMES.some((theme) => theme.id === value)
}

async function update_action(): Promise<void> {
    assert(tab_current.value === 'general')
    assert(!update_busy.value)

    if (update_phase.value === 'available') return update_install()

    return update_check_manual()
}
</script>

<template>
    <section class="settings-view">
        <header class="page-header">
            <div>
                <p class="eyebrow page-eyebrow">Preferences</p>
                <h2 class="!mb-1 flex items-center">
                    Settings
                    <InfoHint :text="HINT_PAGE" />
                </h2>
            </div>
        </header>

        <div class="step-bar mb-6" role="tablist">
            <button
                v-for="tab in settings_tabs"
                :key="tab.id"
                type="button"
                class="step-bar-item"
                role="tab"
                :data-state="tab_current === tab.id ? 'current' : 'todo'"
                :aria-selected="tab_current === tab.id"
                @click="tab_current = tab.id"
            >
                {{ tab.label }}
            </button>
        </div>

        <NoticeBanner v-if="error_message" class="mb-6" @dismiss="error_message = null">
            {{ error_message }}
        </NoticeBanner>

        <div v-if="tab_current === 'general'" class="space-y-6">
            <div>
                <h3 class="mb-3">Appearance</h3>
                <div class="space-y-4">
                    <div>
                        <label class="label" for="settings-theme">Theme</label>
                        <select
                            id="settings-theme"
                            :value="theme_effective"
                            class="input"
                            @change="theme_change"
                        >
                            <option v-for="theme in THEMES" :key="theme.id" :value="theme.id">
                                {{ theme.label }}
                            </option>
                        </select>
                    </div>
                    <div>
                        <label class="label" for="settings-palette">Colour scheme</label>
                        <select
                            id="settings-palette"
                            :value="palette_effective"
                            class="input"
                            @change="palette_change"
                        >
                            <option
                                v-for="palette in PALETTES"
                                :key="palette.id"
                                :value="palette.id"
                            >
                                {{ palette.label }}
                            </option>
                        </select>
                    </div>
                    <div>
                        <label class="label" for="settings-mode">Mode</label>
                        <select
                            id="settings-mode"
                            :value="mode_selected"
                            class="input"
                            @change="mode_change"
                        >
                            <option
                                v-for="choice in MODE_CHOICES"
                                :key="choice.value"
                                :value="choice.value"
                            >
                                {{ choice.label }}
                            </option>
                        </select>
                    </div>
                </div>
            </div>

            <div>
                <h3 class="mb-3 flex items-center">
                    Notes
                    <InfoHint :text="HINT_TEMPLATE_DEFAULT" />
                </h3>
                <div>
                    <select
                        :value="settings.notes_template_id_default"
                        class="input"
                        @change="notes_template_default_change"
                    >
                        <option value="">Ask each time</option>
                        <option
                            v-for="template in templates"
                            :key="template.id"
                            :value="template.id"
                        >
                            {{ template.name }}
                        </option>
                    </select>
                </div>
            </div>

            <div>
                <h3 class="mb-3 flex items-center">
                    Recordings
                    <InfoHint text="The microphone recordings are saved in this folder." />
                </h3>
                <div>
                    <div class="flex gap-2 flex-wrap">
                        <input
                            type="text"
                            class="input flex-1"
                            readonly
                            :value="settings.recordings_directory ?? recordings_directory_default"
                        >
                        <div class="actions-row">
                            <button
                                v-if="settings.recordings_directory !== null"
                                type="button"
                                class="btn-default"
                                @click="recordings_directory_reset"
                            >
                                Use default
                            </button>
                            <button
                                type="button"
                                class="btn-primary"
                                @click="recordings_directory_choose"
                            >
                                Choose folder
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <SearchIndexStatus />

            <div>
                <h3 class="mb-3">About</h3>
                <div class="flex gap-2 flex-wrap items-start">
                    <div class="about-brand">
                        <RemiMark class="about-mark" />
                        <div class="min-w-0">
                            <p class="meta">remi {{ app_version ?? '' }}</p>
                            <p v-if="update_status_text" class="meta">{{ update_status_text }}</p>
                            <StratusCredit class="meta" />
                        </div>
                    </div>
                    <div class="actions-row">
                        <button
                            type="button"
                            :class="update_phase === 'available' ? 'btn-primary' : 'btn-default'"
                            :disabled="update_busy"
                            @click="update_action"
                        >
                            {{ update_button_label }}
                        </button>
                    </div>
                </div>
            </div>
        </div>

        <div v-else class="space-y-6">
            <NoticeBanner v-if="account_error" @dismiss="account_error = null">
                {{ account_error }}
            </NoticeBanner>

            <div>
                <h3 class="mb-3">Balance</h3>
                <div class="flex gap-2 flex-wrap items-center">
                    <p class="flex-1">{{ balance_line }}</p>
                    <div v-if="account !== null" class="actions-row">
                        <button
                            type="button"
                            class="btn-primary"
                            @click="view_reopen('checkout')"
                        >
                            Buy hours
                        </button>
                    </div>
                </div>
            </div>

            <div>
                <h3 class="mb-3 flex items-center">
                    Promo code
                    <InfoHint :text="HINT_PROMO" />
                </h3>
                <form class="flex gap-2 flex-wrap" @submit.prevent="account_promo_redeem">
                    <ClearableInput
                        v-model="promo_input"
                        type="text"
                        class="input flex-1"
                        placeholder="Enter a promo code"
                        autocomplete="off"
                        spellcheck="false"
                    />
                    <div class="actions-row">
                        <button
                            type="submit"
                            class="btn-default"
                            :disabled="promo_busy || promo_input.trim() === '' || account === null"
                        >
                            {{ promo_busy ? 'Redeeming…' : 'Redeem' }}
                        </button>
                    </div>
                </form>
                <p v-if="promo_notice !== null" class="meta mt-2">{{ promo_notice }}</p>
                <p v-if="promo_problem !== null" class="meta mt-2" role="alert">
                    {{ promo_problem }}
                </p>
            </div>

            <div>
                <h3 class="mb-3 flex items-center">
                    Sign-in code
                    <InfoHint :text="HINT_SIGN_IN_CODE" />
                </h3>
                <div class="flex gap-2 flex-wrap items-center">
                    <p v-if="account !== null" class="meta flex-1">
                        Signed in as {{ account.name }} ({{ account.email }}).
                    </p>
                    <div class="actions-row">
                        <button type="button" class="btn-default" @click="account_code_copy">
                            {{ code_copied ? 'Copied' : 'Copy sign-in code' }}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </section>
</template>
