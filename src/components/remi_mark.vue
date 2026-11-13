<script setup lang="ts">
import { computed, useId } from 'vue'


const props = defineProps<{
    lockup?: boolean
    small?: boolean
}>()

const MARK_VIEW_BOX = '8.5 10.1 69.8 84.1'
const MARK_VIEW_BOX_SMALL = '8.5 10.1 74.3 92.6'
const LOCKUP_VIEW_BOX = '0 0 372.99 104.22'
const LOCKUP_VIEW_BOX_SMALL = '0 0 377.54 112.75'
const WORD_TRANSFORM = 'translate(115.34 90.17)'
const WORD_TRANSFORM_SMALL = 'translate(119.89 94.15)'
const PIP = 'M239.24 -84.97L246.88 -72.76L239.24 -60.55L231.61 -72.76Z'

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
    'M36.38 -40.23Q43.67 -40.23 47.55 -44.16Q51.43 -48.08 51.43 -55.70',
    'Q51.43 -60.56 49.78 -63.84Q48.13 -67.13 44.59 -68.81Q41.04 -70.49 35.31 -70.49H15.27',
    'L18.46 -74.36H41.24Q51.71 -74.36 57.79 -72.03Q63.88 -69.70 66.49 -65.71',
    'Q69.10 -61.71 69.10 -56.63Q69.10 -51.86 66.44 -47.84Q63.78 -43.81 58.53 -41.30',
    'Q53.28 -38.79 45.50 -38.47V-38.65Q50.92 -38.48 54.48 -36.97Q58.05 -35.47 60.35 -32.70',
    'Q62.64 -29.92 64.20 -25.78L70.12 -11.17Q71.67 -7.40 73.02 -5.57',
    'Q74.38 -3.74 76.22 -3.19Q78.07 -2.65 81.03 -2.65V0.00Q72.82 0.61 67.72 0.53',
    'Q62.62 0.46 59.69 -0.55Q56.75 -1.55 55.11 -3.69Q53.47 -5.82 52.12 -9.27L44.87 -28.01',
    'Q43.46 -31.61 42.10 -33.39Q40.73 -35.16 39.15 -35.76Q37.56 -36.35 35.41 -36.35H17.97',
    'L14.71 -40.23H36.38ZM29.63 -74.36V-4.25L38.30 -1.73V0.00H2.88V-1.73L11.55 -4.25V-70.16',
    'L2.88 -72.61V-74.36H29.63ZM105.07 -54.53Q111.36 -54.53 115.83 -52.04',
    'Q120.30 -49.54 122.85 -44.80Q125.40 -40.05 125.89 -33.28H90.88V-37.11H118.61',
    'L111.53 -34.66Q111.16 -40.84 110.17 -44.45Q109.19 -48.06 107.52 -49.64',
    'Q105.85 -51.23 103.36 -51.23Q100.22 -51.23 98.00 -49.34Q95.78 -47.46 94.62 -43.31',
    'Q93.45 -39.15 93.45 -32.33Q93.45 -24.11 95.46 -19.05Q97.47 -14.00 101.37 -11.68',
    'Q105.27 -9.37 110.97 -9.37Q113.81 -9.37 116.34 -10.05Q118.88 -10.74 121.24 -12.22',
    'Q123.59 -13.71 125.75 -16.12L126.90 -15.18Q123.36 -9.04 119.80 -5.43',
    'Q116.25 -1.83 112.34 -0.27Q108.44 1.28 103.76 1.28Q96.30 1.28 90.56 -1.86',
    'Q84.82 -5.00 81.59 -11.01Q78.36 -17.03 78.36 -25.59Q78.36 -33.36 81.43 -39.95',
    'Q84.50 -46.53 90.47 -50.53Q96.44 -54.53 105.07 -54.53ZM152.23 -43.18V-3.16',
    'L157.77 -1.55V0.00H130.43V-1.55L136.47 -3.23V-41.64Q135.62 -42.47 134.03 -43.98',
    'Q132.45 -45.49 129.79 -47.66V-48.96L151.47 -54.84H152.23V-43.18ZM184.53 -39.05V-3.16',
    'L190.07 -1.55V0.00H163.21V-1.55L168.77 -3.16V-36.13Q168.77 -38.90 167.91 -40.61',
    'Q167.05 -42.33 165.27 -43.14Q163.49 -43.95 160.71 -43.95Q158.04 -43.95 155.42 -43.23',
    'Q152.81 -42.51 150.47 -41.37L150.14 -42.58Q154.01 -46.46 156.81 -48.79',
    'Q159.60 -51.12 161.81 -52.32Q164.02 -53.51 166.12 -53.90Q168.22 -54.29 170.72 -54.29',
    'Q175.35 -54.29 178.42 -52.59Q181.48 -50.88 183.01 -47.51Q184.53 -44.13 184.53 -39.05Z',
    'M216.83 -39.05V-3.23L222.85 -1.55V0.00H195.51V-1.55L201.07 -3.16V-36.13',
    'Q201.07 -38.90 200.21 -40.61Q199.35 -42.33 197.57 -43.14Q195.79 -43.95 193.00 -43.95',
    'Q190.34 -43.95 187.72 -43.23Q185.11 -42.51 182.77 -41.37L182.44 -42.58',
    'Q186.31 -46.46 189.11 -48.79Q191.90 -51.12 194.11 -52.32Q196.32 -53.51 198.42 -53.90',
    'Q200.51 -54.29 203.02 -54.29Q209.97 -54.29 213.40 -50.48Q216.83 -46.67 216.83 -39.05Z',
    'M247.87 -54.84V-44.13V-3.16L253.64 -1.55V0.00H226.06V-1.55L232.11 -3.23V-41.64',
    'Q231.51 -42.19 230.55 -43.03Q229.59 -43.87 228.31 -45.03Q227.04 -46.18 225.42 -47.66',
    'V-48.96L247.10 -54.84H247.87Z',
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
    fill: #f0a020;
    stroke: #f0a020;
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
    stop-color: #f0a020;
}

.remi-mark-pip-far {
    stop-color: #cc8212;
}

.theme-light .remi-mark-plates {
    fill: #e0457b;
    stroke: #e0457b;
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
