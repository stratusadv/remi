import { isRef, ref } from 'vue'
import { assert } from '../lib/assert'
import type { Ref } from 'vue'


const online = ref(navigator.onLine)


export function use_network(): { online: Ref<boolean> } {
    assert(isRef(online))
    assert(typeof online.value === 'boolean')

    return { online }
}

function online_set(value: boolean): void {
    assert(typeof value === 'boolean')

    online.value = value

    assert(online.value === value)
}

window.addEventListener('online', () => {
    online_set(true)
})

window.addEventListener('offline', () => {
    online_set(false)
})
