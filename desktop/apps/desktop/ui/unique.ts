/** One entry per id: the newest copy wins, keeping first-seen order. */
export function uniqueById<T>(items: T[], key: (item: T) => string = item => (item as { id: string }).id): T[] {
  return [...new Map(items.map(item => [key(item), item])).values()];
}
