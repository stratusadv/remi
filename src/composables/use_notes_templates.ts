import { ref } from 'vue'
import { action_report } from '../lib/actions'
import { assert } from '../lib/assert'
import { error_shown } from '../lib/errors'
import { ipc } from '../lib/ipc'
import { MESSAGE_ENDPOINT_MISSING, use_endpoints } from './use_endpoints'
import type { Instruction, NotesTemplate, TemplateID } from '../types'


const TEMPLATE_COUNT_MAX = 256
const templates = ref<NotesTemplate[]>([])
const error_message = ref<string | null>(null)
const api = Object.freeze({ templates, error_message, refresh, save, remove, generate })


export function use_notes_templates(): typeof api {
    assert(templates.value.length <= TEMPLATE_COUNT_MAX)
    assert(Array.isArray(templates.value))

    return api
}

async function generate(description: Instruction): Promise<string> {
    assert(typeof description === 'string')

    const { endpoints_by_purpose } = use_endpoints()
    const endpoint_id = endpoints_by_purpose('notes')[0]?.id

    if (endpoint_id === undefined) throw new Error(MESSAGE_ENDPOINT_MISSING)

    assert(typeof endpoint_id === 'string')

    return ipc.notes_template_generate(endpoint_id, description)
}

async function refresh(): Promise<void> {
    error_message.value = null

    try {
        const fetched = await ipc.notes_templates_list()

        assert(Array.isArray(fetched))

        templates.value = fetched

        assert(templates.value.length === fetched.length)
    } catch (error) {
        error_message.value = error_shown(error)
    }
}

async function remove(id: TemplateID): Promise<void> {
    assert(typeof id === 'string')
    assert(Array.isArray(templates.value))

    error_message.value = null

    return ipc.notes_template_delete(id)
        .then(refresh)
        .catch((error: unknown) => {
            error_message.value = error_shown(error)
        })
}

async function save(template: NotesTemplate): Promise<void> {
    assert(typeof template.id === 'string')
    assert(typeof template.name === 'string')

    const created = !templates.value.some((existing) => existing.id === template.id)

    error_message.value = null

    return ipc.notes_template_save(template)
        .then(() => {
            if (created) action_report('new-template')
        })
        .then(refresh)
        .catch((error: unknown) => {
            error_message.value = error_shown(error)
        })
}
