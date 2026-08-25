/**
 * Where the code still uses the thing you are about to drop.
 *
 * The database will let you drop a column the moment nothing in the database
 * depends on it. The application is not consulted, and the application is where
 * the outage happens: the migration succeeds, the deploy succeeds, and forty
 * minutes later something serialises a row and finds a field missing.
 *
 * This is deliberately a text search rather than anything cleverer. A real
 * answer would need to understand every ORM, query builder and string-built
 * query in the repository, and would still miss the one in a stored procedure
 * or a dashboard. A text search is honest about being a text search: it finds
 * candidates, and finding zero is not a promise that there are none. That
 * caveat is carried in the result rather than left for the caller to remember.
 *
 * Everything here is pure apart from the file reader passed in, so the matching
 * rules are testable without a workspace.
 */

export interface Reference {
  readonly file: string;
  /** 1-based, so it can be printed the way an editor shows it. */
  readonly line: number;
  /** The line, trimmed, for showing in a list. */
  readonly text: string;
  /** Which spelling matched — the column name, or a language's version of it. */
  readonly form: string;
}

export interface ReferenceScan {
  /** What was searched for, in every spelling. */
  readonly forms: readonly string[];
  readonly references: readonly Reference[];
  readonly filesSearched: number;
  /** Set when the scan stopped early; the result is then a lower bound. */
  readonly truncated?: string;
}

export interface ScanOptions {
  /** Files to look in, already filtered to things worth reading. */
  readonly files: readonly string[];
  readonly read: (file: string) => Promise<string> | string;
  /** Stop after this many matches. Default 200. */
  readonly maxMatches?: number;
  /** Skip files larger than this. Default 512 kB. */
  readonly maxFileBytes?: number;
}

/**
 * The spellings a database identifier takes in application code.
 *
 * `phone_number` in the database is `phoneNumber` in most JavaScript, and
 * `PhoneNumber` in C# and Go. An ORM does that mapping silently, so searching
 * only for the database's spelling misses exactly the code most likely to
 * break.
 */
export function spellings(identifier: string): string[] {
  const forms = new Set<string>([identifier]);

  const parts = identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[_\s-]+/)
    .filter((part) => part.length > 0);

  if (parts.length > 1) {
    const lower = parts.map((part) => part.toLowerCase());
    const camel = lower
      .map((part, index) => (index === 0 ? part : part[0]!.toUpperCase() + part.slice(1)))
      .join('');
    forms.add(camel);
    forms.add(camel[0]!.toUpperCase() + camel.slice(1));
    forms.add(lower.join('_'));
    forms.add(lower.join('-'));
  }

  return [...forms];
}

/**
 * Finds where the identifiers appear.
 *
 * Matched on word boundaries, so `id` does not match `valid` and `user` does
 * not match `users`. That misses `user_id` when searching for `user`, which is
 * the right trade: a scan that matches everything is read as noise and
 * dismissed, and a dismissed warning is worth less than no warning.
 */
export async function scanReferences(
  identifier: string,
  options: ScanOptions,
): Promise<ReferenceScan> {
  const maxMatches = options.maxMatches ?? 200;
  const maxFileBytes = options.maxFileBytes ?? 512 * 1024;

  const forms = spellings(identifier);
  const patterns = forms.map((form) => ({
    form,
    // Word boundaries either side. `\b` handles the underscore case badly —
    // it treats `_` as a word character — so the boundaries are spelled out.
    expression: new RegExp(`(^|[^A-Za-z0-9_])${escape(form)}([^A-Za-z0-9_]|$)`),
  }));

  const references: Reference[] = [];
  let filesSearched = 0;
  let truncated: string | undefined;

  for (const file of options.files) {
    if (references.length >= maxMatches) {
      truncated = `Stopped after ${maxMatches} matches. There may be more.`;
      break;
    }

    let content: string;
    try {
      content = await options.read(file);
    } catch {
      // A file that cannot be read is not a reason to abandon the scan; it is
      // a reason to have searched one file fewer.
      continue;
    }

    if (content.length > maxFileBytes) {
      continue;
    }
    filesSearched += 1;

    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      // Cheap rejection first: most lines contain none of the forms, and
      // running four regexes over every line of a repository is not free.
      if (!forms.some((form) => line.includes(form))) {
        continue;
      }

      for (const { form, expression } of patterns) {
        if (!expression.test(line)) {
          continue;
        }
        references.push({
          file,
          line: index + 1,
          text: line.trim().slice(0, 200),
          form,
        });
        break; // one hit per line is enough to send someone to look
      }

      if (references.length >= maxMatches) {
        break;
      }
    }
  }

  return { forms, references, filesSearched, ...(truncated ? { truncated } : {}) };
}

/**
 * The sentence that goes next to the finding.
 *
 * Says how many and where, and — this is the part that matters — never says
 * "safe". Nothing found means nothing found by a text search over the files it
 * could read, which is a different claim.
 */
export function describeScan(scan: ReferenceScan, identifier: string): string {
  const files = new Set(scan.references.map((reference) => reference.file)).size;

  if (scan.references.length === 0) {
    return (
      `No mention of ${identifier} in the ${scan.filesSearched.toLocaleString()} files ` +
      `searched. This is a text search, so it cannot see a query built at runtime, ` +
      `a stored procedure, or anything outside this repository.`
    );
  }

  const count = scan.references.length;
  return (
    `${count.toLocaleString()} ${count === 1 ? 'mention' : 'mentions'} of ${identifier} in ` +
    `${files} ${files === 1 ? 'file' : 'files'}${scan.truncated ? ' (and counting)' : ''}. ` +
    `Searched as ${scan.forms.join(', ')}.`
  );
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
