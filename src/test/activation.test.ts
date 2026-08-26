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

describe('starting the extension', () => {
  let recorded: Recorded;
  let context: { subscriptions: { dispose(): void }[] };
  let uninstall: () => void;
  let extension: { activate(context: unknown): void; deactivate?(): void };

  before(() => {
    const stub = makeVscodeStub();
    recorded = stub.recorded;
    context = stub.context;
    uninstall = installVscode(stub.api);

    // Required after the stub is installed, so its own `import * as vscode`
    // resolves to it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    extension = require('../extension') as typeof extension;
  });

  after(() => {
    uninstall();
  });

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
