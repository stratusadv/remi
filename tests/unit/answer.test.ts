import { describe, expect, it } from 'vitest'
import {
    answer_blocks,
    answer_parts,
    answer_plain,
    answer_settled,
    source_date,
    source_where,
    sources_cited,
} from '../../src/lib/answer'
import { assert } from '../../src/lib/assert'
import { ask_source_build, job_meta_build } from './fixtures'
import type { AnswerBlock, AnswerPart, SourceCited } from '../../src/lib/answer'


const CITATION_GROUP_PATTERN = /\[M\d+(?:,\s*M\d+){0,7}\]/g
const FRAGMENTS_PER_ANSWER = 12
const SEEDS_MAX = 300

const LINES_GENERATED = Object.freeze([
    '',
    'Sam drafts the banner copy.',
    'The release moves to Friday.',
    '- Ship the retry work',
    '- Review the banner',
    '* Check the rollout numbers',
    '1. Draft the copy',
    '2) Send it for review',
])

const SENTENCES_CITED = Object.freeze([
    'Sam drafts it ',
    '[M1]',
    '[M2]',
    '[M9]',
    '[M1, M9]',
    '[M9, M2]',
    '. ',
    '\n',
    'Due Friday',
])

const MEETING_WEEKLY = job_meta_build({ id: 'job-1', title: 'Weekly sync' })
const MEETING_RETRO = job_meta_build({ id: 'job-2', title: 'Retro' })
const SOURCE_NOTES = ask_source_build({ job_id: 'job-1', marker: 'M1' })

const SOURCE_MOMENT = ask_source_build({
    job_id: 'job-2',
    marker: 'M2',
    heading: null,
    source: 'transcript',
    start_seconds: 126,
    end_seconds: 131,
})


function block_contents(blocks: readonly AnswerBlock[]): string[] {
    assert(blocks.every((block) => block.kind === 'paragraph' || block.items.length > 0))

    return blocks.flatMap(
        (block) => block.kind === 'paragraph' ? block.text.split('\n') : block.items,
    )
}

function generated(seed: number, fragments: readonly string[]): string[] {
    assert(seed > 0)
    assert(seed <= SEEDS_MAX)
    assert(fragments.length > 0)

    const picked: string[] = []
    let state = seed

    for (let index = 0; index < FRAGMENTS_PER_ANSWER; index += 1) {
        state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
        picked.push(fragments[state % fragments.length] ?? '')
    }

    assert(picked.length === FRAGMENTS_PER_ANSWER)

    return picked
}

function marked(parts: readonly AnswerPart[]): string {
    assert(parts.every((part) => part.cited === null || part.cited.number > 0))

    return parts
        .map((part) => part.cited === null ? part.text : `<${String(part.cited.number)}>`)
        .join('')
}

function numbered(entries: [string, number][]): SourceCited[] {
    assert(entries.length > 0)

    const sources = [SOURCE_NOTES, SOURCE_MOMENT, ask_source_build({ marker: 'M5' })]

    return entries.map(([marker, number]) => {
        const source = sources.find((candidate) => candidate.marker === marker)

        assert(source !== undefined)

        const meeting = source.job_id === MEETING_RETRO.id ? MEETING_RETRO : MEETING_WEEKLY

        return { meeting, number, source }
    })
}

describe('answer_blocks', () => {
    it('splits paragraphs and lists, and keeps a run of items in one list', () => {
        const answer = [
            'Three things came up:',
            '',
            '- Ship it',
            '- Review it',
            '',
            '1. Draft',
            '2) Send',
            'That is all.',
        ].join('\n')

        expect(answer_blocks(answer)).toEqual([
            { kind: 'paragraph', text: 'Three things came up:' },
            { kind: 'list', ordered: false, items: ['Ship it', 'Review it'] },
            { kind: 'list', ordered: true, items: ['Draft', 'Send'] },
            { kind: 'paragraph', text: 'That is all.' },
        ])
    })

    it('keeps adjacent lines in one paragraph and starts a new list when the kind changes', () => {
        expect(answer_blocks('First line\nSecond line')).toEqual([
            { kind: 'paragraph', text: 'First line\nSecond line' },
        ])

        const blocks = answer_blocks('- one\n1. two')

        expect(blocks.map((block) => block.kind === 'list' && block.ordered)).toEqual([false, true])
    })

    it('returns no blocks for an empty answer', () => {
        expect(answer_blocks('')).toEqual([])
        expect(answer_blocks('\n\n')).toEqual([])
    })

    it('keeps every written line, in order, without its list marker', () => {
        for (let seed = 1; seed <= SEEDS_MAX; seed += 1) {
            const lines = generated(seed, LINES_GENERATED)

            const expected = lines
                .filter((line) => line.length > 0)
                .map((line) => line.replace(/^(?:[-*]|\d+[.)]) /, ''))

            expect(block_contents(answer_blocks(lines.join('\n')))).toEqual(expected)
        }
    })
})

describe('answer_settled', () => {
    it('leaves a finished answer untouched', () => {
        expect(answer_settled('Shipped [M', false)).toBe('Shipped [M')
        expect(answer_settled('Steps:\n- ', false)).toBe('Steps:\n- ')
    })

    it('holds back a citation that is still arriving', () => {
        expect(answer_settled('Shipped [', true)).toBe('Shipped ')
        expect(answer_settled('Shipped [M1, M', true)).toBe('Shipped ')
        expect(answer_settled('Shipped [M1]', true)).toBe('Shipped [M1]')
        expect(answer_settled('An array[0', true)).toBe('An array[0')
    })

    it('holds back a list item that has no words yet', () => {
        expect(answer_settled('Three things:\n- ', true)).toBe('Three things:')
        expect(answer_settled('Steps:\n2', true)).toBe('Steps:')
        expect(answer_settled('Steps:\n2.', true)).toBe('Steps:')
        expect(answer_settled('Steps:\n2. Send', true)).toBe('Steps:\n2. Send')
    })

    it('shows a prefix of each streamed answer with no half-written citation', () => {
        const answer = [
            'The team ships it [M1].',
            '- Sam drafts the copy [M1, M2].',
            '- Due Friday [M2].',
        ].join('\n')

        for (let length = 0; length <= answer.length; length += 1) {
            const streamed = answer.slice(0, length)
            const settled = answer_settled(streamed, true)

            expect(streamed.startsWith(settled)).toBe(true)
            expect(settled.split('[').length).toBe(settled.split(']').length)
            expect(settled.endsWith('\n')).toBe(false)
            expect(settled.endsWith('\n-')).toBe(false)
        }
    })
})

describe('answer_parts', () => {
    it('turns known markers into numbered sources and hides invented ones', () => {
        const cited = numbered([['M2', 1]])

        expect(marked(answer_parts('Sam drafts it [M2]. Nobody knows [M9].', cited)))
            .toBe('Sam drafts it <1>. Nobody knows.')
    })

    it('keeps the space before a group that still shows a source', () => {
        const cited = numbered([['M2', 1]])

        expect(marked(answer_parts('Due Friday [M9, M2].', cited))).toBe('Due Friday <1>.')
        expect(marked(answer_parts('Due Friday [M2, M9].', cited))).toBe('Due Friday <1>.')
    })

    it('keeps the line break before a hidden marker', () => {
        expect(marked(answer_parts('First.\n[M9] Second.', []))).toBe('First.\n Second.')
    })

    it('shows one source per known marker and no marker text', () => {
        const cited = numbered([['M1', 1], ['M2', 2]])

        for (let seed = 1; seed <= SEEDS_MAX; seed += 1) {
            const answer = generated(seed, SENTENCES_CITED).join('')
            const parts = answer_parts(answer, cited)
            const groups = answer.match(CITATION_GROUP_PATTERN) ?? []
            const known = groups.flatMap((group) => group.match(/M[12]\b/g) ?? [])

            expect(parts.filter((part) => part.cited !== null)).toHaveLength(known.length)
            expect(parts.some((part) => /M\d/.test(part.text))).toBe(false)
        }
    })
})

describe('answer_plain', () => {
    it('numbers each citation and lists the sources after the answer', () => {
        const cited = numbered([['M2', 1], ['M1', 2]])
        const answer = 'Sam drafts it [M2]. It ships Friday [M2, M1]. Not this [M9].'

        expect(answer_plain(answer, cited)).toBe([
            'Sam drafts it [1]. It ships Friday [1][2]. Not this.',
            '',
            'Sources:',
            `[1] Retro, ${source_date(MEETING_RETRO)}, 2:06`,
            `[2] Weekly sync, ${source_date(MEETING_WEEKLY)}, Decisions`,
        ].join('\n'))
    })

    it('returns the bare answer when nothing is cited', () => {
        expect(answer_plain('  Nothing found.  ', [])).toBe('Nothing found.')
    })
})

describe('source_date', () => {
    it('prefers the recording time over the import time', () => {
        const imported = job_meta_build({ created_at_unix: 1_775_000_000, recorded_at_unix: null })
        const recorded = { ...imported, recorded_at_unix: 1_700_000_000 }
        const day = new Date(1_700_000_000_000).getDate()

        expect(source_date(recorded)).toContain(String(day))
        expect(source_date(recorded)).not.toBe(source_date(imported))
    })
})

describe('source_where', () => {
    it('names a notes section by its heading', () => {
        expect(source_where(SOURCE_NOTES)).toBe('Decisions')
        expect(source_where(ask_source_build({ heading: null }))).toBe('Notes')
    })

    it('names a transcript passage by its moment', () => {
        expect(source_where(SOURCE_MOMENT)).toBe('2:06')
        expect(source_where({ ...SOURCE_MOMENT, start_seconds: null })).toBe('Transcript')
    })
})

describe('sources_cited', () => {
    it('numbers sources by first citation and skips a meeting it does not know', () => {
        const unknown = ask_source_build({ job_id: 'job-gone', marker: 'M3' })
        const answer = 'Gone [M3]. Retro [M2]. Both [M1, M2].'
        const sources = [SOURCE_NOTES, SOURCE_MOMENT, unknown]
        const cited = sources_cited(answer, sources, [MEETING_WEEKLY, MEETING_RETRO])

        expect(cited.map((entry) => entry.source.marker)).toEqual(['M2', 'M1'])
        expect(cited.map((entry) => entry.number)).toEqual([1, 2])
        expect(cited.map((entry) => entry.meeting.id)).toEqual(['job-2', 'job-1'])
    })

    it('leaves out sources the answer never cites', () => {
        expect(sources_cited('No citations here.', [SOURCE_NOTES], [MEETING_WEEKLY])).toEqual([])
    })
})
