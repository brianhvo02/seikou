// SPDX-License-Identifier: LGPL-3.0-or-later

/** One result a browser example leaves on `window.__examples`. */
export interface ExampleResult {
  readonly file: string;
  readonly ok: boolean;
  readonly error?: string;
}

/** The marker the page carries, which the browser test looks for before it trusts what it finds. */
export const EXAMPLES_PAGE_MARKER = 'data-examples-page';

/**
 * The page that runs the browser examples (`*.browser.ts` files under `packages/<pkg>/examples/`): its HTML and the
 * source of the module it loads. The module imports every example (paths from the repository root), runs each one in
 * turn, records `{ file, ok, error }` on `window.__examples` and sets `window.__examplesDone` when all have run.
 * An example reads a fixture with `fetch('/developers/_examples/fixtures/<path>')`, where `<path>` is under
 * `fixtures/synthetic/`, or is `encodes/<path under fixtures/encodes/>`; `fixtures` lists the paths the page's build copies there.
 *
 * @param files The browser example files, as paths from the repository root.
 * @param fixtures The fixture files the examples read, as paths from the repository root.
 * @param entryUrl Where the page loads its module from.
 */
export function examplesPage(files: readonly string[], fixtures: readonly string[], entryUrl = './examples-entry.js'): { html: string; entry: string; fixtures: readonly string[] } {
  const imports = files.map((f, i) => `import example${i} from ${JSON.stringify(`/${f}`)};`).join('\n');
  const list = files.map((f, i) => `  [${JSON.stringify(f)}, example${i}],`).join('\n');
  const entry = `${imports}
const examples = [
${list}
];
const results = [];
window.__examples = results;
for (const [file, run] of examples) {
  try {
    await run();
    results.push({ file, ok: true });
  } catch (e) {
    results.push({ file, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
window.__examplesDone = true;
`;
  const html = `<!doctype html>
<html lang="en" ${EXAMPLES_PAGE_MARKER}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Examples</title>
</head>
<body>
<p>Running ${files.length} browser examples.</p>
<script type="module" src=${JSON.stringify(entryUrl)}></script>
</body>
</html>
`;
  return { html, entry, fixtures };
}
