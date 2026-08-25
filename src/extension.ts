import * as vscode from 'vscode';
import { buildDiagram } from './analysis/impact';
import { editsFromClassifications } from './edit/fromSql';
import { findOffenders } from './analysis/offenders';
import { describeScan, scanReferences } from './analysis/references';
import { relative, workspaceSourceFiles } from './analysis/workspaceFiles';
import { analyzeStatements } from './analysis/orchestrator';
import { rankSeverity } from './panel/controller';
import { Finding, Severity, Thresholds } from './analysis/types';
import { ConnectionManager, ProductionRefusedError } from './connection/manager';
import { ConnectionResolutionError } from './connection/resolve';
import { PreviewPanel } from './panel/controller';
import { FindingDiagnostics } from './panel/diagnostics';
import { AppliedChangeset, ChangesetHistory, describeEntry } from './edit/history';
import { SchemaPanel } from './panel/schemaPanel';
import { CandidateResult, IndexPanel } from './panel/indexPanel';
import { IndexCandidate, indexCandidates, seqScans } from './analysis/indexAdvice';
import { StatementLanguage, languageFor } from './parser/language';
import { MigrationFile, findMigrations } from './migrations/discover';
import { readLedger } from './migrations/ledger';
import { healthReport } from './analysis/healthReport';
import { compareSchemas, comparisonReport } from './analysis/compare';
import { PostgresAdapter } from './adapters/postgres';
import { APPLICATION_NAME } from './constants';

export function activate(context: vscode.ExtensionContext): void {
  const connections = new ConnectionManager(context.workspaceState);
  const output = vscode.window.createOutputChannel('Dry Run');
  // The panel is the product, but the panel is also something you have to be
  // looking at. These put the same findings in the Problems view, the ruler and
  // the tab's badge, none of which needed building.
  const diagnostics = new FindingDiagnostics();
  // Applying is the one irreversible thing here, and until this it left no
  // trace outside the database itself.
  const history = new ChangesetHistory(context.workspaceState);
  context.subscriptions.push(connections, output, diagnostics);

  context.subscriptions.push(
    vscode.commands.registerCommand('dryrun.preview', () =>
      preview(context, connections, output, diagnostics),
    ),

    vscode.commands.registerCommand('dryrun.testConnection', async () => {
      try {
        const connection = await connections.acquire();
        const version = await connection.adapter.withRollback(async (tx) => {
          const result = await tx.query('SELECT version() AS v');
          return String(result.rows[0]?.['v'] ?? 'unknown');
        });
        output.appendLine(`Connected to ${connection.identity.display} (via ${connection.source})`);
        output.appendLine(version);
        void vscode.window.showInformationMessage(
          `Dry Run connected to ${connection.identity.display}.`,
        );
      } catch (error) {
        reportError(error, output, connections);
      }
    }),

    vscode.commands.registerCommand('dryrun.exploreSchema', () =>
      exploreSchema(context, connections, output, history),
    ),

    vscode.commands.registerCommand('dryrun.appliedChanges', () => appliedChanges(history)),

    vscode.commands.registerCommand('dryrun.suggestIndexes', () =>
      suggestIndexes(context, connections, output),
    ),

    vscode.commands.registerCommand('dryrun.pendingMigrations', () =>
      pendingMigrations(context, connections, output, diagnostics),
    ),

    vscode.commands.registerCommand('dryrun.schemaHealth', () =>
      schemaHealth(connections, output),
    ),

    vscode.commands.registerCommand('dryrun.compareSchemas', () =>
      compareWithAnother(connections, output),
    ),

    vscode.commands.registerCommand('dryrun.disconnect', async () => {
      await connections.close();
      void vscode.window.showInformationMessage('Dry Run disconnected.');
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
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage('Dry Run: open a SQL file first.');
    return;
  }

  // A selection means "just this bit". Otherwise the whole file, which is what
  // you want for a migration.
  const selection = editor.selection.isEmpty ? undefined : editor.document.getText(editor.selection);
  const offset = selection ? editor.document.offsetAt(editor.selection.start) : 0;
  const text = selection ?? editor.document.getText();

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
      const startLine = editor.document.positionAt(offset + statement.startOffset).line;
      const endLine = editor.document.positionAt(offset + statement.endOffset).line;
      return { ...statement, startLine, endLine };
    });

    if (statements.length === 0) {
      panel.begin(editor.document, [], connection.identity.display, {
        onCancel: () => undefined,
        onShowOffenders: () => undefined,
        onShowReferences: () => undefined,
      });
      panel.finish(`No ${language.noun}s found.`);
      return;
    }

    const classifications = statements.map((statement) => language.classify(statement.sql));

    panel.begin(editor.document, statements, connection.identity.display, {
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
    });

    diagnostics.begin(editor.document, statements);

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
        file: vscode.workspace.asRelativePath(editor.document.uri),
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
  } catch (error) {
    reportError(error, output, connections);
    panel.fail(errorMessage(error));
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
      'Nothing has been applied from Dry Run in this workspace yet.',
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
  const other = await vscode.window.showInputBox({
    title: 'Compare with another database',
    prompt: 'Connection string for the database to compare against. It is not saved.',
    placeHolder: 'postgresql://user:password@host/database',
    password: true,
    ignoreFocusOut: true,
  });

  if (!other || other.trim().length === 0) {
    return;
  }

  const second = new PostgresAdapter();

  try {
    const connection = await connections.acquire();

    const { left, right } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Dry Run: reading both schemas…' },
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
    const health = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Dry Run: reading the catalogue…' },
      () => connection.adapter.schemaHealth(),
    );

    const document = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: healthReport(health, { connection: connection.identity.display }),
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
  const folders = vscode.workspace.workspaceFolders ?? [];
  const layout = folders
    .map((folder) => findMigrations(folder.uri.fsPath))
    .find((found) => found !== undefined);

  if (!layout) {
    void vscode.window.showWarningMessage(
      'Dry Run found no migrations. It looks for prisma/migrations, a Drizzle folder ' +
        'with meta/_journal.json, or a migrations folder of .sql files.',
    );
    return;
  }

  try {
    const connection = await connections.acquire();
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
      placeHolder: 'Which one should Dry Run measure against your data?',
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
    void vscode.window.showWarningMessage('Dry Run: open a SQL file first.');
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
      'does not have. Dry Run can instead build each index inside a transaction it rolls ' +
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
  const config = vscode.workspace.getConfiguration('dryrun');
  return {
    cautionRows: config.get<number>('cautionRowThreshold', 100),
    destructiveRows: config.get<number>('destructiveRowThreshold', 1000),
    largeTable: config.get<number>('largeTableThreshold', 100_000),
    sampleSize: config.get<number>('sampleSize', 20),
    explainAnalyze: config.get<boolean>('explainAnalyze', false),
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportError(
  error: unknown,
  output: vscode.OutputChannel,
  connections?: ConnectionManager,
): void {
  if (error instanceof ProductionRefusedError) {
    output.appendLine(`Refused: ${error.message}`);
    void vscode.window.showErrorMessage(error.message, 'Open Settings').then((choice) => {
      if (choice === 'Open Settings') {
        void vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'dryrun.allowedConnections',
        );
      }
    });
    return;
  }

  if (error instanceof ConnectionResolutionError) {
    output.appendLine(error.message);
    // Rather than leaving the user to work out where the extension is looking,
    // let them point at the file. Only the path is kept; the credential inside
    // it is read fresh each time and never stored.
    void vscode.window
      .showErrorMessage(error.message, 'Select .env file…')
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
            `Dry Run will read ${vscode.workspace.asRelativePath(picked[0])}. Run the command again.`,
          );
        }
      });
    return;
  }

  const message = errorMessage(error);
  output.appendLine(`Error: ${message}`);
  void vscode.window.showErrorMessage(`Dry Run: ${message}`);
}

export { rankSeverity };
