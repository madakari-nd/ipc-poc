/**
 * ELEVATE half of the seed (T054), following the recipe proven on the real stack (research E6,
 * E18, E19): entities as the lab admin, checklist copy + `ward` entity type as the org admin, one
 * observation per assessor per cycle solution, users by login-or-create, mentors by role request →
 * approval, plan template + one plan solution per cycle (FR-018a), the hourly sweep job (E12).
 *
 * Every ELEVATE id is kept in the seed state file, so a re-run makes no new ELEVATE objects.
 */
import { createHash } from 'node:crypto';
import {
  buildAnswer, createElevateClients, ElevateConfigSchema, ElevateError, flattenQuestions,
  type Answer, type Assessment, type ElevateClients,
} from '@ipc/elevate-client';
import {
  ALL_WARDS, ASSESSORS, C0_BASELINES, CATALOGUE, CYCLES, DISTRICTS, HOSPITALS, PEOPLE, PLAN_TASKS, STATE,
  serviceName, serviceSlug,
} from './demo-data.js';
import {
  codePrefix, generatePassword, saveState, type FormQuestion, type ProfileEnv, type SeedState,
} from './seed-env.js';

export const ORG_CODE = 'default_code';
export const ORG_ID = 1;
const EMAIL_DOMAIN = 'ipc.example.org';

export interface ElevateSeedResult {
  created: number;
  prefix: string;
  users: Record<string, { id: number; email: string; name: string }>;
  entities: Record<string, string>;
}

export class ElevateSeeder {
  readonly c: ElevateClients;
  readonly prefix: string;
  created = 0;
  private adminToken = '';
  private orgAdminToken = '';
  private tokens = new Map<string, string>();
  private password = '';

  constructor(private readonly env: ProfileEnv, private readonly state: SeedState, private readonly log: (s: string) => void) {
    this.c = createElevateClients(ElevateConfigSchema.parse(env.values), { clientId: `ipc-seed-${env.profile}` });
    this.prefix = codePrefix(env.get('IPC_CODE_PREFIX') || `${env.profile.toUpperCase()}-`, state.generation);
  }

  private save() { saveState(this.env.profile, this.state); }
  private made(what: string) { this.created++; this.log(`    + ${what}`); }
  email(slug: string) { return `${this.prefix.toLowerCase()}${slug}@${EMAIL_DOMAIN}`; }
  displayName(name: string) { return `TEST ${name}`; }

  async run(): Promise<ElevateSeedResult> {
    this.password = this.ensureDemoPassword();
    this.adminToken = (await this.c.user.adminLogin(this.env.require('ELEVATE_ADMIN_EMAIL'), this.env.require('ELEVATE_ADMIN_PASSWORD'))).access_token;
    this.orgAdminToken = (await this.c.user.login(this.env.require('ELEVATE_ORG_ADMIN_EMAIL'), this.env.require('ELEVATE_ORG_ADMIN_PASSWORD'))).access_token;

    this.log('  ELEVATE entities');
    await this.entities();
    this.log('  ELEVATE users and roles');
    await this.users();
    this.log('  ELEVATE checklist v1 and cycle observation solutions');
    await this.checklist();
    this.log('  ELEVATE plan template and plan solution per cycle');
    await this.planSolutions();
    this.log('  ELEVATE observations (one per assessor per cycle solution, E6)');
    await this.observations();
    this.log('  ELEVATE C0 baselines (Ward 4 and Ward 1 of Hospital A)');
    await this.baselines();
    this.log('  ELEVATE scheduler job (hourly escalation sweep, E12)');
    await this.schedulerJob();

    const users: ElevateSeedResult['users'] = {};
    for (const [slug, u] of Object.entries(this.state.users)) {
      const p = PEOPLE.find((x) => x.slug === slug);
      users[slug] = { ...u, name: this.displayName(p ? p.name : serviceName(slug.replace(/^svc-/, '').toUpperCase())) };
    }
    return { created: this.created, prefix: this.prefix, users, entities: this.state.entities };
  }

  async close() { await this.c.close().catch(() => undefined); }

  /** DEMO_USER_PASSWORD from the env file; generated and written FIRST when empty. */
  private ensureDemoPassword(): string {
    let pw = this.env.get('DEMO_USER_PASSWORD');
    if (!pw) {
      pw = generatePassword();
      this.env.set('DEMO_USER_PASSWORD', pw);
      this.log('  generated DEMO_USER_PASSWORD and saved it to the env file');
    }
    return pw;
  }

  // ---- entities ---------------------------------------------------------------------------------
  private async entities() {
    const auth = { userToken: this.adminToken };
    const types = new Map((await this.c.entity.entityTypeDocs(auth)).map((t) => [t.name, t._id]));
    for (const name of ['state', 'district', 'hospital', 'ward']) {
      if (!types.has(name)) {
        const t = await this.c.entity.createType(auth, { name });
        types.set(name, t._id);
        this.made(`entity type ${name}`);
      }
      this.state.entityTypes[name] = types.get(name)!;
    }
    const p = this.prefix;
    const ensure = async (type: string, externalId: string, name: string) => {
      if (!this.state.entities[externalId]) {
        const found = await this.c.entity.findByExternalId(externalId);
        if (found) this.state.entities[externalId] = found._id;
        else {
          const e = await this.c.entity.add(auth, type, { externalId, name });
          this.state.entities[externalId] = e._id;
          this.made(`${type} ${externalId}`);
        }
        this.save();
      }
      return this.state.entities[externalId]!;
    };
    const pairs: { parentId: string; childId: string; key: string; type: string }[] = [];
    const stateId = await ensure('state', STATE.code(p), `${p}${STATE.name}`);
    for (const d of DISTRICTS) {
      const id = await ensure('district', d.code(p), `${p}${d.name}`);
      pairs.push({ parentId: stateId, childId: id, key: `${STATE.code(p)}>${d.code(p)}`, type: 'district' });
    }
    for (const h of HOSPITALS) {
      const hid = await ensure('hospital', h.code(p), `${p}${h.name}`);
      const did = this.state.entities[DISTRICTS.find((d) => d.key === h.district)!.code(p)]!;
      pairs.push({ parentId: did, childId: hid, key: `${h.district}>${h.code(p)}`, type: 'hospital' });
      for (const w of h.wards) {
        const wid = await ensure('ward', w.code(p), `${p}${h.name} ${w.name}`);
        pairs.push({ parentId: hid, childId: wid, key: `${h.code(p)}>${w.code(p)}`, type: 'ward' });
      }
    }
    const todo = pairs.filter((x) => !this.state.mapped[x.key]);
    if (todo.length) {
      await this.c.entity.mappingUpload(auth, todo.map(({ parentId, childId }) => ({ parentId, childId })));
      for (const x of todo) this.state.mapped[x.key] = true;
      this.made(`${todo.length} parent mappings`);
      this.save();
    }
  }

  // ---- users ------------------------------------------------------------------------------------
  /** Login-or-create (account/create is not idempotent). Returns a fresh token. */
  private async ensureUser(slug: string, name: string): Promise<{ id: number; token: string; roles: string[] }> {
    const email = this.email(slug);
    let r;
    try {
      r = await this.c.user.login(email, this.password);
    } catch (e) {
      if (!(e instanceof ElevateError) || e.status >= 500) throw e;
      r = await this.c.user.createAccount({ name: this.displayName(name), email, password: this.password });
      this.made(`user ${email}`);
    }
    this.state.users[slug] = { id: r.user.id, email };
    this.save();
    const roles = (r.user.organizations ?? []).flatMap((o) => (o.roles ?? []).map((x) => x.title));
    this.tokens.set(slug, r.access_token);
    return { id: r.user.id, token: r.access_token, roles };
  }

  private async users() {
    const roles = new Map((await this.c.user.listRoles(this.adminToken)).map((r) => [r.title, r.id]));
    const people = [
      ...PEOPLE,
      ...ALL_WARDS.map((w) => ({ slug: serviceSlug(w.key), name: serviceName(w.key), elevateRole: 'user', mentor: undefined })),
    ];
    // The first mentor is the preflight/integration mentor: its login goes to the env file FIRST.
    const firstMentor = PEOPLE.find((x) => x.mentor)!;
    this.env.set('ELEVATE_MENTOR_EMAIL', this.email(firstMentor.slug));
    this.env.set('ELEVATE_MENTOR_PASSWORD', this.password);

    for (const person of people) {
      let u = await this.ensureUser(person.slug, person.name);
      if (person.mentor) {
        if (!u.roles.includes('mentor')) {
          let reqId = this.state.mentorRequests[person.slug];
          if (!reqId) {
            const rr = await this.c.mentoring.requestMentorRole(u.token, roles.get('mentor')!, person.mentor.about, person.mentor.years);
            reqId = rr.id;
            this.state.mentorRequests[person.slug] = reqId;
            this.save();
            this.made(`mentor role request ${reqId} for ${person.slug}`);
          }
          await this.c.mentoring.approveMentorRole(this.orgAdminToken, reqId);
          this.made(`mentor approval ${reqId}`);
          u = await this.ensureUser(person.slug, person.name);
          if (!u.roles.includes('mentor')) throw new Error(`${person.slug}: mentor role not visible after approval`);
        }
        await this.ensureMentoringProfile(person.slug, person.name, u.id, u.token, 'mentor');
        continue;
      }
      // People who may request or attend sessions (US6) need a mentoring mentee profile.
      if (PEOPLE.includes(person as never)) await this.ensureMentoringProfile(person.slug, person.name, u.id, u.token, 'mentee');
      if (!u.roles.includes(person.elevateRole)) {
        const roleId = roles.get(person.elevateRole);
        if (!roleId) throw new Error(`ELEVATE role ${person.elevateRole} not found`);
        await this.c.user.assignRole(this.adminToken, { user_id: u.id, role_id: roleId, organization_id: ORG_ID });
        this.made(`role ${person.elevateRole} → ${person.slug}`);
        // assignRole ends the user's sessions: log in again for later calls.
        await this.ensureUser(person.slug, person.name);
      }
    }
    this.env.set('ELEVATE_PF_MENTOR_ID', String(this.state.users[firstMentor.slug]!.id));
  }

  /**
   * Mentoring profile (user extension). The approval's role-change callback and the user-create
   * consumer do not create it on this stack (MENTEE_EXTENSION_NOT_FOUND / no extension), and
   * mentoring `users/create` cannot read the profile without a token, so the seed uses mentoring's
   * internal `users/add`, the path its own user-create consumer takes.
   */
  private async ensureMentoringProfile(slug: string, name: string, id: number, token: string, role: 'mentor' | 'mentee') {
    if (this.state.mentorExtensions[slug]) return;
    const exists = role === 'mentor'
      ? await this.c.mentoring.mentorDetails(token, String(id)).then(() => true, () => false)
      : false;
    if (!exists) {
      await this.c.mentoring.addUserExtension({ id, name: this.displayName(name), email: this.email(slug), organizationId: ORG_ID, roles: [role] });
      this.made(`mentoring ${role} profile for ${slug}`);
    }
    this.state.mentorExtensions[slug] = true;
    this.save();
  }

  private async tokenOf(slug: string) {
    const t = this.tokens.get(slug);
    if (t) return t;
    const r = await this.c.user.login(this.state.users[slug]!.email, this.password);
    this.tokens.set(slug, r.access_token);
    return r.access_token;
  }

  // ---- checklist --------------------------------------------------------------------------------
  /** Copies the lab sample solution and points the copy at the `ward` entity type (E19). */
  private async copyChecklist(externalId: string, name: string): Promise<{ _id: string; externalId: string }> {
    const reader = this.env.get('ELEVATE_TEST_USER_EMAIL')
      ? (await this.c.user.login(this.env.get('ELEVATE_TEST_USER_EMAIL'), this.env.get('ELEVATE_TEST_USER_PASSWORD'))).access_token
      : this.orgAdminToken;
    const src = (await this.c.samiksha.solutionDetails(reader, this.env.require('ELEVATE_PF_OBSERVATION_SOLUTION_ID'))).solution.externalId;
    if (!src) throw new Error('sample solution has no externalId');
    const orgAdminId = String(JSON.parse(Buffer.from(this.orgAdminToken.split('.')[1]!, 'base64url').toString()).data.id);
    const copy = await this.c.samiksha.importFromSolution({ sourceSolutionExternalId: src, externalId, name, userId: orgAdminId, orgId: ORG_CODE });
    this.made(`samiksha solution ${externalId}`);
    return copy;
  }

  private async typeAsWard(solutionId: string) {
    await this.c.samiksha.updateSolution(this.orgAdminToken, solutionId, { entityType: 'ward', entityTypeId: this.state.entityTypes.ward });
  }

  private async checklist() {
    const p = this.prefix;
    if (!this.state.checklist) {
      this.state.checklist = await this.copyChecklist(`${p}IPC-WARD-V1`, `${p}IPC ward checklist v1`);
      this.save();
      await this.typeAsWard(this.state.checklist._id);
    }
    for (const cy of CYCLES) {
      const st = (this.state.cycles[cy.code] ??= {});
      if (!st.observationSolutionId) {
        // The active cycle assesses on checklist v1 itself; every other cycle gets its own copy
        // (one observation per assessor per solution, E6).
        const sol = cy.status === 'active'
          ? this.state.checklist
          : await this.copyChecklist(`${p}IPC-WARD-V1-${cy.code}`, `${p}IPC ward checklist v1 ${cy.code}`);
        st.observationSolutionId = sol._id;
        st.observationSolutionExternalId = sol.externalId;
        st.observationSolutionTyped = cy.status === 'active';
        this.save();
      }
      if (!st.observationSolutionTyped) {
        await this.typeAsWard(st.observationSolutionId);
        st.observationSolutionTyped = true;
        this.save();
      }
    }
  }

  // ---- plan template + plan solution per cycle (FR-018a) ---------------------------------------
  private async planSolutions() {
    const p = this.prefix;
    if (!this.state.planTemplate) {
      const externalId = `${p}IPC-WARD-PLAN`;
      const rows = await this.c.project.bulkCreateTemplates(this.orgAdminToken, [{
        title: `${p}IPC ward improvement plan`, externalId, categories: 'teachers', description: 'IPC ward improvement plan (programme template v1)',
        isReusable: 'TRUE', keywords: 'ipc', _arrayFields: 'categories,keywords',
      }]);
      const templateId = rows[0]?._SYSTEM_ID ?? '';
      if (!/^[a-f0-9]{24}$/.test(templateId)) throw new Error(`plan template not created: ${templateId || 'no _SYSTEM_ID'}`);
      this.made(`project template ${externalId}`);
      const tasks = await this.c.project.bulkCreateTemplateTasks(this.orgAdminToken, templateId, PLAN_TASKS.map((t) => ({
        name: t.title, externalId: `${p}TASK-${t.key}`, type: 'simple', hasAParentTask: 'NO', parentTaskId: '', isDeletable: 'TRUE', description: t.key,
      })));
      const taskIds: Record<string, string> = {};
      for (const t of PLAN_TASKS) {
        const row = tasks.find((r) => r.externalId === `${p}TASK-${t.key}`);
        if (!row || !/^[a-f0-9]{24}$/.test(row._SYSTEM_ID ?? '')) throw new Error(`template task ${t.key} not created: ${row?.STATUS ?? 'missing'}`);
        taskIds[t.key] = row._SYSTEM_ID!;
      }
      this.made(`${PLAN_TASKS.length} template tasks`);
      this.state.planTemplate = { templateId, externalId, taskIds };
      this.save();
    }
    const scope = { organizations: [ORG_CODE], state: ['ALL'] };
    if (!this.state.planProgram) {
      const prog = await this.c.project.createProgram(this.orgAdminToken, { externalId: `${p}IPC-PROGRAMME`, name: `${p}IPC programme`, scope });
      this.state.planProgram = { _id: prog._id, externalId: prog.externalId };
      this.made(`project programme ${prog.externalId}`);
      this.save();
    }
    for (const cy of CYCLES) {
      const st = (this.state.cycles[cy.code] ??= {});
      if (!st.planSolutionId) {
        const sol = await this.c.project.createSolution(this.orgAdminToken, {
          programExternalId: this.state.planProgram.externalId, externalId: `${p}IPC-PLAN-${cy.code}`, name: `${p}IPC ward plans ${cy.code}`, scope,
        });
        st.planSolutionId = sol._id;
        this.made(`plan solution ${p}IPC-PLAN-${cy.code}`);
        this.save();
      }
      if (!st.planTemplateCopyId) {
        const copy = (await this.c.project.importProjectTemplate(this.orgAdminToken, this.state.planTemplate.externalId, st.planSolutionId)) as { _id?: string };
        if (!copy?._id) throw new Error(`importProjectTemplate gave no template for ${cy.code}`);
        st.planTemplateCopyId = copy._id;
        this.made(`plan template copy for ${cy.code}`);
        this.save();
      }
    }
  }

  // ---- observations (E6) ------------------------------------------------------------------------
  private async observations() {
    const p = this.prefix;
    for (const cy of CYCLES) {
      const solId = this.state.cycles[cy.code]!.observationSolutionId!;
      for (const a of ASSESSORS) {
        const key = `${cy.code}:${a.slug}`;
        const token = await this.tokenOf(a.slug);
        if (!this.state.observations[key]) {
          const obs = await this.c.samiksha.createObservation(token, solId, {
            name: `${p}${cy.code} ${a.slug}`, entityIds: a.wards.map((w) => this.wardEntityId(w)),
          });
          this.state.observations[key] = obs._id;
          this.made(`observation ${key}`);
          this.save();
        }
        for (const w of a.wards) {
          const sk = `${key}:${w}`;
          if (this.state.submissions[sk]) continue;
          const form = await this.c.samiksha.assessmentForm(token, this.state.observations[key]!, this.wardEntityId(w));
          this.state.submissions[sk] = form.assessment.submissionId;
          if (cy.status === 'active' && !this.state.formQuestions) this.state.formQuestions = formQuestions(form);
          this.made(`submission ${sk}`);
          this.save();
        }
      }
    }
    if (!this.state.formQuestions) {
      // Catalogue source when every submission already existed (e.g. state written by an older run).
      const key = `${CYCLES.find((c) => c.status === 'active')!.code}:officer-a`;
      const form = await this.c.samiksha.assessmentForm(await this.tokenOf('officer-a'), this.state.observations[key]!, this.wardEntityId('HA-W4'));
      this.state.formQuestions = formQuestions(form);
      this.save();
    }
  }

  wardEntityId(wardKey: string): string {
    const w = ALL_WARDS.find((x) => x.key === wardKey)!;
    return this.state.entities[w.code(this.prefix)]!;
  }

  // ---- C0 baselines -----------------------------------------------------------------------------
  /** Completes the back-dated baselines in ELEVATE so they carry real observation/submission ids. */
  private async baselines() {
    const c0 = CYCLES.find((c) => c.status === 'closed')!.code;
    const token = await this.tokenOf('officer-a');
    for (const b of C0_BASELINES) {
      const sk = `${c0}:officer-a:${b.ward}`;
      if (this.state.completed[sk]) continue;
      const obsId = this.state.observations[`${c0}:officer-a`]!;
      const entityId = this.wardEntityId(b.ward);
      const form = await this.c.samiksha.assessmentForm(token, obsId, entityId);
      const answersByKey: Record<string, boolean> = {};
      let qi = 0;
      let unknownOutcome = false;
      for (const ev of form.assessment.evidences) {
        const answers: Record<string, Answer> = {};
        for (const q of flattenQuestions(ev)) {
          const cat = CATALOGUE[qi++];
          const pass = cat ? b.pass[cat.questionKey] !== false : true;
          if (cat) answersByKey[cat.questionKey] = pass;
          const opts = (q.options ?? []).map((o) => o.value);
          const pick = pass ? opts[opts.length - 1] : opts[0];
          const v = q.responseType === 'multiselect' ? [pick ?? ''] : q.responseType === 'radio' ? pick ?? ''
            : q.responseType === 'number' || q.responseType === 'slider' ? (pass ? 10 : 0) : pass ? 'Meets standard' : 'Not in place';
          answers[q._id] = buildAnswer(q, v, `${this.prefix}C0 baseline`);
        }
        try {
          await this.c.samiksha.submitEvidence(token, form.assessment.submissionId, { externalId: ev.externalId, answers });
        } catch (e) {
          // Known quirk: the call completing the last evidence can answer 500 although it completed.
          if (e instanceof ElevateError && e.isServerError) unknownOutcome = true;
          else throw e;
        }
      }
      const list = await this.c.samiksha.listSubmissions(token, obsId, entityId);
      const status = list.find((s) => s._id === form.assessment.submissionId)?.status ?? 'unknown';
      if (!['completed', 'ratingPending', 'ratingCompleted'].includes(status)) {
        throw new Error(`C0 baseline ${b.ward}: submission status ${status}${unknownOutcome ? ' after a 500' : ''}`);
      }
      this.state.completed[sk] = { at: b.completedAt, answers: answersByKey };
      this.made(`completed C0 baseline ${b.ward} (status ${status})`);
      this.save();
    }
  }

  // ---- scheduler (E12) --------------------------------------------------------------------------
  private async schedulerJob() {
    if (this.state.schedulerJobId) return;
    const jobId = `${this.prefix}escalation-sweep`;
    const workflowUrl = this.env.get('WORKFLOW_URL') || 'http://workflow:8080';
    await this.c.scheduler.createJob({
      jobId, email: `${this.prefix.toLowerCase()}scheduler@${EMAIL_DOMAIN}`, url: `${workflowUrl}/internal/escalations/sweep`,
      headers: { 'x-scheduler-secret': this.env.require('SCHEDULER_SHARED_SECRET') }, body: { source: 'elevate-scheduler' },
      repeat: { pattern: '0 * * * *' }, removeOnComplete: true, removeOnFail: 50,
    });
    this.state.schedulerJobId = jobId;
    this.made(`scheduler job ${jobId} (hourly → ${workflowUrl}/internal/escalations/sweep)`);
    this.save();
  }
}

function questionText(q: { question?: unknown }): string {
  const t = q.question;
  if (Array.isArray(t)) return String(t[0] ?? '');
  return typeof t === 'string' ? t : JSON.stringify(t ?? '');
}

/** The checklist v1 form as the catalogue needs it (question order = catalogue order). */
export function formQuestions(form: Assessment): FormQuestion[] {
  return form.assessment.evidences.flatMap((ev) => ev.sections.flatMap((s) => {
    const walk = (qs: typeof s.questions): typeof s.questions => qs.flatMap((q) => (q.responseType === 'pageQuestions' ? walk(q.pageQuestions ?? []) : [q]));
    return walk(s.questions).map((q) => ({
      externalId: q.externalId ?? q._id, text: questionText(q), responseType: q.responseType, evidence: ev.externalId,
      section: s.code ?? '', options: (q.options ?? []).map((o) => o.value),
    }));
  }));
}

export const textHash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
