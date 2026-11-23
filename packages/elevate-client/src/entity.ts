import { z } from 'zod';
import { csvCell, ElevateError, parseCsv, tenantHeaders, type ElevateHttp } from './http.js';

export const EntitySchema = z.object({
  _id: z.string(),
  entityType: z.string().optional(),
  metaInformation: z.object({ externalId: z.string(), name: z.string().optional() }).passthrough().optional(),
  childHierarchyPath: z.array(z.string()).optional(),
  orgId: z.unknown().optional(),
  tenantId: z.string().optional(),
}).passthrough();
export type Entity = z.infer<typeof EntitySchema>;

const List = z.object({ result: z.array(EntitySchema) }).passthrough();

/**
 * How entity writes are authorised. ELEVATE's entity authenticator needs either an
 * org_admin/tenant_admin user token, or the super-admin header set (admin-auth-token + tenantid
 * + orgid). With a non-admin token the org cannot be validated, so the service account path uses
 * orgId `ALL` (observed 2026-11-23).
 */
export interface EntityWriteAuth {
  userToken: string;
  orgId?: string;
}

/** ELEVATE entity-management (research E4; register c1–c5). */
export class EntityClient {
  constructor(private readonly http: ElevateHttp) {}

  private writeAuth(a: EntityWriteAuth) {
    return { userToken: a.userToken, internal: true, admin: { orgId: a.orgId ?? 'ALL' } };
  }

  /** c4: find by facility/ward code. Internal-token-only call (no user token needed). */
  async findByExternalId(externalId: string, tenantId = this.http.tenantCode): Promise<Entity | undefined> {
    const r = await this.http.call({
      operation: 'entities.find', method: 'POST', path: '/entity-management/v1/entities/find',
      json: { query: { tenantId, 'metaInformation.externalId': externalId }, projection: [] },
      auth: { internal: true }, headers: tenantHeaders(tenantId), schema: List,
    }).catch((e: unknown) => {
      // ELEVATE answers 404 when nothing matches
      if (e instanceof ElevateError && e.status === 404) return { result: [] };
      throw e;
    });
    return r.result[0];
  }

  /** c4 fallback / guest read: needs only the tenant header. */
  async details(entityId: string, tenantId = this.http.tenantCode): Promise<Entity | undefined> {
    const r = await this.http.call({
      operation: 'entities.details', method: 'GET', path: `/entity-management/v1/entities/details/${encodeURIComponent(entityId)}`,
      headers: tenantHeaders(tenantId), schema: List,
    });
    return r.result[0];
  }

  /** Children of a parent of one type (wards of a hospital). */
  async subEntities(userToken: string, parentId: string, type: string, tenantId = this.http.tenantCode) {
    const r = await this.http.call({
      operation: 'entities.subEntityList', method: 'GET',
      path: `/entity-management/v1/entities/subEntityList/${encodeURIComponent(parentId)}`, query: { type },
      auth: { userToken }, headers: tenantHeaders(tenantId),
      schema: z.object({ result: z.object({ data: z.array(z.object({ _id: z.string(), externalId: z.string().optional(), name: z.string().optional(), entityType: z.string().optional() }).passthrough()), count: z.number() }) }).passthrough(),
    });
    return r.result.data;
  }

  /** c2: create ONE entity of a type. ELEVATE validates a single object, not an array. Only
   * externalId and name are kept in metaInformation on this image. */
  async add(auth: EntityWriteAuth, type: string, entity: { externalId: string; name: string; [k: string]: unknown }): Promise<Entity> {
    const r = await this.http.call({
      operation: 'entities.add', method: 'POST', path: '/entity-management/v1/entities/add', query: { type },
      json: entity, auth: this.writeAuth(auth), schema: List,
    });
    const e = r.result[0];
    if (!e) throw new Error('entities.add returned no entity');
    return e;
  }

  /** c2 bulk: CSV upload; ELEVATE streams back a CSV with one row per input (incl. _SYSTEM_ID). */
  async bulkCreate(auth: EntityWriteAuth, type: string, rows: Record<string, unknown>[]): Promise<Record<string, string>[]> {
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
    const form = new FormData();
    form.append('entities', new Blob([csv], { type: 'text/csv' }), 'entities.csv');
    const text = await this.http.call({
      operation: 'entities.bulkCreate', method: 'POST', path: '/entity-management/v1/entities/bulkCreate', query: { type },
      form, auth: this.writeAuth(auth), text: true,
    });
    return parseCsv(String(text ?? ''));
  }

  /** c3: parent→child mapping by Mongo ids. The CSV header typo `parentEntiyId` is ELEVATE's. */
  async mappingUpload(auth: EntityWriteAuth, pairs: { parentId: string; childId: string }[]): Promise<void> {
    const csv = ['parentEntiyId,childEntityId', ...pairs.map((p) => `${p.parentId},${p.childId}`)].join('\n') + '\n';
    const form = new FormData();
    form.append('entityMap', new Blob([csv], { type: 'text/csv' }), 'entityMap.csv');
    await this.http.call({
      operation: 'entities.mappingUpload', method: 'POST', path: '/entity-management/v1/entities/mappingUpload',
      form, auth: this.writeAuth(auth),
    });
  }

  /** c5: update fields (e.g. `metaInformation.location`). */
  async update(auth: EntityWriteAuth, entityId: string, fields: Record<string, unknown>): Promise<unknown> {
    return this.http.call({
      operation: 'entities.update', method: 'POST', path: `/entity-management/v1/entities/update/${encodeURIComponent(entityId)}`,
      json: fields, auth: this.writeAuth(auth),
    });
  }

  /** c1b: create an entity type (CONFIGURE, admin). Used by the seed for `hospital` and `ward`. */
  async createType(
    auth: EntityWriteAuth,
    input: { name: string; isObservable?: boolean; toBeMappedToParentEntities?: boolean },
  ): Promise<{ _id: string; name: string }> {
    const r = await this.http.call({
      operation: 'entityTypes.create', method: 'POST', path: '/entity-management/v1/entityTypes/create',
      json: { isObservable: true, toBeMappedToParentEntities: true, ...input }, auth: this.writeAuth(auth),
      schema: z.object({ result: z.object({ _id: z.string(), name: z.string() }).passthrough() }).passthrough(),
    });
    return r.result;
  }

  /** c1c: entity type documents (id + name) for the tenant. */
  async entityTypeDocs(auth: EntityWriteAuth, tenantId = this.http.tenantCode): Promise<{ _id: string; name: string }[]> {
    const r = await this.http.call({
      operation: 'entityTypes.find', method: 'POST', path: '/entity-management/v1/entityTypes/find',
      json: { query: { tenantId }, projection: ['name', '_id'] }, auth: this.writeAuth(auth),
      schema: z.object({ result: z.array(z.object({ _id: z.string(), name: z.string() }).passthrough()) }).passthrough(),
    });
    return r.result;
  }

  /** c1: list entity types for the tenant. */
  async entityTypes(auth: EntityWriteAuth, tenantId = this.http.tenantCode): Promise<string[]> {
    const r = await this.http.call({
      operation: 'entityTypes.find', method: 'POST', path: '/entity-management/v1/entityTypes/find',
      json: { query: { tenantId }, projection: ['name'] }, auth: this.writeAuth(auth),
      schema: z.object({ result: z.array(z.object({ name: z.string() }).passthrough()) }).passthrough(),
    });
    return r.result.map((t) => t.name);
  }
}
