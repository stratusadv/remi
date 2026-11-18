import { assert } from './assert'
import { ipc } from './ipc'
import { log_warn } from './log'
import type { AccountAction } from '../types'


export function action_report(action: AccountAction): void {
    assert(action.length > 0)
    assert(action === action.trim())

    void Promise.resolve()
        .then(async () => ipc.account_action_report(action))
        .catch((error: unknown) => {
            log_warn('[action] not reported', action, error)
        })
}
