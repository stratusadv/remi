<script setup lang="ts">
import { onBeforeUnmount, onMounted, shallowRef } from 'vue'
import { use_recorder } from '../composables/use_recorder'
import { assert } from '../lib/assert'
import { TRACE_HEIGHT, TRACE_WIDTH, trace_path } from '../lib/trace'


const VIEW_BOX = `0 0 ${String(TRACE_WIDTH)} ${String(TRACE_HEIGHT)}`

const { trace_current } = use_recorder()
const frame_id = shallowRef<number | null>(null)
const path = shallowRef(trace_path([]))


onMounted(() => {
    assert(frame_id.value === null)

    frame_id.value = requestAnimationFrame(frame_draw)
})

onBeforeUnmount(() => {
    assert(frame_id.value !== null)

    cancelAnimationFrame(frame_id.value)

    frame_id.value = null
})

function frame_draw(): void {
    assert(frame_id.value !== null)

    path.value = trace_path(trace_current())
    frame_id.value = requestAnimationFrame(frame_draw)

    assert(path.value.startsWith('M0'))
}
</script>

<template>
    <div class="recording-trace" aria-hidden="true">
        <svg :viewBox="VIEW_BOX" preserveAspectRatio="none">
            <path :d="path" />
        </svg>
    </div>
</template>

<style scoped>
.recording-trace {
    width: 100%;
    max-width: 36rem;
    height: 7.5rem;
    background: radial-gradient(var(--color-border) 1px, transparent 1.5px) center / 16px 16px;
    -webkit-mask:
        linear-gradient(90deg, transparent, #000 25%, #000 75%, transparent),
        linear-gradient(180deg, transparent, #000 25%, #000 75%, transparent);
    -webkit-mask-composite: source-in;
    mask:
        linear-gradient(90deg, transparent, #000 25%, #000 75%, transparent),
        linear-gradient(180deg, transparent, #000 25%, #000 75%, transparent);
    mask-composite: intersect;
}

.recording-trace svg {
    display: block;
    width: 100%;
    height: 100%;
    overflow: visible;
    filter: drop-shadow(0 0 4px color-mix(in oklab, var(--color-danger-text) 55%, transparent));
}

.recording-trace path {
    fill: none;
    stroke: var(--color-danger-text);
    stroke-linejoin: round;
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
}
</style>
