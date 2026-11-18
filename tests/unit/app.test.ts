import { getVersion } from '@tauri-apps/api/app'
import { check } from '@tauri-apps/plugin-updater'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import App from '../../src/app.vue'
import { use_account } from '../../src/composables/use_account'
import { use_dialog } from '../../src/composables/use_dialog'
import { use_pipeline } from '../../src/composables/use_pipeline'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import { ATTACH_TO, mount_auto_unmount } from './fixtures'
import type { VueWrapper } from '@vue/test-utils'
import type { View } from '../../src/composables/use_pipeline'
import type { Settings } from '../../src/types'


vi.mock('../../src/lib/ipc')
vi.mock('@tauri-apps/api/app')
vi.mock('@tauri-apps/api/event')
vi.mock('@tauri-apps/plugin-dialog')
vi.mock('@tauri-apps/plugin-updater')
vi.mock('@tauri-apps/api/webviewWindow', webview_window_mock)

const FONTS = 'fonts'

const SETTINGS = Object.freeze<Settings>({
    notes_template_id_default: null,
    mode: null,
    theme: null,
    palette: null,
    recordings_directory: null,
    jobs_view: null,
})

const account = use_account()
const dialog = use_dialog()
const pipeline = use_pipeline()


async function app_mount(): Promise<VueWrapper> {
    assert(document.body.childElementCount === 0)
    assert(pipeline.view_current.value === 'jobs')

    const wrapper = mount_auto_unmount(App, {
        [ATTACH_TO]: document.body,
        global: {
            stubs: {
                JobsManager: true,
                RichEditorAsync: true,
                Sidebar: true,
                WelcomeScreen: true,
                transition: false,
            },
        },
    })

    await flushPromises()

    assert(shell().dataset['ready'] === 'true')
    assert(document.querySelector('main') !== null)

    return wrapper
}

async function drag_drop_listen(handler: unknown): Promise<() => void> {
    assert(typeof handler === 'function')
    assert(document.querySelector('.app-shell') !== null)

    return Promise.resolve(vi.fn())
}

function notes_view(): HTMLElement {
    const found = document.querySelectorAll<HTMLElement>('main section.step-view')

    assert(found.length === 1, 'the notes view is not the one view on screen')
    assert(pipeline.view_current.value === 'notes')

    const [element] = found

    assert(element !== undefined)

    return element
}

function shell(): HTMLElement {
    const found = document.querySelector<HTMLElement>('.app-shell')

    assert(found !== null, 'the app shell is not mounted')
    assert(found.isConnected)

    return found
}

async function view_show(view: View): Promise<void> {
    assert(view.length > 0)
    assert(view !== pipeline.view_current.value)

    pipeline.view_set(view)
    await flushPromises()

    assert(pipeline.view_current.value === view)
}

function webview_window_current(): Record<string, unknown> {
    return Object.fromEntries<unknown>([['onDragDropEvent', drag_drop_listen]])
}

function webview_window_mock(): Record<string, unknown> {
    return Object.fromEntries<unknown>([['getCurrentWebviewWindow', webview_window_current]])
}

beforeEach(() => {
    onTestFinished(() => {
        dialog.close(false)
        pipeline.pipeline_reset()
        account.status.value = { billing: false, signed_in: false }
        Reflect.deleteProperty(document, FONTS)
        document.body.innerHTML = ''
    })

    vi.resetAllMocks()
    Reflect.defineProperty(document, FONTS, { configurable: true, value: { load: vi.fn() } })
    vi.mocked(getVersion).mockResolvedValue('0.1.5')
    vi.mocked(check).mockResolvedValue(null)
    vi.mocked(ipc.account_status).mockResolvedValue({ billing: false, signed_in: false })
    vi.mocked(ipc.endpoints_list).mockResolvedValue([])
    vi.mocked(ipc.folders_list).mockResolvedValue([])
    vi.mocked(ipc.groups_list).mockResolvedValue([])
    vi.mocked(ipc.job_meta_get).mockResolvedValue(null)
    vi.mocked(ipc.jobs_list).mockResolvedValue([])
    vi.mocked(ipc.notes_templates_list).mockResolvedValue([])
    vi.mocked(ipc.people_list).mockResolvedValue([])
    vi.mocked(ipc.settings_get).mockResolvedValue({ ...SETTINGS })
    pipeline.pipeline_reset()
    pipeline.job_id_current.value = 'job-1'
})

describe('App views', () => {
    it('caches one notes view and unmounts it when the notes view reopens', async () => {
        await app_mount()
        await view_show('notes')

        const first = notes_view()

        await view_show('jobs')
        pipeline.view_reopen('jobs')
        await flushPromises()

        expect(first.isConnected).toBe(false)

        await view_show('notes')

        expect(notes_view()).toBe(first)

        pipeline.view_reopen('notes')
        await flushPromises()

        expect(notes_view()).not.toBe(first)
        expect(first.parentElement).toBeNull()
    })
})

describe('App layers', () => {
    it('makes the app inert while a dialog is open and live again once it closes', async () => {
        await app_mount()

        void dialog.confirm('Discard the draft?')
        await nextTick()

        expect(shell().inert).toBe(true)
        expect(document.querySelector<HTMLElement>('.app-dialog-host')?.inert).toBe(false)

        dialog.close(false)
        await nextTick()

        expect(shell().inert).toBe(false)
    })

    it('makes the app inert while it fades out for the welcome screen', async () => {
        await app_mount()

        const leaving = document.querySelector('main')?.parentElement

        assert(leaving instanceof HTMLElement)

        account.status.value = { billing: true, signed_in: false }
        await nextTick()

        expect(leaving.isConnected).toBe(true)
        expect(leaving.inert).toBe(true)
    })
})
