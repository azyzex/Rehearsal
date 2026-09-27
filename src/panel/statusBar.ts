import * as vscode from 'vscode';
import { engineName } from '../connection/detect';
import { Engine } from '../adapters/types';
import { Finding } from '../analysis/types';

/**
 * Two status bar items: which database, and what the last preview said.
 *
 * The panel is the product, but it is also something you have to be looking at.
 * The status bar is the one place in the window that is always visible, and
 * the two questions worth answering there are the two people keep having to
 * go and check: am I pointed at the database I think I am, and was the last
 * thing I measured safe.
 *
 * Two items rather than one, so each can be clicked for its own thing — the
 * connection opens the switcher, the verdict brings the panel back.
 */
export class StatusBar implements vscode.Disposable {
  private readonly connection: vscode.StatusBarItem;
  private readonly verdict: vscode.StatusBarItem;

  constructor() {
    this.connection = vscode.window.createStatusBarItem(
      'rehearsal.connection',
      vscode.StatusBarAlignment.Left,
      10,
    );
    this.connection.name = 'Rehearsal: connection';
    this.connection.command = 'rehearsal.switchConnection';

    this.verdict = vscode.window.createStatusBarItem(
      'rehearsal.verdict',
      vscode.StatusBarAlignment.Left,
      9,
    );
    this.verdict.name = 'Rehearsal: last preview';
    this.verdict.command = 'rehearsal.preview';

    this.showConnection(undefined);
  }

  /** The database in use, or an invitation to pick one. */
  showConnection(
    current: { display: string; engine: Engine; lost?: string } | undefined,
  ): void {
    if (!current) {
      this.connection.text = '$(database) Rehearsal';
      this.connection.tooltip = 'Not connected. Click to pick a database.';
      this.connection.show();
      // A verdict about a database you are no longer connected to is a
      // statement about the wrong thing.
      this.verdict.hide();
      return;
    }

    if (current.lost) {
      this.connection.text = `$(debug-disconnect) ${current.display}: not answering`;
      this.connection.tooltip =
        `The last command failed because the connection is gone: ${current.lost}\n\n` +
        'Click to reconnect or pick another database.';
      this.connection.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.connection.show();
      return;
    }

    this.connection.backgroundColor = undefined;
    this.connection.text = `$(database) ${current.display}`;
    this.connection.tooltip = new vscode.MarkdownString(
      `**${current.display}** · ${engineName(current.engine)}\n\n` +
        'Everything runs inside a transaction that is rolled back.\n\n' +
        'Click to switch database.',
    );
    this.connection.show();
  }

  /**
   * The last preview, in the fewest words that still carry the verdict.
   *
   * Coloured with the theme's own error and warning backgrounds, which are the
   * only two the status bar allows — and those two are exactly the two cases
   * where someone glancing at it should stop.
   */
  showVerdict(findings: readonly Finding[], file: string): void {
    const destructive = findings.filter((finding) => finding.severity === 'destructive').length;
    const blocking = findings.filter((finding) => finding.severity === 'blocking').length;
    const caution = findings.filter((finding) => finding.severity === 'caution').length;

    if (destructive > 0) {
      this.verdict.text = `$(error) ${destructive} destructive`;
      this.verdict.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (blocking > 0) {
      this.verdict.text = `$(warning) ${blocking} blocking`;
      this.verdict.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (caution > 0) {
      this.verdict.text = `$(info) ${caution} to review`;
      this.verdict.backgroundColor = undefined;
    } else {
      this.verdict.text = '$(pass) Safe';
      this.verdict.backgroundColor = undefined;
    }

    this.verdict.tooltip =
      `Last preview: ${file} — ${findings.length} ` +
      `${findings.length === 1 ? 'statement' : 'statements'}. Click to run it again.`;
    this.verdict.show();
  }

  dispose(): void {
    this.connection.dispose();
    this.verdict.dispose();
  }
}
