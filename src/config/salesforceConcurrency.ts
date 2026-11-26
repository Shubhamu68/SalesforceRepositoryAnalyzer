/**
 * Release-owned, benchmark-validated concurrency limits. These are source-code
 * constants, not runtime settings: no environment, .env, UI, or per-user
 * override. All shared gateway consumers use the same limits.
 */
export const SALESFORCE_HTTP_READ_CONCURRENCY = 6;
export const SALESFORCE_VERIFICATION_CONCURRENCY = 5;
export const ALL_PERSONAS_CONCURRENCY = 2;
