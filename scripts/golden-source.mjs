const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function goldenSource(fixture, constant, header) {
  // Preserve the recorder's JSON conversion for values returned by providers.
  const value = JSON.parse(JSON.stringify(fixture));
  const source = formatValue(value, "");

  return `import type { GoldenFixture } from "@sourcefed/sdk";

${header}
export const ${constant}: GoldenFixture = ${source};
`;
}

function formatValue(value, indent) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);

  const inner = `${indent}  `;

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";

    const items = value.map((item) => `${inner}${formatValue(item, inner)},`);

    return `[\n${items.join("\n")}\n${indent}]`;
  }

  const entries = Object.entries(value);

  if (entries.length === 0) return "{}";

  const properties = entries.map(([key, item]) => {
    const name = IDENTIFIER.test(key) ? key : JSON.stringify(key);
    return `${inner}${name}: ${formatValue(item, inner)},`;
  });

  return `{\n${properties.join("\n")}\n${indent}}`;
}
