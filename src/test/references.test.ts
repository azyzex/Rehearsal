import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeScan, scanReferences, spellings } from '../analysis/references';

/**
 * Where the code still uses the column you are about to drop.
 *
 * The value of this feature is entirely in what it does not say. It is a text
 * search, and a text search that presents itself as an authority is worse than
 * no search — so the tests here are as much about the wording as the matching.
 */

function project(files: Record<string, string>) {
  return {
    files: Object.keys(files),
    read: (file: string) => {
      const content = files[file];
      if (content === undefined) {
        throw new Error(`no such file: ${file}`);
      }
      return content;
    },
  };
}

describe('spellings', () => {
  it('knows what an ORM does to a snake_case column', () => {
    // The mapping is silent, so searching only the database's spelling misses
    // exactly the code most likely to break.
    assert.deepEqual(spellings('phone_number').sort(), [
      'PhoneNumber',
      'phone-number',
      'phoneNumber',
      'phone_number',
    ]);
  });

  it('leaves a single-word column alone', () => {
    assert.deepEqual(spellings('email'), ['email']);
  });

  it('handles a column that is already camelCase', () => {
    assert.deepEqual(spellings('phoneNumber').sort(), [
      'PhoneNumber',
      'phone-number',
      'phoneNumber',
      'phone_number',
    ]);
  });

  it('copes with more than two words', () => {
    assert.ok(spellings('last_login_at').includes('lastLoginAt'));
  });
});

describe('scanning', () => {
  it('finds the column in the shapes real code uses', async () => {
    const scan = await scanReferences(
      'phone_number',
      project({
        'src/user.ts': 'const n = user.phoneNumber;\nconsole.log(n);',
        'sql/report.sql': 'SELECT phone_number FROM users;',
        'web/form.html': '<input name="phone-number">',
        'docs/readme.md': 'nothing relevant here',
      }),
    );

    assert.equal(scan.references.length, 3);
    assert.deepEqual(
      scan.references.map((reference) => reference.form).sort(),
      ['phone-number', 'phoneNumber', 'phone_number'],
    );
    assert.equal(scan.filesSearched, 4);
  });

  it('reports the line the way an editor numbers it', async () => {
    const scan = await scanReferences(
      'email',
      project({ 'a.ts': 'one\ntwo\nconst e = row.email;\nfour' }),
    );
    assert.equal(scan.references[0]!.line, 3);
    assert.equal(scan.references[0]!.text, 'const e = row.email;');
  });

  it('does not match a longer word that contains the name', async () => {
    // `id` matching `valid` would make the feature noise, and noise gets
    // dismissed — which is worth less than saying nothing.
    const scan = await scanReferences(
      'id',
      project({ 'a.ts': 'const valid = true;\nconst hidden = 1;\nconst ident = 2;' }),
    );
    assert.deepEqual(scan.references, []);
  });

  it('matches at the very start and end of a line', async () => {
    const scan = await scanReferences('email', project({ 'a.ts': 'email', 'b.ts': 'x = email' }));
    assert.equal(scan.references.length, 2);
  });

  it('matches a name sitting next to punctuation', async () => {
    const scan = await scanReferences(
      'email',
      project({ 'a.ts': 'select("email"),', 'b.py': "row['email']" }),
    );
    assert.equal(scan.references.length, 2);
  });

  it('counts a line once however many spellings it contains', async () => {
    const scan = await scanReferences(
      'phone_number',
      project({ 'a.ts': 'map(phone_number, phoneNumber)' }),
    );
    assert.equal(scan.references.length, 1, 'one line is one place to go and look');
  });

  it('keeps going when a file cannot be read', async () => {
    const scan = await scanReferences('email', {
      files: ['gone.ts', 'here.ts'],
      read: (file: string) => {
        if (file === 'gone.ts') {
          throw new Error('permission denied');
        }
        return 'const e = email;';
      },
    });

    assert.equal(scan.references.length, 1);
    assert.equal(scan.filesSearched, 1, 'the unreadable one is not counted as searched');
  });

  it('skips a file too large to be source code', async () => {
    const scan = await scanReferences('email', {
      ...project({ 'dump.sql': `email\n${'x'.repeat(2000)}` }),
      maxFileBytes: 100,
    });
    assert.deepEqual(scan.references, []);
    assert.equal(scan.filesSearched, 0);
  });

  it('stops at the cap and says the result is a lower bound', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i += 1) {
      files[`f${i}.ts`] = 'email';
    }

    const scan = await scanReferences('email', { ...project(files), maxMatches: 5 });
    assert.equal(scan.references.length, 5);
    assert.match(scan.truncated!, /There may be more/);
  });
});

describe('what it says', () => {
  it('never calls an empty result safe', async () => {
    const scan = await scanReferences('email', project({ 'a.ts': 'nothing' }));
    const sentence = describeScan(scan, 'users.email');

    assert.match(sentence, /No mention of users\.email in the 1 files searched/);
    assert.match(sentence, /text search/);
    assert.match(sentence, /outside this repository/);
    assert.doesNotMatch(sentence, /safe|unused|nobody/i);
  });

  it('says how many and where, and what it searched for', async () => {
    const scan = await scanReferences(
      'phone_number',
      project({ 'a.ts': 'phoneNumber', 'b.sql': 'phone_number' }),
    );
    const sentence = describeScan(scan, 'users.phone_number');

    assert.match(sentence, /2 mentions of users\.phone_number in 2 files/);
    assert.match(sentence, /Searched as/);
  });

  it('counts files rather than lines when one file has several', async () => {
    const scan = await scanReferences(
      'email',
      project({ 'a.ts': 'email\nemail\nemail', 'b.ts': 'nothing' }),
    );
    assert.match(describeScan(scan, 'email'), /3 mentions of email in 1 file\b/);
  });

  it('says the count is still climbing when it stopped early', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i += 1) {
      files[`f${i}.ts`] = 'email';
    }
    const scan = await scanReferences('email', { ...project(files), maxMatches: 3 });
    assert.match(describeScan(scan, 'email'), /\(and counting\)/);
  });
});
