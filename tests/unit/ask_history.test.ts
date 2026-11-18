import { flushPromises } from '@vue/test-utils'
import { h, nextTick } from 'vue'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import AppDialogHost from '../../src/components/app_dialog_host.vue'
import AskHistory from '../../src/components/ask_history.vue'
import ContextMenu from '../../src/components/context_menu.vue'
import { use_ask } from '../../src/composables/use_ask'
import { use_context_menu } from '../../src/composables/use_context_menu'
import { use_dialog } from '../../src/composables/use_dialog'
import { use_modal_shown } from '../../src/composables/use_modal'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import { ATTACH_TO, deferred_new, mount_auto_unmount } from './fixtures'
import type { ComponentOptions, VNode } from 'vue'
import type { VueWrapper } from '@vue/test-utils'
import type { ChatSummary } from '../../src/types'


vi.mock('../../src/lib/ipc')
vi.mock('@tauri-apps/api/event')

const CHAT_BANNER = '1b4e28ba-2fa1-41d2-883f-0016d3cca427'
const CHAT_RETRY = '6f1c2a9e-3b7d-4c51-9e0a-2d8b7f4a1c33'
const CHAT_SHIP = 'a3d9e2c4-8f1b-4e6a-b5c7-0e9f8d7c6b5a'
const NOW_MS = Date.now()

const CHATS = Object.freeze<ChatSummary[]>([
    { id: CHAT_SHIP, title: 'What did we agree to ship?', updated_at_unix_ms: NOW_MS },
    { id: CHAT_BANNER, title: 'Who drafts the banner?', updated_at_unix_ms: NOW_MS - 1_000 },
    { id: CHAT_RETRY, title: 'Where does retry live?', updated_at_unix_ms: NOW_MS - 2_000 },
])

const ask_state = use_ask()
const context_menu_state = use_context_menu()
const dialog_state = use_dialog()
const modal_shown = use_modal_shown()


function button(label: string): HTMLButtonElement {
    assert(label.length > 0)

    const found = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
        .find((candidate) => candidate.textContent.trim() === label
            || candidate.getAttribute('aria-label') === label)

    assert(found !== undefined, `no button reads ${label}`)

    return found
}

function checkbox(label: string): HTMLInputElement {
    assert(label.length > 0)

    const found = [...document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
        .find((candidate) => candidate.getAttribute('aria-label') === label
            || candidate.closest('label')?.textContent.trim() === label)

    assert(found !== undefined, `no checkbox reads ${label}`)

    return found
}

async function click(element: HTMLElement): Promise<void> {
    assert(element.isConnected)
    assert(!element.matches(':disabled'))

    element.click()
    await flushPromises()
}

function history(): HTMLElement | null {
    const found = document.body.querySelector<HTMLElement>('[aria-labelledby="ask-history-title"]')

    assert(found === null || found.getAttribute('role') === 'dialog')
    assert(found === null || found.contains(document.getElementById('ask-history-title')))

    return found
}

async function history_open(animated = false): Promise<VueWrapper> {
    assert(history() === null)
    assert(typeof animated === 'boolean')

    const wrapper = mount_auto_unmount(AskHistory, {
        [ATTACH_TO]: document.body,
        global: { stubs: { transition: !animated } },
    })

    await wrapper.get('button').trigger('click')
    await flushPromises()

    assert(history() !== null)

    return wrapper
}

function host_mount(): VueWrapper {
    assert(dialog_state.current.value === null)
    assert(document.body.querySelector('.app-dialog-host') === null)

    const wrapper = mount_auto_unmount(AppDialogHost, {
        [ATTACH_TO]: document.body,
        global: { stubs: { transition: false } },
    })

    assert(!wrapper.vm.$.isUnmounted)

    return wrapper
}

async function key_press(key: string): Promise<void> {
    const target = history()

    assert(target !== null)
    assert(key.length > 0)

    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key }))
    await flushPromises()
}

function shell_mount(): HTMLButtonElement {
    assert(history() === null)
    assert(!modal_shown.value)

    const harness: ComponentOptions = { render: shell_render }

    mount_auto_unmount(harness, { [ATTACH_TO]: document.body })

    return button('History')
}

function shell_render(): VNode {
    assert(typeof modal_shown.value === 'boolean')
    assert(document.body.isConnected)

    return h('div', { inert: modal_shown.value }, [h(AskHistory)])
}

function question(): string | null {
    const text = document.body.querySelector('.ask-history-question')?.textContent.trim() ?? null

    assert(text === null || text.startsWith('Delete '))
    assert(text === null || text.endsWith('This cannot be undone.'))

    return text
}

function titles(): string[] {
    const rows = [...document.body.querySelectorAll('.ask-history-open')]

    assert(rows.length <= CHATS.length)

    const shown = rows.map((row) => row.textContent.trim())

    assert(shown.every((title) => title.length > 0))

    return shown
}

beforeEach(() => {
    onTestFinished(() => {
        context_menu_state.close()
        dialog_state.current.value = null
        document.body.innerHTML = ''
    })

    vi.resetAllMocks()
    vi.mocked(ipc.chats_list).mockResolvedValue([...CHATS])
    vi.mocked(ipc.chat_remove).mockResolvedValue(undefined)
    ask_state.chats.value = []
    ask_state.chat_id.value = crypto.randomUUID()
    ask_state.exchanges.value = []
})

describe('AskHistory', () => {
    it('deletes the selected chats after one confirmation and stays open', async () => {
        await history_open()
        await click(checkbox('Select chat: What did we agree to ship?'))
        await click(checkbox('Select chat: Where does retry live?'))
        await click(button('Delete selected'))

        expect(question()).toBe('Delete 2 chats? This cannot be undone.')
        expect(dialog_state.current.value).toBeNull()
        expect(ipc.chat_remove).not.toHaveBeenCalled()

        await click(button('Delete'))

        const removed = vi.mocked(ipc.chat_remove).mock.calls.map(([id]) => id).sort()
        const expected = [CHAT_RETRY, CHAT_SHIP].sort()

        expect(removed).toEqual(expected)
        expect(titles()).toEqual(['Who drafts the banner?'])
        expect(question()).toBeNull()
        expect(button('Delete selected').disabled).toBe(true)
        expect(history()).not.toBeNull()
    })

    it('backs out of a pending delete with Escape before it closes the history', async () => {
        await history_open()
        await click(button('Delete chat: Who drafts the banner?'))

        expect(question()).toBe('Delete "Who drafts the banner?"? This cannot be undone.')

        await key_press('Escape')

        expect(question()).toBeNull()
        expect(history()).not.toBeNull()

        await key_press('Escape')

        expect(history()).toBeNull()
        expect(ipc.chat_remove).not.toHaveBeenCalled()
    })

    it('keeps a chat that failed to delete and says why', async () => {
        vi.mocked(ipc.chat_remove)
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('disk is read-only'))

        await history_open()

        vi.mocked(ipc.chats_list).mockResolvedValue(CHATS.filter((chat) => chat.id !== CHAT_SHIP))

        await click(checkbox('Select chat: What did we agree to ship?'))
        await click(checkbox('Select chat: Who drafts the banner?'))
        await click(button('Delete selected'))
        await click(button('Delete'))

        expect(vi.mocked(ipc.chat_remove).mock.calls).toEqual([[CHAT_SHIP], [CHAT_BANNER]])
        expect(titles()).toEqual(['Who drafts the banner?', 'Where does retry live?'])
        expect(dialog_state.current.value?.message).toContain('disk is read-only')
        expect(history()).not.toBeNull()
    })
})

describe('AskHistory list', () => {
    it('selects every chat at once and shows a partial selection as mixed', async () => {
        await history_open()

        const all = checkbox('Select all')

        expect(button('Delete selected').disabled).toBe(true)

        await click(checkbox('Select chat: Who drafts the banner?'))

        expect([all.checked, all.indeterminate]).toEqual([false, true])

        await click(all)

        expect([all.checked, all.indeterminate]).toEqual([true, false])
        expect(button('Delete selected').disabled).toBe(false)

        await click(all)

        expect([all.checked, all.indeterminate]).toEqual([false, false])
        expect(button('Delete selected').disabled).toBe(true)
    })

    it('opens a chat from its title and closes', async () => {
        vi.mocked(ipc.chat_get).mockResolvedValue({
            exchanges: [
                {
                    answer: 'Sam drafts it.',
                    error: null,
                    id: 'exchange-banner',
                    question: 'Who drafts the banner?',
                    scope: { kind: 'all' },
                    sources: [],
                    state: 'done',
                },
            ],
            id: CHAT_BANNER,
            meetings: [],
        })

        const wrapper = await history_open()

        await click(button('Who drafts the banner?'))

        expect(ipc.chat_get).toHaveBeenCalledExactlyOnceWith(CHAT_BANNER)
        expect(ask_state.chat_id.value).toBe(CHAT_BANNER)
        expect(history()).toBeNull()
        expect(wrapper.emitted('opened')).toHaveLength(1)
    })
})

describe('AskHistory layers', () => {
    it('makes the fading dialog inert so its rows and confirm footer take no press', async () => {
        await history_open(true)
        await click(button('Delete chat: Who drafts the banner?'))

        const leaving = history()

        assert(leaving !== null)

        button('Close').click()
        await nextTick()

        expect(leaving.isConnected).toBe(true)
        expect(leaving.inert).toBe(true)
        expect(button('Delete').closest('[inert]')).toBe(leaving)
        expect(button('Cancel').closest('[inert]')).toBe(leaving)
    })

    it('goes inert under a dialog that opens over it and comes back once that closes', async () => {
        void host_mount()
        await history_open()

        const panel = history()
        const pick = button('Who drafts the banner?')

        assert(panel !== null)

        void dialog_state.confirm('Delete every chat?')
        await nextTick()
        pick.focus()

        expect(panel.inert).toBe(true)
        expect(document.body.querySelector<HTMLElement>('.app-dialog-host')?.inert).toBe(false)
        expect(document.activeElement).not.toBe(pick)

        dialog_state.close(false)
        await nextTick()
        pick.focus()

        expect(panel.inert).toBe(false)
        expect(document.activeElement).toBe(pick)
    })

    it('opens the chat menu above it and deletes the chat from there', async () => {
        mount_auto_unmount(ContextMenu, { [ATTACH_TO]: document.body })
        await history_open()

        const row = document.body.querySelector('.ask-history-row')

        assert(row !== null)

        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
        await flushPromises()

        const item = document.body.querySelector<HTMLButtonElement>('.menu-popover-context button')

        assert(item !== null)

        expect(item.closest('[inert]')).toBeNull()
        expect(document.activeElement).toBe(item)

        await click(item)

        expect(context_menu_state.menu.value).toBeNull()
        expect(question()).toBe('Delete "What did we agree to ship?"? This cannot be undone.')
    })
})

describe('AskHistory and the app behind it', () => {
    it('keeps the History button out of reach while open and focuses it after', async () => {
        const trigger = shell_mount()

        await click(trigger)
        trigger.focus()

        expect(modal_shown.value).toBe(true)
        expect(trigger.closest('[inert]')).not.toBeNull()
        expect(document.activeElement).not.toBe(trigger)

        await key_press('Escape')

        expect(history()).toBeNull()
        expect(modal_shown.value).toBe(false)
        expect(trigger.closest('[inert]')).toBeNull()
        expect(document.activeElement).toBe(trigger)
    })

    it('takes focus off the History button before the chat list arrives', async () => {
        const listed = deferred_new<ChatSummary[]>()
        const trigger = shell_mount()

        vi.mocked(ipc.chats_list).mockReturnValue(listed.promise)
        trigger.focus()
        trigger.click()
        await nextTick()

        expect(document.activeElement).not.toBe(trigger)
        expect(history()?.contains(document.activeElement)).toBe(true)

        listed.resolve([...CHATS])
        await flushPromises()

        expect(document.activeElement?.classList.contains('ask-history-open')).toBe(true)
    })

    it('lets go of the app when it unmounts while open', async () => {
        const wrapper = await history_open()

        expect(modal_shown.value).toBe(true)

        wrapper.unmount()

        expect(modal_shown.value).toBe(false)
    })
})
