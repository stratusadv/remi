import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import AskComposer from '../../src/components/ask_composer.vue'
import { use_network } from '../../src/composables/use_network'
import { use_pipeline } from '../../src/composables/use_pipeline'
import { use_service } from '../../src/composables/use_service'
import { assert } from '../../src/lib/assert'
import { ATTACH_TO, IS_COMPOSING, PROPERTIES, SHIFT_KEY } from './fixtures'
import type { AskScopeChip } from '../../src/types'
import type { VueWrapper } from '@vue/test-utils'


const QUESTION = 'Who drafts the banner copy?'
const SCOPE_FOLDER = Object.freeze<AskScopeChip>({ kind: 'folder', label: 'Acme Mining' })
const SCOPE_MEETING = Object.freeze<AskScopeChip>({ kind: 'meeting', label: 'Weekly sync' })
const { online } = use_network()
const { view_current } = use_pipeline()
const { status } = use_service()
const mounted = new Set<VueWrapper>()


function composer_mount(busy: boolean, scope: AskScopeChip | null = null): VueWrapper {
    assert(typeof busy === 'boolean')
    assert(scope === null || scope.label.length > 0)

    const wrapper = mount(AskComposer, {
        [PROPERTIES]: { busy, scope },
        [ATTACH_TO]: document.body,
    })

    mounted.add(wrapper)

    assert(wrapper.exists())

    return wrapper
}

beforeEach(() => {
    online.value = true
    view_current.value = 'ask'

    status.value = {
        host: { builtin: false, user: true },
        notes: { builtin: false, length: 3, user: true },
        transcription: { builtin: false, length: 3, user: true },
    }
})

afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount()

    mounted.clear()
})

describe('ask_composer', () => {
    it('sends the trimmed question on Enter and clears the box', async () => {
        const wrapper = composer_mount(false)
        const input = wrapper.get('textarea')

        await input.setValue(`  ${QUESTION}  `)
        await input.trigger('keydown', { key: 'Enter' })

        expect(wrapper.emitted('send')).toEqual([[QUESTION]])
        expect((input.element as HTMLTextAreaElement).value).toBe('')
    })

    it('keeps typing on Shift+Enter and while an input method is composing', async () => {
        const wrapper = composer_mount(false)
        const input = wrapper.get('textarea')

        await input.setValue(QUESTION)
        await input.trigger('keydown', { key: 'Enter', [SHIFT_KEY]: true })
        await input.trigger('keydown', { key: 'Enter', [IS_COMPOSING]: true })

        expect(wrapper.emitted('send')).toBeUndefined()
        expect((input.element as HTMLTextAreaElement).value).toBe(QUESTION)
    })

    it('sends nothing for a blank question', async () => {
        const wrapper = composer_mount(false)

        await wrapper.get('textarea').setValue('   ')
        await wrapper.get('textarea').trigger('keydown', { key: 'Enter' })

        expect(wrapper.emitted('send')).toBeUndefined()
        expect(wrapper.get('button[aria-label="Send"]').attributes('disabled')).toBeDefined()
    })
})

describe('ask_composer scope', () => {
    it('shows no chip and asks about every meeting without a scope', () => {
        const wrapper = composer_mount(false)

        expect(wrapper.find('.ask-scope').exists()).toBe(false)
        expect(wrapper.find('select').exists()).toBe(false)
        expect(wrapper.get('textarea').attributes('placeholder')).toBe('Ask about your meetings')
    })

    it('names the folder in a chip and clears it without sending', async () => {
        const wrapper = composer_mount(false, SCOPE_FOLDER)

        await wrapper.get('textarea').setValue(QUESTION)

        expect(wrapper.get('.ask-scope').text()).toBe(SCOPE_FOLDER.label)
        expect(wrapper.get('.ask-scope').attributes('data-kind')).toBe('folder')
        expect(wrapper.get('textarea').attributes('placeholder')).toBe('Ask about this folder')

        await wrapper.get('button[aria-label="Ask about all meetings"]').trigger('click')

        expect(wrapper.emitted('scope_clear')).toEqual([[]])
        expect(wrapper.emitted('send')).toBeUndefined()
        expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe(QUESTION)
    })

    it('names the meeting in a chip', () => {
        const wrapper = composer_mount(false, SCOPE_MEETING)

        expect(wrapper.get('.ask-scope').text()).toBe(SCOPE_MEETING.label)
        expect(wrapper.get('.ask-scope').attributes('data-kind')).toBe('meeting')
        expect(wrapper.get('textarea').attributes('placeholder')).toBe('Ask about this meeting')
    })
})

describe('ask_composer while it cannot send', () => {
    it('turns Send into Stop while an answer is coming', async () => {
        const wrapper = composer_mount(true)

        await wrapper.get('textarea').setValue(QUESTION)
        await wrapper.get('textarea').trigger('keydown', { key: 'Enter' })
        await wrapper.get('button[aria-label="Stop"]').trigger('click')

        expect(wrapper.emitted('send')).toBeUndefined()
        expect(wrapper.emitted('stop')).toEqual([[]])
        expect(wrapper.find('button[aria-label="Send"]').exists()).toBe(false)
    })

    it('points to Settings until the notes service is set up', async () => {
        status.value = {
            host: { builtin: false, user: false },
            notes: { builtin: false, length: 0, user: false },
            transcription: { builtin: false, length: 0, user: false },
        }

        const wrapper = composer_mount(false)

        await wrapper.get('textarea').setValue(QUESTION)

        expect(wrapper.get('button[aria-label="Send"]').attributes('disabled')).toBeDefined()

        await wrapper.get('.ask-composer-link').trigger('click')

        expect(view_current.value).toBe('settings')
    })

    it('says so when the computer is offline', async () => {
        online.value = false

        const wrapper = composer_mount(false)

        await wrapper.get('textarea').setValue(QUESTION)

        expect(wrapper.text()).toContain('You are offline')
        expect(wrapper.get('button[aria-label="Send"]').attributes('disabled')).toBeDefined()
    })
})
