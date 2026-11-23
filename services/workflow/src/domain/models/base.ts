import mongoose, { Schema, type Model, type SchemaOptions } from 'mongoose';

/** Free text is at most 500 characters everywhere (data-model preamble, FR-032). */
export const FREE_TEXT_MAX = 500;

export const OBJECT_ID_RE = /^[a-f0-9]{24}$/;

/** Bounded string field (free text by default). */
export const text = (opts: { required?: boolean; max?: number; enum?: readonly string[] } = {}) => ({
  type: String,
  trim: true,
  maxlength: opts.max ?? FREE_TEXT_MAX,
  ...(opts.required ? { required: true } : {}),
  ...(opts.enum ? { enum: [...opts.enum] } : {}),
});

export const ref = (required = false) => ({ type: Schema.Types.ObjectId, ...(required ? { required: true } : {}) });

/** ELEVATE identifiers / user ids (opaque, max 64). */
export const elevateId = (required = false) => text({ required, max: 64 });

export const localizedText = new Schema(
  { en: text({ required: true }), hi: text(), kn: text() },
  { _id: false, strict: 'throw' },
);

/**
 * Every string path without an explicit maxlength gets the 500-character limit, including strings
 * inside arrays and sub-documents, so a new field cannot silently accept unbounded text.
 */
export function freeTextLimitPlugin(schema: Schema): void {
  schema.eachPath((_path, type) => {
    const st = type as unknown as {
      instance?: string;
      options?: { maxlength?: unknown };
      maxlength?: (n: number) => void;
      caster?: { instance?: string; options?: { maxlength?: unknown }; maxlength?: (n: number) => void };
      schema?: Schema;
    };
    if (st.instance === 'String' && st.options?.maxlength === undefined) st.maxlength?.(FREE_TEXT_MAX);
    if (st.instance === 'Array' && st.caster?.instance === 'String' && st.caster.options?.maxlength === undefined) {
      st.caster.maxlength?.(FREE_TEXT_MAX);
    }
    if (st.schema) freeTextLimitPlugin(st.schema);
  });
}

export const versionField = { v: { type: Number, default: 0, min: 0, required: true } };

/**
 * Common options: explicit collection name, timestamps, our own `v` (If-Match / 409; the service
 * increments it on every write), no index or collection creation at boot (migrations own them,
 * research T12), unknown fields refused.
 */
export function baseOptions(collection: string, extra: SchemaOptions = {}): SchemaOptions {
  return {
    collection,
    timestamps: true,
    versionKey: false,
    autoIndex: false,
    autoCreate: false,
    strict: 'throw',
    toJSON: {
      virtuals: false,
      transform: (_doc, ret: Record<string, unknown>) => {
        ret.id = String(ret._id);
        delete ret._id;
        return ret;
      },
    },
    ...extra,
  };
}

/** Builds a versioned, length-limited schema. */
export function defineSchema<T>(collection: string, definition: Record<string, unknown>, extra: SchemaOptions = {}) {
  const schema = new Schema<T>({ ...definition, ...versionField } as never, baseOptions(collection, extra) as never);
  freeTextLimitPlugin(schema as unknown as Schema);
  return schema;
}

/** Idempotent model registration (tests and scripts import models more than once). */
export function modelFor<T>(name: string, schema: Schema<T>): Model<T> {
  return (mongoose.models[name] as Model<T> | undefined) ?? mongoose.model<T>(name, schema);
}
