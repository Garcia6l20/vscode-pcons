#!/usr/bin/env node
// Refresh the vendored cmake-tools diagnostic parsers in
// src/vendor/cmake-tools/diagnostics/ from upstream.
//
// Downloads the four source files from microsoft/vscode-cmake-tools and reapplies
// the local edits: an attribution header, relative imports, and an inlined `reduce`
// (so the upstream `@cmt/util` dependency is dropped). Idempotent.
//
// Usage: node scripts/update-vendored-diagnostics.mjs [ref]
//   ref - git branch, tag, or commit to pull from (default: main)

import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ref = process.argv[2] ?? 'main';
const repo = 'microsoft/vscode-cmake-tools';
const files = ['gcc.ts', 'gnu-ld.ts', 'msvc.ts', 'util.ts'];

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/vendor/cmake-tools/diagnostics');

const ATTRIBUTION = ' * Vendored from microsoft/vscode-cmake-tools (MIT). See THIRD_PARTY_NOTICES.md.';

const REDUCE = `function reduce<T, U>(iterable: Iterable<T>, initial: U, fn: (acc: U, item: T) => U): U {
    let acc = initial;
    for (const item of iterable) {
        acc = fn(acc, item);
    }
    return acc;
}`;

// Insert the attribution line before the closing `*/` of the leading block comment.
function addAttribution(src) {
    return src.replace(/\n \*\//, `\n *\n${ATTRIBUTION}\n */`);
}

function transform(name, src) {
    let out = addAttribution(src);
    // Cross-imports between the vendored files become relative.
    out = out.replace(/'@cmt\/diagnostics\/util'/g, "'./util'");
    if (name === 'util.ts') {
        // Drop the upstream @cmt/util dependency by inlining its one used helper.
        out = out.replace(/^import \{ reduce \} from '@cmt\/util';\n/m, '');
        out = out.replace(
            /(import \* as vscode from 'vscode';\n)/,
            `$1\n${REDUCE}\n`,
        );
    }
    return out;
}

async function fetchFile(name) {
    const url = `https://raw.githubusercontent.com/${repo}/${ref}/src/diagnostics/${name}`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`${url} -> HTTP ${res.status}`);
    }
    return res.text();
}

await mkdir(outDir, { recursive: true });
for (const name of files) {
    const raw = await fetchFile(name);
    const out = transform(name, raw);
    if (out.includes('@cmt/')) {
        throw new Error(`${name}: unresolved @cmt import after transform, upstream layout may have changed`);
    }
    await writeFile(resolve(outDir, name), out);
    console.log(`updated ${name}`);
}
console.log(`Done (ref: ${ref}). Review the diff, then run: npm run compile`);
