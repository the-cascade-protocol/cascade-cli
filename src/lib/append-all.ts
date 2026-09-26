/**
 * Append every item of `items` to `target`, in order.
 *
 * `target.push(...items)` passes each item as a separate call argument, and a
 * call's arguments live on the stack: past roughly a hundred thousand of them
 * V8 throws `RangeError: Maximum call stack size exceeded`. A pod bucket of
 * daily wellness records holds hundreds of thousands of quads, so a spread
 * push that is harmless on a clinical file takes the whole verb down on a
 * wellness one. This loop has no such limit, and `tests/no-spread-push.test.ts`
 * keeps the spread form out of `src/`.
 */
export function appendAll<T>(target: T[], items: Iterable<T>): T[] {
  for (const item of items) target.push(item);
  return target;
}
