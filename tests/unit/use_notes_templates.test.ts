import { beforeEach, describe, expect, it, vi } from 'vitest'
import { use_endpoints } from '../../src/composables/use_endpoints'
import { use_notes_templates } from '../../src/composables/use_notes_templates'
import { ipc } from '../../src/lib/ipc'
import type { APIEndpoint, NotesTemplate } from '../../src/types'


vi.mock('../../src/lib/ipc')

const TEMPLATE = Object.freeze<NotesTemplate>({
    id: 'meeting',
    name: 'Meeting notes',
    description: 'Summary and decisions',
    instructions: '## Summary',
    edited: false,
})

const ENDPOINT_NOTES = Object.freeze<APIEndpoint>({
    id: 'notes-endpoint',
    name: 'Notes',
    purpose: 'notes',
    host: 'https://ai.example.invalid',
    api_key: '',
    model: 'thinking',
    temperature: null,
    output_tokens_max: null,
    api_path_chat: null,
    api_path_transcribe: null,
    transcribe_verbose: null,
    transcribe_chunk_seconds: null,
    has_api_key: true,
})

const templates_state = use_notes_templates()
const { endpoints } = use_endpoints()

beforeEach(() => {
    vi.resetAllMocks()
    templates_state.templates.value = []
    templates_state.error_message.value = null
    endpoints.value = []
})

describe('refresh', () => {
    it('loads the template list', async () => {
        vi.mocked(ipc.notes_templates_list).mockResolvedValue([TEMPLATE])

        await templates_state.refresh()

        expect(templates_state.templates.value).toEqual([TEMPLATE])
    })

    it('records the failure', async () => {
        vi.mocked(ipc.notes_templates_list).mockRejectedValue(new Error('unreadable'))

        await templates_state.refresh()

        expect(templates_state.error_message.value).toBe('Error: unreadable')
    })
})

describe('save and remove', () => {
    it('saves the template and refreshes', async () => {
        vi.mocked(ipc.notes_template_save).mockResolvedValue(undefined)
        vi.mocked(ipc.notes_templates_list).mockResolvedValue([TEMPLATE])

        await templates_state.save(TEMPLATE)

        expect(ipc.notes_template_save).toHaveBeenCalledWith(TEMPLATE)
        expect(templates_state.templates.value).toEqual([TEMPLATE])
    })

    it('deletes by id and refreshes', async () => {
        vi.mocked(ipc.notes_template_delete).mockResolvedValue(undefined)
        vi.mocked(ipc.notes_templates_list).mockResolvedValue([])

        await templates_state.remove('meeting')

        expect(ipc.notes_template_delete).toHaveBeenCalledWith('meeting')
        expect(ipc.notes_templates_list).toHaveBeenCalledTimes(1)
    })

    it('records a save failure without refreshing', async () => {
        vi.mocked(ipc.notes_template_save).mockRejectedValue(new Error('full'))

        await templates_state.save(TEMPLATE)

        expect(templates_state.error_message.value).toBe('Error: full')
        expect(ipc.notes_templates_list).not.toHaveBeenCalled()
    })
})

describe('generate', () => {
    it('throws a key-missing message when no notes endpoint exists', async () => {
        endpoints.value = [{ ...ENDPOINT_NOTES, purpose: 'transcription' }]

        await expect(templates_state.generate('weekly sync')).rejects.toThrow(
            'Add your notes API key under Settings first.',
        )

        expect(ipc.notes_template_generate).not.toHaveBeenCalled()
    })

    it('generates through the first notes endpoint', async () => {
        endpoints.value = [
            { ...ENDPOINT_NOTES, id: 'transcribe', purpose: 'transcription' },
            ENDPOINT_NOTES,
            { ...ENDPOINT_NOTES, id: 'second-notes' },
        ]

        vi.mocked(ipc.notes_template_generate).mockResolvedValue('## Layout')

        const layout = await templates_state.generate('weekly sync')

        expect(layout).toBe('## Layout')
        expect(ipc.notes_template_generate).toHaveBeenCalledWith('notes-endpoint', 'weekly sync')
    })
})
