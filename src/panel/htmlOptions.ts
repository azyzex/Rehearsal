import * as vscode from 'vscode';
import { HtmlOptions, nonce } from './html';

/**
 * The bridge between a live webview and the pure markup builders.
 *
 * This is the only file in the pair that imports `vscode`, which is the point:
 * `html.ts` stays loadable outside an editor, so the UI tests can render
 * exactly the markup the editor renders in a real browser.
 */
export function htmlOptionsFor(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): HtmlOptions {
  return {
    media: (file) =>
      webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file)).toString(),
    nonce: nonce(),
    cspSource: webview.cspSource,
  };
}
