<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { open as dialog_open } from '@tauri-apps/plugin-dialog'
import { use_account } from '../composables/use_account'
import { use_endpoints } from '../composables/use_endpoints'
import { use_notes_templates } from '../composables/use_notes_templates'
import { use_pipeline } from '../composables/use_pipeline'
import { use_service } from '../composables/use_service'
import { use_settings } from '../composables/use_settings'
import { PALETTES, use_theme } from '../composables/use_theme'
import { use_update } from '../composables/use_update'
import { assert } from '../lib/assert'
import { error_dialog_show, error_friendly } from '../lib/errors'
import { ipc } from '../lib/ipc'
import ClearableInput from './clearable_input.vue'
import InfoHint from './info_hint.vue'
import NoticeBanner from './notice_banner.vue'
import RemiMark from './remi_mark.vue'
import SearchSettings from './search_settings.vue'
import StratusCredit from './stratus_credit.vue'
import type { ViewIntent } from '../composables/use_pipeline'
import type { Palette } from '../composables/use_theme'
import type { APIEndpointPurpose, ThemeChoice, ThinkingChoice } from '../types'


type SettingsTab = 'general' | 'ai' | 'account'

interface SettingsTabItem {
    id: SettingsTab
    label: string
}

interface ThinkingChoiceItem {
    value: ThinkingChoice | ''
    label: string
}

interface ThemeChoiceItem {
    value: ThemeChoice
    label: string
}

interface APIKeyField {
    purpose: APIEndpointPurpose
    label: string
    hint: string
}

const SETTINGS_TABS: SettingsTabItem[] = [
    { id: 'general', label: 'General' },
    { id: 'ai', label: 'AI' },
]

const SETTINGS_TAB_ACCOUNT: SettingsTabItem = { id: 'account', label: 'Account' }

const SETTINGS_TAB_OF_INTENT: Readonly<Partial<Record<ViewIntent, SettingsTab>>> = Object.freeze({
    settings_account: 'account',
    settings_ai: 'ai',
    settings_general: 'general',
})

const THINKING_CHOICES: ThinkingChoiceItem[] = [
    { value: '', label: 'Off' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'xhigh', label: 'High' },
]

const THEME_CHOICES: ThemeChoiceItem[] = [
    { value: 'system', label: 'Match my computer' },
    { value: 'dark', label: 'Dark' },
    { value: 'light', label: 'Light' },
]

const API_KEY_FIELDS: APIKeyField[] = [
    {
        purpose: 'transcription',
        label: 'Transcription key',
        hint: 'This key lets Remi turn your recordings into text. Keep it private, like a '
            + 'password.',
    },
    {
        purpose: 'notes',
        label: 'Notes key',
        hint: 'This key lets Remi write notes from a transcript. Keep it private, like a '
            + 'password.',
    },
]

const HINT_API_HOST = 'This is the web address of the API that Remi sends recordings and '
    + 'transcripts to. Your company gives you this.'

const HINT_PAGE = 'This page covers how Remi looks, where it saves recordings, and your API '
    + 'keys.'

const HINT_PROMO = 'A promo code adds free transcription hours to your account. Each code works '
    + 'once per email address.'

const HINT_SIGN_IN_CODE = 'This code signs in to your account on another computer. Keep it '
    + 'private, like a password.'

const HINT_TEMPLATE_DEFAULT = 'This template is picked for each new recording. You can still '
    + 'choose another before generating.'

const HINT_THINKING = 'This sets how long the AI thinks before writing. A longer setting gives '
    + 'more careful notes and takes longer.'

const COPIED_FLASH_MS = 1500
const KEY_MASK_CHAR = '•'
const KEY_MASK_LENGTH_MAX = 1024
const KEY_PLACEHOLDER = 'Paste your key'
const { settings, error_message, refresh, update } = use_settings()

const {
    status: service_status,
    refresh: service_refresh,
    api_key_set,
    host_ready,
} = use_service()

const {
    account,
    account_load,
    balance_text,
    code_copy,
    error_message: account_error,
    promo_redeem,
    status: account_status,
} = use_account()

const { endpoints, refresh: endpoints_refresh } = use_endpoints()
const { templates } = use_notes_templates()
const { view_intent_take, view_reopen } = use_pipeline()
const { theme_set, theme_effective, palette_set, palette_effective } = use_theme()

const {
    phase: update_phase,
    app_version,
    status_text: update_status_text,
    update_check_manual,
    update_install,
} = use_update()

const tab_current = ref<SettingsTab>('general')
const host_banner_dismissed = ref(false)
const recordings_directory_default = ref('')
const notes_models = ref<string[]>([])
const notes_model_default = ref('')
const api_host_input = ref('')
const code_copied = ref(false)
const promo_busy = ref(false)
const promo_input = ref('')
const promo_notice = ref<string | null>(null)
const promo_problem = ref<string | null>(null)
let code_copied_timer: ReturnType<typeof setTimeout> | null = null

const api_key_inputs = reactive<Record<APIEndpointPurpose, string>>({
    notes: '',
    transcription: '',
})

const notes_model_choices = computed<string[]>(() => {
    const chosen = settings.value.notes_model

    if (chosen === null || notes_models.value.includes(chosen)) return notes_models.value

    return [...notes_models.value, chosen]
})

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

const settings_tabs = computed<SettingsTabItem[]>(() =>
    account_status.value.billing ? [...SETTINGS_TABS, SETTINGS_TAB_ACCOUNT] : SETTINGS_TABS)

const theme_selected = computed<ThemeChoice>(() => settings.value.theme ?? 'system')

const notes_model_default_label = computed(() =>
    notes_model_default.value.length > 0 ? `Default (${notes_model_default.value})` : 'Default')


async function account_code_copy(): Promise<void> {
    try {
        await code_copy()
    } catch (error) {
        await error_dialog_show(error)

        return
    }

    code_copied.value = true

    if (code_copied_timer !== null) clearTimeout(code_copied_timer)

    code_copied_timer = setTimeout(() => {
        code_copied.value = false
        code_copied_timer = null
    }, COPIED_FLASH_MS)
}

async function account_promo_redeem(): Promise<void> {
    const code = promo_input.value.trim()

    if (code === '' || promo_busy.value) return

    promo_busy.value = true
    promo_notice.value = null
    promo_problem.value = null

    await promo_redeem(code)
        .then(() => {
            promo_input.value = ''
            promo_notice.value = `${code} was redeemed. You now have ${balance_text.value}.`
        })
        .catch((error: unknown) => {
            promo_problem.value = error_friendly(error).message
        })
        .finally(() => {
            promo_busy.value = false
        })
}

function api_host_current(): string {
    return settings.value.api_host ?? endpoints.value[0]?.host ?? ''
}

function api_host_input_reset(): void {
    api_host_input.value = api_host_current()
}

async function api_host_save(): Promise<void> {
    const host = api_host_input.value.trim()

    if (host !== api_host_current()) {
        await update({ api_host: host === '' ? null : host })
        await Promise.all([service_refresh(), endpoints_refresh()])
        await notes_models_load()
    }

    api_host_input_reset()
}

function api_key_focus(event: FocusEvent, purpose: APIEndpointPurpose): void {
    const resting = api_key_resting(purpose)

    if (resting === '') return
    if (api_key_inputs[purpose] !== resting) return

    if (event.target instanceof HTMLInputElement) event.target.select()
}

function api_key_input_reset(purpose: APIEndpointPurpose): void {
    api_key_inputs[purpose] = api_key_resting(purpose)
}

function api_key_resting(purpose: APIEndpointPurpose): string {
    const status = service_status.value[purpose]

    if (!status.user && !status.builtin) return ''

    return KEY_MASK_CHAR.repeat(Math.min(Math.max(status.length, 1), KEY_MASK_LENGTH_MAX))
}

intent_apply()

onMounted(async () => {
    await refresh()
    await service_refresh()

    api_host_input.value = api_host_current()

    for (const field of API_KEY_FIELDS) {
        api_key_inputs[field.purpose] = api_key_resting(field.purpose)
    }

    try {
        recordings_directory_default.value = await ipc.recordings_directory_default()
    } catch (error) {
        error_message.value = String(error)
    }

    await notes_models_load()

    void account_load()
})

async function api_key_save(purpose: APIEndpointPurpose): Promise<void> {
    if (api_key_inputs[purpose] === api_key_resting(purpose)) return

    try {
        await api_key_set(purpose, api_key_inputs[purpose].trim())
    } catch (error) {
        await error_dialog_show(error)
    }

    api_key_input_reset(purpose)
}

function api_key_source(purpose: APIEndpointPurpose): string {
    const status = service_status.value[purpose]

    if (status.user) return 'Your own key is in use.'
    if (status.builtin) return 'The key built into Remi is in use.'

    return 'No key is set.'
}

function input_leave(event: KeyboardEvent): void {
    if (event.target instanceof HTMLInputElement) event.target.blur()
}

function intent_apply(): void {
    const intent = view_intent_take()

    if (intent === null) return

    const tab = SETTINGS_TAB_OF_INTENT[intent]

    assert(tab !== undefined, `the Settings view cannot open ${intent}`)
    assert(tab_current.value === 'general')

    if (settings_tabs.value.some((item) => item.id === tab)) tab_current.value = tab
}

function notes_model_change(event: Event): void {
    const value = select_value(event)

    void update({ notes_model: value.length > 0 ? value : null })
}

async function notes_models_load(): Promise<void> {
    if (!host_ready.value) return

    try {
        const listed = await ipc.notes_models_list()

        notes_models.value = listed.models
        notes_model_default.value = listed.model_default
    } catch (error) {
        error_message.value = String(error)
    }
}

function notes_template_default_change(event: Event): void {
    const value = select_value(event)

    void update({ notes_template_id_default: value.length > 0 ? value : null })
}

function notes_thinking_change(event: Event): void {
    const value = select_value(event)

    void update({ notes_thinking: thinking_choice_is(value) ? value : null })
}

function palette_swatch_style(palette: Palette): Record<string, string> {
    const swatch = theme_effective.value === 'light' ? palette.light : palette.dark

    return { '--swatch-surface': swatch.surface, '--swatch-accent': swatch.accent }
}

async function recordings_directory_choose(): Promise<void> {
    try {
        const selected = await dialog_open({
            directory: true,
            defaultPath: settings.value.recordings_directory ?? recordings_directory_default.value,
        })

        if (typeof selected === 'string') await update({ recordings_directory: selected })
    } catch (error) {
        await error_dialog_show(error)
    }
}

function recordings_directory_reset(): void {
    void update({ recordings_directory: null })
}

function select_value(event: Event): string {
    return event.target instanceof HTMLSelectElement ? event.target.value : ''
}

function theme_change(event: Event): void {
    const value = select_value(event)

    if (theme_choice_is(value)) theme_set(value)
}

function theme_choice_is(value: string): value is ThemeChoice {
    return THEME_CHOICES.some((choice) => choice.value === value)
}

function thinking_choice_is(value: string): value is ThinkingChoice {
    return THINKING_CHOICES.some((choice) => choice.value === value && value.length > 0)
}

async function update_action(): Promise<void> {
    if (update_phase.value === 'available') {
        await update_install()

        return
    }

    await update_check_manual()
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

        <NoticeBanner
            v-if="!host_ready && !host_banner_dismissed"
            class="mb-6"
            @dismiss="host_banner_dismissed = true"
        >
            An API address is required before Remi can transcribe or write notes.
            <template #actions>
                <button v-if="tab_current !== 'ai'" class="btn-primary" @click="tab_current = 'ai'">
                    Go to AI
                </button>
            </template>
        </NoticeBanner>

        <NoticeBanner v-if="error_message" class="mb-6" @dismiss="error_message = null">
            {{ error_message }}
        </NoticeBanner>

        <div v-if="tab_current === 'general'" class="space-y-6">
            <div>
                <h3 class="mb-3">Appearance</h3>
                <div class="space-y-4">
                    <div>
                        <label class="label">Theme</label>
                        <select :value="theme_selected" class="input" @change="theme_change">
                            <option
                                v-for="choice in THEME_CHOICES"
                                :key="choice.value"
                                :value="choice.value"
                            >
                                {{ choice.label }}
                            </option>
                        </select>
                    </div>
                    <div>
                        <span class="label">Colour Scheme</span>
                        <div class="palette-row" role="radiogroup" aria-label="Colour Scheme">
                            <button
                                v-for="palette in PALETTES"
                                :key="palette.id"
                                type="button"
                                class="palette-swatch"
                                role="radio"
                                :style="palette_swatch_style(palette)"
                                :aria-checked="palette_effective === palette.id"
                                @click="palette_set(palette.id)"
                            >
                                <span class="palette-swatch-chip"><span /></span>
                                <span class="palette-swatch-label">{{ palette.label }}</span>
                            </button>
                        </div>
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

            <div>
                <h3 class="mb-3">About</h3>
                <div class="flex gap-2 flex-wrap items-start">
                    <div class="about-brand">
                        <RemiMark class="about-mark" />
                        <div class="min-w-0">
                            <p class="meta">Remi Remembers {{ app_version ?? '' }}</p>
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

        <div v-else-if="tab_current === 'ai'" class="space-y-6">
            <div>
                <h3 class="mb-3 flex items-center">
                    API address
                    <InfoHint :text="HINT_API_HOST" />
                </h3>
                <ClearableInput
                    v-model="api_host_input"
                    type="url"
                    class="input"
                    placeholder="https://"
                    autocomplete="off"
                    spellcheck="false"
                    @blur="api_host_save"
                    @keydown.enter.prevent="input_leave"
                />
            </div>

            <div v-for="field in API_KEY_FIELDS" :key="field.purpose">
                <h3 class="mb-3 flex items-center">
                    {{ field.label }}
                    <InfoHint :text="`${field.hint} ${api_key_source(field.purpose)}`" />
                </h3>
                <ClearableInput
                    v-model="api_key_inputs[field.purpose]"
                    type="password"
                    class="input"
                    :placeholder="KEY_PLACEHOLDER"
                    autocomplete="off"
                    @blur="api_key_save(field.purpose)"
                    @focus="api_key_focus($event, field.purpose)"
                    @keydown.enter.prevent="input_leave"
                />
            </div>

            <div>
                <h3 class="mb-3 flex items-center">
                    Model
                    <InfoHint text="This is the AI model that writes your notes." />
                </h3>
                <select
                    :value="settings.notes_model ?? ''"
                    class="input"
                    @change="notes_model_change"
                >
                    <option value="">{{ notes_model_default_label }}</option>
                    <option v-for="model in notes_model_choices" :key="model" :value="model">
                        {{ model }}
                    </option>
                </select>
            </div>

            <div>
                <h3 class="mb-3 flex items-center">
                    Thinking
                    <InfoHint :text="HINT_THINKING" />
                </h3>
                <select
                    :value="settings.notes_thinking ?? ''"
                    class="input"
                    @change="notes_thinking_change"
                >
                    <option
                        v-for="choice in THINKING_CHOICES"
                        :key="choice.value"
                        :value="choice.value"
                    >
                        {{ choice.label }}
                    </option>
                </select>
            </div>

            <SearchSettings :api_host="api_host_current()" />
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
