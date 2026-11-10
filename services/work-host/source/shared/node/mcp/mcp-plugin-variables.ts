/**
 * The form a plugin's variables are asked for in.
 *
 * A plugin declares its variables as a schema, and the form a user fills in is built from it: each variable is named as
 * words, labelled by what it is for, marked required when the schema says so, given its default, and marked as a
 * secret when it says it is one — by its format, by being write-only, or by its name saying so. What is missing from a
 * filled-in form is reported as the fields that are still empty.
 */

/** One variable of a plugin, as the form asks for it. */
export interface PluginVariableField { key: string; label: string; placeholder: string; isRequired: boolean; isSecret: boolean; defaultValue?: string; hint?: string }

/** A name that says it holds a secret: the schema is not always the one that says so. */
const SECRET_NAME_PATTERN = /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/;

/** The words that keep their own case when a variable's name is turned into a label. */
const ACRONYMS = new Set(["url", "uri", "api", "id", "ssl", "tls", "http", "https", "db", "aws", "gcp"]);

/** One word of a variable's name as a label word: acronyms keep their case, other words are capitalized. */
function labelWord(word: string): string {
  if (ACRONYMS.has(word.toLowerCase())) return word.toUpperCase();
  return word.charAt(0).toUpperCase() + word.toLowerCase().slice(1);
}

/** A variable's name as words a user reads: split on underscores, each word labelled. */
export function humanizeVariableName(name: string): string {
  return name.split("_").filter(Boolean).map(labelWord).join(" ");
}

/** A value that is a plain record, when it is one. */
const recordOrUndefined = (value: unknown): Record<string, unknown> | undefined => value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** The text a record carries under this key, when it carries text there. */
function textOf(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/** The keys the schema marks required, ignoring anything in that list that is not a key. */
function requiredKeys(root: Record<string, unknown> | undefined): ReadonlySet<string> {
  if (!Array.isArray(root?.required)) return new Set<string>();
  return new Set(root.required.filter((key): key is string => typeof key === "string"));
}

/** Whether this property holds a secret: it says so by its format, by being write-only, or by its name. */
function isSecretProperty(property: Record<string, unknown>, key: string): boolean {
  return property.format === "password" || property.writeOnly === true || SECRET_NAME_PATTERN.test(key);
}

/** One property of the schema as the field a user fills in. */
function fieldFromProperty(key: string, value: unknown, required: ReadonlySet<string>): PluginVariableField {
  const property = recordOrUndefined(value) ?? {};
  const title = textOf(property, "title");
  const description = textOf(property, "description");
  const defaultValue = textOf(property, "default");
  return {
    key,
    label: title ?? humanizeVariableName(key),
    placeholder: key,
    isRequired: required.has(key),
    isSecret: isSecretProperty(property, key),
    ...(defaultValue == null ? {} : { defaultValue }),
    ...(description == null ? {} : { hint: description }),
  };
}

/** The fields a plugin's variable schema asks for, in the order the schema lists them. */
export function pluginVariablesSchemaToFields(schema: unknown): PluginVariableField[] {
  const root = recordOrUndefined(schema);
  const properties = recordOrUndefined(root?.properties);
  if (properties == null) return [];
  const required = requiredKeys(root);
  return Object.entries(properties).map(([key, value]) => fieldFromProperty(key, value, required));
}

/** Whether this field is required and has neither an entered value nor a default to fall back on. */
function isMissingValue(field: PluginVariableField, values: Readonly<Record<string, string | undefined>>): boolean {
  if (field.isRequired !== true) return false;
  if (values[field.key]?.trim()) return false;
  return (field.defaultValue?.trim() || "").length === 0;
}

/** The required fields a filled-in form left empty, in the schema's order. */
export function findMissingRequiredCatalogFields(fields: readonly PluginVariableField[], values: Readonly<Record<string, string | undefined>>): PluginVariableField[] {
  return fields.filter((field) => isMissingValue(field, values));
}
