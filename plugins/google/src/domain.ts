/**
 * A domain name as the plugin accepts it, in `allowedDomains` and in the `hd` claim: dot-separated
 * labels of ASCII letters, digits and inner hyphens, ending in a letter TLD or a punycode
 * (`xn--`) TLD; lowercase. Shared by config.ts and claims.ts so both normalize alike.
 */
export const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/**
 * Lowercases ASCII letters only. `String.prototype.toLowerCase` folds some non-ASCII characters
 * into ASCII (the Kelvin sign U+212A becomes `k`), which could make one address equal another.
 */
export const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
