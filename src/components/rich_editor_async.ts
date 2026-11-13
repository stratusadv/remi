import { defineAsyncComponent, h } from 'vue'
import { assert } from '../lib/assert'
import type { Component, VNode } from 'vue'


const KEY_LOADING_COMPONENT = 'loadingComponent'

export const rich_editor_async = defineAsyncComponent({
    loader: editor_load,
    [KEY_LOADING_COMPONENT]: { render: skeleton_render },
    delay: 0,
})


async function editor_load(): Promise<Component> {
    assert(KEY_LOADING_COMPONENT.length > 0)
    assert(typeof h === 'function')

    return import('./rich_editor.vue')
}

function skeleton_render(): VNode {
    const select = h('span', { class: 'rich-tb-select invisible' }, ' ')
    const toolbar = h('div', { class: 'rich-editor-toolbar' }, [select])
    const body = h('div', { class: 'rich-editor-body' })
    const stats = h('div', { class: 'rich-editor-stats' }, ' ')

    assert(toolbar.type === 'div')
    assert(stats.type === 'div')

    return h('div', { class: 'rich-editor' }, [toolbar, body, stats])
}
