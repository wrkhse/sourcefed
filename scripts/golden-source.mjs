const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const WIDTH = 80;

export function goldenSource(fixture, constant, header) {
  // Preserve the recorder's JSON conversion for values returned by providers.
  const value = JSON.parse(JSON.stringify(fixture));
  const source = formatValue(value, "");

  return `import type { GoldenFixture } from "@sourcefed/sdk";

${header}
export const ${constant}: GoldenFixture = ${source};
`;
}

function isPrimitive(value) {
  return value === null || typeof value !== "object";
}

function formatValue(value, indent, width = WIDTH - indent.length - 1) {
  if (isPrimitive(value)) return JSON.stringify(value);

  const inner = `${indent}  `;

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";

    if (value.every(isPrimitive)) {
      const primitives = value.map((item) => JSON.stringify(item));
      const inline = `[${primitives.join(", ")}]`;

      if (inline.length <= width) return inline;
    }

    const items = value.map((item) => `${inner}${formatValue(item, inner)},`);

    return `[\n${items.join("\n")}\n${indent}]`;
  }

  const entries = Object.entries(value);

  if (entries.length === 0) return "{}";

  const properties = entries.map(([key, item]) =>
    formatProperty(key, item, inner),
  );

  return `{\n${properties.join("\n")}\n${indent}}`;
}

function formatProperty(key, value, indent) {
  const name = IDENTIFIER.test(key) ? key : JSON.stringify(key);
  const prefix = `${indent}${name}: `;
  const width = WIDTH - prefix.length - 1;
  const source = formatValue(value, indent, width);

  if (isPrimitive(value) && source.length > width)
    return `${indent}${name}:\n${indent}  ${source},`;

  return `${prefix}${source},`;
}
