import { Editor } from '@tiptap/core'
import { assert } from '../../src/lib/assert'
import type { Group, JobListing, JobMeta, Person, Transcript } from '../../src/types'


export const ADD_EVENT_LISTENER = 'addEventListener'
export const ALT_KEY = 'altKey'
export const ATTACH_TO = 'attachTo'
export const CONTENT_RECT = 'contentRect'
export const CTRL_KEY = 'ctrlKey'
export const EMIT_UPDATE = 'emitUpdate'
export const META_KEY = 'metaKey'
export const MODEL_VALUE = 'modelValue'
export const PROPERTIES = 'props'
export const SHIFT_KEY = 'shiftKey'
export const TO_FAKE = 'toFake'
export const WRITE_TEXT = 'writeText'


export interface Deferred<Value> {
    promise: Promise<Value>
    resolve: (value: Value) => void
}

export function deferred_new<Value>(): Deferred<Value> {
    const resolvers: ((value: Value) => void)[] = []

    const promise = new Promise<Value>((resolve) => {
        resolvers.push(resolve)
    })

    const [resolve] = resolvers

    assert(resolve !== undefined)
    assert(resolvers.length === 1)

    return { promise, resolve }
}

export function editor_of(element: Element): Editor {
    assert(element.isConnected)

    const editor: unknown = Reflect.get(element, 'editor')

    assert(editor instanceof Editor, 'tiptap did not attach the editor to its view')

    return editor
}

export function group_build(patch: Partial<Group> = {}): Group {
    assert(typeof patch === 'object')
    assert(patch.person_ids === undefined || Array.isArray(patch.person_ids))

    return { id: 'group-team', name: 'Product team', person_ids: [], ...patch }
}

export function job_listing_build(patch: Partial<JobListing> = {}): JobListing {
    assert(typeof patch === 'object')
    assert(patch.id === undefined || patch.id.length > 0)

    return {
        ...job_meta_build(),
        has_transcript: false,
        has_notes: false,
        duration_seconds: null,
        ...patch,
    }
}

export function job_meta_build(patch: Partial<JobMeta> = {}): JobMeta {
    assert(typeof patch === 'object')
    assert(patch.id === undefined || patch.id.length > 0)

    return {
        id: 'job-1',
        source_path: '/home/you/recordings/weekly-sync.m4a',
        source_size_bytes: 1024,
        created_at_unix: 1_775_000_000,
        recorded_at_unix: null,
        label: null,
        title: null,
        attendees: [],
        person_ids: [],
        person_ids_mentioned: [],
        project: null,
        tags: [],
        favourite: false,
        ...patch,
    }
}

export function person_build(patch: Partial<Person> = {}): Person {
    assert(typeof patch === 'object')
    assert(patch.id === undefined || patch.id.length > 0)

    return {
        id: 'person-john',
        name_first: 'John',
        name_last: 'Doe',
        role: 'Developer',
        description: '',
        ...patch,
    }
}

export function transcript_build(lines: string[]): Transcript {
    assert(Array.isArray(lines))
    assert(lines.every((line) => typeof line === 'string'))

    const segments = lines.map((text, index) => ({
        text,
        start_seconds: index * 10,
        end_seconds: (index + 1) * 10,
    }))

    return { text: lines.join(' '), segments }
}
