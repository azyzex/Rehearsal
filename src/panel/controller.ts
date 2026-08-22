import * as vscode from 'vscode';
import { Diagram } from '../analysis/impact';
import { Finding, Severity } from '../analysis/types';
import { SplitStatement } from '../parser/splitter';

/**
 * The panel is the product (spec §9). Everything Dry Run measures is delivered
 * as a colour and a number next to the line that causes it.
 *
 * The controller owns the webview and the editor decorations, and keeps the two
 * in sync in both directions: clicking a row reveals the statement, moving the
 * cursor highlights the row.
 *
 * Rows arrive one at a time and render as they arrive, so a slow count on a
 * large table never holds up the rest of the file.
 */

export interface PanelHost {
  /** Called when the user asks to stop an in-flight analysis. */
  onCancel(): void;
}

const SEVERITY_RANK: Record<Severity, number> = {
  safe: 0,
  caution: 1,
  blocking: 2,
  destructive: 3,
};

export class PreviewPanel {
  private static current: PreviewPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly decorations = new Map<Severity, vscode.TextEditorDecorationType>();

  private statements: readonly SplitStatement[] = [];
  private findings = new Map<number, Finding>();
  private documentUri: vscode.Uri | undefined;
  private host: PanelHost | undefined;

  static show(context: vscode.ExtensionContext): PreviewPanel {
    if (PreviewPanel.current) {
      PreviewPanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
      return PreviewPanel.current;
    }
    PreviewPanel.current = new PreviewPanel(context);
    return PreviewPanel.current;
  }

  private constructor(private readonly context: vscode.ExtensionContext) {
    this.panel = vscode.window.createWebviewPanel(
      'dryrun.preview',
      'Dry Run',
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

    this.buildDecorations();
    this.panel.webview.html = this.render();

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((message) => this.onMessage(message)),
      vscode.window.onDidChangeTextEditorSelection((event) => this.onSelectionChanged(event)),
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  /** Resets the panel for a new run and tells the webview what to expect. */
  begin(
    document: vscode.TextDocument,
    statements: readonly SplitStatement[],
    connection: string,
    host: PanelHost,
  ): void {
    this.documentUri = document.uri;
    this.statements = statements;
    this.findings = new Map();
    this.host = host;

    void this.panel.webview.postMessage({
      type: 'begin',
      file: vscode.workspace.asRelativePath(document.uri),
      connection,
      statements: statements.map((statement) => ({
        index: statement.index,
        sql: statement.sql,
        startLine: statement.startLine,
        endLine: statement.endLine,
      })),
    });

    this.applyDecorations();
  }

  add(finding: Finding): void {
    this.findings.set(finding.statementIndex, finding);
    void this.panel.webview.postMessage({ type: 'finding', finding: serialize(finding) });
    this.applyDecorations();
  }

  /** The impact diagram, sent separately because it needs every finding first. */
  showDiagram(diagram: Diagram): void {
    void this.panel.webview.postMessage({ type: 'diagram', diagram });
  }

  finish(summary?: string): void {
    void this.panel.webview.postMessage({ type: 'done', summary });
  }

  fail(message: string): void {
    void this.panel.webview.postMessage({ type: 'failed', message });
  }

  private onMessage(message: { type?: string; index?: number }): void {
    if (message.type === 'reveal' && typeof message.index === 'number') {
      void this.revealStatement(message.index);
      return;
    }
    if (message.type === 'cancel') {
      this.host?.onCancel();
    }
  }

  private async revealStatement(index: number): Promise<void> {
    const statement = this.statements[index];
    if (!statement || !this.documentUri) {
      return;
    }

    const document = await vscode.workspace.openTextDocument(this.documentUri);
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
    });

    const range = new vscode.Range(statement.startLine, 0, statement.endLine, 0);
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /** Moving the cursor in the editor highlights the matching row. */
  private onSelectionChanged(event: vscode.TextEditorSelectionChangeEvent): void {
    if (!this.documentUri || event.textEditor.document.uri.toString() !== this.documentUri.toString()) {
      return;
    }

    const line = event.selections[0]?.active.line ?? 0;
    const match = this.statements.find(
      (statement) => line >= statement.startLine && line <= statement.endLine,
    );
    void this.panel.webview.postMessage({ type: 'highlight', index: match?.index ?? null });
  }

  /**
   * Gutter marks mirror the row colours, so the signal is visible while you are
   * reading the SQL itself rather than only when the panel has focus.
   */
  private applyDecorations(): void {
    const editor = vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.toString() === this.documentUri?.toString(),
    );
    if (!editor) {
      return;
    }

    const bySeverity = new Map<Severity, vscode.DecorationOptions[]>();
    for (const [index, finding] of this.findings) {
      const statement = this.statements[index];
      if (!statement) {
        continue;
      }
      const list = bySeverity.get(finding.severity) ?? [];
      list.push({
        range: new vscode.Range(statement.startLine, 0, statement.endLine, 0),
        hoverMessage: new vscode.MarkdownString(`**${finding.headline}** — ${finding.detail}`),
      });
      bySeverity.set(finding.severity, list);
    }

    for (const [severity, decoration] of this.decorations) {
      editor.setDecorations(decoration, bySeverity.get(severity) ?? []);
    }
  }

  private buildDecorations(): void {
    // Theme colours rather than hex, so the gutter stays legible in light,
    // dark and high-contrast themes.
    const colors: Record<Severity, string> = {
      safe: 'editorGutter.addedBackground',
      caution: 'editorWarning.foreground',
      blocking: 'editorError.foreground',
      destructive: 'editorError.foreground',
    };

    for (const severity of Object.keys(colors) as Severity[]) {
      this.decorations.set(
        severity,
        vscode.window.createTextEditorDecorationType({
          borderWidth: '0 0 0 3px',
          borderStyle: 'solid',
          borderColor: new vscode.ThemeColor(colors[severity]),
          isWholeLine: true,
          overviewRulerColor: new vscode.ThemeColor(colors[severity]),
          overviewRulerLane: vscode.OverviewRulerLane.Left,
        }),
      );
    }
  }

  private render(): string {
    const webview = this.panel.webview;
    const media = (file: string): vscode.Uri =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file));

    const nonce = Array.from({ length: 32 }, () =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.charAt(
        Math.floor(Math.random() * 62),
      ),
    ).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${media('panel.css')}" rel="stylesheet">
<title>Dry Run</title>
</head>
<body>
<header id="header">
  <div class="title">
    <span class="badge-dot" aria-hidden="true"></span>
    <span id="file">No file analysed yet</span>
  </div>
  <div class="meta">
    <div class="tabs" role="tablist">
      <button id="tab-list" class="tab active" type="button" role="tab">List</button>
      <button id="tab-diagram" class="tab" type="button" role="tab">Diagram</button>
    </div>
    <span id="connection"></span>
    <button id="cancel" type="button" hidden>Stop</button>
  </div>
</header>
<div id="summary" class="summary" hidden></div>
<main id="rows"></main>
<div id="diagram" hidden></div>
<footer id="footer">Nothing is committed. Dry Run only ever reads and rolls back.</footer>
<script nonce="${nonce}" src="${media('panel.js')}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    PreviewPanel.current = undefined;
    for (const decoration of this.decorations.values()) {
      decoration.dispose();
    }
    this.decorations.clear();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.host?.onCancel();
  }
}

/** Sorts severities worst-first, for the summary line. */
export function rankSeverity(severity: Severity): number {
  return SEVERITY_RANK[severity];
}

/**
 * Postgres hands back Dates, Buffers and objects. The webview only ever
 * displays these, so they are turned into display strings here rather than
 * leaving the webview to guess at types.
 */
function serialize(finding: Finding): unknown {
  return {
    ...finding,
    sample: finding.sample
      ? {
          ...finding.sample,
          rows: finding.sample.rows.map((row) => ({
            key: Object.fromEntries(
              Object.entries(row.key).map(([k, v]) => [k, formatValue(v)]),
            ),
            before: row.before ? mapValues(row.before) : null,
            after: row.after ? mapValues(row.after) : null,
            changed: row.changed,
          })),
        }
      : undefined,
  };
}

function mapValues(row: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, formatValue(v)]));
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '∅';
  }
  if (value instanceof Date) {
    return value.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  }
  if (Buffer.isBuffer(value)) {
    return `<${value.length} bytes>`;
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}
