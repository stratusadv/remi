import { assert } from './assert'


export interface CitationPart {
    text: string
    marker: string | null
}

const CITATION_GROUP_MAX = 8
const CITATION_PARTS_MAX = 2000
const MARKER_PATTERN = /M\d+/g

const CITATION_PATTERN = new RegExp(
    String.raw`\[M\d+(?:,\s*M\d+){0,${String(CITATION_GROUP_MAX - 1)}}\]`,
    'g',
)


export function citations_split(answer: string, markers: readonly string[]): CitationPart[] {
    assert(typeof answer === 'string')
    assert(markers.every((marker) => /^M\d+$/.test(marker)))

    const parts: CitationPart[] = []
    let cursor = 0

    for (const match of answer.matchAll(CITATION_PATTERN)) {
        if (parts.length >= CITATION_PARTS_MAX) break

        const before = answer.slice(cursor, match.index)

        if (before.length > 0) parts.push({ text: before, marker: null })

        parts.push(...group_split(match[0], markers))
        cursor = match.index + match[0].length
    }

    if (cursor < answer.length) parts.push({ text: answer.slice(cursor), marker: null })

    assert(parts.map((part) => part.text).join('') === answer)
    assert(parts.length <= CITATION_PARTS_MAX + CITATION_GROUP_MAX + 1)

    return parts
}

function group_split(group: string, markers: readonly string[]): CitationPart[] {
    assert(group.startsWith('[M'))
    assert(group.endsWith(']'))
    assert(markers.every((marker) => marker.startsWith('M')))

    const found = [...group.matchAll(MARKER_PATTERN)]

    const parts = found.map((match, position) => {
        const start = position === 0 ? 0 : match.index
        const end = found[position + 1]?.index ?? group.length

        return {
            text: group.slice(start, end),
            marker: markers.includes(match[0]) ? match[0] : null,
        }
    })

    assert(parts.length >= 1)
    assert(parts.length <= CITATION_GROUP_MAX)

    return parts
}
