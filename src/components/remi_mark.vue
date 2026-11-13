<script setup lang="ts">
import { computed, useId } from 'vue'


const props = defineProps<{
    lockup?: boolean
    small?: boolean
}>()

const MARK_VIEW_BOX = '8.5 10.1 69.8 84.1'
const MARK_VIEW_BOX_SMALL = '8.5 10.1 74.3 92.6'
const LOCKUP_VIEW_BOX = '0 0 344.45 104.22'
const LOCKUP_VIEW_BOX_SMALL = '0 0 349.00 112.75'
const WORD_TRANSFORM = 'translate(116.24 90.17)'
const WORD_TRANSFORM_SMALL = 'translate(120.79 94.15)'
const PIP = 'M209.81 -84.97L217.44 -72.76L209.81 -60.55L202.18 -72.76Z'

const BARS = [
    'M14.03 20.59L25.15 20.59L20.19 40.47L9.07 40.47Z',
    'M33.41 10.65L44.53 10.65L34.61 50.41L23.49 50.41Z',
    'M48.82 16.61L59.94 16.61L53.00 44.44L41.88 44.44Z',
    'M64.22 22.58L75.34 22.58L71.38 38.48L60.26 38.48Z',
].join('')

const LINES = [
    'M10.65 70.29L13.62 58.36L74.27 58.36L71.30 70.29Z',
    'M10.65 90.17L13.62 78.24L50.41 78.24L47.44 90.17Z',
].join('')

const LINES_SMALL = [
    'M10.65 70.29L13.62 58.36L74.27 58.36L71.30 70.29Z',
    'M10.65 94.15L13.62 82.22L50.41 82.22L47.44 94.15Z',
].join('')

const PLATES = [
    'M14.05 73.69L17.02 61.76L77.67 61.76L74.70 73.69Z',
    'M14.05 93.57L17.02 81.64L53.81 81.64L50.84 93.57Z',
].join('')

const PLATES_SMALL = [
    'M18.60 78.24L21.57 66.31L82.22 66.31L79.25 78.24Z',
    'M18.60 102.10L21.57 90.17L58.36 90.17L55.39 102.10Z',
].join('')

const LETTERS = [
    'M42.01 -54.31Q44.76 -54.31 46.36 -52.64Q47.95 -50.97 47.95 -48.20',
    'Q47.95 -44.74 45.71 -42.36Q43.48 -39.99 40.22 -39.99Q38.29 -39.99 36.81 -40.35',
    'Q35.32 -40.71 33.86 -41.07Q32.40 -41.43 30.50 -41.43Q28.97 -41.43 27.70 -41.03',
    'Q26.43 -40.63 25.29 -39.85Q24.15 -39.07 22.94 -37.87L22.92 -40.26',
    'Q27.18 -45.00 30.09 -47.80Q33.00 -50.61 35.05 -52.01Q37.10 -53.41 38.72 -53.86',
    'Q40.34 -54.31 42.01 -54.31ZM24.42 -44.16V-3.23L31.50 -1.55V0.00H2.61V-1.55L8.66 -3.23',
    'V-41.64Q7.98 -42.27 7.18 -42.97Q6.37 -43.67 5.14 -44.76Q3.90 -45.85 1.98 -47.66V-48.96',
    'L23.65 -54.84H24.42V-44.16ZM75.64 -54.53Q81.93 -54.53 86.40 -52.04',
    'Q90.87 -49.54 93.42 -44.80Q95.97 -40.05 96.46 -33.28H61.45V-37.11H89.18L82.10 -34.66',
    'Q81.73 -40.84 80.74 -44.45Q79.76 -48.06 78.09 -49.64Q76.42 -51.23 73.93 -51.23',
    'Q70.79 -51.23 68.57 -49.34Q66.34 -47.46 65.18 -43.31Q64.02 -39.15 64.02 -32.33',
    'Q64.02 -24.11 66.03 -19.05Q68.03 -14.00 71.94 -11.68Q75.84 -9.37 81.54 -9.37',
    'Q84.37 -9.37 86.91 -10.05Q89.45 -10.74 91.80 -12.22Q94.16 -13.71 96.32 -16.12',
    'L97.46 -15.18Q93.92 -9.04 90.37 -5.43Q86.81 -1.83 82.91 -0.27Q79.01 1.28 74.33 1.28',
    'Q66.87 1.28 61.13 -1.86Q55.39 -5.00 52.16 -11.01Q48.93 -17.03 48.93 -25.59',
    'Q48.93 -33.36 52.00 -39.95Q55.07 -46.53 61.04 -50.53Q67.01 -54.53 75.64 -54.53Z',
    'M122.80 -43.18V-3.16L128.34 -1.55V0.00H101.00V-1.55L107.04 -3.23V-41.64',
    'Q106.19 -42.47 104.60 -43.98Q103.02 -45.49 100.36 -47.66V-48.96L122.03 -54.84H122.80',
    'V-43.18ZM155.10 -39.05V-3.16L160.63 -1.55V0.00H133.78V-1.55L139.34 -3.16V-36.13',
    'Q139.34 -38.90 138.48 -40.61Q137.62 -42.33 135.84 -43.14Q134.06 -43.95 131.27 -43.95',
    'Q128.61 -43.95 125.99 -43.23Q123.38 -42.51 121.04 -41.37L120.71 -42.58',
    'Q124.58 -46.46 127.38 -48.79Q130.17 -51.12 132.38 -52.32Q134.59 -53.51 136.69 -53.90',
    'Q138.78 -54.29 141.28 -54.29Q145.92 -54.29 148.99 -52.59Q152.05 -50.88 153.57 -47.51',
    'Q155.10 -44.13 155.10 -39.05ZM187.40 -39.05V-3.23L193.42 -1.55V0.00H166.08V-1.55',
    'L171.64 -3.16V-36.13Q171.64 -38.90 170.78 -40.61Q169.91 -42.33 168.14 -43.14',
    'Q166.36 -43.95 163.57 -43.95Q160.90 -43.95 158.29 -43.23Q155.67 -42.51 153.34 -41.37',
    'L153.01 -42.58Q156.88 -46.46 159.67 -48.79Q162.47 -51.12 164.68 -52.32',
    'Q166.89 -53.51 168.98 -53.90Q171.08 -54.29 173.58 -54.29Q180.54 -54.29 183.97 -50.48',
    'Q187.40 -46.67 187.40 -39.05ZM218.43 -54.84V-44.13V-3.16L224.21 -1.55V0.00H196.63',
    'V-1.55L202.67 -3.23V-41.64Q202.08 -42.19 201.12 -43.03Q200.15 -43.87 198.88 -45.03',
    'Q197.60 -46.18 195.99 -47.66V-48.96L217.66 -54.84H218.43Z',
].join('')

const id = useId()
const bars_id = `remi-mark-bars-${id}`
const lines_id = `remi-mark-lines-${id}`
const pip_id = `remi-mark-pip-${id}`
const far_tone = computed(() => (props.small ? 'near' : 'far'))

const view_box = computed(() => {
    if (props.lockup) {
        return props.small ? LOCKUP_VIEW_BOX_SMALL : LOCKUP_VIEW_BOX
    }

    return props.small ? MARK_VIEW_BOX_SMALL : MARK_VIEW_BOX
})
</script>

<template>
    <svg
        class="remi-mark"
        :viewBox="view_box"
        aria-hidden="true"
        focusable="false"
    >
        <defs>
            <linearGradient
                :id="bars_id"
                gradientUnits="userSpaceOnUse"
                x1="-9.35"
                y1="37.49"
                x2="94.27"
                y2="63.33"
            >
                <stop offset="0" class="remi-mark-bars-near" />
                <stop offset="0.58" class="remi-mark-bars-near" />
                <stop offset="0.58" :class="`remi-mark-bars-${far_tone}`" />
                <stop offset="1" :class="`remi-mark-bars-${far_tone}`" />
            </linearGradient>
            <linearGradient
                :id="lines_id"
                gradientUnits="userSpaceOnUse"
                x1="-9.35"
                y1="37.49"
                x2="94.27"
                y2="63.33"
            >
                <stop offset="0" class="remi-mark-lines-near" />
                <stop offset="0.58" class="remi-mark-lines-near" />
                <stop offset="0.58" :class="`remi-mark-lines-${far_tone}`" />
                <stop offset="1" :class="`remi-mark-lines-${far_tone}`" />
            </linearGradient>
            <linearGradient v-if="lockup" :id="pip_id" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0.5" class="remi-mark-pip-near" />
                <stop offset="0.5" :class="`remi-mark-pip-${far_tone}`" />
            </linearGradient>
        </defs>
        <path class="remi-mark-shape remi-mark-plates" :d="small ? PLATES_SMALL : PLATES" />
        <path
            class="remi-mark-shape"
            :d="BARS"
            :fill="`url(#${bars_id})`"
            :stroke="`url(#${bars_id})`"
        />
        <path
            class="remi-mark-shape"
            :d="small ? LINES_SMALL : LINES"
            :fill="`url(#${lines_id})`"
            :stroke="`url(#${lines_id})`"
        />
        <g v-if="lockup" :transform="small ? WORD_TRANSFORM_SMALL : WORD_TRANSFORM">
            <path :d="LETTERS" fill="currentColor" />
            <path :d="PIP" :fill="`url(#${pip_id})`" />
        </g>
    </svg>
</template>

<style scoped>
.remi-mark {
    flex-shrink: 0;
    width: auto;
    height: 1em;
}

.remi-mark-shape {
    stroke-width: 1.1;
    stroke-linejoin: round;
}

.remi-mark-plates {
    fill: #e0457b;
    stroke: #e0457b;
}

.remi-mark-bars-near {
    stop-color: #4fd0f5;
}

.remi-mark-bars-far {
    stop-color: #00a2d2;
}

.remi-mark-lines-near {
    stop-color: #f6f8fb;
}

.remi-mark-lines-far {
    stop-color: #c3cddb;
}

.remi-mark-pip-near {
    stop-color: #e0457b;
}

.remi-mark-pip-far {
    stop-color: #a8244f;
}

.theme-light .remi-mark-bars-near {
    stop-color: #00a2d2;
}

.theme-light .remi-mark-bars-far {
    stop-color: #007ba3;
}

.theme-light .remi-mark-lines-near {
    stop-color: #14171d;
}

.theme-light .remi-mark-lines-far {
    stop-color: #3a3f48;
}

.theme-light .remi-mark-pip-near {
    stop-color: #a8244f;
}

.theme-light .remi-mark-pip-far {
    stop-color: #e0457b;
}
</style>
