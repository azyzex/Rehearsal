import * as vscode from 'vscode';
import { SchemaSnapshot } from '../adapters/types';

/**
 * The schema explorer.
 *
 * The whole database drawn as tables and relationships — the canvas that the
 * change preview is eventually laid on top of. On its own it answers "what is
 * in here and how does it hang together", which is the question every developer
 * has on their first day and again every time they touch an unfamiliar corner.
 *
 * Everything it draws is read-only catalog data. It opens no transaction and
 * touches no row.
 */
export class SchemaPanel {
  private static current: SchemaPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext): SchemaPanel {
    if (SchemaPanel.current) {
      SchemaPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return SchemaPanel.current;
    }
    SchemaPanel.current = new SchemaPanel(context);
    return SchemaPanel.current;
  }

  private constructor(private readonly context: vscode.ExtensionContext) {
    this.panel = vscode.window.createWebviewPanel(
      'dryrun.schema',
      'Database Schema',
      vscode.ViewColumn.Active,
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

    this.panel.webview.html = this.render();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  loading(connection: string): void {
    void this.panel.webview.postMessage({ type: 'loading', connection });
  }

  show(snapshot: SchemaSnapshot, connection: string): void {
    void this.panel.webview.postMessage({ type: 'schema', snapshot, connection });
  }

  fail(message: string): void {
    void this.panel.webview.postMessage({ type: 'failed', message });
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
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${media('schema.css')}" rel="stylesheet">
<title>Database Schema</title>
</head>
<body>
<header id="toolbar">
  <div class="left">
    <span class="dot" aria-hidden="true"></span>
    <span id="stats">Reading the schema…</span>
  </div>
  <div class="right">
    <input id="search" type="search" placeholder="Find a table or column" spellcheck="false">
    <select id="schema-filter" title="Schema"></select>
    <button id="fit" type="button" title="Fit the whole schema in view">Fit</button>
    <button id="relayout" type="button" title="Lay the diagram out again">Re-layout</button>
  </div>
</header>

<div id="stage">
  <div id="canvas">
    <svg id="edges" xmlns="http://www.w3.org/2000/svg"></svg>
    <div id="tables"></div>
  </div>
  <div id="status" class="status">Connecting…</div>
</div>

<footer id="legend">
  <span><i class="swatch pk"></i> primary key</span>
  <span><i class="swatch fk"></i> foreign key</span>
  <span>Drag to pan · scroll to zoom · click a table to isolate it</span>
  <span id="connection"></span>
</footer>

<script nonce="${nonce}" src="${media('schema.js')}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    SchemaPanel.current = undefined;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
