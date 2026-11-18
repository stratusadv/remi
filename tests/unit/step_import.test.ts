import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import StepImport from '../../src/components/step_import.vue'
import { use_pipeline } from '../../src/composables/use_pipeline'
import { assert } from '../../src/lib/assert'
import { ipc } from '../../src/lib/ipc'
import { job_meta_build, mount_auto_unmount, transcript_build } from './fixtures'
import type { VueWrapper } from '@vue/test-utils'


vi.mock('../../src/lib/ipc')

const JOB_ID = 'job-imported'
const LINES = Object.freeze(['Alright, everyone is here.', 'The invoice review moved to Friday.'])
const NOTES_STORED = '# Notes\n\nThe invoice review moved to Friday.\n'
const pipeline = use_pipeline()


afterEach(() => {
    pipeline.pipeline_reset()
    vi.resetAllMocks()
})

async function import_submit(notes_stored: string | null): Promise<VueWrapper> {
    assert(notes_stored === null || notes_stored.length > 0)
    assert(LINES.length > 0)

    vi.mocked(ipc.transcript_import).mockResolvedValue({
        job_id: JOB_ID,
        transcript: transcript_build([...LINES]),
        cached: notes_stored !== null,
    })

    vi.mocked(ipc.job_meta_get).mockResolvedValue(job_meta_build({ id: JOB_ID }))
    vi.mocked(ipc.jobs_list).mockResolvedValue([])
    vi.mocked(ipc.notes_load).mockResolvedValue(notes_stored)
    pipeline.view_set('import')

    const wrapper = mount_auto_unmount(StepImport)
    const next = wrapper.findAll('button').find((button) => button.text() === 'Next')

    assert(next !== undefined, 'the import step has no Next button')

    await wrapper.find('textarea').setValue(LINES.join('\n'))
    await next.trigger('click')
    await flushPromises()

    return wrapper
}

describe('StepImport for text imported before', () => {
    it('shows the notes stored for the meeting the import attaches', async () => {
        await import_submit(NOTES_STORED)

        expect(pipeline.view_current.value).toBe('details')
        expect(pipeline.job_id_current.value).toBe(JOB_ID)
        expect(pipeline.notes_markdown.value).toBe(NOTES_STORED)
    })

    it('starts with no notes for text imported for the first time', async () => {
        await import_submit(null)

        expect(pipeline.view_current.value).toBe('details')
        expect(pipeline.job_id_current.value).toBe(JOB_ID)
        expect(pipeline.notes_markdown.value).toBe('')
    })
})
