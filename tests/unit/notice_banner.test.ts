import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import NoticeBanner from '../../src/components/notice_banner.vue'
import { PROPERTIES } from './fixtures'


describe('NoticeBanner', () => {
    it('defaults to an error alert', () => {
        const wrapper = mount(NoticeBanner, { slots: { default: 'Something broke' } })
        const banner = wrapper.get('.banner')

        expect(banner.attributes('data-kind')).toBe('error')
        expect(banner.attributes('role')).toBe('alert')
        expect(wrapper.get('p').text()).toBe('Something broke')
    })

    it('uses the status role for info and warning kinds', () => {
        const information = mount(NoticeBanner, { [PROPERTIES]: { kind: 'info' } })
        const warning = mount(NoticeBanner, { [PROPERTIES]: { kind: 'warning' } })

        expect(information.get('.banner').attributes('role')).toBe('status')
        expect(information.get('.banner').attributes('data-kind')).toBe('info')
        expect(warning.get('.banner').attributes('role')).toBe('status')
    })

    it('keeps the dismiss button after the actions and outside the wrapping body', () => {
        const wrapper = mount(NoticeBanner, {
            slots: { actions: '<button class="retry">Retry</button>' },
        })

        const banner = wrapper.get('.banner')
        const buttons = banner.findAll('button')

        expect(buttons).toHaveLength(2)
        expect(buttons[0]?.classes()).toContain('retry')
        expect(buttons[1]?.attributes('aria-label')).toBe('Dismiss')
        expect(banner.element.lastElementChild).toBe(buttons[1]?.element)
        expect(wrapper.get('.banner-body').find('[aria-label="Dismiss"]').exists()).toBe(false)
    })

    it('renders no empty actions group when it has no actions', () => {
        const wrapper = mount(NoticeBanner, { slots: { default: 'Saved' } })

        expect(wrapper.find('.banner-actions').exists()).toBe(false)
        expect(wrapper.findAll('button')).toHaveLength(1)
    })

    it('emits dismiss when the close button is clicked', async () => {
        const wrapper = mount(NoticeBanner)

        await wrapper.get('.banner-close').trigger('click')

        expect(wrapper.emitted('dismiss')).toHaveLength(1)
    })
})
