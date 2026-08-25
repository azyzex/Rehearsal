const esbuild = require('esbuild');
const fs = require('node:fs');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const shared = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

async function main() {
  // A production build must not ship whatever a previous dev build left here.
  // Source maps are 8MB of the two bundles combined, and `sourcemap: false`
  // does not delete the ones already written — it just stops writing new ones.
  if (production) {
    fs.rmSync('dist', { recursive: true, force: true });
  }

  const contexts = await Promise.all([
    esbuild.context({
      ...shared,
      entryPoints: ['src/extension.ts'],
      outfile: 'dist/extension.js',
      // Provided by the editor at runtime and not resolvable at build time.
      external: ['vscode'],
    }),
    // The same analysis without an editor, for a pull request. It must not
    // pull in `vscode`, and bundling it separately is what enforces that: an
    // accidental import fails the build rather than failing at run time in CI.
    esbuild.context({
      ...shared,
      entryPoints: ['src/cli/main.ts'],
      outfile: 'dist/cli.js',
      banner: { js: '#!/usr/bin/env node' },
    }),
  ]);

  if (watch) {
    await Promise.all(contexts.map((ctx) => ctx.watch()));
  } else {
    await Promise.all(contexts.map((ctx) => ctx.rebuild()));
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
