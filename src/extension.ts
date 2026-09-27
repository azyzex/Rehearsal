import * as vscode from 'vscode';
import { describeError, isConnectionLost } from './errors';
import { buildDiagram } from './analysis/impact';
import { editsFromClassifications } from './edit/fromSql';
import { findOffenders } from './analysis/offenders';
import { describeScan, scanReferences } from './analysis/references';
import { relative, workspaceSourceFiles } from './analysis/workspaceFiles';
import { analyzeStatements } from './analysis/orchestrator';
import { rankSeverity } from './panel/controller';
import { Finding, Severity, Thresholds } from './analysis/types';
import { ConnectionManager, ProductionRefusedError } from './connection/manager';
import { engineName } from './connection/detect';
import { ConnectionResolutionError } from './connection/resolve';
import { PreviewPanel } from './panel/controller';
import { FindingDiagnostics } from './panel/diagnostics';
import { RewriteActions } from './panel/quickFixes';
import { StatusBar } from './panel/statusBar';
import { RecentPreviews } from './panel/recent';
import { StatementLenses, TableHover } from './panel/editorLens';
import { buildSample } from './sample/sampleDatabase';
import { compareWithPrisma, driftReport, parsePrisma } from './analysis/prismaDrift';
import { SchemaSnapshot } from './adapters/types';
import { Sidebar } from './panel/sidebar';
import { SavedConnections } from './connection/saved';
import { AppliedChangeset, ChangesetHistory, describeEntry } from './edit/history';
import { SchemaPanel } from './panel/schemaPanel';
import { CandidateResult, IndexPanel } from './panel/indexPanel';
import { IndexCandidate, indexCandidates, seqScans } from './analysis/indexAdvice';
import { StatementLanguage, languageFor } from './parser/language';
import { MigrationFile, findMigrations } from './migrations/discover';
import { readLedger } from './migrations/ledger';
import { healthReport } from './analysis/healthReport';
import { columnSections, findColumnOpportunities } from './analysis/columnFindings';
import { compareSchemas, comparisonReport } from './analysis/compare';
import { adapterFor } from './adapters/select';
import { APPLICATION_NAME } from './constants';

export function activate(context: vscode.ExtensionContext): void {
  const connections = new ConnectionManager(context.workspaceState);
  const output = vscode.window.createOutputChannel('Rehearsal');
  // The panel is the product, but the panel is also something you have to be
  // looking at. These put the same findings in the Problems view, the ruler and
  // the tab's badge, none of which needed building.
  const diagnostics = new FindingDiagnostics();
  // Applying is the one irreversible thing here, and until this it left no
  // trace outside the database itself.
  const history = new ChangesetHistory(context.workspaceState);

  // The front door. Connections live in the OS keychain; only their labels go
  // in global state, so the list can be drawn without touching a credential.
  const saved = new SavedConnections(context.globalState, context.secrets);
  // The last few files previewed here, so measuring one again is one click.
  const recent = new RecentPreviews(context.workspaceState);
  const sidebar = new Sidebar(context, {
    connections,
    saved,
    recent,
    run: (command) => void vscode.commands.executeCommand(command),
    // Quiet: the sidebar puts the failure in a red box of its own, and a
    // notification repeating it word for word is the tool talking over itself.
    report: (error) => reportError(error, output, connections, true),
  });

  context.subscriptions.push(
    connections,
    output,
    diagnostics,
    // The safer statement, offered where the unsafe one is written. Built from
    // the same measurement the squiggle came from, so an offer can never
    // describe a statement other than the one that was measured.
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file' },
      new RewriteActions(diagnostics),
      RewriteActions.metadata,
    ),
    vscode.window.registerWebviewViewProvider(Sidebar.viewId, sidebar, {
      // Kept alive while hidden, so a half-typed connection string survives
      // the panel being collapsed.
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // The sidebar shows what is connected, and connecting happens elsewhere too
  // — through a command, or through the .env fallback. Both have to reach it.
  connections.onChanged(() => void sidebar.refresh());

  // Which database, and what the last preview said, in the one place in the
  // window that is always visible.
  const statusBar = new StatusBar();
  context.subscriptions.push(statusBar);
  const showConnection = (): void => {
    const current = connections.current;
    statusBar.showConnection(
      current
        ? {
            display: current.identity.display,
            engine: current.adapter.engine,
            lost: connections.lost,
          }
        : undefined,
    );
  };
  connections.onChanged(showConnection);
  showConnection();

  // The schema for hovers, read once per connection and kept for a few
  // minutes. Only ever from a connection that is already open: a hover must
  // never be the thing that connects to a database.
  let schemaCache: { key: string; at: number; snapshot: Promise<SchemaSnapshot | undefined> } | undefined;
  const cachedSchema = (): Promise<SchemaSnapshot | undefined> => {
    const current = connections.current;
    if (!current) {
      return Promise.resolve(undefined);
    }
    const key = current.identity.display;
    if (!schemaCache || schemaCache.key !== key || Date.now() - schemaCache.at > 5 * 60_000) {
      schemaCache = {
        key,
        at: Date.now(),
        snapshot: current.adapter.schemaSnapshot().catch(() => undefined),
      };
    }
    return schemaCache.snapshot;
  };

  const migrationFiles: vscode.DocumentSelector = [
    { language: 'sql' },
    { pattern: '**/*.mongodb.js' },
    { pattern: '**/{migrations,operations}/*.js' },
  ];
  const lenses = new StatementLenses(diagnostics, () => connections.current?.adapter.engine);
  connections.onChanged(() => {
    schemaCache = undefined;
    lenses.refresh();
  });
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(migrationFiles, lenses),
    vscode.languages.registerHoverProvider(migrationFiles, new TableHover(cachedSchema)),
  );

  // One preview at a time. Two runs against one connection would interleave
  // their transactions, and the second would redraw rows the first is still
  // filling in.
  let previewing = false;
  const runPreview = async (saved?: vscode.TextDocument): Promise<void> => {
    if (previewing) {
      return;
    }
    previewing = true;
    try {
      const result = await preview(context, connections, output, diagnostics, saved);
      if (result) {
        connections.markAlive();
        statusBar.showVerdict(result.findings, result.file);
        await recent.add(result.uri, result.file, result.findings);
        void sidebar.refresh();
      }
    } finally {
      previewing = false;
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('rehearsal.preview', () => runPreview()),

    // What the Prisma schema believes against what the database is. Read from
    // the file, compared with a snapshot, written as a document: nothing runs.
    vscode.commands.registerCommand('rehearsal.ormDrift', async () => {
      try {
        const files = await vscode.workspace.findFiles('**/schema.prisma', '**/node_modules/**', 10);
        if (files.length === 0) {
          void vscode.window.showInformationMessage(
            'There is no schema.prisma in this workspace. Rehearsal compares Prisma schemas; ' +
              'Drizzle schemas are TypeScript, and reading them properly means running them.',
          );
          return;
        }

        let file = files[0]!;
        if (files.length > 1) {
          const picked = await vscode.window.showQuickPick(
            files.map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri })),
            { title: 'Which Prisma schema?' },
          );
          if (!picked) {
            return;
          }
          file = picked.uri;
        }

        const connection = await connections.acquire();
        const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
        const snapshot = await connection.adapter.schemaSnapshot();
        const drift = compareWithPrisma(parsePrisma(text), snapshot);

        const document = await vscode.workspace.openTextDocument({
          language: 'markdown',
          content: driftReport(drift, {
            schemaFile: vscode.workspace.asRelativePath(file),
            connection: connection.identity.display,
          }),
        });
        await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One });
      } catch (error) {
        reportError(error, output, connections);
      }
    }),

    // No database, no credentials, no setup: a small SQLite file in the
    // extension's own storage, a sample migration beside it, and a preview
    // with real numbers in it seconds after installing.
    vscode.commands.registerCommand('rehearsal.trySample', async () => {
      try {
        const sample = buildSample(vscode.Uri.joinPath(context.globalStorageUri, 'sample').fsPath);
        await connections.useConnectionString(`sqlite:${sample.database}`);
        const document = await vscode.workspace.openTextDocument(sample.migration);
        await vscode.window.showTextDocument(document, { preview: false });
        await runPreview(document);
      } catch (error) {
        reportError(error, output, connections);
      }
    }),

    // From a lens: select the one statement and preview the selection, which
    // is the path a hand selection already takes.
    vscode.commands.registerCommand(
      'rehearsal.previewStatement',
      async (uri?: vscode.Uri, start?: number, end?: number) => {
        // From the palette, or any caller without a statement: the whole file.
        if (!uri || typeof start !== 'number' || typeof end !== 'number') {
          await runPreview();
          return;
        }
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        editor.selection = new vscode.Selection(document.positionAt(start), document.positionAt(end));
        await runPreview();
      },
    ),

    // From the Explorer's right-click menu: measure a file without opening it
    // first. It is opened anyway, beside nothing, because a row in the panel
    // reveals its line and needs a document to reveal it in.
    vscode.commands.registerCommand('rehearsal.previewFile', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        return;
      }
      // Passed as the document rather than left to the active editor: from
      // the Explorer, or from the panel's Run again, the file is what was
      // asked for — not whatever happens to be selected in it.
      const document = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
      await runPreview(document);
    }),

    // Changing database without opening the sidebar. The sidebar's own
    // connect path does the work, so the two cannot drift apart — including
    // the message for an entry whose password is no longer in the keychain.
    vscode.commands.registerCommand('rehearsal.switchConnection', async () => {
      const current = connections.current?.identity.display;
      type Pick = vscode.QuickPickItem & { id?: string; action?: 'new' | 'disconnect' };

      const items: Pick[] = saved.all().map((entry) => ({
        label: `$(database) ${entry.label}`,
        description: engineName(entry.engine),
        detail: entry.label === current ? 'Connected now' : undefined,
        id: entry.id,
      }));

      items.push(
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        { label: '$(add) Connect to another database…', action: 'new' },
      );
      if (connections.current) {
        items.push({ label: '$(debug-disconnect) Disconnect', action: 'disconnect' });
      }

      const picked = await vscode.window.showQuickPick(items, {
        title: 'Rehearsal: switch database',
        placeHolder: current ? `Connected to ${current}` : 'Not connected',
        matchOnDescription: true,
      });

      if (!picked) {
        return;
      }
      if (picked.action === 'new') {
        await vscode.commands.executeCommand('rehearsal.sidebar.focus');
        return;
      }
      if (picked.action === 'disconnect') {
        await vscode.commands.executeCommand('rehearsal.disconnect');
        return;
      }
      if (picked.id) {
        await sidebar.connectSaved(picked.id);
      }
    }),

    // Saving is when a migration is finished being typed, which is exactly when
    // its measurements are worth having again. Deliberately narrow: only a file
    // the panel is already showing, only when a connection is already open, and
    // off unless asked for. A save must never be the thing that opens a
    // connection or queries a database nobody pointed at this file.
    vscode.workspace.onDidSaveTextDocument((document) => {
      const on = vscode.workspace
        .getConfiguration('rehearsal')
        .get<boolean>('previewOnSave', false);
      if (!on || !connections.current || !PreviewPanel.isShowing(document.uri)) {
        return;
      }
      void runPreview(document);
    }),

    vscode.commands.registerCommand('rehearsal.testConnection', async () => {
      try {
        const connection = await connections.acquire();
        const version = await connection.adapter.withRollback(async (tx) => {
          const result = await tx.query('SELECT version() AS v');
          return String(result.rows[0]?.['v'] ?? 'unknown');
        });
        connections.markAlive();
        output.appendLine(`Connected to ${connection.identity.display} (via ${connection.source})`);
        output.appendLine(version);
        void vscode.window.showInformationMessage(
          `Rehearsal connected to ${connection.identity.display}.`,
        );
      } catch (error) {
        reportError(error, output, connections);
      }
    }),

    vscode.commands.registerCommand('rehearsal.exploreSchema', () =>
      exploreSchema(context, connections, output, history),
    ),

    vscode.commands.registerCommand('rehearsal.appliedChanges', () => appliedChanges(history)),

    vscode.commands.registerCommand('rehearsal.suggestIndexes', () =>
      suggestIndexes(context, connections, output),
    ),

    vscode.commands.registerCommand('rehearsal.pendingMigrations', () =>
      pendingMigrations(context, connections, output, diagnostics),
    ),

    vscode.commands.registerCommand('rehearsal.schemaHealth', () =>
      schemaHealth(connections, output),
    ),

    vscode.commands.registerCommand('rehearsal.compareSchemas', () =>
      compareWithAnother(connections, output),
    ),

    vscode.commands.registerCommand('rehearsal.disconnect', async () => {
      await connections.close();
      void vscode.window.showInformationMessage('Rehearsal disconnected.');
    }),
  );
}

export function deactivate(): void {
  // Connections are disposed through context.subscriptions.
}

async function preview(
  context: vscode.ExtensionContext,
  connections: ConnectionManager,
  output: vscode.OutputChannel,
  diagnostics: FindingDiagnostics,
  /** Set when a save triggered this rather than the command. */
  saved?: vscode.TextDocument,
): Promise<{ findings: Finding[]; file: string; uri: vscode.Uri } | undefined> {
  const editor = saved
    ? vscode.window.visibleTextEditors.find(
        (candidate) => candidate.document.uri.toString() === saved.uri.toString(),
      )
    : vscode.window.activeTextEditor;

  const document = saved ?? editor?.document;
  if (!document) {
    void vscode.window.showWarningMessage('Rehearsal: open a SQL file first.');
    return;
  }

  // A selection means "just this bit". Otherwise the whole file, which is what
  // you want for a migration. A save always re-measures the whole file: the
  // selection that produced the last run is not necessarily still there, and
  // silently measuring a stale range is worse than measuring everything.
  const region = saved || !editor || editor.selection.isEmpty ? undefined : editor.selection;
  const selection = region ? document.getText(region) : undefined;
  const offset = region ? document.offsetAt(region.start) : 0;
  const text = selection ?? document.getText();

  const panel = PreviewPanel.show(context);
  let cancelled = false;

  try {
    // The connection comes first now, because how to read the file depends on
    // which database it is: two of the three engines take SQL and one does not.
    const connection = await connections.acquire();
    const language = languageFor(connection.adapter.engine);

    const statements = language.split(text).map((statement) => {
      if (!selection) {
        return statement;
      }
      // Shift line numbers so clicking a row still lands on the right line.
      const startLine = document.positionAt(offset + statement.startOffset).line;
      const endLine = document.positionAt(offset + statement.endOffset).line;
      return { ...statement, startLine, endLine };
    });

    if (statements.length === 0) {
      panel.begin(
        document,
        [],
        connection.identity.display,
        {
          onCancel: () => undefined,
          onShowOffenders: () => undefined,
          onShowReferences: () => undefined,
        },
        connection.adapter.engine,
      );
      panel.finish(`No ${language.noun}s found.`);
      return;
    }

    const classifications = statements.map((statement) => language.classify(statement.sql));

    panel.begin(document, statements, connection.identity.display, {
      onCancel: () => {
        cancelled = true;
      },
      // Fetched only when asked. A migration touching several large tables
      // would otherwise pay for rows nobody looks at.
      onShowOffenders: async (index) => {
        const classification = classifications[index];
        if (!classification) {
          return;
        }
        try {
          const offenders = await findOffenders(connection.adapter, classification, 25);
          panel.showOffenders(index, offenders ?? null);
        } catch (error) {
          output.appendLine(`Could not fetch the offending rows: ${errorMessage(error)}`);
          panel.showOffenders(index, null);
        }
      },

      // Reads every source file in the workspace, so it happens only when
      // someone asks the question it answers.
      onShowReferences: async (index) => {
        const classification = classifications[index];
        const target = classification?.column ?? classification?.table;
        if (!classification || !target) {
          return;
        }
        try {
          const workspace = await workspaceSourceFiles();
          const scan = await scanReferences(target, workspace);
          const label = classification.column
            ? `${classification.table}.${classification.column}`
            : String(classification.table);

          panel.showReferences(index, {
            summary: `${describeScan(scan, label)}${workspace.note ? ` ${workspace.note}` : ''}`,
            references: scan.references.slice(0, 100).map((reference) => ({
              ...reference,
              file: relative(reference.file),
            })),
            total: scan.references.length,
          });
        } catch (error) {
          output.appendLine(`Could not search the workspace: ${errorMessage(error)}`);
          panel.showReferences(index, null);
        }
      },
    }, connection.adapter.engine);

    diagnostics.begin(document, statements, connection.adapter.engine, offset);

    const findings: Finding[] = [];
    await analyzeStatements({
      adapter: connection.adapter,
      statements,
      thresholds: readThresholds(),
      isCancelled: () => cancelled,
      onFinding: (finding) => {
        findings.push(finding);
        panel.add(finding);
        diagnostics.add(finding);
      },
    });

    // The diagram needs the whole picture, so it is built after the rows have
    // all resolved rather than incrementally.
    if (!cancelled) {
      try {
        panel.showDiagram(await buildDiagram(connection.adapter, findings));
      } catch (error) {
        // A missing diagram is a worse panel, not a broken one — the rows
        // carry every measurement already.
        output.appendLine(`Diagram unavailable: ${errorMessage(error)}`);
      }
    }

    // If the schema explorer is open, put this file's impact on the real
    // diagram too. A migration and a visual edit go through the same
    // projection, so the two cannot tell different stories.
    const schema = SchemaPanel.open;
    if (!cancelled && schema?.hasSchema) {
      const { edits, indexes } = editsFromClassifications(findings.map((f) => f.classification));
      schema.showMigrationImpact({
        file: vscode.workspace.asRelativePath(document.uri),
        edits,
        labels: indexes.map((i) => findings[i]?.headline ?? ''),
        findings: indexes.map((i, position) => ({
          ...findings[i],
          statementIndex: position,
        })),
        summary: summarize(findings, statements.length, cancelled),
      });
    }

    panel.finish(summarize(findings, statements.length, cancelled));
    return cancelled
      ? undefined
      : { findings, file: vscode.workspace.asRelativePath(document.uri), uri: document.uri };
  } catch (error) {
    reportError(error, output, connections);
    panel.fail(
      errorMessage(error),
      error instanceof ConnectionResolutionError ? 'connect' : undefined,
    );
    return undefined;
  }
}

/**
 * Opens the schema explorer and keeps it fed.
 *
 * The panel holds no connection of its own: it asks through the host, which
 * means there is still exactly one connection and the editing session cannot
 * outlive it.
 */
async function exploreSchema(
  context: vscode.ExtensionContext,
  connections: ConnectionManager,
  output: vscode.OutputChannel,
  history: ChangesetHistory,
): Promise<void> {
  const load = async (panel: SchemaPanel): Promise<void> => {
    const connection = await connections.acquire();
    panel.loading(connection.identity.display);
    const snapshot = await connection.adapter.schemaSnapshot();
    panel.show(snapshot, connection.identity.display);
  };

  const panel = SchemaPanel.show(context, {
    adapter: () => connections.current?.adapter,
    thresholds: readThresholds,
    refresh: async () => {
      await load(panel).catch((error) => reportError(error, output, connections));
    },
    report: (error) => reportError(error, output, connections),
    history,
  });

  try {
    await load(panel);
  } catch (error) {
    reportError(error, output, connections);
    panel.fail(errorMessage(error));
  }
}

/**
 * What has been applied from here, and how to get back.
 *
 * Nothing on this list is executed. The down migration and the rescue file are
 * opened as documents, and getting back is done by previewing them like
 * anything else — which keeps the property the whole extension is built on:
 * nothing is written whose measured consequences have not already been shown.
 */
async function appliedChanges(history: ChangesetHistory): Promise<void> {
  const entries = history.all();
  if (entries.length === 0) {
    void vscode.window.showInformationMessage(
      'Nothing has been applied from Rehearsal in this workspace yet.',
    );
    return;
  }

  const chosen = await vscode.window.showQuickPick(
    entries.map((entry) => ({
      label: describeEntry(entry),
      description: new Date(entry.appliedAt).toLocaleString(),
      detail: `${entry.connection} — ${entry.summary}`,
      entry,
    })),
    { title: 'Applied changes', placeHolder: 'Which one?' },
  );

  if (!chosen) {
    return;
  }
  await offerRecovery(chosen.entry);
}

async function offerRecovery(entry: AppliedChangeset): Promise<void> {
  const actions: string[] = ['Show what ran'];
  if (entry.downSql) {
    actions.push('Open the down migration');
  }
  if (entry.rescueFile) {
    actions.push('Open the rescue file');
  }

  const action = await vscode.window.showQuickPick(actions, {
    title: describeEntry(entry),
    placeHolder: 'Nothing here runs anything. Each opens a file to review.',
  });

  if (action === 'Show what ran') {
    await openSql(
      `-- Applied ${entry.appliedAt} against ${entry.connection}\n` +
        `-- ${entry.summary}\n\n${entry.statements.map((sql) => `${sql};`).join('\n')}\n`,
    );
    return;
  }

  if (action === 'Open the down migration' && entry.downSql) {
    await openSql(entry.downSql);
    return;
  }

  if (action === 'Open the rescue file' && entry.rescueFile) {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const uri = folder
      ? vscode.Uri.joinPath(folder, entry.rescueFile)
      : vscode.Uri.file(entry.rescueFile);
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One });
    } catch {
      void vscode.window.showWarningMessage(
        `The rescue file is no longer at ${entry.rescueFile}.`,
      );
    }
  }
}

async function openSql(content: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument({ language: 'sql', content });
  await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One });
}

/**
 * Compares the connected database with another one.
 *
 * The question is nearly always the same: staging and production are supposed
 * to be the same shape, and something is happening in one of them that does not
 * happen in the other. The answer is usually a column somebody added by hand, or
 * a NOT NULL applied to one and forgotten on the other.
 *
 * The second connection is opened for the length of the comparison and closed
 * again. It is read the same way as the first — a catalogue query, no writes,
 * no transaction left open — and its connection string is never stored.
 */
async function compareWithAnother(
  connections: ConnectionManager,
  output: vscode.OutputChannel,
): Promise<void> {
  // The connection this one compares against, first. Asking for the second
  // string before knowing there is a first one means asking someone to type a
  // password for a comparison that cannot happen, and only then saying so —
  // and with nothing connected at all it used to close the box and say
  // nothing whatsoever.
  let connection;
  try {
    connection = await connections.acquire();
  } catch (error) {
    reportError(error, output, connections);
    return;
  }

  const other = await vscode.window.showInputBox({
    title: 'Compare with another database',
    prompt: `Connection string for the database to compare ${connection.identity.display} against. It is not saved.`,
    placeHolder: 'postgresql://user:password@host/database',
    password: true,
    ignoreFocusOut: true,
  });

  if (!other || other.trim().length === 0) {
    return;
  }

  // The adapter the *other* string asks for, not a Postgres one. This was
  // hardcoded, so comparing two MySQL databases opened a Postgres driver
  // against the second and failed with an error about the wrong protocol.
  const second = adapterFor(other.trim());

  if (second.engine !== connection.adapter.engine) {
    // Two engines describe a schema in different vocabularies — a MongoDB
    // collection has no nullability to differ on and no foreign keys to be
    // missing — so a diff between them would be a list of differences that are
    // not differences.
    void vscode.window.showWarningMessage(
      `Rehearsal compares two databases of the same kind. This connection is ` +
        `${connection.adapter.engine} and the one you gave is ${second.engine}.`,
    );
    return;
  }

  try {
    const { left, right } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Rehearsal: reading both schemas…' },
      async () => {
        const reference = await connection.adapter.schemaSnapshot();

        // The production guard is not applied to this one on purpose: it exists
        // to stop writes reaching a database nobody meant to touch, and the
        // only thing done here is a catalogue read. Refusing to *look at* a
        // production schema would make the feature useless for the case it
        // exists for.
        await second.connect({
          connectionString: other.trim(),
          statementTimeoutMs: 30_000,
          lockTimeoutMs: 5000,
          applicationName: APPLICATION_NAME,
        });

        return { left: reference, right: await second.schemaSnapshot() };
      },
    );

    const comparison = compareSchemas(left, right);
    const document = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: comparisonReport(comparison, {
        left: connection.identity.display,
        right: describeConnection(other),
      }),
    });
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One });

    if (comparison.identical) {
      void vscode.window.showInformationMessage('The two schemas match.');
    }
  } catch (error) {
    reportError(error, output, connections);
  } finally {
    // Closed whether or not it worked. A comparison that leaves a connection
    // open to a production database is a worse problem than the drift.
    await second.dispose().catch(() => undefined);
  }
}

/**
 * A connection string with the credential taken out.
 *
 * This goes in a document the user may well paste into a ticket, so the
 * password must not travel with it.
 */
function describeConnection(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    const database = url.pathname.replace(/^\//, '') || 'database';
    return `${database}@${url.hostname}`;
  } catch {
    return 'the other database';
  }
}

/**
 * Writes the schema health report.
 *
 * A markdown document rather than a panel: it can be pasted into the pull
 * request that adds the index, it is readable by someone without this
 * extension, and it diffs — running it again next month and looking at what
 * changed says more than any view of the present.
 */
async function schemaHealth(
  connections: ConnectionManager,
  output: vscode.OutputChannel,
): Promise<void> {
  try {
    const connection = await connections.acquire();
    const { health, extra } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Rehearsal: reading the catalogue…' },
      async (progress) => {
        const health = await connection.adapter.schemaHealth();

        // What the columns' own data says about them, where the engine keeps
        // statistics to start from. Each candidate is checked with an exact
        // count before it is reported.
        let extra: string[] = [];
        if (connection.adapter.columnStatistics) {
          progress.report({ message: 'checking what the data says about its columns…' });
          const statistics = await connection.adapter.columnStatistics().catch(() => []);
          const snapshot = await connection.adapter.schemaSnapshot();
          const rows = new Map(snapshot.tables.map((table) => [table.qualified, table.rows]));
          const findings = await findColumnOpportunities(connection.adapter, statistics, rows);

          // Columns nothing fills in are only interesting if nothing reads them
          // either, so those few get a search of the workspace.
          const references = new Map<string, number>();
          if (findings.neverFilled.length > 0) {
            const workspace = await workspaceSourceFiles().catch(() => undefined);
            if (workspace) {
              for (const entry of findings.neverFilled.slice(0, 10)) {
                const scan = await scanReferences(entry.column, workspace).catch(() => undefined);
                if (scan) {
                  references.set(`${entry.table}.${entry.column}`, scan.references.length);
                }
              }
            }
          }
          extra = columnSections(findings, references);
        }

        return { health, extra };
      },
    );

    const document = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: healthReport(health, {
        connection: connection.identity.display,
        engine: connection.adapter.engine,
        extra,
      }),
    });
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One });
  } catch (error) {
    reportError(error, output, connections);
  }
}

/**
 * Previews the migrations this database has not run yet.
 *
 * Prisma and Drizzle both generate SQL and then warn about it without a number
 * in the warning — "possible data loss", "you are about to drop a column".
 * Possible how, losing what? Neither tool goes and looks, because neither wants
 * to connect to production to generate a migration. The answer is sitting in
 * the database the whole time.
 *
 * So this finds the migration files, asks the database which of them it has
 * already run, and hands the rest to the same preview everything else uses.
 */
async function pendingMigrations(
  context: vscode.ExtensionContext,
  connections: ConnectionManager,
  output: vscode.OutputChannel,
  diagnostics: FindingDiagnostics,
): Promise<void> {
  // The connection first, because what counts as a migration file depends on
  // the engine: a MongoDB project keeps `.js`, and looking for `.sql` in it
  // answered "none found" for a directory full of them.
  let connection;
  try {
    connection = await connections.acquire();
  } catch (error) {
    reportError(error, output, connections);
    return;
  }

  const engine = connection.adapter.engine;
  const folders = vscode.workspace.workspaceFolders ?? [];
  const layout = folders
    .map((folder) => findMigrations(folder.uri.fsPath, engine))
    .find((found) => found !== undefined);

  if (!layout) {
    void vscode.window.showWarningMessage(
      engine === 'mongo'
        ? 'Rehearsal found no operations. It looks for a migrations or operations folder ' +
            'of .js files.'
        : 'Rehearsal found no migrations. It looks for prisma/migrations, a Drizzle folder ' +
            'with meta/_journal.json, or a migrations folder of .sql files.',
    );
    return;
  }

  try {
    const status = await readLedger(connection.adapter, layout);

    output.appendLine(
      `${layout.tool}: ${layout.migrations.length} migrations on disk, ` +
        `${status.appliedCount} applied to ${connection.identity.display}.`,
    );

    // Drift is worth saying out loud even when the answer to the question
    // asked is "nothing is pending": a database holding migrations this
    // checkout has never seen is usually not the database you thought.
    if (status.unknownToRepo.length > 0) {
      void vscode.window.showWarningMessage(
        `${connection.identity.display} has run ${status.unknownToRepo.length} ` +
          `${status.unknownToRepo.length === 1 ? 'migration' : 'migrations'} that are not in ` +
          `this checkout: ${status.unknownToRepo.slice(0, 3).join(', ')}` +
          `${status.unknownToRepo.length > 3 ? '…' : ''}`,
      );
    }

    if (status.pending.length === 0) {
      void vscode.window.showInformationMessage(
        `Nothing pending. ${connection.identity.display} has run all ` +
          `${layout.migrations.length} of these migrations.`,
      );
      return;
    }

    const picked = await pickMigration(status.pending, status.note);
    if (!picked) {
      return;
    }

    // Opened first so the panel has a document to reveal into when a row is
    // clicked — the preview is anchored to a file, exactly as it is for a
    // migration the user opened themselves.
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(picked.file));
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One });

    await preview(context, connections, output, diagnostics);
  } catch (error) {
    reportError(error, output, connections);
  }
}

async function pickMigration(
  pending: readonly MigrationFile[],
  note: string | undefined,
): Promise<MigrationFile | undefined> {
  if (pending.length === 1 && !note) {
    return pending[0];
  }

  const choice = await vscode.window.showQuickPick(
    pending.map((migration) => ({
      label: migration.name,
      description: migration.tool,
      migration,
    })),
    {
      title: note
        ? `${pending.length} migrations — ${note}`
        : `${pending.length} pending ${pending.length === 1 ? 'migration' : 'migrations'}`,
      placeHolder: 'Which one should Rehearsal measure against your data?',
    },
  );
  return choice?.migration;
}

/**
 * Answers "would an index help this query", with the answer measured.
 *
 * The suggestion is the easy half and every tool stops there. The half that
 * decides anything is whether the planner would actually reach for the index,
 * and that is a question only the planner can answer — so it is asked, before
 * the suggestion is shown.
 */
async function suggestIndexes(
  context: vscode.ExtensionContext,
  connections: ConnectionManager,
  output: vscode.OutputChannel,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage('Rehearsal: open a SQL file first.');
    return;
  }

  const panel = IndexPanel.show(context);

  try {
    // The connection first, because reading the statement under the cursor
    // means knowing what language the file is in.
    const connection = await connections.acquire();

    const found = statementAtCursor(editor, languageFor(connection.adapter.engine));
    if (!found) {
      panel.fail('Put the cursor inside a query, or select one.');
      return;
    }

    panel.begin(found.sql, connection.identity.display, {
      uri: editor.document.uri,
      line: found.startLine,
    });

    // Estimate-only: the plan is needed to find the scans, and running the
    // query for real to find out whether it is slow would be a strange way to
    // treat a query the user already suspects is slow.
    const plan = await connection.adapter.explain(found.sql, false);

    const columnsByTable = new Map<string, readonly string[]>();
    for (const scan of seqScans(plan)) {
      if (columnsByTable.has(scan.relation)) {
        continue;
      }
      try {
        const columns = await connection.adapter.tableColumns(scan.relation);
        columnsByTable.set(
          scan.relation,
          columns.map((column) => column.name),
        );
      } catch (error) {
        output.appendLine(`Could not read ${scan.relation}: ${errorMessage(error)}`);
      }
    }

    // The plan carries no measured rows, so size cannot filter candidates here.
    // The table's own size does that instead, further down.
    const candidates = indexCandidates(plan, { columnsByTable, minimumRowsRead: 0 });
    const worthwhile = await filterBySize(connection.adapter, candidates, readThresholds());

    if (worthwhile.length === 0) {
      panel.candidates([]);
      panel.finish(
        candidates.length === 0
          ? 'No sequential scan in this plan has a filter an index could narrow.'
          : 'Every table this scans is small enough that a scan is the right plan.',
      );
      return;
    }

    const build = await confirmBuildingIfNeeded(connection.adapter);
    if (build === undefined) {
      panel.finish('Cancelled. Nothing was tested.');
      return;
    }

    const results: CandidateResult[] = worthwhile.map((candidate) => ({ candidate }));
    panel.candidates(results);

    let helped = 0;
    for (const [index, result] of results.entries()) {
      try {
        const experiment = await connection.adapter.testIndex(
          result.candidate.sql,
          found.sql,
          [],
          { build },
        );
        if (experiment.used && experiment.afterCost < experiment.beforeCost) {
          helped += 1;
        }
        panel.result(index, { ...result, experiment });
      } catch (error) {
        panel.result(index, { ...result, error: errorMessage(error) });
      }
    }

    panel.finish(
      helped === 0
        ? `Tested ${results.length}. The planner would not use any of them.`
        : `${helped} of ${results.length} would be used. Nothing was built — the index is still yours to create.`,
    );
  } catch (error) {
    reportError(error, output, connections);
    panel.fail(errorMessage(error));
  }
}

/**
 * Drops candidates whose table is too small to care about.
 *
 * An index on a thousand-row table costs write throughput and buys a scan the
 * database was doing in microseconds anyway.
 */
async function filterBySize(
  adapter: { tableStats(table: string): Promise<{ estimatedRows: number }> },
  candidates: readonly IndexCandidate[],
  thresholds: Thresholds,
): Promise<IndexCandidate[]> {
  const kept: IndexCandidate[] = [];
  const sizes = new Map<string, number>();

  for (const candidate of candidates) {
    let rows = sizes.get(candidate.table);
    if (rows === undefined) {
      try {
        rows = (await adapter.tableStats(candidate.table)).estimatedRows;
      } catch {
        // A table whose size cannot be read is not a reason to withhold the
        // suggestion; it is a reason not to filter on size.
        rows = Number.POSITIVE_INFINITY;
      }
      sizes.set(candidate.table, rows);
    }
    if (rows >= thresholds.cautionRows) {
      kept.push(candidate);
    }
  }
  return kept;
}

/**
 * Establishes whether building an index for real is allowed.
 *
 * Returns false when the no-lock path is available, true when the user has
 * agreed to the other one, and undefined when they declined. The prompt is
 * deliberate: the two paths differ by a lock held for the length of a real
 * index build, which on a large table is not a detail.
 */
async function confirmBuildingIfNeeded(adapter: {
  supportsHypotheticalIndexes(): Promise<boolean>;
}): Promise<boolean | undefined> {
  if (await adapter.supportsHypotheticalIndexes()) {
    return false;
  }

  const choice = await vscode.window.showWarningMessage(
    'Testing an index without building it needs the hypopg extension, which this database ' +
      'does not have. Rehearsal can instead build each index inside a transaction it rolls ' +
      'back: the measurements are real and nothing is kept, but the build takes the same ' +
      'lock a real one would while it runs.',
    { modal: true },
    'Build and roll back',
  );
  return choice === 'Build and roll back' ? true : undefined;
}

/** The statement the cursor is inside, or the selection when there is one. */
function statementAtCursor(
  editor: vscode.TextEditor,
  language: StatementLanguage,
): { sql: string; startLine: number } | undefined {
  if (!editor.selection.isEmpty) {
    const sql = editor.document.getText(editor.selection).trim();
    return sql.length > 0 ? { sql, startLine: editor.selection.start.line } : undefined;
  }

  const offset = editor.document.offsetAt(editor.selection.active);
  const statements = language.split(editor.document.getText());
  const containing =
    statements.find(
      (statement) => offset >= statement.startOffset && offset <= statement.endOffset,
    ) ?? statements[0];

  return containing
    ? { sql: containing.sql.trim(), startLine: containing.startLine }
    : undefined;
}

function readThresholds(): Thresholds {
  const config = vscode.workspace.getConfiguration('rehearsal');
  return {
    cautionRows: config.get<number>('cautionRowThreshold', 100),
    destructiveRows: config.get<number>('destructiveRowThreshold', 1000),
    largeTable: config.get<number>('largeTableThreshold', 100_000),
    sampleSize: config.get<number>('sampleSize', 20),
    explainAnalyze: config.get<boolean>('explainAnalyze', false),
    cloneTables: config.get<boolean>('mysql.measureOnCopy', false),
    cloneRowLimit: config.get<number>('mysql.measureOnCopyRowLimit', 500_000),
    productionRows: config.get<Record<string, number>>('productionRows', {}),
  };
}

/** The one-line verdict above the rows. Leads with the worst thing found. */
function summarize(findings: readonly Finding[], total: number, cancelled: boolean): string {
  if (cancelled) {
    return `Stopped after ${findings.length} of ${total} statements. Nothing was committed.`;
  }

  const counts = new Map<Severity, number>();
  for (const finding of findings) {
    counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  }

  const destructive = counts.get('destructive') ?? 0;
  const blocking = counts.get('blocking') ?? 0;

  if (destructive === 0 && blocking === 0) {
    return `${total} ${total === 1 ? 'statement' : 'statements'}, nothing destructive found.`;
  }

  const parts: string[] = [];
  if (destructive > 0) {
    parts.push(`${destructive} would destroy data`);
  }
  if (blocking > 0) {
    parts.push(`${blocking} would fail or lock`);
  }
  return `${parts.join(', ')}. Out of ${total} ${total === 1 ? 'statement' : 'statements'}.`;
}

/**
 * Kept as a name because it is used everywhere; the work moved to errors.ts
 * after an AggregateError with an empty message rendered as an empty red box.
 */
function errorMessage(error: unknown): string {
  return describeError(error);
}

/**
 * Where a failure goes.
 *
 * `quiet` is for callers that are already showing the failure themselves. The
 * sidebar puts it in a red box two inches from the cursor; raising a
 * notification saying the same sentence again is the tool talking over itself,
 * and the second copy is the one that has to be dismissed.
 */
function reportError(
  error: unknown,
  output: vscode.OutputChannel,
  connections?: ConnectionManager,
  quiet = false,
): void {
  if (connections && isConnectionLost(error)) {
    connections.markLost(errorMessage(error));
  }

  if (error instanceof ProductionRefusedError) {
    output.appendLine(`Refused: ${error.message}`);
    if (quiet) {
      return;
    }
    void vscode.window.showErrorMessage(error.message, 'Open Settings').then((choice) => {
      if (choice === 'Open Settings') {
        void vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'rehearsal.allowedConnections',
        );
      }
    });
    return;
  }

  if (error instanceof ConnectionResolutionError) {
    output.appendLine(error.message);
    if (quiet) {
      return;
    }

    // There is a front door now. "No connection string found" used to be the
    // end of the road — a message about a file the user had not written, with
    // nothing to press. Opening the panel that exists to answer it is a better
    // answer than explaining where the extension looked.
    Sidebar.reveal();

    void vscode.window
      .showWarningMessage(
        'Rehearsal is not connected to anything yet. Paste a connection string in the ' +
          'Rehearsal panel, or point it at a .env file.',
        'Select .env file…',
      )
      .then(async (choice) => {
        if (choice !== 'Select .env file…' || !connections) {
          return;
        }
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: 'Use this file',
          title: 'Select the .env file holding your connection string',
          filters: { 'Environment files': ['env'], 'All files': ['*'] },
        });
        if (picked?.[0]) {
          await connections.useEnvFile(picked[0]);
          void vscode.window.showInformationMessage(
            `Rehearsal will read ${vscode.workspace.asRelativePath(picked[0])}. Run the command again.`,
          );
        }
      });
    return;
  }

  const message = errorMessage(error);
  output.appendLine(`Error: ${message}`);
  if (!quiet) {
    void vscode.window.showErrorMessage(`Rehearsal: ${message}`);
  }
}

export { rankSeverity };
