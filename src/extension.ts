import * as vscode from 'vscode';
import { ConnectionManager, ProductionRefusedError } from './connection/manager';
import { ConnectionResolutionError } from './connection/resolve';

export function activate(context: vscode.ExtensionContext): void {
  const connections = new ConnectionManager();
  context.subscriptions.push(connections);

  const output = vscode.window.createOutputChannel('Dry Run');
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand('dryrun.testConnection', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Dry Run: connecting…' },
        async () => {
          try {
            const connection = await connections.acquire();

            // Proves the whole mechanism end to end: open a transaction, do
            // work inside it, and confirm the server threw the work away.
            const serverVersion = await connection.adapter.withRollback(async (tx) => {
              const result = await tx.query('SELECT version() AS v');
              return String(result.rows[0]?.['v'] ?? 'unknown');
            });

            output.appendLine(`Connected to ${connection.identity.display} (via ${connection.source})`);
            output.appendLine(serverVersion);

            void vscode.window.showInformationMessage(
              `Dry Run connected to ${connection.identity.display}.`,
            );
          } catch (error) {
            reportError(error, output);
          }
        },
      );
    }),
  );
}

export function deactivate(): void {
  // Connections are disposed through context.subscriptions.
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

  const message = error instanceof Error ? error.message : String(error);
  output.appendLine(`Error: ${message}`);
  void vscode.window.showErrorMessage(`Dry Run: ${message}`);
}
