import * as vscode from 'vscode';

/**
 * The files worth searching for a column name.
 *
 * Restricted by extension rather than by trying to detect languages: the list
 * is long, boring, and easy to extend, and getting it wrong costs a missed
 * match rather than a wrong answer. Everything a repository accumulates that is
 * not source — dependencies, build output, lock files — is excluded, because a
 * hit in `node_modules` is never the hit anyone wanted.
 */

const SOURCE = [
  // Application code.
  'ts,tsx,js,jsx,mjs,cjs,vue,svelte',
  'py,rb,php,go,java,kt,kts,scala,cs,fs,swift,rs,dart,ex,exs,erl,clj,pl,lua,r',
  // Queries and schemas, where a column name appears verbatim.
  'sql,prisma,graphql,gql,proto,hbs,ejs,erb,liquid,twig',
  // Configuration and templates that carry field names.
  'json,yaml,yml,toml,xml,html,css,scss,md,mdx,env,ini,conf,tf',
].join(',');

const EXCLUDE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/out/**',
  '**/build/**',
  '**/target/**',
  '**/vendor/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.venv/**',
  '**/venv/**',
  '**/__pycache__/**',
  '**/*.min.js',
  '**/*.map',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
].join(',');

export interface WorkspaceFiles {
  readonly files: readonly string[];
  read(file: string): Promise<string>;
  /** Set when the file list itself was capped. */
  readonly note?: string;
}

/**
 * Lists the workspace's source files, capped.
 *
 * The cap exists because this runs while someone is waiting to find out
 * whether they can drop a column. A scan that is thorough and takes ninety
 * seconds gets cancelled, and a cancelled scan tells you nothing at all.
 */
export async function workspaceSourceFiles(limit = 4000): Promise<WorkspaceFiles> {
  const found = await vscode.workspace.findFiles(`**/*.{${SOURCE}}`, `{${EXCLUDE}}`, limit);

  const files = found.map((uri) => uri.fsPath);
  return {
    files,
    read: async (file: string): Promise<string> => {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
      return Buffer.from(bytes).toString('utf8');
    },
    ...(files.length >= limit
      ? {
          note:
            `Stopped listing at ${limit.toLocaleString()} files, so this searched part of ` +
            `the workspace rather than all of it.`,
        }
      : {}),
  };
}

/** Turns an absolute path into something short enough to show in a list. */
export function relative(file: string): string {
  return vscode.workspace.asRelativePath(vscode.Uri.file(file));
}
