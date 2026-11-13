<script setup lang="ts">
import stratus_mark from '../../assets/stratus-mark.svg'
</script>

<template>
    <a class="stratus-credit" href="https://stratusadv.com" target="_blank" rel="noopener noreferrer">
        <img :src="stratus_mark" alt="">
        <span>Powered by Stratus Advanced Technologies</span>
    </a>
</template>

<style scoped>
.stratus-credit {
    display: inline-flex;
    align-items: center;
    gap: 0.625rem;
    text-decoration: none;
}

.stratus-credit img {
    width: 1.25rem;
    user-select: none;
}

.stratus-credit:hover span {
    text-decoration: underline;
    text-underline-offset: 0.2em;
}
</style>
