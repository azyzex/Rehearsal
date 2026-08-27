import * as vscode from 'vscode';
import { rewritesFor } from '../analysis/rewrite';
import { replacement } from './rewriteText';
import { FindingDiagnostics } from './diagnostics';

/**
 * The safer statement, offered where the unsafe one is written.
 *
 * `rewrite.ts` has always known that a plain `CREATE INDEX` should have been
 * `CONCURRENTLY`, and the panel has always been able to say so. But saying so
 * in a panel leaves the work of retyping it to the reader, in a file they are
 * looking at in another window, and a rewrite retyped by hand is a rewrite
 * with a typo in it.
 *
 * This is the same suggestion as a `ctrl + .` on the squiggle: the replacement
 * is applied to the file, correct, with its reasoning left above it as a
 * comment. The reasoning goes into the file deliberately — the rewrite changes
 * the shape of a migration, sometimes into three statements that must not
 * share a transaction, and the next person to read it deserves to know why
 * rather than finding an unexplained `NOT VALID`.
 *
 * Nothing here re-derives anything. The offers come from the measurement that
 * produced the squiggle, so an offer can never describe a statement other than
 * the one that was measured, and they disappear the moment the file is edited
 * — because that is when the measurement stops being about this text.
 */

export class RewriteActions implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };

  constructor(private readonly diagnostics: FindingDiagnostics) {}

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
  ): vscode.CodeAction[] {
    const measured = this.diagnostics.measuredAt(document.uri, range.start.line);
    if (!measured) {
      return [];
    }

    const rewrites = rewritesFor(measured.finding, measured.engine);
    if (rewrites.length === 0) {
      return [];
    }

    const start = document.positionAt(measured.start);
    const end = document.positionAt(measured.end);
    const indent = document.lineAt(start.line).text.slice(0, start.character).match(/^\s*/)?.[0] ?? '';

    return rewrites.map((rewrite, position) => {
      const action = new vscode.CodeAction(rewrite.title, vscode.CodeActionKind.QuickFix);

      action.edit = new vscode.WorkspaceEdit();
      action.edit.replace(document.uri, new vscode.Range(start, end), replacement(rewrite, indent));

      // Ties the fix to the squiggle, so it shows on the lightbulb rather than
      // only in the refactor menu.
      action.diagnostics = vscode.languages
        .getDiagnostics(document.uri)
        .filter(
          (diagnostic) =>
            diagnostic.source === 'Dry Run' && diagnostic.range.start.line === start.line,
        );

      // The first offer is the one to reach for. Where a statement cannot
      // apply at all — twelve rows have no email — that first offer is the
      // backfill, which is the thing that actually has to happen.
      action.isPreferred = position === 0;

      return action;
    });
  }
}
