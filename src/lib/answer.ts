import { assert } from './assert'
import { citations_split } from './citations'
import { seconds_to_clock_hours } from './duration'
import { job_title } from './job_status'
import type { AskSource, JobMeta } from '../types'


export type AnswerBlock =
    | { kind: 'list', ordered: boolean, items: string[] }
    | { kind: 'paragraph', text: string }

export interface AnswerPart {
    cited: SourceCited | null
    text: string
}

export interface SourceCited {
    meeting: JobMeta
    number: number
    source: AskSource
}

const ANSWER_LINES_MAX = 400
const CITATION_TAIL_PATTERN = /\[(?:M\d*(?:,\s*(?:M\d*)?)*)?$/
const LIST_ITEM_PATTERN = /^\s*(?:([-*\u2022])|(\d{1,3})[.)])\s+(.*)$/
const LIST_TAIL_PATTERN = /\n[ \t]*(?:[-*\u2022]|\d{1,3}[.)]?)?[ \t]*$/
const MARKER_PATTERN = /M\d+/g
const MILLISECONDS_PER_SECOND = 1000
const SPACE_TAIL_PATTERN = /[ \t]+$/


export function answer_blocks(answer: string): AnswerBlock[] {
    assert(typeof answer === 'string')

    const lines = answer.split('\n')
    const blocks: AnswerBlock[] = []
    const paragraph: string[] = []

    for (const line of lines.slice(0, ANSWER_LINES_MAX)) {
        const item = LIST_ITEM_PATTERN.exec(line)

        if (item !== null) {
            paragraph_flush(blocks, paragraph)
            list_push(blocks, item[1] === undefined, item[3] ?? '')
        } else if (line.trim().length === 0) {
            paragraph_flush(blocks, paragraph)
        } else {
            paragraph.push(line.trim())
        }
    }

    const rest = lines.slice(ANSWER_LINES_MAX).join('\n').trim()

    if (rest.length > 0) paragraph.push(rest)

    paragraph_flush(blocks, paragraph)

    assert(blocks.length <= Math.min(lines.length, ANSWER_LINES_MAX) + 1)

    return blocks
}

export function answer_parts(text: string, cited: readonly SourceCited[]): AnswerPart[] {
    assert(typeof text === 'string')
    assert(cited.every((entry) => entry.number > 0))

    const numbered = new Map(cited.map((entry) => [entry.source.marker, entry]))
    const markers = [...new Set(text.match(MARKER_PATTERN))]
    const parts: AnswerPart[] = []
    let hidden = false

    for (const part of citations_split(text, markers)) {
        if (part.marker === null) {
            if (hidden) space_trim(parts)

            parts.push({ cited: null, text: part.text })
            hidden = false
            continue
        }

        const entry = numbered.get(part.marker)

        if (entry === undefined) {
            hidden = hidden || parts.at(-1)?.cited === null
            continue
        }

        parts.push({ cited: entry, text: '' })
        hidden = false
    }

    if (hidden) space_trim(parts)

    assert(parts.length <= text.length)

    return parts
}

export function answer_plain(answer: string, cited: readonly SourceCited[]): string {
    assert(typeof answer === 'string')
    assert(cited.every((entry, index) => entry.number === index + 1))

    const text = answer_parts(answer, cited)
        .map((part) => part.cited === null ? part.text : `[${String(part.cited.number)}]`)
        .join('')
        .trim()

    if (cited.length === 0) return text

    const lines = cited.map((entry) => {
        const where = `${source_date(entry.meeting)}, ${source_where(entry.source)}`

        return `[${String(entry.number)}] ${job_title(entry.meeting)}, ${where}`
    })

    return `${text}\n\nSources:\n${lines.join('\n')}`
}

export function answer_settled(answer: string, streaming: boolean): string {
    assert(typeof answer === 'string')

    if (!streaming) return answer

    const settled = answer.replace(CITATION_TAIL_PATTERN, '').replace(LIST_TAIL_PATTERN, '')

    assert(answer.startsWith(settled))

    return settled
}

export function source_date(meeting: JobMeta): string {
    assert(meeting.id.length > 0)

    const unix = meeting.recorded_at_unix ?? meeting.created_at_unix

    assert(Number.isFinite(unix))

    return new Date(unix * MILLISECONDS_PER_SECOND).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
    })
}

export function source_where(source: AskSource): string {
    assert(source.marker.length > 0)
    assert(source.job_id.length > 0)

    if (source.source === 'notes') return source.heading ?? 'Notes'
    if (source.start_seconds === null) return 'Transcript'

    return seconds_to_clock_hours(source.start_seconds)
}

export function sources_cited(
    answer: string,
    sources: readonly AskSource[],
    meetings: readonly JobMeta[],
): SourceCited[] {
    assert(typeof answer === 'string')
    assert(meetings.length <= sources.length)

    const numbers = new Map<string, number>()

    for (const part of citations_split(answer, sources.map((source) => source.marker))) {
        if (part.marker === null) continue
        if (numbers.has(part.marker)) continue

        const source = sources.find((candidate) => candidate.marker === part.marker)
        const known = meetings.some((meeting) => meeting.id === source?.job_id)

        if (known) numbers.set(part.marker, numbers.size + 1)
    }

    const cited = sources.flatMap((source) => {
        const number = numbers.get(source.marker)
        const meeting = meetings.find((candidate) => candidate.id === source.job_id)

        if (number === undefined) return []
        if (meeting === undefined) return []

        return [{ meeting, number, source }]
    })

    assert(cited.length === numbers.size)

    return cited.sort((left, right) => left.number - right.number)
}

function list_push(blocks: AnswerBlock[], ordered: boolean, item: string): void {
    assert(blocks.length < ANSWER_LINES_MAX)
    assert(typeof item === 'string')

    const last = blocks.at(-1)
    const list = last?.kind === 'list' ? last : null

    if (list?.ordered === ordered) {
        list.items.push(item)

        return
    }

    blocks.push({ kind: 'list', ordered, items: [item] })
}

function paragraph_flush(blocks: AnswerBlock[], paragraph: string[]): void {
    assert(blocks.length <= ANSWER_LINES_MAX)
    assert(paragraph.every((line) => line.length > 0))

    if (paragraph.length === 0) return

    blocks.push({ kind: 'paragraph', text: paragraph.splice(0).join('\n') })
}

function space_trim(parts: AnswerPart[]): void {
    assert(parts.length > 0)

    const last = parts.at(-1)

    assert(last?.cited === null)

    last.text = last.text.replace(SPACE_TAIL_PATTERN, '')
}
