import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assert } from '../../src/lib/assert'
import { MODE_STORAGE_KEY, PALETTE_STORAGE_KEY, THEME_STORAGE_KEY } from '../../src/lib/theme'
import { ADD_EVENT_LISTENER } from './fixtures'
import type { use_settings } from '../../src/composables/use_settings'
import type { use_theme } from '../../src/composables/use_theme'
import type { ipc as ipc_contract } from '../../src/lib/ipc'


vi.mock('../../src/lib/ipc')


type ChangeListener = () => void
type ChangeListenerAdd = (name: string, listener: ChangeListener) => void
type ThemeHarness = ReturnType<typeof use_settings> & ReturnType<typeof use_theme> & {
    ipc: typeof ipc_contract
}

interface MediaQueryListeners {
    change_listeners: Set<ChangeListener>
}

interface MediaQueryMatches {
    matches: boolean
}

type MediaQueryStub = MediaQueryListeners
    & MediaQueryMatches
    & Record<typeof ADD_EVENT_LISTENER, ChangeListenerAdd>

function change_listener_add(
    change_listeners: Set<ChangeListener>,
    name: string,
    listener: ChangeListener,
): void {
    assert(name === 'change')
    assert(typeof listener === 'function')
    assert(!change_listeners.has(listener))

    change_listeners.add(listener)
}

async function flush(): Promise<void> {
    assert(typeof setTimeout === 'function')
    assert(document.documentElement.dataset['theme'] !== undefined)

    return new Promise((resolve) => {
        setTimeout(resolve, 0)
    })
}

function match_media_install(query: MediaQueryStub): void {
    assert(typeof query.matches === 'boolean')
    assert(typeof query.addEventListener === 'function')

    vi.stubGlobal('matchMedia', vi.fn(() => query))
}

function media_query_stub(matches: boolean): MediaQueryStub {
    assert(typeof matches === 'boolean')
    assert(!vi.isMockFunction(globalThis.matchMedia))

    const change_listeners = new Set<ChangeListener>()

    return {
        change_listeners,
        matches,
        [ADD_EVENT_LISTENER]: change_listener_add.bind(undefined, change_listeners),
    }
}

async function theme_import(): Promise<ThemeHarness> {
    assert(typeof vi.resetModules === 'function')

    vi.resetModules()

    const [{ ipc }, settings_module, theme_module] = await Promise.all([
        import('../../src/lib/ipc'),
        import('../../src/composables/use_settings'),
        import('../../src/composables/use_theme'),
    ])

    vi.mocked(ipc.settings_update).mockResolvedValue(undefined)

    assert(typeof ipc.settings_update === 'function')

    return { ipc, ...settings_module.use_settings(), ...theme_module.use_theme() }
}

beforeEach(() => {
    localStorage.clear()
    document.documentElement.className = ''
    document.documentElement.style.colorScheme = ''
    delete document.documentElement.dataset['palette']
    delete document.documentElement.dataset['theme']
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('use_theme on load', () => {
    it('applies the system mode, the Cubism theme, and its colour scheme immediately', async () => {
        match_media_install(media_query_stub(true))

        const theme = await theme_import()

        expect(theme.mode_effective.value).toBe('light')
        expect(theme.theme_effective.value).toBe('cubism')
        expect(theme.palette_effective.value).toBe('cubist')
        expect(document.documentElement.classList.contains('mode-light')).toBe(true)
        expect(document.documentElement.dataset['theme']).toBe('cubism')
        expect(document.documentElement.dataset['palette']).toBe('cubist')
        expect(localStorage.length).toBe(0)
    })

    it('paints the stored appearance before the settings arrive', async () => {
        match_media_install(media_query_stub(false))
        localStorage.setItem(MODE_STORAGE_KEY, 'light')
        localStorage.setItem(PALETTE_STORAGE_KEY, 'nord')
        localStorage.setItem(THEME_STORAGE_KEY, 'standard')

        const theme = await theme_import()

        expect(theme.settings.value.theme).toBeNull()
        expect(document.documentElement.classList.contains('mode-light')).toBe(true)
        expect(document.documentElement.dataset['theme']).toBe('standard')
        expect(document.documentElement.dataset['palette']).toBe('nord')
        expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('standard')
    })

    it('paints the default for a stored theme or colour scheme that no longer exists', async () => {
        match_media_install(media_query_stub(false))
        localStorage.setItem(PALETTE_STORAGE_KEY, 'mauve')
        localStorage.setItem(THEME_STORAGE_KEY, 'baroque')

        await theme_import()

        expect(document.documentElement.dataset['theme']).toBe('cubism')
        expect(document.documentElement.dataset['palette']).toBe('cubist')
    })
})

describe('use_theme after load', () => {
    it('applies and stores the settings once they arrive', async () => {
        match_media_install(media_query_stub(true))

        const theme = await theme_import()

        theme.settings.value = { ...theme.settings.value, mode: 'dark', theme: 'standard' }
        await flush()

        expect(document.documentElement.classList.contains('mode-dark')).toBe(true)
        expect(document.documentElement.dataset['theme']).toBe('standard')
        expect(document.documentElement.dataset['palette']).toBe('graphite')
        expect(localStorage.getItem(MODE_STORAGE_KEY)).toBe('dark')
        expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('standard')
        expect(localStorage.getItem(PALETTE_STORAGE_KEY)).toBeNull()
    })

    it('follows a later system change while the mode is system', async () => {
        const query = media_query_stub(false)

        match_media_install(query)
        const theme = await theme_import()

        expect(theme.mode_effective.value).toBe('dark')

        query.matches = true

        for (const listener of query.change_listeners) listener()

        expect(document.documentElement.classList.contains('mode-light')).toBe(true)
    })

    it('ignores a system change once an explicit mode is set', async () => {
        const query = media_query_stub(false)

        match_media_install(query)
        const theme = await theme_import()

        theme.mode_set('dark')
        await flush()
        query.matches = true

        for (const listener of query.change_listeners) listener()

        expect(document.documentElement.classList.contains('mode-dark')).toBe(true)
        expect(document.documentElement.classList.contains('mode-light')).toBe(false)
    })
})

describe('mode_set', () => {
    it('persists an explicit choice to the backend, the html and local storage', async () => {
        match_media_install(media_query_stub(true))

        const theme = await theme_import()

        theme.mode_set('dark')
        await flush()

        expect(theme.ipc.settings_update).toHaveBeenCalledWith(
            expect.objectContaining({ mode: 'dark' }),
        )

        expect(document.documentElement.classList.contains('mode-dark')).toBe(true)
        expect(document.documentElement.style.colorScheme).toBe('dark')
        expect(localStorage.getItem(MODE_STORAGE_KEY)).toBe('dark')
    })

    it('stores system as null and clears local storage', async () => {
        match_media_install(media_query_stub(true))

        const theme = await theme_import()

        theme.mode_set('dark')
        await flush()
        theme.mode_set('system')
        await flush()

        expect(theme.ipc.settings_update).toHaveBeenLastCalledWith(
            expect.objectContaining({ mode: null }),
        )

        expect(localStorage.getItem(MODE_STORAGE_KEY)).toBeNull()
        expect(document.documentElement.classList.contains('mode-light')).toBe(true)
    })
})

describe('mode_toggle', () => {
    it('flips between light and dark from the effective mode', async () => {
        match_media_install(media_query_stub(true))

        const theme = await theme_import()

        theme.mode_toggle()
        await flush()

        expect(theme.settings.value.mode).toBe('dark')
        expect(theme.mode_effective.value).toBe('dark')

        theme.mode_toggle()
        await flush()

        expect(theme.settings.value.mode).toBe('light')
        expect(document.documentElement.classList.contains('mode-light')).toBe(true)
    })
})

describe('theme_set', () => {
    it('persists the theme and switches to its own colour scheme', async () => {
        match_media_install(media_query_stub(false))

        const theme = await theme_import()

        theme.palette_set('nord')
        await flush()
        theme.theme_set('standard')

        expect(document.documentElement.dataset['theme']).toBe('standard')
        expect(document.documentElement.dataset['palette']).toBe('graphite')

        await flush()

        expect(theme.ipc.settings_update).toHaveBeenLastCalledWith(
            expect.objectContaining({ theme: 'standard', palette: null }),
        )

        expect(theme.theme_effective.value).toBe('standard')
        expect(theme.palette_effective.value).toBe('graphite')
        expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('standard')
        expect(localStorage.getItem(PALETTE_STORAGE_KEY)).toBeNull()
    })

    it('reports each new theme, colour scheme, or mode, and nothing for the same one', async () => {
        match_media_install(media_query_stub(false))

        const theme = await theme_import()

        theme.theme_set('cubism')
        theme.palette_set('cubist')
        theme.mode_set('system')
        await flush()

        expect(theme.ipc.account_action_report).not.toHaveBeenCalled()

        theme.theme_set('standard')
        theme.palette_set('nord')
        theme.mode_set('light')
        await flush()

        theme.palette_set('nord')
        theme.mode_set('light')
        await flush()

        expect(vi.mocked(theme.ipc.account_action_report).mock.calls).toEqual([
            ['change-theme'],
            ['change-theme'],
            ['change-theme'],
        ])
    })

    it('returns to the Cubist colour scheme with the Cubism theme', async () => {
        match_media_install(media_query_stub(false))

        const theme = await theme_import()

        theme.theme_set('standard')
        await flush()
        theme.theme_set('cubism')
        await flush()

        expect(document.documentElement.dataset['theme']).toBe('cubism')
        expect(document.documentElement.dataset['palette']).toBe('cubist')
        expect(theme.palette_effective.value).toBe('cubist')
    })
})

describe('palette_set', () => {
    it('persists the palette and writes it to the html', async () => {
        match_media_install(media_query_stub(false))

        const theme = await theme_import()

        theme.palette_set('nord')
        await flush()

        expect(theme.ipc.settings_update).toHaveBeenCalledWith(
            expect.objectContaining({ palette: 'nord' }),
        )

        expect(document.documentElement.dataset['palette']).toBe('nord')
        expect(theme.palette_effective.value).toBe('nord')
        expect(localStorage.getItem(PALETTE_STORAGE_KEY)).toBe('nord')
    })

    it('keeps a chosen colour scheme under either theme', async () => {
        match_media_install(media_query_stub(false))

        const theme = await theme_import()

        theme.theme_set('standard')
        await flush()
        theme.palette_set('cubist')
        await flush()

        expect(theme.theme_effective.value).toBe('standard')
        expect(theme.palette_effective.value).toBe('cubist')
        expect(document.documentElement.dataset['palette']).toBe('cubist')
    })
})

describe('palette_resolve and theme_resolve', () => {
    it('falls back to the theme colour scheme for an unknown saved palette', async () => {
        match_media_install(media_query_stub(false))

        await theme_import()

        const { palette_resolve } = await import('../../src/composables/use_theme')

        expect(palette_resolve('graphite', 'cubism')).toBe('graphite')
        expect(palette_resolve('nord', 'standard')).toBe('nord')
        expect(palette_resolve('mauve', 'cubism')).toBe('cubist')
        expect(palette_resolve(null, 'cubism')).toBe('cubist')
        expect(palette_resolve('mauve', 'standard')).toBe('graphite')
        expect(palette_resolve(null, 'standard')).toBe('graphite')
    })

    it('falls back to Cubism for a saved theme that does not exist', async () => {
        match_media_install(media_query_stub(false))

        await theme_import()

        const { THEMES, theme_resolve } = await import('../../src/composables/use_theme')

        expect(theme_resolve('standard')).toBe('standard')
        expect(theme_resolve('dark')).toBe('cubism')
        expect(theme_resolve(null)).toBe('cubism')
        expect(THEMES.map((candidate) => candidate.id)).toEqual(['cubism', 'standard'])
    })
})
