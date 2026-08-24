import * as vscode from 'vscode';
import { buildDiagram } from './analysis/impact';
import { editsFromClassifications } from './edit/fromSql';
import { findOffenders } from './analysis/offenders';
import { classify } from './parser/classifier';
import { analyzeStatements } from './analysis/orchestrator';
import { rankSeverity } from './panel/controller';
import { Finding, Severity, Thresholds } from './analysis/types';
import { ConnectionManager, ProductionRefusedError } from './connection/manager';
import { ConnectionResolutionError } from './connection/resolve';
import { PreviewPanel } from './panel/controller';
import { SchemaPanel } from './panel/schemaPanel';
import { CandidateResult, IndexPanel } from './panel/indexPanel';
import { IndexCandidate, indexCandidates, seqScans } from './analysis/indexAdvice';
import { splitStatements } from './parser/splitter';

export function activate(context: vscode.ExtensionContext): void {
  const connections = new ConnectionManager(context.workspaceState);
  const output = vscode.window.createOutputChannel('Dry Run');
  context.subscriptions.push(connections, output);

  context.subscriptions.push(
    vscode.commands.registerCommand('dryrun.preview', () => preview(context, connections, output)),

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
      exploreSchema(context, connections, output),
    ),

    vscode.commands.registerCommand('dryrun.suggestIndexes', () =>
      suggestIndexes(context, connections, output),
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

  const statements = splitStatements(text).map((statement) => {
    if (!selection) {
      return statement;
    }
    // Shift line numbers so clicking a row still lands on the right line.
    const startLine = editor.document.positionAt(offset + statement.startOffset).line;
    const endLine = editor.document.positionAt(offset + statement.endOffset).line;
    return { ...statement, startLine, endLine };
  });

  const panel = PreviewPanel.show(context);

  if (statements.length === 0) {
    panel.begin(editor.document, [], '—', {
      onCancel: () => undefined,
      onShowOffenders: () => undefined,
    });
    panel.finish('No statements found.');
    return;
  }

  let cancelled = false;

  try {
    const connection = await connections.acquire();
    const classifications = statements.map((statement) => classify(statement.sql));

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
    });

    const findings: Finding[] = [];
    await analyzeStatements({
      adapter: connection.adapter,
      statements,
      thresholds: readThresholds(),
      isCancelled: () => cancelled,
      onFinding: (finding) => {
        findings.push(finding);
        panel.add(finding);
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
  });

  try {
    await load(panel);
  } catch (error) {
    reportError(error, output, connections);
    panel.fail(errorMessage(error));
  }
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

  const found = statementAtCursor(editor);
  if (!found) {
    void vscode.window.showWarningMessage(
      'Dry Run: put the cursor inside a query, or select one.',
    );
    return;
  }

  const panel = IndexPanel.show(context);

  try {
    const connection = await connections.acquire();
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
): { sql: string; startLine: number } | undefined {
  if (!editor.selection.isEmpty) {
    const sql = editor.document.getText(editor.selection).trim();
    return sql.length > 0 ? { sql, startLine: editor.selection.start.line } : undefined;
  }

  const offset = editor.document.offsetAt(editor.selection.active);
  const statements = splitStatements(editor.document.getText());
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
