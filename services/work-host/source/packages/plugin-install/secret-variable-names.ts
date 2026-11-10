/**
 * Whether a plugin variable's name says it holds a secret.
 *
 * A variable's name is read as words rather than as a string, so `MY_API_KEY` and `apiKey` are the same answer, and a
 * name that says credential, password, token or the like is treated as a secret wherever it appears in the name.
 */

/** A lower-case letter or digit followed by a capital: where a camel hump ends. */
const CAMEL_HUMP = /([a-z\d])([A-Z])/g;

/** An acronym followed by a capitalized word: where a run of capitals ends. */
const ACRONYM_RUN = /([A-Z]+)([A-Z][a-z])/g;

/** Anything that is not a letter or a digit: a word separator. */
const WORD_SEPARATOR = /[^a-z\d]+/gi;

/** The words that say a variable holds a secret. */
const SECRET_WORD_SET = new Set(["CREDENTIAL", "CREDENTIALS", "KEY", "PASSPHRASE", "PASSWORD", "SECRET", "TOKEN"]);

/** The words a variable's name is made of, in the order it says them. */
function nameWords(name: string): string[] {
  return name
    .replace(CAMEL_HUMP, "$1_$2")
    .replace(ACRONYM_RUN, "$1_$2")
    .replace(WORD_SEPARATOR, "_")
    .toUpperCase()
    .split("_")
    .filter(Boolean);
}

/** Whether one of the words a variable's name is made of says the variable holds a secret. */
export const isSecretPluginVariableName = (name: string): boolean => nameWords(name).some((word) => SECRET_WORD_SET.has(word));
