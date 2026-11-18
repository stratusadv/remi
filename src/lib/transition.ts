import { assert } from './assert'


export function transition_leave_inert(element: Element): void {
    assert(element instanceof HTMLElement)
    assert(element.isConnected)

    element.toggleAttribute('inert', true)
}
