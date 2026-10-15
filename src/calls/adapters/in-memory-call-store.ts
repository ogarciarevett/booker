import { requireListLimit } from "../../shared/listing.ts";
import { type Call, isCallOpen } from "../call.ts";
import type {
  ActiveGrantBinding,
  CreateCallResult,
  LiveCallStore,
  UpdateCallResult,
} from "../call-store.ts";

interface StoredCall {
  call: Call;
  activeGrant: ActiveGrantBinding | null;
  callSid: string | null;
}

/**
 * In-memory `CallStore`, useful for tests and the shared contract suite. Not safe across
 * processes; the SQLite adapter is the durable one.
 */
export class InMemoryCallStore implements LiveCallStore {
  private readonly calls = new Map<string, StoredCall>();

  /** True when some call other than `excludeId` already holds this non-null `externalId`. */
  private externalIdTaken(externalId: string, excludeId: string): boolean {
    for (const stored of this.calls.values()) {
      if (stored.call.id !== excludeId && stored.call.externalId === externalId) return true;
    }
    return false;
  }

  async create(call: Call): Promise<CreateCallResult> {
    if (this.calls.has(call.id)) return { ok: false, reason: "duplicate_call_id" };
    if (call.externalId !== null && this.externalIdTaken(call.externalId, call.id)) {
      return { ok: false, reason: "duplicate_external_id" };
    }
    this.calls.set(call.id, { call: structuredClone(call), activeGrant: null, callSid: null });
    return { ok: true };
  }

  async findById(id: string): Promise<Call | undefined> {
    const stored = this.calls.get(id);
    return stored === undefined ? undefined : structuredClone(stored.call);
  }

  async findByExternalId(externalId: string): Promise<Call | undefined> {
    for (const stored of this.calls.values()) {
      if (stored.call.externalId === externalId) return structuredClone(stored.call);
    }
    return undefined;
  }

  async update(call: Call): Promise<UpdateCallResult> {
    const stored = this.calls.get(call.id);
    if (stored === undefined) return { ok: false, reason: "not_found" };
    if (call.externalId !== null && this.externalIdTaken(call.externalId, call.id)) {
      return { ok: false, reason: "duplicate_external_id" };
    }
    stored.call = {
      ...stored.call,
      status: call.status,
      externalId: call.externalId,
      endedAt: call.endedAt,
    };
    return { ok: true };
  }

  async setActiveGrant(
    callId: string,
    binding: ActiveGrantBinding | null,
  ): Promise<UpdateCallResult> {
    const stored = this.calls.get(callId);
    if (stored === undefined) return { ok: false, reason: "not_found" };
    stored.activeGrant = binding === null ? null : { ...binding };
    return { ok: true };
  }

  async activeGrant(callId: string): Promise<ActiveGrantBinding | undefined> {
    const binding = this.calls.get(callId)?.activeGrant ?? null;
    return binding === null ? undefined : { ...binding };
  }

  async setCallSid(callId: string, callSid: string): Promise<UpdateCallResult> {
    const stored = this.calls.get(callId);
    if (stored === undefined) return { ok: false, reason: "not_found" };
    stored.callSid = callSid;
    return { ok: true };
  }

  async callSid(callId: string): Promise<string | undefined> {
    return this.calls.get(callId)?.callSid ?? undefined;
  }

  async listOpen(): Promise<Call[]> {
    return [...this.calls.values()]
      .filter((stored) => isCallOpen(stored.call))
      .map((stored) => structuredClone(stored.call));
  }

  async listByErrand(errandId: string): Promise<Call[]> {
    return [...this.calls.values()]
      .filter((stored) => stored.call.errandId === errandId)
      .map((stored) => structuredClone(stored.call));
  }
  async listRecent(limit: number): Promise<Call[]> {
    requireListLimit(limit, "listRecent");
    return [...this.calls.values()]
      .map((stored) => stored.call)
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? a.id.localeCompare(b.id)
          : b.createdAt.localeCompare(a.createdAt),
      )
      .slice(0, limit)
      .map((call) => structuredClone(call));
  }
}
