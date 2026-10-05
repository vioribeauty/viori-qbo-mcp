import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Write guard for every QuickBooks write made through node-quickbooks.
 *
 * Handlers call quickbooks.createX / updateX / deleteX / voidX with very
 * different tool-level parameter shapes, but the payload that reaches the
 * QuickBooks instance is always the real QBO entity. Guarding at that layer
 * gives two guarantees uniformly across all write tools:
 *
 * 1. "[Claude]" memo: the entity's internal memo field is prefixed with
 *    "[Claude]" so the change is identifiable in the QuickBooks audit log.
 *    Updates are sparse (node-quickbooks default), so when the caller did not
 *    send the memo field the current value is read and prefixed instead of
 *    being overwritten. Deletes/voids can't carry a memo, so the record is
 *    first stamped "[Claude] deleted via connector" (sparse update), then
 *    deleted - both steps appear in the audit log.
 * 2. dry_run: when the current tool call is a dry run, reads still happen
 *    (needed to build accurate payloads) but no write is sent. The exact
 *    payloads that would have been posted are recorded for the response.
 */

export const CLAUDE_PREFIX = "[Claude]";

export interface PlannedWrite {
  operation: "create" | "update" | "delete" | "void" | "upload";
  entity: string;
  payload: unknown;
}

interface WriteContext {
  dryRun: boolean;
  planned: PlannedWrite[];
}

const writeContext = new AsyncLocalStorage<WriteContext>();

export function runWithWriteContext<R>(dryRun: boolean, fn: () => Promise<R>): Promise<{ result: R; planned: PlannedWrite[] }> {
  const ctx: WriteContext = { dryRun, planned: [] };
  return writeContext.run(ctx, async () => ({ result: await fn(), planned: ctx.planned }));
}

export function isDryRun(): boolean {
  return writeContext.getStore()?.dryRun === true;
}

export function recordPlannedWrite(w: PlannedWrite): void {
  writeContext.getStore()?.planned.push(w);
}

// Internal (non customer-facing) memo field per QBO entity, with its max length.
// Entities absent here have no memo-type field in the QBO API (Vendor, Item,
// Employee, Class, Department, Term, PaymentMethod, CompanyInfo, Preferences).
const MEMO_FIELDS: Record<string, { field: string; max: number }> = {
  JournalEntry: { field: "PrivateNote", max: 4000 },
  Bill: { field: "PrivateNote", max: 4000 },
  BillPayment: { field: "PrivateNote", max: 4000 },
  Purchase: { field: "PrivateNote", max: 4000 },
  Payment: { field: "PrivateNote", max: 4000 },
  Deposit: { field: "PrivateNote", max: 4000 },
  Transfer: { field: "PrivateNote", max: 4000 },
  Invoice: { field: "PrivateNote", max: 4000 },
  Estimate: { field: "PrivateNote", max: 4000 },
  SalesReceipt: { field: "PrivateNote", max: 4000 },
  CreditMemo: { field: "PrivateNote", max: 4000 },
  RefundReceipt: { field: "PrivateNote", max: 4000 },
  PurchaseOrder: { field: "PrivateNote", max: 4000 },
  VendorCredit: { field: "PrivateNote", max: 4000 },
  Customer: { field: "Notes", max: 2000 },
  Account: { field: "Description", max: 100 },
  TimeActivity: { field: "Description", max: 4000 },
  Attachable: { field: "Note", max: 2000 },
};

export function memoFieldFor(entity: string): { field: string; max: number } | undefined {
  return MEMO_FIELDS[entity];
}

/** "[Claude] <existing>" - idempotent, trimmed to the field's max length. */
export function stampMemo(existing: unknown, max: number): string {
  const text = typeof existing === "string" ? existing.trim() : "";
  const stamped = text.startsWith(CLAUDE_PREFIX) ? text : text ? `${CLAUDE_PREFIX} ${text}` : CLAUDE_PREFIX;
  return stamped.slice(0, max);
}

function stripPrefix(text: unknown): string {
  const t = typeof text === "string" ? text.trim() : "";
  return t.startsWith(CLAUDE_PREFIX) ? t.slice(CLAUDE_PREFIX.length).trim() : t;
}

const WRITE_METHOD = /^(create|update|delete|void)([A-Z][A-Za-z]*)$/;
// Side-effecting calls that are not entity writes; blocked entirely during a dry run.
const OTHER_SIDE_EFFECTS = /^(send[A-Z]|upload$|batch$)/;

type Callback = (err: unknown, result?: unknown) => void;

function call(target: any, method: string, arg: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const fn = target[method];
    if (typeof fn !== "function") {
      reject(new Error(`node-quickbooks has no ${method}()`));
      return;
    }
    fn.call(target, arg, (err: unknown, result: unknown) => (err ? reject(err) : resolve(result)));
  });
}

export function guardWrites<T extends object>(qb: T): T {
  return new Proxy(qb, {
    get(target: any, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || typeof orig !== "function") return orig;

      const m = WRITE_METHOD.exec(prop);
      if (!m) {
        if (OTHER_SIDE_EFFECTS.test(prop)) {
          return function (...args: unknown[]) {
            if (!isDryRun()) return orig.apply(target, args);
            recordPlannedWrite({ operation: "upload", entity: prop, payload: args[0] });
            const cb = args.find((a) => typeof a === "function") as Callback | undefined;
            cb?.(null, { DryRun: true });
          };
        }
        return orig;
      }

      const operation = m[1] as PlannedWrite["operation"];
      const entity = m[2];
      return function (payload: unknown, callback?: Callback) {
        const cb: Callback = typeof callback === "function" ? callback : () => {};
        guardedWrite(target, orig, operation, entity, payload).then(
          (result) => cb(null, result),
          (err) => cb(err)
        );
      };
    },
  });
}

async function guardedWrite(target: any, orig: Function, operation: PlannedWrite["operation"], entity: string, payload: unknown): Promise<unknown> {
  const memo = memoFieldFor(entity);
  const send = (body: unknown) =>
    new Promise((resolve, reject) =>
      orig.call(target, body, (err: unknown, result: unknown) => (err ? reject(err) : resolve(result)))
    );

  if (operation === "create") {
    const body = memo && payload && typeof payload === "object"
      ? { ...(payload as object), [memo.field]: stampMemo((payload as any)[memo.field], memo.max) }
      : payload;
    if (isDryRun()) {
      recordPlannedWrite({ operation, entity, payload: body });
      return { DryRun: true };
    }
    return send(body);
  }

  if (operation === "update") {
    let body = payload;
    if (memo && payload && typeof payload === "object") {
      const p = payload as Record<string, unknown>;
      let current: unknown = p[memo.field];
      if (!(memo.field in p)) {
        // Sparse update without the memo field: prefix the existing memo rather than replacing it.
        const existing = await call(target, `get${entity}`, p.Id);
        current = existing?.[memo.field];
      }
      body = { ...p, [memo.field]: stampMemo(current, memo.max) };
    }
    if (isDryRun()) {
      recordPlannedWrite({ operation, entity, payload: body });
      return { DryRun: true };
    }
    return send(body);
  }

  // delete / void: stamp the record first so the audit trail names Claude, then delete with the fresh SyncToken.
  const id = payload && typeof payload === "object" ? (payload as any).Id : payload;
  if (!memo || id === undefined || id === null || typeof target[`get${entity}`] !== "function") {
    if (isDryRun()) {
      recordPlannedWrite({ operation, entity, payload });
      return { DryRun: true };
    }
    return send(payload);
  }

  const current = await call(target, `get${entity}`, id);
  const prior = stripPrefix(current?.[memo.field]);
  const verb = operation === "delete" ? "deleted" : "voided";
  const stamp = `${CLAUDE_PREFIX} ${verb} via connector${prior ? ` · was: ${prior}` : ""}`.slice(0, memo.max);
  const stampBody = { Id: current.Id, SyncToken: current.SyncToken, sparse: true, [memo.field]: stamp };

  if (isDryRun()) {
    recordPlannedWrite({ operation: "update", entity, payload: stampBody });
    recordPlannedWrite({ operation, entity, payload: { Id: current.Id, SyncToken: "<SyncToken returned by the stamp update>" } });
    return { DryRun: true };
  }

  const stamped = await call(target, `update${entity}`, stampBody);
  return send({ Id: stamped.Id, SyncToken: stamped.SyncToken });
}
