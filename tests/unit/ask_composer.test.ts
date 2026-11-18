import { beforeEach, describe, expect, it } from 'vitest'
import AskComposer from '../../src/components/ask_composer.vue'
import { use_network } from '../../src/composables/use_network'
import { assert } from '../../src/lib/assert'
import { ATTACH_TO, IS_COMPOSING, PROPERTIES, SHIFT_KEY, mount_auto_unmount } from './fixtures'
import type { AskScopeChip } from '../../src/types'
import type { VueWrapper } from '@vue/test-utils'


const CHARACTER_SUPPLEMENTARY = '\u{20BB7}'
const QUESTION = 'Who drafts the banner copy?'
const QUESTION_CHARS_MAX = 1000
const SCOPE_FOLDER = Object.freeze<AskScopeChip>({ kind: 'folder', label: 'Acme Mining' })
const SCOPE_MEETING = Object.freeze<AskScopeChip>({ kind: 'meeting', label: 'Weekly sync' })
const { online } = use_network()


function composer_mount(busy: boolean, scope: AskScopeChip | null = null): VueWrapper {
    assert(typeof busy === 'boolean')
    assert(scope === null || scope.label.length > 0)

    const wrapper = mount_auto_unmount(AskComposer, {
        [PROPERTIES]: { busy, scope },
        [ATTACH_TO]: document.body,
    })

    assert(wrapper.exists())

    return wrapper
}

beforeEach(() => {
    online.value = true
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

    it('says so when the computer is offline', async () => {
        online.value = false

        const wrapper = composer_mount(false)

        await wrapper.get('textarea').setValue(QUESTION)

        expect(wrapper.text()).toContain('You are offline')
        expect(wrapper.get('button[aria-label="Send"]').attributes('disabled')).toBeDefined()
    })
})

describe('ask_composer length', () => {
    it('cuts a question the textarea let past the limit to exactly the limit', async () => {
        const wrapper = composer_mount(false)
        const input = wrapper.get('textarea')

        await input.setValue('a'.repeat(QUESTION_CHARS_MAX + 200))

        expect((input.element as HTMLTextAreaElement).value).toBe('a'.repeat(QUESTION_CHARS_MAX))
    })

    it('cuts a question counted in code points without splitting a surrogate pair', async () => {
        const wrapper = composer_mount(false)
        const input = wrapper.get('textarea')
        const kept = `a${CHARACTER_SUPPLEMENTARY.repeat(499)}`

        assert(kept.length === QUESTION_CHARS_MAX - 1)

        await input.setValue(`${kept}${CHARACTER_SUPPLEMENTARY}`)

        const value = (input.element as HTMLTextAreaElement).value

        expect(value).toBe(kept)
        expect(new TextDecoder().decode(new TextEncoder().encode(value))).toBe(value)

        await input.trigger('keydown', { key: 'Enter' })

        expect(wrapper.emitted('send')).toEqual([[kept]])
    })
})
