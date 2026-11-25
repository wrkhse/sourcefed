export function goldenSource(fixture, constant, header) {
  const source = JSON.stringify(fixture, null, 2);

  return `import type { GoldenFixture } from "@sourcefed/sdk";

${header}
export const ${constant}: GoldenFixture = ${source};
`;
}
