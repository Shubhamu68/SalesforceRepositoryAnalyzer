/**
 * Shared repository discovery policy. Generated tooling/build trees are not
 * application source and must never contribute Apex classes, methods or calls.
 * Match whole directory names (case-insensitive), not arbitrary path text.
 * Do not exclude real application classes by name, including Database.cls.
 */
const EXCLUDED_REPOSITORY_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git", ".sfdx", ".sf", "node_modules", "dist", "build", ".next", "coverage",
]);

export function isExcludedRepositoryDirectory(name: string): boolean {
  return EXCLUDED_REPOSITORY_DIRECTORIES.has(name.toLowerCase());
}
