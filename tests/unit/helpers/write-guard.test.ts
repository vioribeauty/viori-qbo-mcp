import { jest, describe, it, expect } from '@jest/globals';
import { guardWrites, runWithWriteContext, stampMemo } from '../../../src/helpers/write-guard';

// Minimal node-quickbooks stand-in: callback-style methods that record what was posted.
function fakeQb(existing: Record<string, any> = {}) {
  const posted: { method: string; body: any }[] = [];
  const qb: any = {
    createJournalEntry: jest.fn((body: any, cb: any) => { posted.push({ method: 'createJournalEntry', body }); cb(null, { Id: '9', ...body }); }),
    updateJournalEntry: jest.fn((body: any, cb: any) => { posted.push({ method: 'updateJournalEntry', body }); cb(null, { ...existing, ...body, SyncToken: String(Number(body.SyncToken) + 1) }); }),
    deleteJournalEntry: jest.fn((body: any, cb: any) => { posted.push({ method: 'deleteJournalEntry', body }); cb(null, { status: 'Deleted' }); }),
    getJournalEntry: jest.fn((_id: any, cb: any) => cb(null, existing)),
    createVendor: jest.fn((body: any, cb: any) => { posted.push({ method: 'createVendor', body }); cb(null, body); }),
    sendInvoicePdf: jest.fn((_id: any, _to: any, cb: any) => { posted.push({ method: 'sendInvoicePdf', body: null }); cb(null, {}); }),
  };
  return { qb: guardWrites(qb), raw: qb, posted };
}

const promisify = (fn: (cb: any) => void) => new Promise<any>((resolve, reject) => fn((e: any, r: any) => (e ? reject(e) : resolve(r))));

describe('stampMemo', () => {
  it('prefixes, is idempotent, and respects max length', () => {
    expect(stampMemo('connector test', 4000)).toBe('[Claude] connector test');
    expect(stampMemo('[Claude] connector test', 4000)).toBe('[Claude] connector test');
    expect(stampMemo(undefined, 4000)).toBe('[Claude]');
    expect(stampMemo('x'.repeat(200), 100)).toHaveLength(100);
  });
});

describe('guardWrites', () => {
  it('stamps PrivateNote on create', async () => {
    const { qb, posted } = fakeQb();
    await runWithWriteContext(false, () => promisify((cb) => qb.createJournalEntry({ TxnDate: '2026-09-30', PrivateNote: 'connector test' }, cb)));
    expect(posted[0].body.PrivateNote).toBe('[Claude] connector test');
  });

  it('dry_run records the payload and posts nothing', async () => {
    const { qb, posted } = fakeQb();
    const { planned } = await runWithWriteContext(true, () => promisify((cb) => qb.createJournalEntry({ TxnDate: '2026-09-30' }, cb)));
    expect(posted).toHaveLength(0);
    expect(planned).toEqual([{ operation: 'create', entity: 'JournalEntry', payload: { TxnDate: '2026-09-30', PrivateNote: '[Claude]' } }]);
  });

  it('sparse update without the memo field prefixes the existing memo instead of replacing it', async () => {
    const { qb, posted } = fakeQb({ Id: '9', SyncToken: '0', PrivateNote: 'accrual for Sept' });
    await runWithWriteContext(false, () => promisify((cb) => qb.updateJournalEntry({ Id: '9', SyncToken: '0', DocNumber: 'A1' }, cb)));
    expect(posted[0].body.PrivateNote).toBe('[Claude] accrual for Sept');
  });

  it('delete stamps the record first, then deletes with the new SyncToken', async () => {
    const { qb, posted } = fakeQb({ Id: '9', SyncToken: '3', PrivateNote: '[Claude] connector test' });
    await runWithWriteContext(false, () => promisify((cb) => qb.deleteJournalEntry('9', cb)));
    expect(posted.map((p) => p.method)).toEqual(['updateJournalEntry', 'deleteJournalEntry']);
    expect(posted[0].body).toEqual({ Id: '9', SyncToken: '3', sparse: true, PrivateNote: '[Claude] deleted via connector · was: connector test' });
    expect(posted[1].body).toEqual({ Id: '9', SyncToken: '4' });
  });

  it('dry_run delete posts nothing', async () => {
    const { qb, posted } = fakeQb({ Id: '9', SyncToken: '3' });
    const { planned } = await runWithWriteContext(true, () => promisify((cb) => qb.deleteJournalEntry('9', cb)));
    expect(posted).toHaveLength(0);
    expect(planned.map((p) => p.operation)).toEqual(['update', 'delete']);
  });

  it('leaves entities without a memo field untouched', async () => {
    const { qb, posted } = fakeQb();
    await runWithWriteContext(false, () => promisify((cb) => qb.createVendor({ DisplayName: 'Acme' }, cb)));
    expect(posted[0].body).toEqual({ DisplayName: 'Acme' });
  });

  it('blocks other side effects (emails) during dry_run', async () => {
    const { qb, posted } = fakeQb();
    await runWithWriteContext(true, () => promisify((cb) => qb.sendInvoicePdf('1', 'a@b.c', cb)));
    expect(posted).toHaveLength(0);
  });
});
