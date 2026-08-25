import * as vscode from 'vscode';
import { IndexCandidate } from '../analysis/indexAdvice';
import { IndexExperiment } from '../adapters/types';
import { indexPanelHtml } from './html';
import { htmlOptionsFor } from './htmlOptions';

/**
 * What an index would do, side by side with what happens now.
 *
 * Index advice is normally delivered as a suggestion and left there, which
 * puts the entire burden of evaluation on the reader: build it on a copy,
 * remember to measure before, remember to measure after, remember to drop it.
 * Almost nobody does, so the advice is either followed on faith or ignored.
 *
 * This panel refuses to make a suggestion it has not already tested. Every row
 * here has been through the planner with the index in place, and the verdict
 * at the top of each card is whether the planner reached for it — including
 * when the answer is no, which is the more useful half of the feature.
 */

export interface CandidateResult {
  readonly candidate: IndexCandidate;
  /** Absent while the experiment is still running. */
  readonly experiment?: IndexExperiment;
  /** Set instead of `experiment` when the test could not be run. */
  readonly error?: string;
}

export class IndexPanel {
  private static current: IndexPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  /** Where "Add to file" writes. Set each time a query is tested. */
  private origin: { uri: vscode.Uri; line: number } | undefined;

  static show(context: vscode.ExtensionContext): IndexPanel {
    if (IndexPanel.current) {
      IndexPanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
      return IndexPanel.current;
    }
    IndexPanel.current = new IndexPanel(context);
    return IndexPanel.current;
  }

  private constructor(context: vscode.ExtensionContext) {
    this.panel = vscode.window.createWebviewPanel(
      'dryrun.indexes',
      'Dry Run — Indexes',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      },
    );

    this.panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, 'media', 'icon-light.svg'),
      dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'icon-dark.svg'),
    };

    this.panel.webview.html = this.render(context);

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((message: { type?: string; sql?: string }) => {
        if (message.type === 'insertIndex' && typeof message.sql === 'string') {
          void this.insert(message.sql);
        }
      }),
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  /** Announces what is being tested, before any of it has finished. */
  begin(query: string, connection: string, origin?: { uri: vscode.Uri; line: number }): void {
    this.origin = origin;
    void this.panel.webview.postMessage({ type: 'begin', query, connection });
  }

  /**
   * Writes the index into the file the query came from.
   *
   * An edit to a document, not a statement sent to the server: it lands in the
   * undo stack and shows up in a diff, and building it for real stays
   * something the user does deliberately with their own migration tooling.
   */
  private async insert(sql: string): Promise<void> {
    if (!this.origin) {
      void vscode.window.showWarningMessage(
        'Dry Run does not know which file this query came from. Copy the statement instead.',
      );
      return;
    }

    const document = await vscode.workspace.openTextDocument(this.origin.uri);
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One,
    });

    const line = Math.min(this.origin.line, document.lineCount - 1);
    const indent = /^[ \t]*/.exec(document.lineAt(line).text)?.[0] ?? '';
    await editor.edit((builder) =>
      builder.insert(new vscode.Position(line, 0), `${indent}${sql};\n`),
    );
  }

  /** The candidates, as soon as they are known and before any is tested. */
  candidates(results: readonly CandidateResult[]): void {
    void this.panel.webview.postMessage({ type: 'candidates', results: results.map(plain) });
  }

  /** One candidate's verdict. Sent as each finishes so the panel fills in. */
  result(index: number, result: CandidateResult): void {
    void this.panel.webview.postMessage({ type: 'result', index, result: plain(result) });
  }

  finish(summary: string): void {
    void this.panel.webview.postMessage({ type: 'done', summary });
  }

  fail(message: string): void {
    void this.panel.webview.postMessage({ type: 'failed', message });
  }

  private render(context: vscode.ExtensionContext): string {
    return indexPanelHtml(htmlOptionsFor(this.panel.webview, context.extensionUri));
  }

  private dispose(): void {
    IndexPanel.current = undefined;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

/**
 * Strips the plan JSON before it crosses into the webview.
 *
 * A plan for a large query is megabytes, none of which this panel draws — the
 * numbers already extracted from it are the entire content. Posting the raw
 * plan would make every update pay to clone it.
 */
function plain(result: CandidateResult): unknown {
  const experiment = result.experiment;
  return {
    candidate: {
      table: result.candidate.table,
      columns: result.candidate.columns,
      reason: result.candidate.reason,
      sql: result.candidate.sql,
    },
    error: result.error,
    experiment: experiment
      ? {
          method: experiment.method,
          used: experiment.used,
          beforeCost: experiment.beforeCost,
          afterCost: experiment.afterCost,
          beforeMs: experiment.beforeMs,
          afterMs: experiment.afterMs,
          note: experiment.note,
        }
      : undefined,
  };
}
