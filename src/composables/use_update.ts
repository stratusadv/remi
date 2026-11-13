import { computed, ref, shallowRef } from 'vue'
import { getVersion } from '@tauri-apps/api/app'
import { check } from '@tauri-apps/plugin-updater'
import { assert, unreachable } from '../lib/assert'
import { error_text_extract } from '../lib/errors'
import { ipc } from '../lib/ipc'
import { log_warn } from '../lib/log'
import { use_dialog } from './use_dialog'
import { use_tasks } from './use_tasks'
import type { DownloadEvent, Update } from '@tauri-apps/plugin-updater'


export type UpdatePhase =
    | 'idle'
    | 'checking'
    | 'none'
    | 'available'
    | 'downloading'
    | 'installing'
    | 'error'

const CHECK_TIMEOUT_MS = 15_000
const DOWNLOAD_TIMEOUT_MS = 600_000
const PERCENT_MAX = 100
const phase = ref<UpdatePhase>('idle')
const app_version = ref<string | null>(null)
const update_version = ref<string | null>(null)
const download_bytes_received = ref(0)
const download_bytes_total = ref<number | null>(null)
const error_message = ref<string | null>(null)
const update_pending = shallowRef<Update | null>(null)

const progress_percent = computed(() => {
    const total = download_bytes_total.value

    if (total === null) return null
    if (total === 0) return null

    const fraction = download_bytes_received.value / total

    return Math.min(PERCENT_MAX, Math.round(fraction * PERCENT_MAX))
})

const status_text = computed(() => {
    switch (phase.value) {
        case 'idle': return ''
        case 'checking': return 'Checking for updates…'
        case 'none': return 'remi is up to date.'
        case 'available': return `remi ${update_version.value ?? ''} is ready to install.`
        case 'downloading': return status_text_downloading()
        case 'installing': return 'Installing the update. remi will restart in a moment.'
        case 'error': return error_message.value ?? 'The update check failed.'
    }
})


export function use_update(): typeof api {
    assert(Object.isFrozen(api))

    download_state_assert()

    return api
}

async function app_version_refresh(): Promise<void> {
    if (app_version.value !== null) return

    return getVersion()
        .then((version) => {
            assert(version.length > 0)

            app_version.value = version

            assert(app_version.value === version)
        })
        .catch((error: unknown) => {
            log_warn('[update] app version unavailable', error)
        })
}

function download_event_apply(event: DownloadEvent): void {
    assert(event.event.length > 0)
    assert(download_bytes_received.value >= 0)

    switch (event.event) {
        case 'Started':
            download_bytes_total.value = event.data.contentLength ?? null

            return
        case 'Progress':
            download_bytes_received.value += event.data.chunkLength

            return
        case 'Finished':
            phase.value = 'installing'

            return
        default:
            unreachable(event)
    }
}

function download_state_assert(): void {
    assert(Number.isSafeInteger(download_bytes_received.value))
    assert(download_bytes_received.value >= 0)
    assert(download_bytes_total.value === null || download_bytes_total.value >= 0)
    assert(app_version.value === null || app_version.value.length > 0)
    assert(update_version.value === null || update_version.value.length > 0)
    assert(update_pending.value === null || update_pending.value.version.length > 0)
}

function phase_set(next: UpdatePhase): void {
    assert(next.length > 0)

    phase.value = next

    assert(phase.value === next)
}

function status_text_downloading(): string {
    const percent = progress_percent.value

    assert(percent === null || percent >= 0)
    assert(percent === null || percent <= PERCENT_MAX)

    if (percent === null) return 'Downloading the update…'

    return `Downloading the update… ${String(percent)}%`
}

async function update_check(): Promise<boolean> {
    if (phase.value === 'downloading') return false
    if (phase.value === 'installing') return false

    await update_release()

    phase_set('checking')

    error_message.value = null

    assert(phase.value === 'checking')
    assert(Number.isInteger(CHECK_TIMEOUT_MS))

    return check({ timeout: CHECK_TIMEOUT_MS }).then(update_found).catch(update_check_failed)
}

function update_check_failed(error: unknown): boolean {
    phase_set('error')

    error_message.value = 'The update check failed. Check your internet connection '
        + `and try again. (${error_text_extract(error)})`

    assert(error_message.value.length > 0)
    assert(phase.value === 'error')

    return false
}

async function update_check_manual(): Promise<void> {
    await app_version_refresh()

    const available = await update_check()

    assert(typeof available === 'boolean')
    assert(!available || update_pending.value !== null)
}

async function update_check_startup(): Promise<void> {
    await app_version_refresh()

    const available = await update_check()

    if (available) {
        await update_prompt()

        return
    }

    if (phase.value === 'error') {
        log_warn('[remi] update check failed:', error_message.value)
        phase_set('idle')
    }

    assert(phase.value !== 'error')
}

function update_found(update: Update | null): boolean {
    assert(update === null || update.version.length > 0)

    if (update === null) {
        phase_set('none')

        return false
    }

    update_pending.value = update
    update_version.value = update.version

    phase_set('available')

    assert(update_version.value === update.version)

    return true
}

async function update_install(): Promise<void> {
    const { message: dialog_message } = use_dialog()
    const { tasks_running } = use_tasks()
    const update = update_pending.value

    if (update === null) return

    if (tasks_running.value.length > 0) {
        return dialog_message(
            'remi is still working on a recording. Wait for it to finish, then install '
            + 'the update from Settings.',
            { title: 'Update waiting', kind: 'info' },
        )
    }

    assert(update.version.length > 0)
    assert(Number.isInteger(DOWNLOAD_TIMEOUT_MS))

    phase_set('downloading')

    download_bytes_received.value = 0
    download_bytes_total.value = null

    return update
        .downloadAndInstall(download_event_apply, { timeout: DOWNLOAD_TIMEOUT_MS })
        .then(async () => ipc.app_relaunch())
        .catch(update_install_failed)
}

async function update_install_failed(error: unknown): Promise<void> {
    const { message: dialog_message } = use_dialog()

    phase_set('error')

    const failure = 'The update could not be installed. remi keeps working as '
        + `it is; try again later from Settings. (${error_text_extract(error)})`

    error_message.value = failure

    assert(failure.length > 0)
    assert(phase.value === 'error')

    return update_release().then(async () =>
        dialog_message(failure, { title: 'Update failed', kind: 'error' }))
}

async function update_prompt(): Promise<void> {
    const { confirm: dialog_confirm } = use_dialog()

    assert(update_version.value !== null)
    assert(update_pending.value !== null)

    const answer = dialog_confirm(
        `A new version of remi (${update_version.value}) is ready. Installing takes `
        + 'about a minute and remi will restart. Install it now?',
        {
            title: 'Update available',
            kind: 'info',
            ok_label: 'Install now',
            cancel_label: 'Later',
        },
    )

    return answer.then(async (install_now) => {
        if (install_now) await update_install()
    })
}

const api = Object.freeze({
    phase,
    app_version,
    update_version,
    progress_percent,
    status_text,
    update_check_manual,
    update_check_startup,
    update_install,
})

async function update_release(): Promise<void> {
    download_state_assert()

    if (update_pending.value === null) return

    return update_pending.value
        .close()
        .catch((error: unknown) => {
            log_warn('[update] release failed', error)
        })
        .finally(() => {
            update_pending.value = null
        })
}
