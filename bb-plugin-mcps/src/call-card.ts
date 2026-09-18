import type { JsonRecord } from "./types.js";

const MAX_ENUM = 8;
const MAX_FIELDS = 24;
const MAX_DEPTH = 4;
const MAX_EXAMPLE_KEYS = 6;
const MAX_ALTS = 4;
const MAX_SHAPE_KEYS = 10;
const MAX_SHAPE_CHARS = 480;
const MAX_CARD_CHARS = 1_600;
const MAX_MERGE_DEPTH = 8;

// Ceiling: $ref is not followed. additionalProperties, patternProperties, not,
// if/then/else, and tuple `items` arrays are not evaluated. Upgrade: a JSON
// Schema validator if live tools start depending on those keywords.

export type CallCard = {
  truncated?: boolean;
  shape: string;
  fields: Array<{ name: string; type: string; required: boolean; enum?: string[] }>;
  example: JsonRecord;
};

type BranchMode = "all" | "any" | "one";

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (typeof left !== "object" || typeof right !== "object") return false;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function enumIncludes(list: unknown[], value: unknown): boolean {
  return list.some((item) => jsonEqual(item, value));
}

function rawObject(value: unknown): JsonRecord {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as JsonRecord;
  return { type: "object" };
}

function requiredOf(schema: JsonRecord): string[] {
  return Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
}

function copyIfMissing(target: JsonRecord, source: JsonRecord, key: string): void {
  if (target[key] === undefined && source[key] !== undefined) target[key] = source[key];
}

function propertiesOfRaw(schema: JsonRecord): Record<string, JsonRecord> {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return {};
  const out: Record<string, JsonRecord> = {};
  for (const [key, value] of Object.entries(properties as Record<string, unknown>)) out[key] = mergeAllOf(rawObject(value));
  return out;
}

function mergeAllOf(schema: JsonRecord, depth = 0): JsonRecord {
  const parts = Array.isArray(schema.allOf) ? schema.allOf.map((part) => mergeAllOf(rawObject(part), depth + 1)) : [];
  if (parts.length === 0) return schema;
  if (depth > MAX_MERGE_DEPTH) return schema;
  const base: JsonRecord = { ...schema };
  delete base.allOf;
  const properties: Record<string, JsonRecord> = { ...propertiesOfRaw(base) };
  let required = requiredOf(base);
  for (const part of parts) {
    for (const [key, nested] of Object.entries(propertiesOfRaw(part))) {
      properties[key] = properties[key] ? mergeAllOf({ allOf: [properties[key], nested] }, depth + 1) : nested;
    }
    required = [...required, ...requiredOf(part)];
    if (Array.isArray(base.enum) && Array.isArray(part.enum)) {
      base.enum = base.enum.filter((item) => enumIncludes(part.enum as unknown[], item));
    } else copyIfMissing(base, part, "enum");
    for (const key of ["type", "items", "const", "anyOf", "oneOf", "default", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "exclusiveMinimum", "exclusiveMaximum"]) {
      copyIfMissing(base, part, key);
    }
  }
  if (Object.keys(properties).length > 0) base.properties = properties;
  if (required.length > 0) base.required = [...new Set(required)];
  return base;
}

function normalize(value: unknown): JsonRecord {
  return mergeAllOf(rawObject(value));
}

function intersect(base: JsonRecord, extra: JsonRecord): JsonRecord {
  return mergeAllOf({ allOf: [base, extra] });
}

function branches(schema: JsonRecord): { mode: BranchMode; schemas: JsonRecord[] } {
  const record = normalize(schema);
  const anyOf = Array.isArray(record.anyOf) ? record.anyOf.map((part) => normalize(part)) : [];
  const oneOf = Array.isArray(record.oneOf) ? record.oneOf.map((part) => normalize(part)) : [];
  const rest: JsonRecord = { ...record };
  delete rest.anyOf;
  delete rest.oneOf;
  // Ceiling: if both anyOf and oneOf appear, oneOf wins instead of ANDing them.
  if (oneOf.length > 0) return { mode: "one", schemas: oneOf.map((part) => intersect(rest, part)) };
  if (anyOf.length > 0) return { mode: "any", schemas: anyOf.map((part) => intersect(rest, part)) };
  return { mode: "all", schemas: [record] };
}

function propertiesOf(schema: JsonRecord): Record<string, JsonRecord> {
  return propertiesOfRaw(normalize(schema));
}

function clipShape(text: string): string {
  if (text.length <= MAX_SHAPE_CHARS) return text;
  return `${text.slice(0, Math.max(0, MAX_SHAPE_CHARS - 1))}…`;
}

function baseTypeName(schema: JsonRecord): string {
  const record = normalize(schema);
  if (record.const !== undefined) return JSON.stringify(record.const);
  if (Array.isArray(record.enum) && record.enum.length > 0) {
    return record.enum.slice(0, MAX_ENUM).map((item) => JSON.stringify(item)).join("|");
  }
  if (Array.isArray(record.type)) return record.type.filter((item) => typeof item === "string").join("|") || "any";
  if (record.type === "array") return `${typeName(normalize(record.items))}[]`;
  if (typeof record.type === "string") return record.type;
  if (Object.keys(propertiesOf(record)).length > 0) return "object";
  return "any";
}

function typeName(schema: JsonRecord): string {
  const record = normalize(schema);
  const constraints = ["format", "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems"]
    .filter(key => record[key] !== undefined).map(key => `${key}=${JSON.stringify(record[key])}`);
  return baseTypeName(record) + (constraints.length ? ` (${constraints.join(", ")})` : "");
}

function stringEnums(schema: JsonRecord): string[] {
  return Array.isArray(schema.enum) ? schema.enum.filter((item): item is string => typeof item === "string").slice(0, MAX_ENUM) : [];
}

export function schemaShape(schema: unknown, depth = 0): string {
  const { schemas } = branches(normalize(schema));
  if (schemas.length > 1) {
    const shown = schemas.slice(0, MAX_ALTS).map((item) => schemaShape(item, depth));
    if (schemas.length > MAX_ALTS) shown.push("…");
    return clipShape(shown.join(" | "));
  }
  const record = schemas[0]!;
  if (record.type === "array") return clipShape(`${schemaShape(record.items, depth + 1)}[]`);
  const properties = propertiesOf(record);
  const keys = Object.keys(properties);
  if (keys.length === 0) {
    if (record.type === "object" || depth === 0) return "{}";
    return typeName(record);
  }
  if (depth >= MAX_DEPTH) return "object";
  const required = new Set(requiredOf(record));
  const ordered = [...keys.filter((key) => required.has(key)), ...keys.filter((key) => !required.has(key))];
  const shown = ordered.slice(0, MAX_SHAPE_KEYS);
  const inner = shown.map((key) => {
    const nested = properties[key]!;
    const nestedBranches = branches(nested);
    const nestedObject = nestedBranches.schemas.some((item) => Object.keys(propertiesOf(item)).length > 0) || nestedBranches.schemas.length > 1;
    if (nestedObject) return `${key}: ${schemaShape(nested, depth + 1)}`;
    return key;
  });
  if (ordered.length > MAX_SHAPE_KEYS) inner.push("…");
  return clipShape(`{ ${inner.join(", ")} }`);
}

export function parameterNames(schema: unknown, into: string[] = []): string[] {
  for (const record of branches(normalize(schema)).schemas) {
    if (record.type === "array") parameterNames(record.items, into);
    for (const [key, nested] of Object.entries(propertiesOf(record))) {
      into.push(key);
      parameterNames(nested, into);
    }
  }
  return into;
}

function exampleFromBranch(record: JsonRecord, depth: number): unknown {
  if (depth > MAX_DEPTH) return null;
  if (record.const !== undefined) return record.const;
  if (Array.isArray(record.enum) && record.enum.length > 0) return record.enum[0];
  if (record.default !== undefined) return record.default;
  const type = record.type;
  if (type === "string") {
    if (typeof record.minLength === "number" && record.minLength > 0) return "x".repeat(Math.min(record.minLength, 32));
    return "";
  }
  if (type === "integer" || type === "number") {
    if (typeof record.minimum === "number") return record.minimum;
    if (typeof record.exclusiveMinimum === "number") return type === "integer" ? Math.floor(record.exclusiveMinimum) + 1 : record.exclusiveMinimum + 1;
    return 0;
  }
  if (type === "boolean") return false;
  if (type === "array") {
    const item = exampleFromBranch(normalize(record.items), depth + 1);
    const minItems = typeof record.minItems === "number" ? record.minItems : 0;
    if (item === undefined || item === null) return [];
    return Array.from({ length: Math.max(1, Math.min(minItems, 3)) }, () => item);
  }
  const properties = propertiesOf(record);
  const keys = Object.keys(properties);
  if (type === "object" || keys.length > 0) {
    const required = requiredOf(record);
    const chosen = (required.length > 0 ? required : keys).slice(0, MAX_EXAMPLE_KEYS);
    const example: JsonRecord = {};
    for (const key of chosen) {
      const nested = properties[key];
      if (!nested) continue;
      example[key] = exampleValue(nested, depth + 1);
    }
    return example;
  }
  return null;
}

function exampleValue(schema: JsonRecord, depth: number): unknown {
  const { schemas } = branches(schema);
  if (depth === 0) {
    for (const record of schemas) {
      const candidate = exampleFromBranch(record, depth);
      if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate) && validateCallArgs(schema, candidate as JsonRecord) === null) {
        return candidate;
      }
    }
  }
  const objectBranch = schemas.find((item) => Object.keys(propertiesOf(item)).length > 0);
  return exampleFromBranch(objectBranch ?? schemas[0]!, depth);
}

function collectFields(schema: JsonRecord, prefix: string, parentRequired: boolean, into: CallCard["fields"]): void {
  if (into.length >= MAX_FIELDS) return;
  const { schemas } = branches(schema);
  if (schemas.length > 1) {
    const keys = new Map<string, JsonRecord>();
    for (const record of schemas) {
      for (const [key, nested] of Object.entries(propertiesOf(record))) {
        if (!keys.has(key)) keys.set(key, nested);
      }
      if (Object.keys(propertiesOf(record)).length === 0 && prefix && !into.some((field) => field.name === prefix)) {
        const enums = stringEnums(record);
        into.push({ name: prefix, type: typeName(record), required: parentRequired, ...(enums.length > 0 ? { enum: enums } : {}) });
      }
    }
    for (const [key, nested] of keys) {
      if (into.length >= MAX_FIELDS) return;
      const name = prefix ? `${prefix}.${key}` : key;
      const childRequired = parentRequired && schemas.every((record) => requiredOf(record).includes(key));
      const nestedObject = branches(nested).schemas.some((item) => Object.keys(propertiesOf(item)).length > 0);
      if (nestedObject) collectFields(nested, name, childRequired, into);
      else if (!into.some((field) => field.name === name)) {
        const enums = stringEnums(nested);
        into.push({
          name,
          type: typeName(nested),
          required: childRequired,
          ...(enums.length > 0 ? { enum: enums } : {}),
        });
      }
    }
    return;
  }
  const record = schemas[0]!;
  const properties = propertiesOf(record);
  const required = new Set(requiredOf(record));
  if (Object.keys(properties).length === 0) {
    if (prefix && !into.some((field) => field.name === prefix)) {
      const enums = stringEnums(record);
      into.push({ name: prefix, type: typeName(record), required: parentRequired, ...(enums.length > 0 ? { enum: enums } : {}) });
    }
    return;
  }
  for (const [key, nested] of Object.entries(properties)) {
    if (into.length >= MAX_FIELDS) return;
    const name = prefix ? `${prefix}.${key}` : key;
    const childRequired = parentRequired && required.has(key);
    const nestedObject = branches(nested).schemas.some((item) => Object.keys(propertiesOf(item)).length > 0);
    if (nestedObject) collectFields(nested, name, childRequired, into);
    else if (!into.some((field) => field.name === name)) {
      const enums = stringEnums(nested);
      into.push({
        name,
        type: typeName(nested),
        required: childRequired,
        ...(enums.length > 0 ? { enum: enums } : {}),
      });
    }
  }
}

function boundCard(card: CallCard): CallCard {
  let { shape, fields, example } = card;
  const size = () => JSON.stringify({ shape, fields, example }).length;
  while (size() > MAX_CARD_CHARS) {
    if (fields.length > 8) fields = fields.slice(0, Math.max(4, fields.length - 4));
    else if (Object.keys(example).length > 1) {
      const keys = Object.keys(example).slice(0, -1);
      example = Object.fromEntries(keys.map((key) => [key, example[key]]));
    } else if (shape.length > 80) shape = clipShape(shape.slice(0, 80));
    else if (fields.length > 0) fields = [];
    else {
      example = {};
      break;
    }
  }
  return { shape, fields, example, ...(fields.length < card.fields.length || card.fields.length >= MAX_FIELDS ? { truncated: true } : {}) };
}

export function callCard(schema: unknown): CallCard {
  const record = normalize(schema);
  const fields: CallCard["fields"] = [];
  collectFields(record, "", true, fields);
  const example = exampleValue(record, 0);
  return boundCard({
    shape: schemaShape(record),
    fields,
    example: example !== null && typeof example === "object" && !Array.isArray(example) ? example as JsonRecord : {},
  });
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(schema: JsonRecord, value: unknown): boolean {
  const types = Array.isArray(schema.type) ? schema.type : schema.type !== undefined ? [schema.type] : [];
  if (types.length === 0) return true;
  const actual = jsonType(value);
  return types.some((type) => {
    if (type === "integer") return typeof value === "number" && Number.isInteger(value);
    if (type === "number") return typeof value === "number";
    if (type === "null") return value === null;
    return type === actual;
  });
}

function walkArray(record: JsonRecord, value: unknown[], path: string): string[] {
  const problems: string[] = [];
  const label = path || "arguments";
  if (typeof record.minItems === "number" && value.length < record.minItems) problems.push(`${label} needs at least ${record.minItems} items`);
  if (typeof record.maxItems === "number" && value.length > record.maxItems) problems.push(`${label} has at most ${record.maxItems} items`);
  const items = record.items;
  if (items && typeof items === "object" && !Array.isArray(items)) {
    for (let index = 0; index < value.length; index++) {
      problems.push(...walkProblems(normalize(items), value[index], `${path}[${index}]`));
    }
  }
  return problems;
}

function walkProblems(expected: JsonRecord, value: unknown, path: string): string[] {
  const { mode, schemas } = branches(expected);
  const label = path || "arguments";
  if (schemas.length > 1 || mode === "any" || mode === "one") {
    const nested = schemas.map((alt) => walkProblems(alt, value, path));
    const matches = nested.filter((item) => item.length === 0).length;
    if (mode === "one") {
      if (matches === 1) return [];
      if (matches > 1) return [`${label} matches more than one alternative`];
    } else if (matches >= 1) return [];
    const firsts = nested.map((item) => item[0]).filter((item): item is string => Boolean(item));
    if (firsts.length > 0 && firsts.every((item) => item === firsts[0])) return [firsts[0]!];
    return [`${label} should be ${schemas.slice(0, MAX_ALTS).map((item) => schemaShape(item)).join(" | ")}`];
  }
  const record = schemas[0]!;
  const problems: string[] = [];
  if (!matchesType(record, value)) {
    problems.push(`${label} should be ${typeName(record)}`);
    return problems;
  }
  if (record.const !== undefined && !jsonEqual(value, record.const)) {
    problems.push(`${label} should be ${JSON.stringify(record.const)}`);
  }
  if (Array.isArray(record.enum) && record.enum.length > 0 && !enumIncludes(record.enum, value)) {
    problems.push(`${label} should be one of ${record.enum.slice(0, MAX_ENUM).map((item) => JSON.stringify(item)).join(", ")}`);
  }
  if (typeof value === "string") {
    if (typeof record.minLength === "number" && value.length < record.minLength) problems.push(`${label} is shorter than ${record.minLength}`);
    if (typeof record.maxLength === "number" && value.length > record.maxLength) problems.push(`${label} is longer than ${record.maxLength}`);
  }
  if (typeof value === "number") {
    if (typeof record.minimum === "number" && value < record.minimum) problems.push(`${label} is below ${record.minimum}`);
    if (typeof record.maximum === "number" && value > record.maximum) problems.push(`${label} is above ${record.maximum}`);
    if (typeof record.exclusiveMinimum === "number" && value <= record.exclusiveMinimum) problems.push(`${label} must be greater than ${record.exclusiveMinimum}`);
    if (typeof record.exclusiveMaximum === "number" && value >= record.exclusiveMaximum) problems.push(`${label} must be less than ${record.exclusiveMaximum}`);
  }
  if (record.type === "array" || Array.isArray(value) && record.items !== undefined) {
    if (!Array.isArray(value)) {
      problems.push(`${label} should be ${typeName(record)}`);
      return problems;
    }
    problems.push(...walkArray(record, value, path));
    return problems;
  }
  const nestedProps = propertiesOf(record);
  const nestedRequired = requiredOf(record);
  if (Object.keys(nestedProps).length === 0 && nestedRequired.length === 0) return problems;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (nestedRequired.length > 0) problems.push(`${label} should be ${schemaShape(record)}`);
    return problems;
  }
  const object = value as JsonRecord;
  for (const key of nestedRequired) {
    if (object[key] === undefined) problems.push(`missing ${path ? `${path}.${key}` : key}`);
  }
  for (const [key, nested] of Object.entries(nestedProps)) {
    if (object[key] === undefined) continue;
    problems.push(...walkProblems(nested, object[key], path ? `${path}.${key}` : key));
  }
  return problems;
}

export function validateCallArgs(schema: unknown, args: JsonRecord): string | null {
  const record = normalize(schema);
  const properties = propertiesOf(record);
  const required = requiredOf(record);
  const { schemas } = branches(record);
  if (required.length === 0 && Object.keys(properties).length === 0 && schemas.length <= 1) return null;
  const problems = walkProblems(record, args, "");
  if (problems.length === 0) return null;
  return `expected ${schemaShape(record)}. ${problems[0]}`;
}
