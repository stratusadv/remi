<script setup lang="ts">
import stratus_mark from '../../assets/stratus-mark.svg'
import { use_dialog } from '../composables/use_dialog'
import { assert } from '../lib/assert'
import { ipc } from '../lib/ipc'
import { log_warn } from '../lib/log'


const WEBSITE_HOST = 'stratusadv.com'

const { message: dialog_message } = use_dialog()


async function website_open(event: MouseEvent): Promise<void> {
    assert(event.type === 'click')
    assert(event.defaultPrevented)

    return ipc.desktop_website_open().catch(async (error: unknown) => {
        log_warn('[credit] the website did not open', error)

        return dialog_message(
            `The website could not be opened. Visit ${WEBSITE_HOST} in your browser.`,
            { title: 'Website', kind: 'warning' },
        )
    })
}
</script>

<template>
    <a class="stratus-credit" :href="`https://${WEBSITE_HOST}`" @click.prevent="website_open">
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
    transition: color 100ms ease;
}

.stratus-credit img {
    width: 1.25rem;
    user-select: none;
}

.stratus-credit:hover {
    color: var(--color-content);
}
</style>
