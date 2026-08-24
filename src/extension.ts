import * as vscode from 'vscode';
import { buildDiagram } from './analysis/impact';
import { editsFromClassifications } from './edit/fromSql';
import { analyzeStatements } from './analysis/orchestrator';
import { rankSeverity } from './panel/controller';
import { Finding, Severity, Thresholds } from './analysis/types';
import { ConnectionManager, ProductionRefusedError } from './connection/manager';
import { ConnectionResolutionError } from './connection/resolve';
import { PreviewPanel } from './panel/controller';
import { SchemaPanel } from './panel/schemaPanel';
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
    panel.begin(editor.document, [], '—', { onCancel: () => undefined });
    panel.finish('No statements found.');
    return;
  }

  let cancelled = false;

  try {
    const connection = await connections.acquire();
    panel.begin(editor.document, statements, connection.identity.display, {
      onCancel: () => {
        cancelled = true;
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

function readThresholds(): Thresholds {
  const config = vscode.workspace.getConfiguration('dryrun');
  return {
    cautionRows: config.get<number>('cautionRowThreshold', 100),
    destructiveRows: config.get<number>('destructiveRowThreshold', 1000),
    largeTable: config.get<number>('largeTableThreshold', 100_000),
    sampleSize: config.get<number>('sampleSize', 20),
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
