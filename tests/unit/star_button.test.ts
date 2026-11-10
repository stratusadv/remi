import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import StarButton from '../../src/components/star_button.vue'
import { PROPERTIES } from './fixtures'


describe('StarButton', () => {
    it('renders the add state when not a favourite', () => {
        const properties = { favourite: false, title: 'Weekly sync' }
        const wrapper = mount(StarButton, { [PROPERTIES]: properties })
        const button = wrapper.get('button')

        expect(button.attributes('aria-pressed')).toBe('false')
        expect(button.attributes('aria-label')).toBe('Add Weekly sync to favourites')
        expect(button.attributes('title')).toBe('Add to favourites')
        expect(wrapper.get('svg').attributes('fill')).toBe('none')
    })

    it('renders the remove state when a favourite', () => {
        const properties = { favourite: true, title: 'Weekly sync' }
        const wrapper = mount(StarButton, { [PROPERTIES]: properties })
        const button = wrapper.get('button')

        expect(button.attributes('aria-pressed')).toBe('true')
        expect(button.attributes('aria-label')).toBe('Remove Weekly sync from favourites')
        expect(button.attributes('title')).toBe('Remove from favourites')
        expect(wrapper.get('svg').attributes('fill')).toBe('currentColor')
    })

    it('emits toggle on click', async () => {
        const wrapper = mount(StarButton, { [PROPERTIES]: { favourite: false, title: 'x' } })

        await wrapper.get('button').trigger('click')

        expect(wrapper.emitted('toggle')).toHaveLength(1)
    })
})
