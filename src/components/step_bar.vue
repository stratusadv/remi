<script setup lang="ts">
import { use_pipeline } from '../composables/use_pipeline'
import { assert } from '../lib/assert'
import type { View } from '../composables/use_pipeline'


type StepState = 'done' | 'current' | 'todo'

interface Step {
    label: string
    view: View
}

const STEPS = Object.freeze<Step[]>([
    { label: 'Transcript', view: 'transcribe' },
    { label: 'Meeting', view: 'details' },
    { label: 'Notes', view: 'notes' },
])

const { transcript, view_current, view_set } = use_pipeline()


function step_index_current(): number {
    assert(STEPS[1]?.view === 'details')
    assert(STEPS[2]?.view === 'notes')

    if (view_current.value === 'details') return 1
    if (view_current.value === 'notes') return 2

    return 0
}

function step_reachable(index: number): boolean {
    assert(Number.isInteger(index))
    assert(index >= 0)
    assert(index < STEPS.length)

    if (index === 0) return true

    return transcript.value !== null
}

function step_state(index: number): StepState {
    assert(Number.isInteger(index))
    assert(index >= 0)
    assert(index < STEPS.length)

    const current = step_index_current()

    if (index < current) return 'done'
    if (index === current) return 'current'

    return 'todo'
}
</script>

<template>
    <ol class="step-bar">
        <li v-for="(step, index) in STEPS" :key="step.view">
            <button
                type="button"
                class="step-bar-item"
                :data-state="step_state(index)"
                :aria-current="step_state(index) === 'current' ? 'step' : undefined"
                :disabled="!step_reachable(index)"
                @click="view_set(step.view)"
            >
                {{ step.label }}
            </button>
        </li>
    </ol>
</template>
