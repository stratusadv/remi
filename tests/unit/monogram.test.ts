import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MonogramTile from '../../src/components/monogram_tile.vue'
import { hash_fnv } from '../../src/lib/hash'
import { MONOGRAM_HUE_COUNT, monogram_hue, monogram_letters } from '../../src/lib/monogram'
import { PROPERTIES } from './fixtures'


const FNV_EMPTY = 0x811c9dc5
const FNV_FOOBAR = 0xbf9cf968
const FNV_LETTER_A = 0xe40c292c

const NAMES = Object.freeze([
    'Jane Doe',
    'John Doe',
    'Sam Smith',
    'Product team',
    'Meeting notes',
    'Stand-up digest',
    'Design review',
    'Quarterly planning',
    'Support rotation',
    'Board update',
])


describe('hash_fnv', () => {
    it('matches the published FNV-1a test vectors', () => {
        expect(hash_fnv('')).toBe(FNV_EMPTY)
        expect(hash_fnv('a')).toBe(FNV_LETTER_A)
        expect(hash_fnv('foobar')).toBe(FNV_FOOBAR)
    })
})

describe('monogram_letters', () => {
    it('takes the first letter of the first two words in capitals', () => {
        expect(monogram_letters('Jane Doe')).toBe('JD')
        expect(monogram_letters('  stand-up   digest  ')).toBe('SD')
        expect(monogram_letters('Product team leads')).toBe('PT')
        expect(monogram_letters('remi')).toBe('R')
        expect(monogram_letters('   ')).toBe('')
    })

    it('keeps one character per word when a capital spans two or a letter is astral', () => {
        expect(monogram_letters('ßeta Émile')).toBe('SÉ')
        expect(monogram_letters('😀 smile')).toBe('😀S')
    })
})

describe('monogram_hue', () => {
    it('stays in range and ignores case and outer spaces', () => {
        for (const name of NAMES) {
            const hue = monogram_hue(name)

            expect(hue).toBeGreaterThanOrEqual(0)
            expect(hue).toBeLessThan(MONOGRAM_HUE_COUNT)
            expect(monogram_hue(`  ${name.toUpperCase()}  `)).toBe(hue)
        }
    })

    it('spreads names across more than one hue', () => {
        const hues = new Set(NAMES.map(monogram_hue))

        expect(hues.size).toBeGreaterThan(1)
    })
})

describe('MonogramTile', () => {
    it('carries the letters for its hidden tile without adding text to the row', () => {
        const wrapper = mount(MonogramTile, { [PROPERTIES]: { text: 'Jane Doe' } })
        const tile = wrapper.get('.monogram')

        expect(tile.text()).toBe('')
        expect(tile.attributes('data-letters')).toBe('JD')
        expect(tile.attributes('aria-hidden')).toBe('true')
        expect(tile.attributes('data-hue')).toBe(String(monogram_hue('Jane Doe')))
    })
})
