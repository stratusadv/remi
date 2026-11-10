import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import PersonForm from '../../src/components/person_form.vue'
import { assert } from '../../src/lib/assert'
import { PROPERTIES, person_build } from './fixtures'
import type { DOMWrapper, VueWrapper } from '@vue/test-utils'
import type { Person } from '../../src/types'


interface PersonInputs {
    name_first: DOMWrapper<HTMLInputElement> | undefined
    name_last: DOMWrapper<HTMLInputElement> | undefined
    role: DOMWrapper<HTMLInputElement> | undefined
    description: Omit<DOMWrapper<HTMLTextAreaElement>, 'exists'>
}

function inputs(wrapper: VueWrapper): PersonInputs {
    assert(wrapper.exists())
    assert(wrapper.findAll('input').length > 0)

    const fields = wrapper.findAll('input')

    return {
        name_first: fields[0],
        name_last: fields[1],
        role: fields[2],
        description: wrapper.get('textarea'),
    }
}

function save_button(wrapper: VueWrapper): Omit<DOMWrapper<Element>, 'exists'> {
    assert(wrapper.exists())
    assert(wrapper.find('.btn-primary').exists())

    return wrapper.get('.btn-primary')
}

describe('PersonForm', () => {
    it('starts empty with save disabled for a new person', () => {
        const wrapper = mount(PersonForm, { [PROPERTIES]: { person: null } })
        const fields = inputs(wrapper)

        expect(fields.name_first?.element.value).toBe('')
        expect(fields.name_last?.element.value).toBe('')
        expect(fields.role?.element.value).toBe('')
        expect(fields.description.element.value).toBe('')
        expect(save_button(wrapper).attributes('disabled')).toBeDefined()
    })

    it('prefills the fields from an existing person', () => {
        const person = person_build({ role: 'Client', description: 'Signs off releases' })
        const wrapper = mount(PersonForm, { [PROPERTIES]: { person } })
        const fields = inputs(wrapper)

        expect(fields.name_first?.element.value).toBe('John')
        expect(fields.name_last?.element.value).toBe('Doe')
        expect(fields.role?.element.value).toBe('Client')
        expect(fields.description.element.value).toBe('Signs off releases')
        expect(save_button(wrapper).attributes('disabled')).toBeUndefined()
    })

    it('enables save only once the first name has non-blank text', async () => {
        const wrapper = mount(PersonForm, { [PROPERTIES]: { person: null } })

        await inputs(wrapper).name_first?.setValue('   ')

        expect(save_button(wrapper).attributes('disabled')).toBeDefined()

        await inputs(wrapper).name_first?.setValue(' Ada ')

        expect(save_button(wrapper).attributes('disabled')).toBeUndefined()
    })

    it('emits a trimmed person with a fresh id on save', async () => {
        const wrapper = mount(PersonForm, { [PROPERTIES]: { person: null } })
        const fields = inputs(wrapper)

        await fields.name_first?.setValue(' Ada ')
        await fields.name_last?.setValue(' Lovelace ')
        await fields.role?.setValue(' Engineer ')
        await fields.description.setValue(' First programmer ')
        await save_button(wrapper).trigger('click')

        const [saved] = wrapper.emitted<Person[]>('save')?.[0] ?? []

        expect(saved).toMatchObject({
            name_first: 'Ada',
            name_last: 'Lovelace',
            role: 'Engineer',
            description: 'First programmer',
        })

        expect(saved?.id).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('keeps the id of an existing person on save', async () => {
        const person = person_build({ id: 'keep-me' })
        const wrapper = mount(PersonForm, { [PROPERTIES]: { person } })

        await save_button(wrapper).trigger('click')

        expect(wrapper.emitted<Person[]>('save')?.[0]?.[0]?.id).toBe('keep-me')
    })
})

describe('PersonForm', () => {
    it('saves on enter from a text field and never with a blank first name', async () => {
        const wrapper = mount(PersonForm, { [PROPERTIES]: { person: null } })

        await inputs(wrapper).role?.trigger('keydown', { key: 'Enter' })

        expect(wrapper.emitted('save')).toBeUndefined()

        await inputs(wrapper).name_first?.setValue('Ada')
        await inputs(wrapper).name_last?.trigger('keydown', { key: 'Enter' })

        expect(wrapper.emitted('save')).toHaveLength(1)
    })

    it('emits cancel from the cancel button', async () => {
        const wrapper = mount(PersonForm, { [PROPERTIES]: { person: null } })

        await wrapper.get('.btn-default').trigger('click')

        expect(wrapper.emitted('cancel')).toHaveLength(1)
    })
})
