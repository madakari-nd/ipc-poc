import { Schema, type Types } from 'mongoose';
import { ROLES, SCOPE_LEVELS, type Role, type Scope } from '../scope.js';
import { defineSchema, elevateId, modelFor, ref, text, localizedText, OBJECT_ID_RE } from './base.js';

export const PROFILES = ['dev', 'test', 'uat', 'prod'] as const;
export const LANGUAGES = ['en', 'hi', 'kn'] as const;

interface Meta { _id: Types.ObjectId; v: number; createdAt: Date; updatedAt: Date }

// ---- Programme (§1)
export interface Programme extends Meta {
  code: string; name: string; stateEntityId: string; elevateOrgId: string;
  profile: (typeof PROFILES)[number]; languages: string[];
}
export const ProgrammeModel = modelFor<Programme>('Programme', defineSchema('programmes', {
  code: text({ required: true, max: 32 }),
  name: text({ required: true, max: 200 }),
  stateEntityId: elevateId(true),
  elevateOrgId: elevateId(true),
  profile: text({ required: true, enum: PROFILES }),
  languages: { type: [text({ enum: LANGUAGES })], default: ['en', 'hi', 'kn'] },
}));

// ---- Facility (§1)
export interface Facility extends Meta {
  facilityCode: string; elevateEntityId: string; name: string; districtCode: string;
  level: 'district' | 'sub-district' | 'community'; location?: { lat: number; lng: number };
  status: 'active' | 'inactive';
}
export const FacilityModel = modelFor<Facility>('Facility', defineSchema('facilities', {
  facilityCode: text({ required: true, max: 64 }),
  elevateEntityId: elevateId(true),
  name: text({ required: true, max: 200 }),
  districtCode: text({ required: true, max: 32 }),
  level: text({ required: true, enum: ['district', 'sub-district', 'community'] }),
  location: { type: new Schema({ lat: { type: Number, min: -90, max: 90, required: true }, lng: { type: Number, min: -180, max: 180, required: true } }, { _id: false }), default: undefined },
  status: text({ required: true, enum: ['active', 'inactive'] }),
}));

// ---- Ward (§1)
export interface Ward extends Meta {
  facilityId: Types.ObjectId; wardCode: string; elevateEntityId: string; name: string; wardType: string;
  active: boolean; serviceAccountUserId?: string;
}
export const WardModel = modelFor<Ward>('Ward', defineSchema('wards', {
  facilityId: ref(true),
  wardCode: text({ required: true, max: 64 }),
  elevateEntityId: elevateId(true),
  name: text({ required: true, max: 200 }),
  wardType: text({ required: true, max: 32 }),
  active: { type: Boolean, default: true },
  serviceAccountUserId: elevateId(),
}));

// ---- Cycle (§1)
export interface Cycle extends Meta {
  code: string; startsAt: Date; endsAt: Date; targetDates: { baselineBy?: Date; repeatBy?: Date };
  elevateSolutionIds: { plan?: string; observation?: string }; status: 'planned' | 'active' | 'closed';
}
export const CycleModel = modelFor<Cycle>('Cycle', defineSchema('cycles', {
  code: text({ required: true, max: 32 }),
  startsAt: { type: Date, required: true },
  endsAt: { type: Date, required: true },
  targetDates: { baselineBy: Date, repeatBy: Date },
  elevateSolutionIds: { plan: elevateId(), observation: elevateId() },
  status: text({ required: true, enum: ['planned', 'active', 'closed'] }),
}));

// ---- ScopeAssignment (§1)
export interface ScopeAssignmentDoc extends Meta {
  userId: string; role: Role; scope: Scope; validFrom: Date; validTo?: Date | null; source: 'hr_import' | 'admin';
}
const oidString = { type: String, match: OBJECT_ID_RE, maxlength: 24 };
const scopeSchema = new Schema(
  {
    level: text({ required: true, enum: SCOPE_LEVELS }),
    districtCode: text({ max: 32 }),
    facilityId: oidString,
    facilityIds: { type: [oidString], default: undefined },
    wardIds: { type: [oidString], default: undefined },
  },
  { _id: false, strict: 'throw' },
);
export const ScopeAssignmentModel = modelFor<ScopeAssignmentDoc>('ScopeAssignment', defineSchema('scope_assignments', {
  userId: elevateId(true),
  role: text({ required: true, enum: ROLES }),
  scope: { type: scopeSchema, required: true },
  validFrom: { type: Date, required: true },
  validTo: { type: Date, default: null },
  source: text({ required: true, enum: ['hr_import', 'admin'] }),
}));

export { localizedText };
