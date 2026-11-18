<script setup lang="ts">
import { use_dialog } from '../composables/use_dialog'
import { assert } from '../lib/assert'
import { ipc } from '../lib/ipc'
import { log_warn } from '../lib/log'


const PRIVACY_URL = 'https://remirememberthat.com/privacy/'

const { message: dialog_message } = use_dialog()


async function privacy_open(event: MouseEvent): Promise<void> {
    assert(event.type === 'click')
    assert(event.defaultPrevented)

    return ipc.desktop_privacy_open().catch(async (error: unknown) => {
        log_warn('[privacy] the privacy policy did not open', error)

        return dialog_message(
            `The privacy policy could not be opened. Visit ${PRIVACY_URL} in your browser.`,
            { title: 'Privacy policy', kind: 'warning' },
        )
    })
}
</script>

<template>
    <a class="privacy-link" :href="PRIVACY_URL" @click.prevent="privacy_open">Privacy policy</a>
</template>

<style scoped>
.privacy-link {
    text-decoration: none;
    transition: color 100ms ease;
}

.privacy-link:hover {
    color: var(--color-content);
}
</style>
