import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

/**
 * The message contract, both ways.
 *
 * An extension and its webview talk by posting untyped objects at each other.
 * Nothing checks that the thing being posted is a thing anyone listens for, and
 * when it is not, nothing anywhere reports it: the extension posts, the webview
 * ignores it, and what the user sees is a button that does nothing. That is
 * indistinguishable from a feature nobody wrote, and it is the failure this
 * project keeps hitting — the drawer that would not open, the preview that
 * seemed to do nothing.
 *
 * The browser harness cannot see this, because the harness posts the messages
 * itself. If a command never posts one, every UI test still passes. So this
 * reads both halves of each panel and checks that every message has someone at
 * the other end.
 *
 * It found `rename`: the sidebar could rename a saved connection, the handler
 * was written, and no button had ever posted it.
 *
 * This supersedes the two message checks that used to live in
 * webview.test.ts. Those matched `case 'x':` literally, so the schema
 * explorer — which dispatches with `if (message.type === 'x')` — had to be
 * left out of the one that mattered, and neither ever looked for a handler
 * with nothing behind it. webview.test.ts keeps the checks that are its own:
 * that each script parses, acquires the API once, and reaches only for
 * elements the markup renders.
 */

const ROOT = path.resolve(__dirname, '..', '..');

/** Each panel: the file that runs in the extension host, the scripts it loads. */
const PANELS = [
  { name: 'the preview panel', host: 'src/panel/controller.ts', scripts: ['media/panel.js'] },
  {
    name: 'the schema explorer',
    host: 'src/panel/schemaPanel.ts',
    scripts: ['media/schema.js', 'media/schema-editor.js'],
  },
  { name: 'the index advisor', host: 'src/panel/indexPanel.ts', scripts: ['media/indexes.js'] },
  { name: 'the sidebar', host: 'src/panel/sidebar.ts', scripts: ['media/sidebar.js'] },
];

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

/**
 * The index just past a matching close brace, skipping anything inside a
 * string, a template literal or a comment.
 *
 * Counting raw braces desynchronises on the first `'{'` in a SQL fragment and
 * then returns a slice of the wrong part of the file, which is worse than not
 * looking: the checks below would quietly pass on nothing.
 */
function blockAt(source: string, open: number): string {
  let depth = 0;

  for (let at = open; at < source.length; at += 1) {
    const here = source[at];
    const next = source[at + 1];

    if (here === '/' && next === '/') {
      at = source.indexOf('\n', at);
      if (at < 0) break;
      continue;
    }
    if (here === '/' && next === '*') {
      at = source.indexOf('*/', at) + 1;
      continue;
    }
    if (here === "'" || here === '"' || here === '`') {
      const quote = here;
      at += 1;
      while (at < source.length && source[at] !== quote) {
        // 92 is a backslash. Written as a code point so this line survives
        // every layer that would otherwise eat the escape.
        at += source.charCodeAt(at) === 92 ? 2 : 1;
      }
      continue;
    }

    if (here === '{') {
      depth += 1;
    } else if (here === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open, at + 1);
      }
    }
  }

  throw new Error('unbalanced braces looking for a switch body');
}

/**
 * Every message type this source dispatches on.
 *
 * Two forms, because both are used: a `switch` on the type, and a chain of
 * `if (message.type === '…')`. Only switches on a `type` are read, so the
 * `switch (state.kind)` elsewhere in the same file contributes nothing.
 */
function handles(source: string): Set<string> {
  const found = new Set<string>();

  for (const match of source.matchAll(/switch\s*\(\s*(?:\w+\.)?type\s*\)\s*\{/g)) {
    const body = blockAt(source, match.index + match[0].length - 1);
    for (const label of body.matchAll(/case\s+'([A-Za-z0-9]+)'/g)) {
      found.add(label[1]!);
    }
  }

  for (const match of source.matchAll(/(?:\w+\.type|\w+\['type'\])\s*===\s*'([A-Za-z0-9]+)'/g)) {
    found.add(match[1]!);
  }

  return found;
}

/**
 * Every message type this source posts.
 *
 * `type` must be the first key, which is how every call in this codebase is
 * written and is what keeps a column literal like `{ name: 'id', type:
 * 'bigserial' }` from being read as a message.
 */
function posts(source: string): Set<string> {
  const found = new Set<string>();
  for (const match of source.matchAll(/\bpost(?:Message)?\(\s*\{\s*type:\s*'([A-Za-z0-9]+)'/g)) {
    found.add(match[1]!);
  }
  return found;
}

const missing = (from: Set<string>, to: Set<string>) => [...from].filter((t) => !to.has(t)).sort();

describe('the message contract between each panel and its webview', () => {
  for (const panel of PANELS) {
    describe(panel.name, () => {
      const host = read(panel.host);
      const web = panel.scripts.map(read).join('\n');

      it('reads both halves', () => {
        // If an extraction breaks, every check below passes on an empty set.
        assert.ok(posts(host).size > 0, `nothing posted in ${panel.host}`);
        assert.ok(handles(web).size > 0, `nothing handled in ${panel.scripts.join(', ')}`);
        assert.ok(posts(web).size > 0, `the webview posts nothing back`);
        assert.ok(handles(host).size > 0, `${panel.host} handles nothing`);
      });

      it('has a listener for everything the extension sends', () => {
        assert.deepEqual(
          missing(posts(host), handles(web)),
          [],
          'the extension posts these and the webview ignores them, silently',
        );
      });

      it('sends everything the webview listens for', () => {
        assert.deepEqual(
          missing(handles(web), posts(host)),
          [],
          'the webview handles these and nothing ever sends them',
        );
      });

      it('has a handler for everything the webview sends back', () => {
        assert.deepEqual(
          missing(posts(web), handles(host)),
          [],
          'the webview posts these and the extension ignores them — a dead button',
        );
      });

      it('sends everything the extension listens for', () => {
        assert.deepEqual(
          missing(handles(host), posts(web)),
          [],
          'the extension handles these and no control ever posts them',
        );
      });
    });
  }
});

/**
 * The other contract: command identifiers.
 *
 * A command declared in the manifest and never registered still appears in the
 * palette, and running it says "command 'dryrun.x' not found" — which reads as
 * the extension being broken rather than as one string being wrong. A command
 * registered and never declared cannot be found at all. A `data-command` on a
 * sidebar button that names neither is a button that does nothing, which is the
 * same silent failure as a missing message handler and is caught the same way.
 */
describe('the command identifiers', () => {
  const manifest = JSON.parse(read('package.json')) as {
    contributes: {
      commands?: { command: string }[];
      keybindings?: { command: string }[];
      menus?: Record<string, { command: string }[]>;
    };
  };

  const declared = new Set((manifest.contributes.commands ?? []).map((one) => one.command));

  const registered = new Set(
    [...read('src/extension.ts').matchAll(/registerCommand\(\s*'([^']+)'/g)].map((m) => m[1]!),
  );

  const onButtons = new Set(
    [...read('src/panel/html.ts').matchAll(/data-command="([^"]+)"/g)].map((m) => m[1]!),
  );

  it('reads all three lists', () => {
    assert.ok(declared.size > 0);
    assert.ok(registered.size > 0);
    assert.ok(onButtons.size > 0);
  });

  it('registers every command the manifest declares', () => {
    assert.deepEqual(missing(declared, registered), [], 'these appear in the palette and fail');
  });

  it('declares every command it registers', () => {
    assert.deepEqual(missing(registered, declared), [], 'these cannot be found from the palette');
  });

  it('puts a real command behind every button in the sidebar', () => {
    assert.deepEqual(missing(onButtons, declared), [], 'these buttons do nothing');
  });

  it('binds keys and menu entries to commands that exist', () => {
    const referenced = new Set([
      ...(manifest.contributes.keybindings ?? []).map((one) => one.command),
      ...Object.values(manifest.contributes.menus ?? {}).flatMap((entries) =>
        entries.map((one) => one.command),
      ),
    ]);
    assert.deepEqual(missing(referenced, declared), []);
  });
});

/**
 * The README, against what the extension actually contributes.
 *
 * Documentation drifts silently and is read by exactly the people who cannot
 * check it. This file already found the two worst kinds: a Limitations section
 * still saying "Postgres only. MySQL and MongoDB are scaffolded but not
 * implemented" three hundred lines under a table describing how all three
 * behave, and a Safety section promising "credentials are never stored" after
 * saved connections started going to the OS keychain. The first is
 * embarrassing; the second is a safety claim that was not true.
 *
 * Only presence is checked. Whether the sentence next to it is any good is not
 * something a test can know.
 */
describe('the README, against what the extension contributes', () => {
  const readme = read('README.md');
  const manifest = JSON.parse(read('package.json')) as {
    contributes: {
      commands?: { command: string; title: string }[];
      configuration?: { properties?: Record<string, unknown> };
    };
  };

  it('documents every setting', () => {
    const settings = Object.keys(manifest.contributes.configuration?.properties ?? {});
    assert.ok(settings.length > 0);
    assert.deepEqual(
      settings.filter((name) => !readme.includes(name)),
      [],
      'these are configurable and nothing says so',
    );
  });

  it('documents every command', () => {
    const titles = (manifest.contributes.commands ?? []).map((one) => one.title);
    assert.ok(titles.length > 0);
    assert.deepEqual(
      titles.filter((title) => !readme.includes(title)),
      [],
      'these appear in the palette and nothing says what they do',
    );
  });

  it('does not still say the other two engines are unimplemented', () => {
    // The specific sentence that was wrong, kept as a tripwire: this claim is
    // the one most likely to be reintroduced by someone copying an old section.
    assert.doesNotMatch(readme, /scaffolded but not implemented/i);
    assert.doesNotMatch(readme, /\bPostgres only\b/i);
  });

  it('does not claim credentials are never stored, because they can be', () => {
    assert.doesNotMatch(readme, /[Cc]redentials are never stored/);
    assert.match(readme, /SecretStorage|keychain/, 'and says where they go instead');
  });
});
