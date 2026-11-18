import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it } from 'vitest'
import StepCitation from '../../src/components/step_citation.vue'
import { use_pipeline } from '../../src/composables/use_pipeline'


const QUESTION = 'Who is drafting the banner copy?'

const pipeline = use_pipeline()

beforeEach(() => {
    pipeline.pipeline_reset()
})

describe('StepCitation', () => {
    it('shows nothing for a meeting opened without a citation', () => {
        pipeline.view_set('transcribe')

        const wrapper = mount(StepCitation)

        expect(wrapper.find('.step-citation').exists()).toBe(false)
    })

    it('names the citation and its question, then returns to the answer', async () => {
        pipeline.view_set('transcribe')
        pipeline.citation_return.value = { number: 2, question: QUESTION }

        const wrapper = mount(StepCitation)
        const back = wrapper.get('button')

        expect(wrapper.get('.ask-source-number').text()).toBe('2')

        expect(wrapper.get('.step-citation-label').text()).toBe(
            `Source 2: Cited in your chat ${QUESTION}`,
        )

        expect(back.text()).toBe('Back to answer')

        await back.trigger('click')
        await nextTick()

        expect(pipeline.view_current.value).toBe('ask')
        expect(pipeline.citation_return.value).toBeNull()
        expect(wrapper.find('.step-citation').exists()).toBe(false)
    })
})
