/**
 * Whether a plugin variable's name says it holds a secret.
 *
 * A variable's name is read as words rather than as a string, so `MY_API_KEY` and `apiKey` are the same answer, and a
 * name that says credential, password, token or the like is treated as a secret wherever it appears in the name.
 */
const SECRET_WORDS = new Set(["CREDENTIAL", "CREDENTIALS", "KEY", "PASSPHRASE", "PASSWORD", "SECRET", "TOKEN"]);
function toSegments(name: string): string[] { return name.replace(/([a-z\d])([A-Z])/g, "$1_$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/[^a-z\d]+/gi, "_").toUpperCase().split("_").filter(Boolean); }
export const isSecretPluginVariableName = (name: string): boolean => toSegments(name).some((segment) => SECRET_WORDS.has(segment));
