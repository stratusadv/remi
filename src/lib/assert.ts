export class AssertionError extends Error {
    override name = 'AssertionError'
}

export function assert(condition: boolean, message?: string): asserts condition {
    if (condition) return

    throw new AssertionError(message ?? 'an assertion failed')
}

export function unreachable(value: never): never {
    throw new AssertionError(`an unreachable branch ran with ${JSON.stringify(value)}`)
}
