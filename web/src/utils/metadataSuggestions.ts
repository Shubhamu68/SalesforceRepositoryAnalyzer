/** Keep the source order and return ALL matching Salesforce metadata names.
 * The dropdown handles scrolling; no arbitrary suggestion cap is applied.
 */
export function filterMetadataSuggestions(
  names: readonly string[],
  searchText: string
): string[] {
  const search = searchText.trim().toLowerCase();
  if (!search) return [...names];
  return names.filter((name) => name.toLowerCase().includes(search));
}
