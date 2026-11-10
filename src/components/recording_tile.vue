<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { use_jobs } from '../composables/use_jobs'
import { job_duration_text, job_status } from '../lib/job_status'
import { log_warn } from '../lib/log'
import RowMenu from './row_menu.vue'
import StarButton from './star_button.vue'
import type { JobListing, Waveform } from '../types'
import type { RowMenuItem } from './row_menu.vue'


const props = defineProps<{
    job: JobListing
    title: string
    when: string
    people: string | null
    snippet: string | null
    menu_items: RowMenuItem[]
}>()

const emit = defineEmits<{
    open: []
    favourite: []
    menu: [id: string]
}>()

const WAVEFORM_BAR_HEIGHT_MIN = 4
const WAVEFORM_BAR_PITCH = 3
const WAVEFORM_BAR_WIDTH = 2
const WAVEFORM_HEIGHT = 100
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
const FNV_OFFSET = 2166136261
const FNV_PRIME = 16777619
const UINT32_SPAN = 4294967296

interface GlyphWord {
    x: number
    y: number
    width: number
}

const { waveform_load } = use_jobs()
const waveform = ref<Waveform | null>(null)
const audio_missing = ref(false)

const wave_bars = computed(() =>
    (waveform.value?.peaks ?? []).map((peak, index) => ({
        x: index * WAVEFORM_BAR_PITCH,
        height: Math.max(WAVEFORM_BAR_HEIGHT_MIN, peak * WAVEFORM_HEIGHT),
    })))

const wave_view_box = computed(() => {
    const width = Math.max(1, wave_bars.value.length) * WAVEFORM_BAR_PITCH

    return `0 0 ${String(width)} ${String(WAVEFORM_HEIGHT)}`
})

const glyph_words = computed(() => glyph_words_build(hash_fnv(props.job.id)))
const duration_text = computed(() => job_duration_text(props.job))
const status = computed(() => job_status(props.job))


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

function hash_fnv(text: string): number {
    let hash = FNV_OFFSET

    for (const char of text) {
        hash ^= char.codePointAt(0) ?? 0
        hash = Math.imul(hash, FNV_PRIME) >>> 0
    }

    return hash
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
        tabindex="0"
        @click="emit('open')"
        @keydown.enter="emit('open')"
    >
        <div class="recording-tile-band">
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
            <svg
                v-else
                class="recording-tile-wave"
                :viewBox="wave_view_box"
                preserveAspectRatio="none"
                aria-hidden="true"
            >
                <rect
                    v-for="bar in wave_bars"
                    :key="bar.x"
                    :x="bar.x"
                    :y="(WAVEFORM_HEIGHT - bar.height) / 2"
                    :width="WAVEFORM_BAR_WIDTH"
                    :height="bar.height"
                    rx="1"
                />
            </svg>
            <div class="recording-tile-tools" @click.stop @keydown.enter.stop>
                <StarButton
                    :favourite="props.job.favourite"
                    :title="props.title"
                    @toggle="emit('favourite')"
                />
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
                <span>{{ props.when }}</span>
                <span class="pill recording-tile-status" :data-state="status.state">
                    {{ status.text }}
                </span>
            </div>
        </div>
    </article>
</template>
