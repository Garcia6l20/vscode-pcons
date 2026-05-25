export function reduce<T, U>(iterable: Iterable<T>, initial: U, fn: (acc: U, item: T) => U): U {
    let acc = initial;
    for (const item of iterable) {
        acc = fn(acc, item);
    }
    return acc;
}
