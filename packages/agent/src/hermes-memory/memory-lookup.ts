/** Content identity uses the complete value. Display labels are never protocol data. */
export function normalizeMemoryLookupText(text:string):string {
  return text.normalize("NFKC").trim().replace(/\s+/gu," ");
}
