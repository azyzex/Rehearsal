import assert from 'node:assert/strict';
import * as net from 'node:net';
import { describe, it } from 'node:test';
import { describeError } from '../errors';

/**
 * Turning a thrown thing into a sentence.
 *
 * Written because of an empty red box. Connecting to a local database that was
 * not running produced a failure with nothing in it, and the panel dutifully
 * rendered nothing — a coloured rectangle with no words, which tells the reader
 * less than no rectangle would have.
 *
 * The first test is the one that matters: it makes Node produce the real error
 * rather than a hand-written imitation of it, because the whole bug was that
 * the real one is a shape nobody expects.
 */

describe('describing a failure', () => {
  it('never returns nothing', () => {
    // The property the empty red box violated.
    for (const thrown of [
      new Error(''),
      new AggregateError([]),
      {},
      null,
      undefined,
      '',
      new Error(),
    ]) {
      assert.ok(describeError(thrown).length > 0, `empty for ${JSON.stringify(thrown)}`);
    }
  });

  it('reads the error Node really throws for a closed port', async () => {
    // Node tries ::1 and 127.0.0.1, both are refused, and reports that as an
    // AggregateError whose own message is the empty string. Produced here
    // rather than imitated, because imitating it is how it was missed.
    const thrown = await new Promise<unknown>((resolve) => {
      const socket = net.connect({ host: 'localhost', port: 1 });
      socket.on('error', (error) => {
        socket.destroy();
        resolve(error);
      });
    });

    assert.equal((thrown as Error).message, '', 'the error really does say nothing');

    const described = describeError(thrown);
    assert.match(described, /Nothing is listening/);
    assert.match(described, /not running, or it is on a different port/);
  });

  it('says the same thing for a refusal with the port in it', () => {
    const refused = Object.assign(new Error(''), {
      code: 'ECONNREFUSED',
      address: '127.0.0.1',
      port: 54329,
    });
    assert.match(describeError(refused), /Nothing is listening at 127\.0\.0\.1:54329/);
  });

  it('unwraps an AggregateError to its causes when it has no better answer', () => {
    const aggregate = new AggregateError([
      new Error('something specific went wrong'),
      new Error('something specific went wrong'),
    ]);
    // Deduplicated: the same failure on two addresses is one fact, not two.
    assert.equal(describeError(aggregate), 'something specific went wrong');
  });

  it('follows a cause chain', () => {
    const outer = new Error('', { cause: new Error('the real reason') });
    assert.equal(describeError(outer), 'the real reason');
  });

  it('leaves a message that already says something alone', () => {
    assert.equal(describeError(new Error('relation "users" does not exist')),
      'relation "users" does not exist');
  });

  describe('the failures people actually hit', () => {
    const withCode = (code: string, message = '') =>
      Object.assign(new Error(message), { code });

    it('explains a host that does not resolve', () => {
      const error = Object.assign(new Error(''), { code: 'ENOTFOUND', hostname: 'db.wrong.host' });
      assert.match(describeError(error), /does not resolve/);
      assert.match(describeError(error), /db\.wrong\.host/);
    });

    it('explains a timeout as a firewall rather than as a code', () => {
      assert.match(describeError(withCode('ETIMEDOUT')), /firewall|allow-list/);
    });

    it('explains a rejected password', () => {
      assert.equal(describeError(withCode('28P01')), 'The password was rejected.');
      assert.match(describeError(withCode('ER_ACCESS_DENIED_ERROR')), /username or password/);
    });

    it('explains a database that is not there', () => {
      assert.match(describeError(withCode('3D000')), /does not exist on this server/);
      assert.match(describeError(withCode('ER_BAD_DB_ERROR')), /does not exist on this server/);
    });

    it('explains an unverifiable certificate, with the flag that fixes it', () => {
      assert.match(describeError(withCode('SELF_SIGNED_CERT_IN_CHAIN')), /sslmode=require/);
    });

    it('explains MongoDB, which reports everything as one error type', () => {
      const error = new Error('Server selection timed out after 10000 ms');
      error.name = 'MongoServerSelectionError';
      assert.match(describeError(error), /Check the host/);
      assert.match(describeError(error), /access list/);
    });

    it('finds the code inside a wrapper rather than only on the surface', () => {
      const aggregate = new AggregateError([
        Object.assign(new Error(''), { code: 'ECONNREFUSED', address: '::1', port: 5432 }),
        Object.assign(new Error(''), { code: 'ECONNREFUSED', address: '127.0.0.1', port: 5432 }),
      ]);
      assert.match(describeError(aggregate), /Nothing is listening/);
    });
  });

  it('says the driver’s own words for anything it does not recognise', () => {
    // A wrong explanation is worse than the driver's wording, so anything off
    // the list is passed through rather than guessed at.
    const odd = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    assert.equal(describeError(odd), 'deadlock detected');
  });
});
