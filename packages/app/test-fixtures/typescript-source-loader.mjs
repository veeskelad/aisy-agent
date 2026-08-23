// Test-only ESM resolver for Node's native type stripping. Production source
// uses emitted `.js` specifiers; this maps them to sibling `.ts` files when the
// integration fixture deliberately executes the source tree without a build.
import { readFile } from 'node:fs/promises'

import ts from '../node_modules/typescript/lib/typescript.js'

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.endsWith('.js')) throw error
    return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
  }
}

// Native strip-only mode intentionally rejects parameter properties and other
// transform-requiring syntax. Real-process fixtures still execute the source
// graph, so compile only local TypeScript modules in-memory with the workspace's
// pinned compiler. No emitted file or production loader is involved.
export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:') || (!url.endsWith('.ts') && !url.endsWith('.mts'))) {
    return nextLoad(url, context)
  }
  const source = await readFile(new URL(url), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      sourceMap: false,
      inlineSourceMap: false,
      verbatimModuleSyntax: true,
    },
    fileName: new URL(url).pathname,
  }).outputText
  return { format: 'module', shortCircuit: true, source: output }
}
