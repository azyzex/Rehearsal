import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Recorded, installVscode, makeContext, makeVscodeStub } from './support/vscodeStub';

/**
 * Starting the extension.
 *
 * `activate()` is the one function nothing could reach: it is not called by any
 * test, it cannot be imported without a `vscode` module to resolve, and if it
 * throws, the whole extension does nothing at all — no icon in the activity
 * bar, no commands in the palette, and no message anywhere saying why. The
 * user's report for that is "I clicked the thing and nothing happened", which
 * is the same report as for every other bug in this project.
 *
 * The other tests check that the manifest and the source agree about command
 * names. This checks that the code registering them actually runs.
 */

/**
 * One stub for the whole file.
 *
 * The extension module binds its `import * as vscode` the first time it is
 * required and keeps that binding, so a second stub installed later would be
 * ignored — the module would go on registering commands into the first one,
 * and a test reading the second would find an empty map.
 */
const stub = makeVscodeStub();
const uninstall = installVscode(stub.api);
const recorded: Recorded = stub.recorded;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const extension = require('../extension') as {
  activate(context: unknown): void;
  deactivate?(): void;
};

describe('starting the extension', () => {
  const context = stub.context as { subscriptions: { dispose(): void }[] };

  it('activates without throwing', () => {
    // The whole point. Everything below is only meaningful if this passed.
    extension.activate(context);
  });

  it('registers every command the manifest declares', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const manifest = require('../../package.json') as {
      contributes: { commands: { command: string }[] };
    };

    const missing = manifest.contributes.commands
      .map((one) => one.command)
      .filter((id) => !recorded.commands.has(id));

    assert.deepEqual(missing, [], 'these are in the palette and would say "command not found"');
  });

  it('puts the view in the activity bar', () => {
    // Without this the icon opens an empty panel, which is the first thing
    // anyone sees.
    assert.ok(
      recorded.webviewViewProviders.has('dryrun.sidebar'),
      `registered ${[...recorded.webviewViewProviders.keys()].join(', ') || 'nothing'}`,
    );
  });

  it('opens somewhere to write to, and somewhere to put problems', () => {
    assert.deepEqual(recorded.outputChannels, ['Dry Run']);
    assert.equal(recorded.diagnosticCollections.length, 1);
  });

  it('says nothing to the user on the way up', () => {
    // A notification during activation fires on every window that opens a
    // workspace, before anyone has asked for anything.
    assert.deepEqual(recorded.shown, []);
  });

  it('registers everything it made for disposal', () => {
    // A webview provider or an output channel that outlives a reload leaks one
    // per reload, and the leaked one still holds a database connection.
    assert.ok(
      context.subscriptions.length >= 12,
      `only ${context.subscriptions.length} things will be cleaned up`,
    );

    for (const subscription of context.subscriptions) {
      assert.equal(
        typeof subscription.dispose,
        'function',
        'something in subscriptions cannot be disposed, which throws on reload',
      );
    }
  });

  it('shuts down without throwing', () => {
    for (const subscription of context.subscriptions) {
      subscription.dispose();
    }
    extension.deactivate?.();
  });

  it('activates a second time cleanly', () => {
    // Reloading the window does exactly this. A module-level singleton that
    // survived the first activation fails here rather than in the wild.
    //
    // Against the same API object, because the module bound its
    // `import * as vscode` once when it was loaded — only the context is new,
    // which is the half that really is new on a reload.
    const before = recorded.shown.length;
    const second = makeContext() as { subscriptions: { dispose(): void }[] };

    extension.activate(second);

    assert.ok(second.subscriptions.length >= 12, 'the second activation registered nothing');
    assert.equal(recorded.shown.length, before, 'it complained on the way up the second time');

    for (const subscription of second.subscriptions) {
      subscription.dispose();
    }
  });
});

/**
 * Running each command with nothing connected.
 *
 * "It says connected but the actions do nothing" is on the manual list, and the
 * version of it that matters more is the one before connecting: every command
 * in the palette is runnable the moment the extension loads, and each one has
 * to say something useful rather than throwing into a log nobody opens.
 *
 * There is no database here and no workspace folder, which is exactly the state
 * a first-time user is in.
 */
describe('every command, with nothing connected', () => {
  before(() => {
    // The commands registered by the activation above are still in place.
    assert.ok(recorded.commands.size > 0, 'nothing was registered to run');
  });

  after(() => {
    uninstall();
  });

  it('runs all of them without any of them throwing', async () => {
    const failed: string[] = [];

    for (const [id, handler] of recorded.commands) {
      try {
        await handler();
      } catch (error) {
        failed.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    assert.deepEqual(failed, [], 'a command in the palette threw with nothing connected');
  });

  it('says what is wrong rather than saying nothing', async () => {
    // Every one of these needs a connection, so every one of them should have
    // said so by now. Silence is the failure being described here: the command
    // runs, nothing appears, and the extension looks broken.
    const needsConnection = [
      'dryrun.exploreSchema',
      'dryrun.schemaHealth',
      'dryrun.suggestIndexes',
      'dryrun.pendingMigrations',
      'dryrun.compareSchemas',
    ];

    for (const id of needsConnection) {
      const before = recorded.shown.length;
      await recorded.commands.get(id)!();
      assert.ok(
        recorded.shown.length > before,
        `${id} did nothing at all and said nothing about it`,
      );
    }
  });

  it('says it is not connected, in words, not in a stack trace', async () => {
    recorded.shown.length = 0;
    await recorded.commands.get('dryrun.exploreSchema')!();

    const said = recorded.shown.map((one) => one.message).join('\n');
    assert.match(said, /not connected/i);
    assert.doesNotMatch(said, /\bat .*\.js:\d+/, 'a stack trace reached the user');
    assert.doesNotMatch(said, /undefined|\[object Object\]/);
  });

  it('never shows an empty message', async () => {
    // The empty red box, one layer further out. A message with no words in it
    // tells the reader less than no message would have.
    const blank = recorded.shown.filter((one) => one.message.trim().length === 0);
    assert.deepEqual(blank, []);
  });
});
