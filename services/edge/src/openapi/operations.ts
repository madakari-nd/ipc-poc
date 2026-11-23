import { loadOpenApi } from '@ipc/contracts';

type Json = Record<string, unknown>;

export interface OperationInfo {
  operationId: string;
  method: string;
  /** Contract path template, e.g. `/ipc/v1/evidence/{evidenceId}`. */
  template: string;
  regex: RegExp;
  paramNames: string[];
  roles: string[];
  /** Top-level properties the request body schema declares (resolved through $ref/allOf/oneOf). */
  bodyProps: Set<string>;
  queryParams: Set<string>;
  headerParams: Set<string>;
  idempotent: boolean;
  ifMatch: boolean;
  public: boolean;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

function resolveRef(doc: Json, ref: string): Json {
  return ref
    .replace(/^#\//, '')
    .split('/')
    .reduce<Json>((acc, k) => (acc?.[k] ?? {}) as Json, doc);
}

function deref(doc: Json, node: unknown): Json {
  let n = (node ?? {}) as Json;
  for (let i = 0; i < 10 && typeof n.$ref === 'string'; i++) n = resolveRef(doc, n.$ref);
  return n;
}

function schemaProps(doc: Json, schema: unknown, depth = 0): Set<string> {
  const s = deref(doc, schema);
  const out = new Set<string>(Object.keys((s.properties ?? {}) as Json));
  if (depth > 5) return out;
  for (const k of ['allOf', 'oneOf', 'anyOf'] as const) {
    for (const sub of (s[k] ?? []) as unknown[]) for (const p of schemaProps(doc, sub, depth + 1)) out.add(p);
  }
  return out;
}

/** Index of contract operations, used before schema validation (allow-list, stripping, roles, If-Match). */
export class OperationIndex {
  private readonly ops: OperationInfo[];

  constructor(filter: (path: string) => boolean, doc: Json = loadOpenApi()) {
    const ops: OperationInfo[] = [];
    for (const [template, item] of Object.entries((doc.paths ?? {}) as Record<string, Json>)) {
      if (!filter(template)) continue;
      const shared = ((item.parameters ?? []) as unknown[]).map((p) => deref(doc, p));
      for (const m of METHODS) {
        const op = item[m] as Json | undefined;
        if (!op) continue;
        const params = [...shared, ...((op.parameters ?? []) as unknown[]).map((p) => deref(doc, p))];
        const paramNames: string[] = [];
        const regex = new RegExp(
          `^${template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{([^}]+)\}/g, (_s, name: string) => {
            paramNames.push(name);
            return '([^/]+)';
          })}$`,
        );
        const body = op.requestBody ? deref(doc, op.requestBody) : undefined;
        const content = (body?.content ?? {}) as Record<string, Json>;
        const bodySchema = Object.values(content)[0]?.schema;
        const headers = new Set(params.filter((p) => p.in === 'header').map((p) => String(p.name).toLowerCase()));
        const roles = (op['x-roles'] ?? []) as string[];
        ops.push({
          operationId: String(op.operationId),
          method: m.toUpperCase(),
          template,
          regex,
          paramNames,
          roles,
          bodyProps: bodySchema ? schemaProps(doc, bodySchema) : new Set(),
          queryParams: new Set(params.filter((p) => p.in === 'query').map((p) => String(p.name))),
          headerParams: headers,
          idempotent: headers.has('idempotency-key'),
          ifMatch: headers.has('if-match'),
          public: roles.includes('PUBLIC'),
        });
      }
    }
    // Literal segments win over parameters (`/evidence/intents` before `/evidence/{evidenceId}`).
    this.ops = ops.sort((a, b) => a.paramNames.length - b.paramNames.length);
  }

  match(method: string, path: string): OperationInfo | null {
    const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
    return this.ops.find((o) => o.method === m && o.regex.test(path)) ?? null;
  }

  byId(operationId: string): OperationInfo | undefined {
    return this.ops.find((o) => o.operationId === operationId);
  }

  all(): readonly OperationInfo[] {
    return this.ops;
  }
}

/** Operations reachable on the public listener: `/ipc/v1/*` and the edge health routes. */
export const isPublicPath = (p: string) => p.startsWith('/ipc/v1/') || ['/healthz', '/readyz', '/dependencies'].includes(p);
/** Operations the edge serves on its private listener (only `edgeInternalEvidenceDQ`). */
export const isEdgePrivatePath = (p: string) => p === '/internal/evidence/data-quality';
