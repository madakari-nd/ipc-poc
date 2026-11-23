import type { Actor } from './types.js';
import type { WorkflowClient } from '../workflow/workflow.client.js';

export interface WardInfo {
  wardId: string;
  wardCode: string;
  facilityId: string;
  facilityCode: string;
  districtCode: string;
  facilityLocation: { lat: number; lng: number } | null;
}

export interface FacilityInfo {
  facilityId: string;
  facilityCode: string;
  districtCode: string;
  location: { lat: number; lng: number } | null;
}

/** Ward → facility → district register, read from workflow as the acting user (cached 60 s). */
export class WardDirectory {
  private readonly cache = new Map<string, { at: number; wards: Map<string, WardInfo>; facilities: Map<string, FacilityInfo> }>();

  constructor(
    private readonly workflow: WorkflowClient,
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  private async load(actor: Actor) {
    const key = `${actor.userId}:${actor.role}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit;
    const wards = new Map<string, WardInfo>();
    const facilities = new Map<string, FacilityInfo>();
    for (const f of await this.workflow.listFacilities(actor)) {
      const location = f.location ?? null;
      facilities.set(f.id, { facilityId: f.id, facilityCode: f.facilityCode, districtCode: f.districtCode, location });
      for (const w of f.wards ?? []) {
        wards.set(w.id, {
          wardId: w.id,
          wardCode: w.wardCode,
          facilityId: f.id,
          facilityCode: f.facilityCode,
          districtCode: f.districtCode,
          facilityLocation: location,
        });
      }
    }
    const entry = { at: this.now(), wards, facilities };
    this.cache.set(key, entry);
    if (this.cache.size > 5_000) this.cache.delete(this.cache.keys().next().value as string);
    return entry;
  }

  async ward(actor: Actor, wardId: string): Promise<WardInfo | null> {
    return (await this.load(actor)).wards.get(wardId) ?? null;
  }

  async facility(actor: Actor, facilityId: string): Promise<FacilityInfo | null> {
    return (await this.load(actor)).facilities.get(facilityId) ?? null;
  }
}
