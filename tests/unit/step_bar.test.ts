import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import StepBar from '../../src/components/step_bar.vue'
import { use_pipeline } from '../../src/composables/use_pipeline'
import { assert } from '../../src/lib/assert'
import { transcript_build } from './fixtures'
import type { VueWrapper } from '@vue/test-utils'


const pipeline = use_pipeline()

function states(wrapper: VueWrapper): (string | undefined)[] {
    assert(wrapper.exists())
    assert(pipeline.view_current.value.length > 0)

    return wrapper.findAll('.step-bar-item').map((button) => button.attributes('data-state'))
}

beforeEach(() => {
    pipeline.pipeline_reset()
})

describe('StepBar', () => {
    it('lists the three steps in order', () => {
        const wrapper = mount(StepBar)

        expect(wrapper.findAll('.step-bar-item').map((button) => button.text())).toEqual([
            'Transcript',
            'Meeting',
            'Notes',
        ])
    })

    it('marks the transcript step current on the transcribe view', () => {
        pipeline.view_set('transcribe')

        const wrapper = mount(StepBar)

        expect(states(wrapper)).toEqual(['current', 'todo', 'todo'])
        expect(wrapper.findAll('.step-bar-item')[0]?.attributes('aria-current')).toBe('step')
        expect(wrapper.findAll('.step-bar-item')[1]?.attributes('aria-current')).toBeUndefined()
    })

    it('marks earlier steps done on the notes view', () => {
        pipeline.view_set('notes')

        expect(states(mount(StepBar))).toEqual(['done', 'done', 'current'])
    })

    it('marks the meeting step current on the details view', () => {
        pipeline.view_set('details')

        expect(states(mount(StepBar))).toEqual(['done', 'current', 'todo'])
    })

    it('treats any other view as the first step', () => {
        pipeline.view_set('settings')

        expect(states(mount(StepBar))).toEqual(['current', 'todo', 'todo'])
    })

    it('disables later steps until a transcript exists', async () => {
        pipeline.view_set('transcribe')

        const wrapper = mount(StepBar)
        const buttons = wrapper.findAll('.step-bar-item')

        expect(buttons[0]?.attributes('disabled')).toBeUndefined()
        expect(buttons[1]?.attributes('disabled')).toBeDefined()
        expect(buttons[2]?.attributes('disabled')).toBeDefined()

        pipeline.transcript.value = transcript_build(['hello'])
        await wrapper.vm.$nextTick()

        expect(buttons[1]?.attributes('disabled')).toBeUndefined()
        expect(buttons[2]?.attributes('disabled')).toBeUndefined()
    })

    it('switches the pipeline view when a reachable step is clicked', async () => {
        pipeline.view_set('transcribe')
        pipeline.transcript.value = transcript_build(['hello'])

        const wrapper = mount(StepBar)

        await wrapper.findAll('.step-bar-item')[2]?.trigger('click')

        expect(pipeline.view_current.value).toBe('notes')
        expect(states(wrapper)).toEqual(['done', 'done', 'current'])
    })
})
