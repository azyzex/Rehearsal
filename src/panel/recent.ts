import * as vscode from 'vscode';
import { Finding } from '../analysis/types';

/**
 * The last few files previewed, so measuring one again is one click.
 *
 * Migrations get previewed repeatedly — edit, preview, edit, preview — and
 * getting back to one meant finding it in the tree and pressing a shortcut.
 * Kept per workspace, because a list of another project's files is noise.
 */

export interface RecentPreview {
  readonly uri: string;
  /** Workspace-relative, for display. */
  readonly file: string;
  /** "1 destructive", "safe" — what it said last time. */
  readonly verdict: string;
  readonly severity: 'destructive' | 'blocking' | 'caution' | 'safe';
  readonly at: string;
}

const KEY = 'rehearsal.recentPreviews';
const KEEP = 5;

export class RecentPreviews {
  constructor(private readonly state: vscode.Memento) {}

  all(): RecentPreview[] {
    const stored = this.state.get<unknown>(KEY);
    return Array.isArray(stored) ? (stored as RecentPreview[]).slice(0, KEEP) : [];
  }

  async add(uri: vscode.Uri, file: string, findings: readonly Finding[]): Promise<void> {
    const { verdict, severity } = verdictOf(findings);
    const entry: RecentPreview = {
      uri: uri.toString(),
      file,
      verdict,
      severity,
      at: new Date().toISOString(),
    };

    const rest = this.all().filter((existing) => existing.uri !== entry.uri);
    await this.state.update(KEY, [entry, ...rest].slice(0, KEEP));
  }
}

/** The worst thing found, in as few words as still say it. */
export function verdictOf(findings: readonly Finding[]): Pick<RecentPreview, 'verdict' | 'severity'> {
  for (const severity of ['destructive', 'blocking', 'caution'] as const) {
    const count = findings.filter((finding) => finding.severity === severity).length;
    if (count > 0) {
      return {
        severity,
        verdict: `${count} ${severity === 'caution' ? 'to review' : severity}`,
      };
    }
  }
  return { severity: 'safe', verdict: 'safe' };
}
