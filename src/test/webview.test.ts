import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

/**
 * Static checks on the webview scripts.
 *
 * There are no unit tests for the webview code — it needs a DOM — so these are
 * the cheap structural checks that catch the failures which are otherwise
 * completely silent. A thrown error in a webview script does not fail a build,
 * does not appear in any log the user would open, and looks exactly like a
 * feature nobody wrote.
 *
 * This file exists because of one such bug: `acquireVsCodeApi()` may be called
 * once per webview, and two scripts in the same panel both called it. The
 * second threw on its first line, so the entire visual editor was dead while
 * the diagram beside it worked perfectly. Clicking a table did nothing, and
 * there was nothing to see anywhere.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const MEDIA = path.join(ROOT, 'media');
const PANELS = path.join(ROOT, 'src', 'panel');

/** The script files each panel loads, read out of its HTML. */
function scriptsFor(controller: string): string[] {
  const source = fs.readFileSync(path.join(PANELS, controller), 'utf8');
  // Either quote style: these calls sit inside a template literal holding HTML,
  // and the formatter rewrites the quotes there without asking.
  return [...source.matchAll(/media\(['"]([^'"]+\.js)['"]\)/g)].map((match) => match[1]!);
}

/** Removes // and block comments, so prose about a call is not counted as one. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^.*?\/\/.*$/gm, (line) => {
    const at = line.indexOf('//');
    return line.slice(0, at);
  });
}

const panels: Record<string, string[]> = {
  'controller.ts': scriptsFor('controller.ts'),
  'schemaPanel.ts': scriptsFor('schemaPanel.ts'),
  'indexPanel.ts': scriptsFor('indexPanel.ts'),
};

describe('webview scripts', () => {
  it('finds the scripts each panel loads', () => {
    assert.deepEqual(panels['controller.ts'], ['panel.js']);
    assert.deepEqual(panels['schemaPanel.ts'], ['schema.js', 'schema-editor.js']);
    assert.deepEqual(panels['indexPanel.ts'], ['indexes.js']);
  });

  for (const [panel, scripts] of Object.entries(panels)) {
    it(`${panel} acquires the VS Code API exactly once`, () => {
      // Calling it twice in one webview throws on the second call, killing
      // whichever script ran second in its entirety.
      const calls = scripts.reduce((count, script) => {
        // Comments are stripped first: the file that explains why it does *not*
        // call this names it, and a comment is not a call.
        const source = stripComments(fs.readFileSync(path.join(MEDIA, script), 'utf8'));
        return count + (source.match(/acquireVsCodeApi\s*\(/g) ?? []).length;
      }, 0);

      assert.equal(
        calls,
        1,
        `${panel} loads ${scripts.join(' + ')} and calls acquireVsCodeApi() ${calls} times. ` +
          `It may be called once per webview; share the handle instead.`,
      );
    });

    for (const script of scripts) {
      it(`${script} parses`, () => {
        // A syntax error here is silent at build time — the bundler never sees
        // these files, they are loaded straight from disk by the webview.
        const source = fs.readFileSync(path.join(MEDIA, script), 'utf8');
        assert.doesNotThrow(() => new Function(source), `${script} does not parse`);
      });
    }
  }

  it('every element the scripts reach for exists in the HTML that loads them', () => {
    // getElementById returns null rather than throwing, so a renamed element
    // becomes a TypeError on first use — often long after startup, in a branch
    // nobody exercised.
    for (const [panel, scripts] of Object.entries(panels)) {
      const html = fs.readFileSync(path.join(PANELS, panel), 'utf8');
      const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]!));

      for (const script of scripts) {
        const source = fs.readFileSync(path.join(MEDIA, script), 'utf8');
        for (const match of source.matchAll(/getElementById\('([^']+)'\)/g)) {
          const id = match[1]!;
          assert.ok(
            ids.has(id),
            `${script} looks for #${id}, which ${panel} does not render`,
          );
        }
      }
    }
  });

  it('the editor half only talks to the diagram through the bridge', () => {
    // Two files sharing one webview is workable only while the surface between
    // them stays small and explicit.
    const editor = fs.readFileSync(path.join(MEDIA, 'schema-editor.js'), 'utf8');
    const bridge = fs.readFileSync(path.join(MEDIA, 'schema.js'), 'utf8');

    const used = new Set([...editor.matchAll(/host\.(\w+)\(/g)].map((m) => m[1]!));
    for (const method of used) {
      assert.match(
        bridge,
        new RegExp(`\\b${method}\\s*\\(`),
        `schema-editor.js calls host.${method}(), which schema.js does not expose`,
      );
    }
  });

  it('every message a webview sends is handled by its panel', () => {
    // The two halves of a feature land in different files, and a message with
    // no case on the other side is silent in both directions: the button works,
    // the panel does nothing, and nothing anywhere says why.
    for (const [panel, scripts] of Object.entries(panels)) {
      const controller = stripComments(fs.readFileSync(path.join(PANELS, panel), 'utf8'));

      for (const script of scripts) {
        const source = stripComments(fs.readFileSync(path.join(MEDIA, script), 'utf8'));
        for (const match of source.matchAll(/postMessage\(\{\s*type:\s*'(\w+)'/g)) {
          const type = match[1]!;
          assert.ok(
            controller.includes(`'${type}'`),
            `${script} sends { type: '${type}' }, which ${panel} never handles`,
          );
        }
      }
    }
  });

  // schemaPanel.ts posts through a single helper, so what it sends cannot be
  // read off the source the way these two can.
  for (const [panel, script] of [
    ['controller.ts', 'panel.js'],
    ['indexPanel.ts', 'indexes.js'],
  ]) {
    it(`every message ${panel} sends is handled by ${script}`, () => {
      // The same gap the other way round: a measurement is computed, posted,
      // and dropped on the floor.
      const controller = stripComments(fs.readFileSync(path.join(PANELS, panel!), 'utf8'));
      const source = stripComments(fs.readFileSync(path.join(MEDIA, script!), 'utf8'));

      const sent = new Set(
        [...controller.matchAll(/postMessage\(\{\s*type:\s*'(\w+)'/g)].map((m) => m[1]!),
      );
      assert.ok(sent.size > 0, 'found no outgoing messages at all — the regex has rotted');

      for (const type of sent) {
        assert.match(
          source,
          new RegExp(`case '${type}':`),
          `${panel} sends { type: '${type}' }, which ${script} never handles`,
        );
      }
    });
  }
});
