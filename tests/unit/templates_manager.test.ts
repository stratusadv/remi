import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TemplatesManager from '../../src/components/templates_manager.vue'
import { use_context_menu } from '../../src/composables/use_context_menu'
import { use_notes_templates } from '../../src/composables/use_notes_templates'
import { use_pipeline } from '../../src/composables/use_pipeline'
import { use_settings } from '../../src/composables/use_settings'
import { assert } from '../../src/lib/assert'
import { ATTACH_TO } from './fixtures'
import type { VueWrapper } from '@vue/test-utils'
import type { NotesTemplate } from '../../src/types'


vi.mock('../../src/lib/ipc')

const NAME_INPUT = 'input[placeholder="e.g. Meeting notes"]'

const STANDUP = Object.freeze<NotesTemplate>({
    id: 'template-standup',
    name: 'Standup',
    description: 'The daily check-in',
    instructions: 'What changed since yesterday, and what is blocked.',
    edited: true,
})

const context_menu = use_context_menu()
const mounted = new Set<VueWrapper>()
const pipeline = use_pipeline()
const settings_state = use_settings()
const templates_state = use_notes_templates()


function default_set(id: string | null): void {
    assert(id === null || id.length > 0)

    const updated = { ...settings_state.settings.value, notes_template_id_default: id }

    settings_state.settings.value = updated

    assert(settings_state.settings.value.notes_template_id_default === id)
}

function menu_ids(): string[] {
    const shown = context_menu.menu.value

    assert(shown !== null)
    assert(shown.items.length > 0)

    return shown.items.map((item) => item.id)
}

async function mount_templates(): Promise<VueWrapper> {
    assert(mounted.size === 0)

    const wrapper = mount(TemplatesManager, { [ATTACH_TO]: document.body })

    mounted.add(wrapper)
    await flushPromises()

    assert(wrapper.element instanceof Node)
    assert(document.body.contains(wrapper.element))

    return wrapper
}

function name_shown(wrapper: VueWrapper): string | null {
    assert(mounted.has(wrapper))

    const input = wrapper.find<HTMLInputElement>(NAME_INPUT)

    assert(wrapper.findAll(NAME_INPUT).length <= 1)

    return input.exists() ? input.element.value : null
}

beforeEach(() => {
    pipeline.pipeline_reset()
    templates_state.templates.value = [{ ...STANDUP }]
    default_set(null)
})

afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount()

    mounted.clear()
    context_menu.close()
    templates_state.templates.value = []
    document.body.innerHTML = ''
})

describe('TemplatesManager', () => {
    it('opens a blank template when Add template was chosen from the sidebar', async () => {
        pipeline.view_intent_open('template_add')

        const wrapper = await mount_templates()

        expect(name_shown(wrapper)).toBe('')
        expect(pipeline.view_intent_take()).toBeNull()
    })

    it('shows the list when the view is opened plainly', async () => {
        pipeline.view_reopen('templates')

        const wrapper = await mount_templates()

        expect(name_shown(wrapper)).toBeNull()
        expect(wrapper.findAll('li')).toHaveLength(1)
    })

    it('offers Make default only on a template that is not already the default', async () => {
        const wrapper = await mount_templates()

        await wrapper.get('li').trigger('contextmenu')

        expect(menu_ids()).toEqual(['default', 'edit', 'delete'])

        context_menu.close()
        default_set(STANDUP.id)
        await flushPromises()
        await wrapper.get('li').trigger('contextmenu')

        expect(menu_ids()).toEqual(['edit', 'delete'])

        await context_menu.choose('edit')
        await flushPromises()

        expect(name_shown(wrapper)).toBe(STANDUP.name)
    })
})
