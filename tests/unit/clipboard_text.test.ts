import { describe, expect, it } from 'vitest'
import { assert } from '../../src/lib/assert'
import { clipboard_plain_text } from '../../src/lib/clipboard_text'
import type { ClipboardFragment, ClipboardNode } from '../../src/lib/clipboard_text'


const IS_TEXT = 'isText'
const KEY_ATTRIBUTES = 'attrs'
const TEXT_CONTENT = 'textContent'


type Attributes = Record<string, unknown>

function bullet_list(...items: ClipboardNode[]): ClipboardNode {
    assert(Array.isArray(items))
    assert(items.every((item) => item.type.name === 'listItem'))

    return node('bulletList', items)
}

function code_block(value: string): ClipboardNode {
    assert(typeof value === 'string')
    assert(value.length >= 0)

    return node('codeBlock', [text(value)])
}

function fragment(...blocks: ClipboardNode[]): ClipboardFragment {
    assert(Array.isArray(blocks))
    assert(blocks.every((block) => block.type.name.length > 0))

    return blocks
}

function hard_break(): ClipboardNode {
    const breaking = node('hardBreak')

    assert(!breaking.isText)
    assert(breaking.textContent.length === 0)

    return breaking
}

function heading(value: string, level: number): ClipboardNode {
    assert(typeof value === 'string')
    assert(level > 0)

    return node('heading', [text(value)], { level })
}

function list_item(...blocks: ClipboardNode[]): ClipboardNode {
    assert(Array.isArray(blocks))
    assert(blocks.every((block) => block.type.name.length > 0))

    return node('listItem', blocks)
}

function node(
    type: string,
    children: ClipboardNode[] = [],
    attributes: Attributes = {},
): ClipboardNode {
    assert(type.length > 0)
    assert(Array.isArray(children))
    assert(typeof attributes === 'object')

    return {
        [KEY_ATTRIBUTES]: attributes,
        content: children,
        [IS_TEXT]: false,
        text: undefined,
        [TEXT_CONTENT]: children.map((child) => child.textContent).join(''),
        type: { name: type },
    }
}

function ordered_list(items: ClipboardNode[], attributes: Attributes = {}): ClipboardNode {
    assert(Array.isArray(items))
    assert(typeof attributes === 'object')

    return node('orderedList', items, attributes)
}

function paragraph(...inline: (string | ClipboardNode)[]): ClipboardNode {
    assert(Array.isArray(inline))
    assert(inline.length >= 0)

    return node('paragraph', inline.map((part) => (typeof part === 'string' ? text(part) : part)))
}

function table_cell(...blocks: ClipboardNode[]): ClipboardNode {
    assert(Array.isArray(blocks))
    assert(blocks.length > 0)

    return node('tableCell', blocks)
}

function table_row(...cells: ClipboardNode[]): ClipboardNode {
    assert(Array.isArray(cells))
    assert(cells.length > 0)

    return node('tableRow', cells)
}

function task_item(checked: boolean, ...blocks: ClipboardNode[]): ClipboardNode {
    assert(typeof checked === 'boolean')
    assert(Array.isArray(blocks))

    return node('taskItem', blocks, { checked })
}

function text(value: string): ClipboardNode {
    assert(typeof value === 'string')
    assert(value.length >= 0)

    return {
        [KEY_ATTRIBUTES]: {},
        content: [],
        [IS_TEXT]: true,
        text: value,
        [TEXT_CONTENT]: value,
        type: { name: 'text' },
    }
}

describe('clipboard_plain_text', () => {
    it('joins paragraphs with a blank line', () => {
        const result = clipboard_plain_text(fragment(paragraph('First'), paragraph('Second')))

        expect(result).toBe('First\n\nSecond')
    })

    it('returns an empty string for an empty fragment', () => {
        expect(clipboard_plain_text(fragment())).toBe('')
    })

    it('drops blocks that produce no lines', () => {
        const result = clipboard_plain_text(
            fragment(paragraph('One'), node('horizontalRule'), paragraph('Two')),
        )

        expect(result).toBe('One\n\nTwo')
    })

    it('turns a hard break into a newline within a paragraph', () => {
        const block = paragraph('line one', hard_break(), 'line two')
        const result = clipboard_plain_text(fragment(block))

        expect(result).toBe('line one\nline two')
    })

    it('keeps heading text without any markdown marker', () => {
        expect(clipboard_plain_text(fragment(heading('Summary', 2)))).toBe('Summary')
    })

    it('keeps code block lines verbatim', () => {
        const result = clipboard_plain_text(fragment(code_block('let x = 1\nlet y = 2')))

        expect(result).toBe('let x = 1\nlet y = 2')
    })

    it('uses the text content of an unknown inline-bearing node', () => {
        const mention = node('mention', [text('@sam')])

        expect(clipboard_plain_text(fragment(paragraph('Ask ', mention)))).toBe('Ask @sam')
    })

    it('skips an unknown node with no text', () => {
        expect(clipboard_plain_text(fragment(node('image')))).toBe('')
    })

    it('prefixes bullet items with a dash', () => {
        const result = clipboard_plain_text(fragment(bullet_list(
            list_item(paragraph('apples')),
            list_item(paragraph('pears')),
        )))

        expect(result).toBe('- apples\n- pears')
    })

    it('numbers ordered items from one by default', () => {
        const result = clipboard_plain_text(fragment(ordered_list([
            list_item(paragraph('first')),
            list_item(paragraph('second')),
        ])))

        expect(result).toBe('1. first\n2. second')
    })
})

describe('clipboard_plain_text', () => {
    it('honours the start attribute of an ordered list', () => {
        const result = clipboard_plain_text(fragment(ordered_list(
            [list_item(paragraph('nine')), list_item(paragraph('ten'))],
            { start: 9 },
        )))

        expect(result).toBe('9. nine\n10. ten')
    })

    it('indents a nested list by two spaces per level', () => {
        const result = clipboard_plain_text(fragment(bullet_list(
            list_item(
                paragraph('fruit'),
                ordered_list([
                    list_item(
                        paragraph('apples'),
                        bullet_list(list_item(paragraph('granny smith'))),
                    ),
                    list_item(paragraph('pears')),
                ]),
            ),
            list_item(paragraph('bread')),
        )))

        expect(result).toBe([
            '- fruit',
            '  1. apples',
            '    - granny smith',
            '  2. pears',
            '- bread',
        ].join('\n'))
    })

    it('aligns continuation lines under the item text', () => {
        const result = clipboard_plain_text(fragment(bullet_list(
            list_item(paragraph('first', hard_break(), 'wrapped'), paragraph('second paragraph')),
        )))

        expect(result).toBe('- first\n  wrapped\n  second paragraph')
    })

    it('marks task items with their checked state', () => {
        const tasks = [
            task_item(true, paragraph('done')),
            task_item(false, paragraph('open')),
        ]

        const result = clipboard_plain_text(fragment(node('taskList', tasks)))

        expect(result).toBe('[x] done\n[ ] open')
    })

    it('flattens a blockquote into its paragraphs', () => {
        const result = clipboard_plain_text(fragment(
            node('blockquote', [paragraph('quoted'), paragraph('again')]),
        ))

        expect(result).toBe('quoted\nagain')
    })
})

describe('clipboard_plain_text', () => {
    it('renders table rows as tab separated cells', () => {
        const header = table_row(table_cell(paragraph('Who')), table_cell(paragraph('What')))
        const cell_last = table_cell(paragraph('copy', hard_break(), 'draft'))
        const row = table_row(table_cell(paragraph('Sam')), cell_last)
        const table = node('table', [header, row])

        expect(clipboard_plain_text(fragment(table))).toBe('Who\tWhat\nSam\tcopy draft')
    })

    it('stops visiting nodes once the node budget is spent', () => {
        const items: ClipboardNode[] = []

        for (let index = 0; index < 60_000; index += 1) {
            items.push(list_item(paragraph('x')))
        }

        const lines = clipboard_plain_text(fragment(bullet_list(...items))).split('\n')

        expect(lines.length).toBe(49_999)
        expect(lines[0]).toBe('- x')
        expect(lines[49_998]).toBe('- x')
    })
})
