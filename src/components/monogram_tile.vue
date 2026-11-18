<script setup lang="ts">
import { computed } from 'vue'
import { monogram_hue, monogram_letters } from '../lib/monogram'


const properties = defineProps<{
    text: string
}>()

const hue = computed(() => monogram_hue(properties.text))
const letters = computed(() => monogram_letters(properties.text))
</script>

<template>
    <span class="monogram" :data-hue="hue" :data-letters="letters" aria-hidden="true" />
</template>
