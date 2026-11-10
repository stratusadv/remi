export function assert(condition: boolean, message?: string): asserts condition {
    if (condition) return

    throw new Error(message ?? 'an assertion failed')
}

export function unreachable(value: never): never {
    throw new Error(`an unreachable branch ran with ${JSON.stringify(value)}`)
}
