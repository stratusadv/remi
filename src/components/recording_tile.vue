<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { use_jobs } from '../composables/use_jobs'
import { assert } from '../lib/assert'
import { hash_fnv } from '../lib/hash'
import { job_askable, job_duration_text, job_status } from '../lib/job_status'
import { log_warn } from '../lib/log'
import AskButton from './ask_button.vue'
import RowMenu from './row_menu.vue'
import StarButton from './star_button.vue'
import type { MenuItem } from '../lib/menu'
import type { JobListing, Waveform } from '../types'


const props = defineProps<{
    job: JobListing
    title: string
    when: string
    people: string | null
    snippet: string | null
    menu_items: MenuItem[]
}>()

const emit = defineEmits<{
    open: []
    favourite: []
    ask: []
    menu: [id: string]
    contextmenu: [event: MouseEvent]
    pointerdown: [event: PointerEvent]
}>()

const ART_HUE_COUNT = 4
const ART_LAYOUT_COUNT = 3
const WAVEFORM_BARS_SHOWN = 36
const WAVEFORM_HEIGHT = 100
const WAVEFORM_LEVEL_MIN = 0.08
const GLYPH_WIDTH = 100
const GLYPH_LINE_COUNT = 5
const GLYPH_LINE_HEIGHT = 8
const GLYPH_LINE_PITCH = 18
const GLYPH_LINE_TOP = 6
const GLYPH_LINE_LAST_FILL_MIN = 0.3
const GLYPH_LINE_LAST_FILL_SPAN = 0.4
const GLYPH_WORD_GAP = 3
const GLYPH_WORD_WIDTH_MIN = 6
const GLYPH_WORD_WIDTH_MAX = 22
const UINT32_SPAN = 4294967296

interface GlyphWord {
    x: number
    y: number
    width: number
}

interface WaveBar {
    index: number
    level: number
}

const { waveform_load } = use_jobs()
const waveform = ref<Waveform | null>(null)
const audio_missing = ref(false)

const art_seed = computed(() => hash_fnv(props.job.id))
const art_hue = computed(() => art_seed.value % ART_HUE_COUNT)
const art_layout = computed(() => Math.floor(art_seed.value / ART_HUE_COUNT) % ART_LAYOUT_COUNT)
const wave_bars = computed(() => wave_bars_build(waveform.value?.peaks ?? []))
const glyph_words = computed(() => glyph_words_build(hash_fnv(props.job.id)))
const duration_text = computed(() => job_duration_text(props.job))
const status = computed(() => job_status(props.job))
const askable = computed(() => job_askable(props.job))


function glyph_words_build(seed: number): GlyphWord[] {
    const random = random_from(seed)
    const words: GlyphWord[] = []

    for (let line = 0; line < GLYPH_LINE_COUNT; line += 1) {
        const last = line === GLYPH_LINE_COUNT - 1
        const top = GLYPH_LINE_TOP + line * GLYPH_LINE_PITCH
        const fill = last ? GLYPH_LINE_LAST_FILL_MIN + random() * GLYPH_LINE_LAST_FILL_SPAN : 1
        const width_line = GLYPH_WIDTH * fill
        let left = 0

        while (left < width_line) {
            const width_span = GLYPH_WORD_WIDTH_MAX - GLYPH_WORD_WIDTH_MIN
            const width = Math.min(GLYPH_WORD_WIDTH_MIN + random() * width_span, width_line - left)

            if (width < GLYPH_WORD_WIDTH_MIN / 2) break

            words.push({ x: left, y: top, width })

            left += width + GLYPH_WORD_GAP
        }
    }

    return words
}

function random_from(seed: number): () => number {
    let state = seed === 0 ? 1 : seed

    return function random(): number {
        state ^= state << 13
        state >>>= 0
        state ^= state >>> 17
        state ^= state << 5
        state >>>= 0

        return state / UINT32_SPAN
    }
}

function wave_bars_build(peaks: readonly number[]): WaveBar[] {
    assert(peaks.every((peak) => Number.isFinite(peak)))

    const count = Math.min(WAVEFORM_BARS_SHOWN, peaks.length)
    const stretch = peaks.length / Math.max(1, count)
    const bars: WaveBar[] = []

    for (let index = 0; index < count; index += 1) {
        const start = Math.floor(index * stretch)
        const end = Math.max(start + 1, Math.floor((index + 1) * stretch))
        const loudest = Math.max(...peaks.slice(start, end))
        const level = Math.min(1, Math.max(WAVEFORM_LEVEL_MIN, loudest))

        bars.push({ index, level: Number(level.toFixed(3)) })
    }

    assert(bars.length === count)

    return bars
}

onMounted(async () => {
    try {
        waveform.value = await waveform_load(props.job.id)
        audio_missing.value = waveform.value === null
    } catch (error) {
        log_warn('[recordings] waveform unavailable', props.job.id, error)
    }
})
</script>

<template>
    <article
        class="recording-tile card"
        :data-hue="art_hue"
        :data-layout="art_layout"
        tabindex="0"
        @click="emit('open')"
        @contextmenu="emit('contextmenu', $event)"
        @keydown.enter="emit('open')"
        @pointerdown="emit('pointerdown', $event)"
    >
        <div class="recording-tile-band">
            <div class="recording-tile-art" aria-hidden="true">
                <i />
                <i />
            </div>
            <svg
                v-if="audio_missing"
                class="recording-tile-wave recording-tile-glyph"
                :viewBox="`0 0 ${GLYPH_WIDTH} ${WAVEFORM_HEIGHT}`"
                preserveAspectRatio="none"
                aria-hidden="true"
            >
                <rect
                    v-for="word in glyph_words"
                    :key="`${word.x}-${word.y}`"
                    :x="word.x"
                    :y="word.y"
                    :width="word.width"
                    :height="GLYPH_LINE_HEIGHT"
                    rx="2"
                />
            </svg>
            <div v-else class="recording-tile-bars" aria-hidden="true">
                <i
                    v-for="bar in wave_bars"
                    :key="bar.index"
                    :style="{ '--level': bar.level }"
                />
            </div>
            <div class="recording-tile-tools" @click.stop @keydown.enter.stop>
                <span class="recording-tile-tools-start">
                    <StarButton
                        :favourite="props.job.favourite"
                        :title="props.title"
                        @toggle="emit('favourite')"
                    />
                    <AskButton v-if="askable" :title="props.title" @ask="emit('ask')" />
                </span>
                <span class="recording-tile-menu">
                    <RowMenu
                        :label="props.title"
                        :items="props.menu_items"
                        @select="emit('menu', $event)"
                    />
                </span>
            </div>
            <span v-if="duration_text" class="recording-tile-duration">{{ duration_text }}</span>
        </div>

        <div class="recording-tile-body">
            <h3 class="recording-tile-title">{{ props.title }}</h3>
            <div class="recording-tile-people meta">
                {{ props.snippet ?? props.people ?? 'No participants' }}
            </div>
            <div class="recording-tile-foot meta">
                <span class="recording-tile-when">{{ props.when }}</span>
                <span class="pill recording-tile-status" :data-state="status.state">
                    {{ status.text }}
                </span>
            </div>
        </div>
    </article>
</template>
