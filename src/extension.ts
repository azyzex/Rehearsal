import * as vscode from 'vscode';
import { analyzeStatements } from './analysis/orchestrator';
import { rankSeverity } from './panel/controller';
import { Finding, Severity, Thresholds } from './analysis/types';
import { ConnectionManager, ProductionRefusedError } from './connection/manager';
import { ConnectionResolutionError } from './connection/resolve';
import { PreviewPanel } from './panel/controller';
import { splitStatements } from './parser/splitter';

export function activate(context: vscode.ExtensionContext): void {
  const connections = new ConnectionManager();
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
        reportError(error, output);
      }
    }),

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

    panel.finish(summarize(findings, statements.length, cancelled));
  } catch (error) {
    reportError(error, output);
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

function reportError(error: unknown, output: vscode.OutputChannel): void {
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
    void vscode.window.showErrorMessage(error.message);
    return;
  }

  const message = errorMessage(error);
  output.appendLine(`Error: ${message}`);
  void vscode.window.showErrorMessage(`Dry Run: ${message}`);
}

export { rankSeverity };
