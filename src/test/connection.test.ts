import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkConnection, identify } from '../connection/guard';
import {
  ConnectionResolutionError,
  expandEnvReferences,
  parseEnvFile,
  resolveConnection,
} from '../connection/resolve';

const PATTERNS = ['prod', 'production', 'live'];

describe('identify', () => {
  it('reads a URL connection string without keeping the password', () => {
    const id = identify('postgresql://app:sup3rs3cret@db.example.com:6543/shop');
    assert.equal(id.host, 'db.example.com');
    assert.equal(id.port, '6543');
    assert.equal(id.database, 'shop');
    assert.equal(id.user, 'app');
    assert.equal(id.key, 'db.example.com:6543/shop');
    assert.equal(id.display.includes('sup3rs3cret'), false);
  });

  it('reads key/value connection strings', () => {
    const id = identify('host=db.internal port=5433 dbname=shop user=app password=secret');
    assert.equal(id.key, 'db.internal:5433/shop');
    assert.equal(id.display.includes('secret'), false);
  });

  it('defaults host and port', () => {
    assert.equal(identify('postgresql:///scratch').key, 'localhost:5432/scratch');
  });
});

describe('production guard', () => {
  const check = (url: string, allowed: string[] = []) =>
    checkConnection(url, { productionPatterns: PATTERNS, allowedConnections: allowed });

  it('allows a local development database', () => {
    assert.equal(check('postgresql://postgres:postgres@localhost:5432/shop_dev').allowed, true);
  });

  it('refuses a host that looks like production', () => {
    const verdict = check('postgresql://app:pw@prod-db.example.com:5432/shop');
    assert.equal(verdict.allowed, false);
    assert.ok(verdict.allowed === false && verdict.matchedPattern === 'prod');
  });

  it('refuses a database name that looks like production', () => {
    assert.equal(check('postgresql://app:pw@db.example.com:5432/shop_production').allowed, false);
  });

  it('does not match against the password', () => {
    // The word only appears in the credential, which the guard never inspects.
    assert.equal(check('postgresql://app:prod123@staging.example.com:5432/shop').allowed, true);
  });

  it('exempts a connection listed in allowedConnections', () => {
    const url = 'postgresql://app:pw@prod-db.example.com:5432/shop';
    assert.equal(check(url, ['prod-db.example.com:5432/shop']).allowed, true);
  });

  it('ignores a malformed user pattern rather than failing to connect', () => {
    const verdict = checkConnection('postgresql://localhost:5432/dev', {
      productionPatterns: ['*broken('],
      allowedConnections: [],
    });
    assert.equal(verdict.allowed, true);
  });
});

describe('parseEnvFile', () => {
  it('reads plain, exported, quoted and commented lines', () => {
    const parsed = parseEnvFile(
      [
        '# a comment',
        'DATABASE_URL=postgresql://localhost:5432/dev',
        'export OTHER="postgresql://localhost:5432/other"',
        "QUOTED='single'",
        'WITH_COMMENT=value # trailing',
        'MALFORMED',
        '',
      ].join('\n'),
    );

    assert.equal(parsed['DATABASE_URL'], 'postgresql://localhost:5432/dev');
    assert.equal(parsed['OTHER'], 'postgresql://localhost:5432/other');
    assert.equal(parsed['QUOTED'], 'single');
    assert.equal(parsed['WITH_COMMENT'], 'value');
    assert.equal(parsed['MALFORMED'], undefined);
  });

  it('keeps a # that is inside a quoted value', () => {
    assert.equal(parseEnvFile('URL="postgres://a:p#w@h:5432/d"')['URL'], 'postgres://a:p#w@h:5432/d');
  });
});

describe('expandEnvReferences', () => {
  it('substitutes ${env:VAR}', () => {
    const { expanded, missing } = expandEnvReferences('${env:DB}', { DB: 'postgres://x' });
    assert.equal(expanded, 'postgres://x');
    assert.deepEqual(missing, []);
  });

  it('reports variables that are not set', () => {
    const { missing } = expandEnvReferences('${env:NOPE}', {});
    assert.deepEqual(missing, ['NOPE']);
  });
});

describe('resolveConnection', () => {
  it('prefers the setting, with env references expanded', () => {
    const resolved = resolveConnection({
      setting: '${env:MY_DB}',
      env: { MY_DB: 'postgres://from-setting', DATABASE_URL: 'postgres://from-env' },
    });
    assert.equal(resolved.connectionString, 'postgres://from-setting');
    assert.equal(resolved.source.kind, 'setting');
  });

  it('falls back to the environment, DRYRUN_DATABASE_URL first', () => {
    const resolved = resolveConnection({
      setting: '',
      env: { DRYRUN_DATABASE_URL: 'postgres://dryrun', DATABASE_URL: 'postgres://generic' },
    });
    assert.equal(resolved.connectionString, 'postgres://dryrun');
    assert.equal(resolved.source.detail, 'DRYRUN_DATABASE_URL');
  });

  it('falls back to the .env file last', () => {
    const resolved = resolveConnection({
      setting: '',
      env: {},
      envFileContents: 'DATABASE_URL=postgres://from-file',
      envFilePath: '.env',
    });
    assert.equal(resolved.connectionString, 'postgres://from-file');
    assert.equal(resolved.source.kind, 'envFile');
  });

  it('explains itself when nothing is configured', () => {
    assert.throws(() => resolveConnection({ setting: '', env: {} }), ConnectionResolutionError);
  });

  it('refuses a setting whose environment variable is missing', () => {
    assert.throws(
      () => resolveConnection({ setting: '${env:NOT_SET}', env: {} }),
      /NOT_SET/,
    );
  });
});
