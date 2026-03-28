/**
 * Echo Recruiting v2.0.0
 * AI-Powered Applicant Tracking System — Greenhouse/Lever Alternative
 * Cloudflare Worker — D1 + KV + Stripe Payments
 */

const VERSION = '2.0.0';

interface Env {
  DB: D1Database;
  RC_CACHE: KVNamespace;
  ENGINE_RUNTIME: Fetcher;
  SHARED_BRAIN: Fetcher;
  EMAIL_SENDER: Fetcher;
  ECHO_API_KEY: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
}

/* ── Stripe Helpers ── */
const STRIPE_API = 'https://api.stripe.com/v1';

const PLANS = {
  free:       { name: 'Free',       price_cents: 0,     max_jobs: 3,   featured: false, analytics: false },
  pro:        { name: 'Pro',        price_cents: 4900,   max_jobs: 25,  featured: true,  analytics: false },
  enterprise: { name: 'Enterprise', price_cents: 14900,  max_jobs: -1,  featured: true,  analytics: true  },
} as const;
type PlanTier = keyof typeof PLANS;

const FEATURED_BOOST_CENTS = 1999;

async function stripeRequest(env: Env, path: string, params: Record<string, string>, method = 'POST'): Promise<any> {
  const body = new URLSearchParams(params);
  const resp = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: method === 'GET' ? undefined : body.toString(),
  });
  return resp.json();
}

async function verifyStripeSignature(req: Request, secret: string): Promise<{ valid: boolean; payload?: any }> {
  const sigHeader = req.headers.get('stripe-signature');
  if (!sigHeader) return { valid: false };

  const bodyText = await req.text();
  const parts: Record<string, string> = {};
  for (const item of sigHeader.split(',')) {
    const [k, v] = item.split('=');
    parts[k.trim()] = v.trim();
  }
  const timestamp = parts['t'];
  const sig = parts['v1'];
  if (!timestamp || !sig) return { valid: false };

  // 5-minute replay window
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (age > 300) return { valid: false };

  const signedPayload = `${timestamp}.${bodyText}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const expected = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');

  // Constant-time compare
  if (expected.length !== sig.length) return { valid: false };
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return { valid: false };

  return { valid: true, payload: JSON.parse(bodyText) };
}

interface RLState { c: number; t: number }
const WINDOW = 60_000, MAX_REQ = 120;

function sanitize(s: unknown, max = 2000): string {
  if (typeof s !== 'string') return '';
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').slice(0, max);
}
function authOk(req: Request, env: Env): boolean {
  return req.headers.get('X-Echo-API-Key') === env.ECHO_API_KEY;
}
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'X-XSS-Protection': '1; mode=block', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Strict-Transport-Security': 'max-age=63072000; includeSubDomains' } });
}

function slog(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) {
  const entry = { ts: new Date().toISOString(), level, worker: 'echo-recruiting', version: VERSION, msg, ...data };
  if (level === 'error') console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}
async function rateLimit(ip: string, kv: KVNamespace): Promise<boolean> {
  const key = `rl:${ip}`;
  const raw = await kv.get(key);
  const now = Date.now();
  let st: RLState = raw ? JSON.parse(raw) : { c: 0, t: now };
  const elapsed = now - st.t;
  const decayed = Math.max(0, st.c - (elapsed / WINDOW) * MAX_REQ);
  if (decayed + 1 > MAX_REQ) return false;
  st = { c: decayed + 1, t: now };
  await kv.put(key, JSON.stringify(st), { expirationTtl: 120 });
  return true;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,X-Echo-API-Key' } });

    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;
    const ip = req.headers.get('CF-Connecting-IP') || '0';

    if (!(await rateLimit(ip, env.RC_CACHE))) return json({ error: 'rate limited' }, 429);

    try {
      /* ── Public Endpoints ── */
      if (p === '/') return json({ name: 'echo-recruiting', status: 'ok', version: VERSION, docs: '/health', timestamp: new Date().toISOString() });
      if (p === '/health') return json({ status: 'ok', service: 'echo-recruiting', version: VERSION, stripe: !!env.STRIPE_SECRET_KEY, plans: Object.keys(PLANS), featured_boost_price: `$${FEATURED_BOOST_CENTS / 100}`, timestamp: new Date().toISOString() });

      // Public careers page — list open jobs for a company
      if (p.match(/^\/careers\/([a-z0-9-]+)$/) && m === 'GET') {
        const slug = p.split('/')[2];
        const co = await env.DB.prepare('SELECT id, name, logo_url, website, careers_page FROM companies WHERE slug=? AND status=?').bind(slug, 'active').first() as any;
        if (!co) return json({ error: 'company not found' }, 404);
        const jobs = await env.DB.prepare('SELECT id, title, slug, location, location_type, employment_type, salary_min, salary_max, salary_currency, experience_level, skills, benefits, description, published_at, is_featured, featured_until FROM jobs WHERE company_id=? AND status=? AND is_public=1 ORDER BY (CASE WHEN is_featured=1 AND featured_until > datetime(\'now\') THEN 0 ELSE 1 END), published_at DESC').bind(co.id, 'open').all();
        return json({ company: { name: co.name, logo_url: co.logo_url, website: co.website }, jobs: jobs.results });
      }

      // Public job detail
      if (p.match(/^\/careers\/([a-z0-9-]+)\/([a-z0-9-]+)$/) && m === 'GET') {
        const [, coSlug, jobSlug] = p.split('/').slice(1);
        const co = await env.DB.prepare('SELECT id, name, logo_url FROM companies WHERE slug=?').bind(coSlug).first() as any;
        if (!co) return json({ error: 'company not found' }, 404);
        const job = await env.DB.prepare('SELECT * FROM jobs WHERE company_id=? AND slug=? AND status=? AND is_public=1').bind(co.id, jobSlug, 'open').first();
        if (!job) return json({ error: 'job not found' }, 404);
        return json({ company: { name: co.name, logo_url: co.logo_url }, job });
      }

      // Public apply
      if (p.match(/^\/careers\/([a-z0-9-]+)\/([a-z0-9-]+)\/apply$/) && m === 'POST') {
        const [, coSlug, jobSlug] = p.split('/').slice(1);
        const co = await env.DB.prepare('SELECT id FROM companies WHERE slug=?').bind(coSlug).first() as any;
        if (!co) return json({ error: 'company not found' }, 404);
        const job = await env.DB.prepare('SELECT id FROM jobs WHERE company_id=? AND slug=? AND status=?').bind(co.id, jobSlug, 'open').first() as any;
        if (!job) return json({ error: 'job not found or closed' }, 404);
        const b = await req.json() as any;
        const email = sanitize(b.email, 200).toLowerCase();
        const firstName = sanitize(b.first_name, 100);
        const lastName = sanitize(b.last_name, 100);
        if (!email || !firstName || !lastName) return json({ error: 'first_name, last_name, email required' }, 400);

        // Upsert candidate
        let cand = await env.DB.prepare('SELECT id FROM candidates WHERE company_id=? AND email=?').bind(co.id, email).first() as any;
        if (!cand) {
          const r = await env.DB.prepare('INSERT INTO candidates (company_id,first_name,last_name,email,phone,location,linkedin_url,portfolio_url,resume_url,source) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(co.id, firstName, lastName, email, sanitize(b.phone || '', 50), sanitize(b.location || '', 200), sanitize(b.linkedin_url || '', 500), sanitize(b.portfolio_url || '', 500), sanitize(b.resume_url || '', 500), sanitize(b.source || 'careers_page', 50)).run();
          cand = { id: r.meta.last_row_id };
        }

        // Check if already applied
        const existing = await env.DB.prepare('SELECT id FROM applications WHERE job_id=? AND candidate_id=?').bind(job.id, cand.id).first();
        if (existing) return json({ error: 'already applied' }, 409);

        const r = await env.DB.prepare('INSERT INTO applications (job_id,candidate_id,company_id,cover_letter,answers,referred_by) VALUES (?,?,?,?,?,?)').bind(job.id, cand.id, co.id, sanitize(b.cover_letter || '', 10000), b.answers ? JSON.stringify(b.answers) : '[]', sanitize(b.referred_by || '', 100)).run();
        await env.DB.prepare("INSERT INTO activity_log (company_id,action,target,details) VALUES (?,?,?,?)").bind(co.id, 'application_received', `job:${job.id}`, `${firstName} ${lastName} (${email})`).run();
        return json({ application_id: r.meta.last_row_id, message: 'Application submitted successfully' });
      }

      /* ── Stripe Webhook (NO auth, signature-verified) ── */
      if (p === '/webhooks/stripe' && m === 'POST') {
        if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: 'stripe webhooks not configured' }, 503);
        const { valid, payload } = await verifyStripeSignature(req, env.STRIPE_WEBHOOK_SECRET);
        if (!valid) { slog('warn', 'Invalid Stripe signature'); return json({ error: 'invalid signature' }, 400); }
        const event = payload;
        slog('info', 'Stripe webhook received', { type: event.type, id: event.id });

        if (event.type === 'checkout.session.completed') {
          const session = event.data.object;
          const meta = session.metadata || {};
          const companyId = meta.company_id;

          if (meta.type === 'plan_upgrade' && companyId && meta.plan) {
            const plan = meta.plan as PlanTier;
            const planInfo = PLANS[plan];
            if (planInfo) {
              await env.DB.prepare("UPDATE companies SET plan=?, stripe_customer_id=?, stripe_subscription_id=?, max_active_jobs=?, updated_at=datetime('now') WHERE id=?")
                .bind(plan, session.customer || '', session.subscription || '', planInfo.max_jobs, companyId).run();
              await env.DB.prepare("INSERT INTO stripe_events (stripe_event_id,event_type,company_id,amount_cents,currency,metadata) VALUES (?,?,?,?,?,?)")
                .bind(event.id, event.type, companyId, session.amount_total || planInfo.price_cents, session.currency || 'usd', JSON.stringify(meta)).run();
              await env.DB.prepare("INSERT INTO activity_log (company_id,action,target,details) VALUES (?,?,?,?)")
                .bind(companyId, 'plan_upgraded', `plan:${plan}`, `Upgraded to ${planInfo.name} ($${planInfo.price_cents / 100}/mo)`).run();
              slog('info', 'Plan upgraded via Stripe', { company_id: companyId, plan });
            }
          } else if (meta.type === 'featured_boost' && meta.job_id && companyId) {
            await env.DB.prepare("UPDATE jobs SET is_featured=1, featured_until=datetime('now','+30 days'), updated_at=datetime('now') WHERE id=? AND company_id=?")
              .bind(meta.job_id, companyId).run();
            await env.DB.prepare("INSERT INTO stripe_events (stripe_event_id,event_type,company_id,amount_cents,currency,metadata) VALUES (?,?,?,?,?,?)")
              .bind(event.id, event.type, companyId, FEATURED_BOOST_CENTS, session.currency || 'usd', JSON.stringify(meta)).run();
            await env.DB.prepare("INSERT INTO activity_log (company_id,action,target,details) VALUES (?,?,?,?)")
              .bind(companyId, 'job_featured', `job:${meta.job_id}`, `Featured boost purchased ($${FEATURED_BOOST_CENTS / 100})`).run();
            slog('info', 'Job featured via Stripe', { company_id: companyId, job_id: meta.job_id });
          }
        }

        if (event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.updated') {
          const sub = event.data.object;
          const companyRow = await env.DB.prepare("SELECT id FROM companies WHERE stripe_subscription_id=?").bind(sub.id).first() as any;
          if (companyRow) {
            if (event.type === 'customer.subscription.deleted' || sub.status === 'canceled' || sub.status === 'unpaid') {
              await env.DB.prepare("UPDATE companies SET plan='free', max_active_jobs=3, stripe_subscription_id=NULL, updated_at=datetime('now') WHERE id=?").bind(companyRow.id).run();
              await env.DB.prepare("INSERT INTO activity_log (company_id,action,target,details) VALUES (?,?,?,?)")
                .bind(companyRow.id, 'plan_downgraded', 'plan:free', 'Subscription canceled — reverted to Free').run();
              slog('info', 'Subscription canceled, downgraded to free', { company_id: companyRow.id });
            }
          }
          await env.DB.prepare("INSERT INTO stripe_events (stripe_event_id,event_type,company_id,amount_cents,currency,metadata) VALUES (?,?,?,?,?,?)")
            .bind(event.id, event.type, companyRow?.id || '', 0, 'usd', JSON.stringify(sub.metadata || {})).run();
        }

        if (event.type === 'invoice.payment_failed') {
          const invoice = event.data.object;
          const companyRow = await env.DB.prepare("SELECT id FROM companies WHERE stripe_customer_id=?").bind(invoice.customer).first() as any;
          if (companyRow) {
            await env.DB.prepare("INSERT INTO activity_log (company_id,action,target,details) VALUES (?,?,?,?)")
              .bind(companyRow.id, 'payment_failed', `invoice:${invoice.id}`, 'Payment failed — action required').run();
            slog('warn', 'Payment failed', { company_id: companyRow.id, invoice_id: invoice.id });
          }
          await env.DB.prepare("INSERT INTO stripe_events (stripe_event_id,event_type,company_id,amount_cents,currency,metadata) VALUES (?,?,?,?,?,?)")
            .bind(event.id, event.type, companyRow?.id || '', invoice.amount_due || 0, invoice.currency || 'usd', '{}').run();
        }

        return json({ received: true });
      }

      /* ── Auth Required ── */
      try {
    if (!authOk(req, env)) return json({ error: 'unauthorized' }, 401);
      const db = env.DB;

      /* ═══ COMPANIES ═══ */
      if (p === '/companies' && m === 'GET') {
        const r = await db.prepare('SELECT * FROM companies ORDER BY name').all();
        return json({ companies: r.results });
      }
      if (p === '/companies' && m === 'POST') {
        const b = await req.json() as any;
        const name = sanitize(b.name, 200);
        const slug = sanitize(b.slug || b.name, 100).toLowerCase().replace(/[^a-z0-9]+/g, '-');
        if (!name) return json({ error: 'name required' }, 400);
        const r = await db.prepare('INSERT INTO companies (name,slug,industry,website,logo_url,careers_page) VALUES (?,?,?,?,?,?)').bind(name, slug, sanitize(b.industry || '', 100), sanitize(b.website || '', 500), sanitize(b.logo_url || '', 500), sanitize(b.careers_page || '', 500)).run();
        return json({ id: r.meta.last_row_id, slug });
      }
      if (p.match(/^\/companies\/(\d+)$/) && m === 'PUT') {
        const id = p.split('/')[2];
        const b = await req.json() as any;
        await db.prepare("UPDATE companies SET name=COALESCE(?,name), industry=COALESCE(?,industry), website=COALESCE(?,website), logo_url=COALESCE(?,logo_url), careers_page=COALESCE(?,careers_page), settings=COALESCE(?,settings), updated_at=datetime('now') WHERE id=?").bind(b.name ? sanitize(b.name, 200) : null, b.industry ? sanitize(b.industry, 100) : null, b.website ? sanitize(b.website, 500) : null, b.logo_url ? sanitize(b.logo_url, 500) : null, b.careers_page ? sanitize(b.careers_page, 500) : null, b.settings ? JSON.stringify(b.settings) : null, id).run();
        return json({ updated: true });
      }

      /* ═══ DEPARTMENTS ═══ */
      if (p === '/departments' && m === 'GET') {
        const coId = url.searchParams.get('company_id');
        if (!coId) return json({ error: 'company_id required' }, 400);
        const r = await db.prepare('SELECT * FROM departments WHERE company_id=? ORDER BY name').bind(coId).all();
        return json({ departments: r.results });
      }
      if (p === '/departments' && m === 'POST') {
        const b = await req.json() as any;
        if (!b.company_id || !b.name) return json({ error: 'company_id and name required' }, 400);
        const r = await db.prepare('INSERT INTO departments (company_id,name,head) VALUES (?,?,?)').bind(b.company_id, sanitize(b.name, 200), sanitize(b.head || '', 100)).run();
        return json({ id: r.meta.last_row_id });
      }

      /* ═══ JOBS ═══ */
      if (p === '/jobs' && m === 'GET') {
        const coId = url.searchParams.get('company_id');
        const status = url.searchParams.get('status');
        let q = 'SELECT * FROM jobs WHERE 1=1';
        const params: any[] = [];
        if (coId) { q += ' AND company_id=?'; params.push(coId); }
        if (status) { q += ' AND status=?'; params.push(status); }
        q += ' ORDER BY created_at DESC';
        const r = await db.prepare(q).bind(...params).all();
        return json({ jobs: r.results });
      }
      if (p === '/jobs' && m === 'POST') {
        const b = await req.json() as any;
        if (!b.company_id || !b.title) return json({ error: 'company_id and title required' }, 400);
        const slug = sanitize(b.slug || b.title, 100).toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const r = await db.prepare('INSERT INTO jobs (company_id,department_id,title,slug,description,requirements,responsibilities,location,location_type,employment_type,salary_min,salary_max,salary_currency,experience_level,skills,benefits,pipeline_stages,hiring_manager,recruiter,headcount,is_public,status,published_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(
          b.company_id, b.department_id || null, sanitize(b.title, 200), slug,
          sanitize(b.description || '', 20000), sanitize(b.requirements || '', 10000),
          sanitize(b.responsibilities || '', 10000), sanitize(b.location || '', 200),
          sanitize(b.location_type || 'onsite', 20), sanitize(b.employment_type || 'full_time', 20),
          b.salary_min || null, b.salary_max || null, sanitize(b.salary_currency || 'USD', 10),
          sanitize(b.experience_level || 'mid', 20),
          b.skills ? JSON.stringify(b.skills) : '[]', b.benefits ? JSON.stringify(b.benefits) : '[]',
          b.pipeline_stages ? JSON.stringify(b.pipeline_stages) : '["applied","screening","phone_screen","interview","technical","offer","hired"]',
          sanitize(b.hiring_manager || '', 100), sanitize(b.recruiter || '', 100),
          b.headcount || 1, b.is_public !== false ? 1 : 0,
          sanitize(b.status || 'open', 20), b.status === 'open' ? new Date().toISOString() : null
        ).run();
        await db.prepare("INSERT INTO activity_log (company_id,action,target,details) VALUES (?,?,?,?)").bind(b.company_id, 'job_created', slug, sanitize(b.title, 200)).run();
        return json({ id: r.meta.last_row_id, slug });
      }
      if (p.match(/^\/jobs\/(\d+)$/) && m === 'GET') {
        const id = p.split('/')[2];
        const job = await db.prepare('SELECT * FROM jobs WHERE id=?').bind(id).first();
        if (!job) return json({ error: 'not found' }, 404);
        const apps = await db.prepare("SELECT a.*, c.first_name, c.last_name, c.email, c.current_title FROM applications a JOIN candidates c ON a.candidate_id=c.id WHERE a.job_id=? AND a.status='active' ORDER BY a.applied_at DESC").bind(id).all();
        return json({ ...job, applications: apps.results });
      }
      if (p.match(/^\/jobs\/(\d+)$/) && m === 'PUT') {
        const id = p.split('/')[2];
        const b = await req.json() as any;
        const fields: string[] = [];
        const vals: any[] = [];
        for (const [k, v] of Object.entries(b)) {
          if (['title', 'description', 'requirements', 'responsibilities', 'location', 'location_type', 'employment_type', 'experience_level', 'hiring_manager', 'recruiter', 'status'].includes(k)) {
            fields.push(`${k}=?`);
            vals.push(sanitize(String(v), 20000));
          }
          if (['salary_min', 'salary_max', 'headcount', 'is_public', 'department_id'].includes(k)) {
            fields.push(`${k}=?`);
            vals.push(v);
          }
          if (['skills', 'benefits', 'pipeline_stages'].includes(k)) {
            fields.push(`${k}=?`);
            vals.push(JSON.stringify(v));
          }
        }
        if (fields.length === 0) return json({ error: 'no valid fields' }, 400);
        if (b.status === 'open' && !fields.includes('published_at=?')) { fields.push('published_at=?'); vals.push(new Date().toISOString()); }
        fields.push("updated_at=datetime('now')");
        vals.push(id);
        await db.prepare(`UPDATE jobs SET ${fields.join(',')} WHERE id=?`).bind(...vals).run();
        return json({ updated: true });
      }
      // Pipeline view — candidates grouped by stage
      if (p.match(/^\/jobs\/(\d+)\/pipeline$/) && m === 'GET') {
        const jobId = p.split('/')[2];
        const job = await db.prepare('SELECT pipeline_stages FROM jobs WHERE id=?').bind(jobId).first() as any;
        if (!job) return json({ error: 'not found' }, 404);
        const stages = JSON.parse(job.pipeline_stages || '[]');
        const apps = await db.prepare("SELECT a.*, c.first_name, c.last_name, c.email, c.current_title, c.current_company FROM applications a JOIN candidates c ON a.candidate_id=c.id WHERE a.job_id=? AND a.status='active' ORDER BY a.stage_changed_at DESC").bind(jobId).all();
        const pipeline: Record<string, any[]> = {};
        for (const s of stages) pipeline[s] = [];
        for (const a of apps.results as any[]) {
          if (pipeline[a.stage]) pipeline[a.stage].push(a);
          else pipeline[a.stage] = [a];
        }
        return json({ stages, pipeline, total: apps.results.length });
      }

      /* ═══ CANDIDATES ═══ */
      if (p === '/candidates' && m === 'GET') {
        const coId = url.searchParams.get('company_id');
        const search = url.searchParams.get('q');
        let q = 'SELECT * FROM candidates WHERE 1=1';
        const params: any[] = [];
        if (coId) { q += ' AND company_id=?'; params.push(coId); }
        if (search) { q += " AND (first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR current_title LIKE ?)"; const s = `%${search}%`; params.push(s, s, s, s); }
        q += ' ORDER BY created_at DESC LIMIT 200';
        const r = await db.prepare(q).bind(...params).all();
        return json({ candidates: r.results });
      }
      if (p === '/candidates' && m === 'POST') {
        const b = await req.json() as any;
        if (!b.company_id || !b.first_name || !b.last_name || !b.email) return json({ error: 'company_id, first_name, last_name, email required' }, 400);
        const r = await db.prepare('INSERT INTO candidates (company_id,first_name,last_name,email,phone,location,linkedin_url,portfolio_url,resume_url,resume_text,skills,experience_years,current_company,current_title,source,tags,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(
          b.company_id, sanitize(b.first_name, 100), sanitize(b.last_name, 100), sanitize(b.email, 200).toLowerCase(),
          sanitize(b.phone || '', 50), sanitize(b.location || '', 200), sanitize(b.linkedin_url || '', 500),
          sanitize(b.portfolio_url || '', 500), sanitize(b.resume_url || '', 500), sanitize(b.resume_text || '', 50000),
          b.skills ? JSON.stringify(b.skills) : '[]', b.experience_years || null,
          sanitize(b.current_company || '', 200), sanitize(b.current_title || '', 200),
          sanitize(b.source || 'manual', 50), b.tags ? JSON.stringify(b.tags) : '[]', sanitize(b.notes || '', 5000)
        ).run();
        return json({ id: r.meta.last_row_id });
      }
      if (p.match(/^\/candidates\/(\d+)$/) && m === 'GET') {
        const id = p.split('/')[2];
        const cand = await db.prepare('SELECT * FROM candidates WHERE id=?').bind(id).first();
        if (!cand) return json({ error: 'not found' }, 404);
        const apps = await db.prepare("SELECT a.*, j.title as job_title, j.slug as job_slug FROM applications a JOIN jobs j ON a.job_id=j.id WHERE a.candidate_id=? ORDER BY a.applied_at DESC").bind(id).all();
        return json({ ...cand, applications: apps.results });
      }
      if (p.match(/^\/candidates\/(\d+)$/) && m === 'PUT') {
        const id = p.split('/')[2];
        const b = await req.json() as any;
        const fields: string[] = [];
        const vals: any[] = [];
        for (const [k, v] of Object.entries(b)) {
          if (['first_name', 'last_name', 'email', 'phone', 'location', 'linkedin_url', 'portfolio_url', 'resume_url', 'resume_text', 'current_company', 'current_title', 'source', 'notes', 'status'].includes(k)) {
            fields.push(`${k}=?`); vals.push(sanitize(String(v), 50000));
          }
          if (['skills', 'tags'].includes(k)) { fields.push(`${k}=?`); vals.push(JSON.stringify(v)); }
          if (k === 'experience_years') { fields.push(`${k}=?`); vals.push(v); }
        }
        if (fields.length === 0) return json({ error: 'no valid fields' }, 400);
        fields.push("updated_at=datetime('now')");
        vals.push(id);
        await db.prepare(`UPDATE candidates SET ${fields.join(',')} WHERE id=?`).bind(...vals).run();
        return json({ updated: true });
      }

      /* ═══ APPLICATIONS ═══ */
      if (p === '/applications' && m === 'GET') {
        const coId = url.searchParams.get('company_id');
        const jobId = url.searchParams.get('job_id');
        const stage = url.searchParams.get('stage');
        let q = "SELECT a.*, c.first_name, c.last_name, c.email, c.current_title, j.title as job_title FROM applications a JOIN candidates c ON a.candidate_id=c.id JOIN jobs j ON a.job_id=j.id WHERE a.status='active'";
        const params: any[] = [];
        if (coId) { q += ' AND a.company_id=?'; params.push(coId); }
        if (jobId) { q += ' AND a.job_id=?'; params.push(jobId); }
        if (stage) { q += ' AND a.stage=?'; params.push(stage); }
        q += ' ORDER BY a.applied_at DESC LIMIT 500';
        const r = await db.prepare(q).bind(...params).all();
        return json({ applications: r.results });
      }
      // Move candidate through pipeline
      if (p.match(/^\/applications\/(\d+)\/move$/) && m === 'POST') {
        const id = p.split('/')[2];
        const b = await req.json() as any;
        const stage = sanitize(b.stage, 50);
        if (!stage) return json({ error: 'stage required' }, 400);
        await db.prepare("UPDATE applications SET stage=?, stage_changed_at=datetime('now') WHERE id=?").bind(stage, id).run();
        const app = await db.prepare('SELECT company_id, candidate_id, job_id FROM applications WHERE id=?').bind(id).first() as any;
        if (app) await db.prepare("INSERT INTO activity_log (company_id,action,target,details) VALUES (?,?,?,?)").bind(app.company_id, 'stage_changed', `app:${id}`, `Moved to ${stage}`).run();
        // If moved to 'hired', increment job filled count
        if (stage === 'hired') {
          await db.prepare('UPDATE jobs SET filled = filled + 1 WHERE id=?').bind(app.job_id).run();
        }
        return json({ updated: true, stage });
      }
      // Reject application
      if (p.match(/^\/applications\/(\d+)\/reject$/) && m === 'POST') {
        const id = p.split('/')[2];
        const b = await req.json() as any;
        await db.prepare("UPDATE applications SET status='rejected', rejection_reason=? WHERE id=?").bind(sanitize(b.reason || '', 2000), id).run();
        return json({ rejected: true });
      }
      // AI screen resume
      if (p.match(/^\/applications\/(\d+)\/ai-screen$/) && m === 'POST') {
        const id = p.split('/')[2];
        const app = await db.prepare('SELECT a.*, c.first_name, c.last_name, c.resume_text, c.skills, c.experience_years, c.current_title, j.title as job_title, j.requirements, j.skills as job_skills FROM applications a JOIN candidates c ON a.candidate_id=c.id JOIN jobs j ON a.job_id=j.id WHERE a.id=?').bind(id).first() as any;
        if (!app) return json({ error: 'not found' }, 404);
        let aiScore = 0;
        let aiSummary = '';
        try {
          const prompt = `Score this candidate (0-100) and provide a 2-sentence summary.\n\nJob: ${app.job_title}\nRequirements: ${app.requirements}\nJob Skills: ${app.job_skills}\n\nCandidate: ${app.first_name} ${app.last_name}\nCurrent: ${app.current_title}\nExperience: ${app.experience_years} years\nSkills: ${app.skills}\nResume: ${(app.resume_text || '').slice(0, 3000)}`;
          const aiResp = await env.ENGINE_RUNTIME.fetch('https://engine/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine_id: 'hr-advisor', query: prompt }) });
          if (aiResp.ok) {
            const data = await aiResp.json() as any;
            const text = data.response || data.answer || '';
            const scoreMatch = text.match(/(\d{1,3})\s*\/?\s*100/);
            aiScore = scoreMatch ? Math.min(100, parseInt(scoreMatch[1])) : 50;
            aiSummary = text.slice(0, 500);
          }
        } catch { aiScore = 50; aiSummary = 'AI screening unavailable'; }
        await db.prepare('UPDATE applications SET ai_score=?, ai_summary=? WHERE id=?').bind(aiScore, aiSummary, id).run();
        return json({ ai_score: aiScore, ai_summary: aiSummary });
      }

      /* ═══ INTERVIEWS ═══ */
      if (p === '/interviews' && m === 'GET') {
        const coId = url.searchParams.get('company_id');
        const appId = url.searchParams.get('application_id');
        let q = 'SELECT * FROM interviews WHERE 1=1';
        const params: any[] = [];
        if (coId) { q += ' AND company_id=?'; params.push(coId); }
        if (appId) { q += ' AND application_id=?'; params.push(appId); }
        q += ' ORDER BY scheduled_at';
        const r = await db.prepare(q).bind(...params).all();
        return json({ interviews: r.results });
      }
      if (p === '/interviews' && m === 'POST') {
        const b = await req.json() as any;
        if (!b.application_id || !b.company_id || !b.interviewer) return json({ error: 'application_id, company_id, interviewer required' }, 400);
        const r = await db.prepare('INSERT INTO interviews (application_id,company_id,interviewer,interview_type,scheduled_at,duration_min,location,meeting_link,notes) VALUES (?,?,?,?,?,?,?,?,?)').bind(b.application_id, b.company_id, sanitize(b.interviewer, 100), sanitize(b.interview_type || 'video', 20), b.scheduled_at || null, b.duration_min || 60, sanitize(b.location || '', 200), sanitize(b.meeting_link || '', 500), sanitize(b.notes || '', 2000)).run();
        // Move application to interview stage
        await db.prepare("UPDATE applications SET stage='interview', stage_changed_at=datetime('now') WHERE id=? AND stage IN ('applied','screening','phone_screen')").bind(b.application_id).run();
        return json({ id: r.meta.last_row_id });
      }
      if (p.match(/^\/interviews\/(\d+)\/complete$/) && m === 'POST') {
        const id = p.split('/')[2];
        await db.prepare("UPDATE interviews SET status='completed', completed_at=datetime('now') WHERE id=?").bind(id).run();
        return json({ completed: true });
      }
      if (p.match(/^\/interviews\/(\d+)\/cancel$/) && m === 'POST') {
        const id = p.split('/')[2];
        await db.prepare("UPDATE interviews SET status='cancelled' WHERE id=?").bind(id).run();
        return json({ cancelled: true });
      }

      /* ═══ SCORECARDS ═══ */
      if (p === '/scorecards' && m === 'GET') {
        const appId = url.searchParams.get('application_id');
        const intId = url.searchParams.get('interview_id');
        let q = 'SELECT * FROM scorecards WHERE 1=1';
        const params: any[] = [];
        if (appId) { q += ' AND application_id=?'; params.push(appId); }
        if (intId) { q += ' AND interview_id=?'; params.push(intId); }
        q += ' ORDER BY created_at DESC';
        const r = await db.prepare(q).bind(...params).all();
        return json({ scorecards: r.results });
      }
      if (p === '/scorecards' && m === 'POST') {
        const b = await req.json() as any;
        if (!b.interview_id || !b.application_id || !b.company_id || !b.reviewer) return json({ error: 'interview_id, application_id, company_id, reviewer required' }, 400);
        const r = await db.prepare('INSERT INTO scorecards (interview_id,application_id,company_id,reviewer,overall_rating,ratings,strengths,weaknesses,recommendation,notes) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(
          b.interview_id, b.application_id, b.company_id, sanitize(b.reviewer, 100),
          b.overall_rating || 0, b.ratings ? JSON.stringify(b.ratings) : '{}',
          sanitize(b.strengths || '', 5000), sanitize(b.weaknesses || '', 5000),
          sanitize(b.recommendation || 'undecided', 30), sanitize(b.notes || '', 5000)
        ).run();
        return json({ id: r.meta.last_row_id });
      }

      /* ═══ OFFERS ═══ */
      if (p === '/offers' && m === 'GET') {
        const coId = url.searchParams.get('company_id');
        const q = coId ? "SELECT o.*, c.first_name, c.last_name, c.email FROM offers o JOIN candidates c ON o.candidate_id=c.id WHERE o.company_id=? ORDER BY o.created_at DESC" : 'SELECT * FROM offers ORDER BY created_at DESC';
        const r = coId ? await db.prepare(q).bind(coId).all() : await db.prepare(q).all();
        return json({ offers: r.results });
      }
      if (p === '/offers' && m === 'POST') {
        const b = await req.json() as any;
        if (!b.application_id || !b.company_id || !b.candidate_id || !b.job_title) return json({ error: 'application_id, company_id, candidate_id, job_title required' }, 400);
        const r = await db.prepare('INSERT INTO offers (application_id,company_id,candidate_id,job_title,salary,salary_currency,equity,bonus,start_date,expiry_date,benefits,letter_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').bind(
          b.application_id, b.company_id, b.candidate_id, sanitize(b.job_title, 200),
          b.salary || null, sanitize(b.salary_currency || 'USD', 10),
          sanitize(b.equity || '', 200), sanitize(b.bonus || '', 200),
          b.start_date || null, b.expiry_date || null,
          b.benefits ? JSON.stringify(b.benefits) : '[]', sanitize(b.letter_url || '', 500)
        ).run();
        // Move application to offer stage
        await db.prepare("UPDATE applications SET stage='offer', stage_changed_at=datetime('now') WHERE id=?").bind(b.application_id).run();
        return json({ id: r.meta.last_row_id });
      }
      if (p.match(/^\/offers\/(\d+)\/send$/) && m === 'POST') {
        const id = p.split('/')[2];
        await db.prepare("UPDATE offers SET status='sent', sent_at=datetime('now'), updated_at=datetime('now') WHERE id=?").bind(id).run();
        return json({ sent: true });
      }
      if (p.match(/^\/offers\/(\d+)\/accept$/) && m === 'POST') {
        const id = p.split('/')[2];
        await db.prepare("UPDATE offers SET status='accepted', responded_at=datetime('now'), updated_at=datetime('now') WHERE id=?").bind(id).run();
        const offer = await db.prepare('SELECT application_id FROM offers WHERE id=?').bind(id).first() as any;
        if (offer) await db.prepare("UPDATE applications SET stage='hired', stage_changed_at=datetime('now') WHERE id=?").bind(offer.application_id).run();
        return json({ accepted: true });
      }
      if (p.match(/^\/offers\/(\d+)\/decline$/) && m === 'POST') {
        const id = p.split('/')[2];
        await db.prepare("UPDATE offers SET status='declined', responded_at=datetime('now'), updated_at=datetime('now') WHERE id=?").bind(id).run();
        return json({ declined: true });
      }

      /* ═══ TALENT POOL ═══ */
      if (p === '/talent-pool' && m === 'GET') {
        const coId = url.searchParams.get('company_id');
        const pool = url.searchParams.get('pool_name') || 'general';
        if (!coId) return json({ error: 'company_id required' }, 400);
        const r = await db.prepare("SELECT tp.*, c.first_name, c.last_name, c.email, c.current_title, c.skills FROM talent_pool tp JOIN candidates c ON tp.candidate_id=c.id WHERE tp.company_id=? AND tp.pool_name=? ORDER BY tp.created_at DESC").bind(coId, pool).all();
        return json({ talent_pool: r.results });
      }
      if (p === '/talent-pool' && m === 'POST') {
        const b = await req.json() as any;
        if (!b.company_id || !b.candidate_id) return json({ error: 'company_id and candidate_id required' }, 400);
        const r = await db.prepare('INSERT OR IGNORE INTO talent_pool (company_id,candidate_id,pool_name,added_by,notes) VALUES (?,?,?,?,?)').bind(b.company_id, b.candidate_id, sanitize(b.pool_name || 'general', 100), sanitize(b.added_by || '', 100), sanitize(b.notes || '', 2000)).run();
        return json({ added: r.meta.changes > 0 });
      }

      /* ═══ HIRING TEAM ═══ */
      if (p === '/hiring-team' && m === 'GET') {
        const jobId = url.searchParams.get('job_id');
        const coId = url.searchParams.get('company_id');
        let q = 'SELECT * FROM hiring_team WHERE 1=1';
        const params: any[] = [];
        if (coId) { q += ' AND company_id=?'; params.push(coId); }
        if (jobId) { q += ' AND job_id=?'; params.push(jobId); }
        const r = await db.prepare(q).bind(...params).all();
        return json({ team: r.results });
      }
      if (p === '/hiring-team' && m === 'POST') {
        const b = await req.json() as any;
        if (!b.company_id || !b.user_email) return json({ error: 'company_id and user_email required' }, 400);
        const r = await db.prepare('INSERT OR IGNORE INTO hiring_team (company_id,job_id,user_email,user_name,role) VALUES (?,?,?,?,?)').bind(b.company_id, b.job_id || null, sanitize(b.user_email, 200), sanitize(b.user_name || '', 100), sanitize(b.role || 'interviewer', 50)).run();
        return json({ added: r.meta.changes > 0 });
      }

      /* ═══ ANALYTICS & DASHBOARD ═══ */
      if (p.match(/^\/dashboard\/(\d+)$/) && m === 'GET') {
        const coId = p.split('/')[2];
        const [openJobs, totalApps, byStage, recentApps, interviews, offers] = await Promise.all([
          db.prepare("SELECT COUNT(*) as cnt FROM jobs WHERE company_id=? AND status='open'").bind(coId).first() as any,
          db.prepare("SELECT COUNT(*) as cnt FROM applications WHERE company_id=? AND status='active'").bind(coId).first() as any,
          db.prepare("SELECT stage, COUNT(*) as cnt FROM applications WHERE company_id=? AND status='active' GROUP BY stage").bind(coId).all(),
          db.prepare("SELECT a.id, c.first_name, c.last_name, j.title as job_title, a.stage, a.applied_at FROM applications a JOIN candidates c ON a.candidate_id=c.id JOIN jobs j ON a.job_id=j.id WHERE a.company_id=? AND a.status='active' ORDER BY a.applied_at DESC LIMIT 10").bind(coId).all(),
          db.prepare("SELECT COUNT(*) as cnt FROM interviews WHERE company_id=? AND status='scheduled' AND scheduled_at > datetime('now')").bind(coId).first() as any,
          db.prepare("SELECT COUNT(*) as cnt FROM offers WHERE company_id=? AND status='sent'").bind(coId).first() as any,
        ]);
        const hired = await db.prepare("SELECT COUNT(*) as cnt FROM applications WHERE company_id=? AND stage='hired'").bind(coId).first() as any;
        return json({
          open_jobs: openJobs?.cnt || 0,
          total_applications: totalApps?.cnt || 0,
          by_stage: byStage.results,
          upcoming_interviews: interviews?.cnt || 0,
          pending_offers: offers?.cnt || 0,
          total_hires: hired?.cnt || 0,
          recent_applications: recentApps.results,
        });
      }

      /* ═══ AI ═══ */
      if (p.match(/^\/ai\/job-description$/) && m === 'POST') {
        const b = await req.json() as any;
        if (!b.title) return json({ error: 'title required' }, 400);
        let description = '';
        try {
          const prompt = `Write a professional job description for: ${b.title}${b.company ? ` at ${b.company}` : ''}${b.industry ? ` (${b.industry} industry)` : ''}. Include: overview, responsibilities (5-7 bullet points), requirements (5-7 bullet points), nice-to-haves (3-4), and benefits. Format in clean markdown.`;
          const aiResp = await env.ENGINE_RUNTIME.fetch('https://engine/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine_id: 'hr-advisor', query: prompt }) });
          if (aiResp.ok) {
            const data = await aiResp.json() as any;
            description = data.response || data.answer || 'AI generation unavailable';
          }
        } catch { description = 'AI generation unavailable'; }
        return json({ description });
      }

      if (p.match(/^\/ai\/pipeline-insights\/(\d+)$/) && m === 'GET') {
        const coId = p.split('/')[3];
        const jobs = await db.prepare("SELECT j.id, j.title, j.headcount, j.filled, (SELECT COUNT(*) FROM applications WHERE job_id=j.id AND status='active') as total_apps, (SELECT COUNT(*) FROM applications WHERE job_id=j.id AND stage='hired') as hires, (SELECT AVG(julianday(stage_changed_at) - julianday(applied_at)) FROM applications WHERE job_id=j.id AND stage='hired') as avg_days_to_hire FROM jobs j WHERE j.company_id=? AND j.status='open'").bind(coId).all();
        const stageDropoff = await db.prepare("SELECT stage, COUNT(*) as cnt FROM applications WHERE company_id=? AND status='rejected' GROUP BY stage ORDER BY cnt DESC").bind(coId).all();
        const sources = await db.prepare("SELECT c.source, COUNT(*) as cnt FROM applications a JOIN candidates c ON a.candidate_id=c.id WHERE a.company_id=? GROUP BY c.source ORDER BY cnt DESC").bind(coId).all();
        return json({
          jobs: jobs.results,
          dropoff_stages: stageDropoff.results,
          candidate_sources: sources.results,
          generated_at: new Date().toISOString(),
        });
      }

      /* ═══ EXPORT ═══ */
      if (p.match(/^\/export\/(\d+)$/) && m === 'GET') {
        const coId = p.split('/')[2];
        const format = url.searchParams.get('format') || 'json';
        const jobs = await db.prepare('SELECT * FROM jobs WHERE company_id=?').bind(coId).all();
        const candidates = await db.prepare('SELECT * FROM candidates WHERE company_id=?').bind(coId).all();
        const apps = await db.prepare('SELECT * FROM applications WHERE company_id=?').bind(coId).all();
        if (format === 'csv') {
          let csv = 'Job Title,Candidate Name,Email,Stage,Applied At,AI Score\n';
          for (const a of apps.results as any[]) {
            const j = (jobs.results as any[]).find(j => j.id === a.job_id);
            const c = (candidates.results as any[]).find(c => c.id === a.candidate_id);
            csv += `"${j?.title || ''}","${c?.first_name || ''} ${c?.last_name || ''}","${c?.email || ''}","${a.stage}","${a.applied_at}",${a.ai_score || ''}\n`;
          }
          return new Response(csv, { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="recruiting-${coId}.csv"`, 'Access-Control-Allow-Origin': '*' } });
        }
        return json({ jobs: jobs.results, candidates: candidates.results, applications: apps.results, exported_at: new Date().toISOString() });
      }

      /* ═══ STRIPE PAYMENTS ═══ */
      // Feature/boost a job listing — creates Stripe Checkout
      if (p.match(/^\/jobs\/(\d+)\/feature$/) && m === 'POST') {
        if (!env.STRIPE_SECRET_KEY) return json({ error: 'payments not configured' }, 503);
        const jobId = p.split('/')[2];
        const job = await db.prepare('SELECT id, title, company_id FROM jobs WHERE id=?').bind(jobId).first() as any;
        if (!job) return json({ error: 'job not found' }, 404);
        const company = await db.prepare('SELECT id, name, plan FROM companies WHERE id=?').bind(job.company_id).first() as any;
        if (!company) return json({ error: 'company not found' }, 404);

        const b = await req.json().catch(() => ({})) as any;
        const successUrl = sanitize(b.success_url || 'https://echo-prime.tech/recruiting/success', 500);
        const cancelUrl = sanitize(b.cancel_url || 'https://echo-prime.tech/recruiting/cancel', 500);

        const session = await stripeRequest(env, '/checkout/sessions', {
          'mode': 'payment',
          'line_items[0][price_data][currency]': 'usd',
          'line_items[0][price_data][unit_amount]': String(FEATURED_BOOST_CENTS),
          'line_items[0][price_data][product_data][name]': `Featured Boost: ${job.title}`,
          'line_items[0][price_data][product_data][description]': '30-day featured placement for your job listing',
          'line_items[0][quantity]': '1',
          'metadata[type]': 'featured_boost',
          'metadata[job_id]': String(jobId),
          'metadata[company_id]': String(job.company_id),
          'success_url': successUrl,
          'cancel_url': cancelUrl,
        });

        if (session.error) {
          slog('error', 'Stripe checkout failed', { error: session.error.message });
          return json({ error: 'Payment session creation failed', detail: session.error.message }, 502);
        }
        slog('info', 'Featured boost checkout created', { job_id: jobId, session_id: session.id });
        return json({ checkout_url: session.url, session_id: session.id, amount: '$19.99' });
      }

      // Plan upgrade — creates Stripe Checkout for subscription
      if (p === '/plans/upgrade' && m === 'POST') {
        if (!env.STRIPE_SECRET_KEY) return json({ error: 'payments not configured' }, 503);
        const b = await req.json() as any;
        const companyId = b.company_id;
        const plan = b.plan as PlanTier;
        if (!companyId || !plan || !PLANS[plan] || plan === 'free') {
          return json({ error: 'company_id and plan (pro|enterprise) required' }, 400);
        }
        const company = await db.prepare('SELECT id, name, plan as current_plan, stripe_customer_id FROM companies WHERE id=?').bind(companyId).first() as any;
        if (!company) return json({ error: 'company not found' }, 404);
        if (company.current_plan === plan) return json({ error: 'already on this plan' }, 400);

        const planInfo = PLANS[plan];
        const successUrl = sanitize(b.success_url || 'https://echo-prime.tech/recruiting/success', 500);
        const cancelUrl = sanitize(b.cancel_url || 'https://echo-prime.tech/recruiting/cancel', 500);

        const params: Record<string, string> = {
          'mode': 'subscription',
          'line_items[0][price_data][currency]': 'usd',
          'line_items[0][price_data][unit_amount]': String(planInfo.price_cents),
          'line_items[0][price_data][recurring][interval]': 'month',
          'line_items[0][price_data][product_data][name]': `Echo Recruiting ${planInfo.name} Plan`,
          'line_items[0][price_data][product_data][description]': `${planInfo.max_jobs === -1 ? 'Unlimited' : planInfo.max_jobs} active job posts${planInfo.featured ? ' + featured placement' : ''}${planInfo.analytics ? ' + analytics' : ''}`,
          'line_items[0][quantity]': '1',
          'metadata[type]': 'plan_upgrade',
          'metadata[company_id]': String(companyId),
          'metadata[plan]': plan,
          'success_url': successUrl,
          'cancel_url': cancelUrl,
        };
        if (company.stripe_customer_id) {
          params['customer'] = company.stripe_customer_id;
        }

        const session = await stripeRequest(env, '/checkout/sessions', params);
        if (session.error) {
          slog('error', 'Stripe plan upgrade failed', { error: session.error.message });
          return json({ error: 'Payment session creation failed', detail: session.error.message }, 502);
        }
        slog('info', 'Plan upgrade checkout created', { company_id: companyId, plan, session_id: session.id });
        return json({ checkout_url: session.url, session_id: session.id, plan: planInfo.name, price: `$${planInfo.price_cents / 100}/mo` });
      }

      // List plans
      if (p === '/plans' && m === 'GET') {
        return json({
          plans: Object.entries(PLANS).map(([tier, info]) => ({
            tier, ...info, price: info.price_cents === 0 ? 'Free' : `$${info.price_cents / 100}/mo`,
          })),
          featured_boost: { price_cents: FEATURED_BOOST_CENTS, price: `$${FEATURED_BOOST_CENTS / 100}`, description: '30-day featured placement per listing' },
        });
      }

      // Company billing info
      if (p.match(/^\/billing\/(\d+)$/) && m === 'GET') {
        const coId = p.split('/')[2];
        const co = await db.prepare('SELECT id, name, plan, stripe_customer_id, stripe_subscription_id, max_active_jobs FROM companies WHERE id=?').bind(coId).first() as any;
        if (!co) return json({ error: 'company not found' }, 404);
        const activeJobs = await db.prepare("SELECT COUNT(*) as cnt FROM jobs WHERE company_id=? AND status='open'").bind(coId).first() as any;
        const featuredJobs = await db.prepare("SELECT COUNT(*) as cnt FROM jobs WHERE company_id=? AND is_featured=1 AND featured_until > datetime('now')").bind(coId).first() as any;
        const events = await db.prepare("SELECT * FROM stripe_events WHERE company_id=? ORDER BY created_at DESC LIMIT 20").bind(coId).all();
        const planInfo = PLANS[(co.plan || 'free') as PlanTier] || PLANS.free;
        return json({
          plan: co.plan || 'free',
          plan_details: planInfo,
          stripe_customer_id: co.stripe_customer_id,
          active_jobs: activeJobs?.cnt || 0,
          max_active_jobs: co.max_active_jobs || 3,
          featured_jobs: featuredJobs?.cnt || 0,
          recent_events: events.results,
        });
      }

      // Admin: Stripe schema migration
      if (p === '/admin/migrate-stripe' && m === 'POST') {
        const stmts = [
          `ALTER TABLE companies ADD COLUMN plan TEXT DEFAULT 'free'`,
          `ALTER TABLE companies ADD COLUMN stripe_customer_id TEXT DEFAULT ''`,
          `ALTER TABLE companies ADD COLUMN stripe_subscription_id TEXT DEFAULT ''`,
          `ALTER TABLE companies ADD COLUMN max_active_jobs INTEGER DEFAULT 3`,
          `ALTER TABLE jobs ADD COLUMN is_featured INTEGER DEFAULT 0`,
          `ALTER TABLE jobs ADD COLUMN featured_until TEXT`,
          `CREATE TABLE IF NOT EXISTS stripe_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            stripe_event_id TEXT UNIQUE NOT NULL,
            event_type TEXT NOT NULL,
            company_id TEXT,
            amount_cents INTEGER DEFAULT 0,
            currency TEXT DEFAULT 'usd',
            metadata TEXT DEFAULT '{}',
            created_at TEXT DEFAULT (datetime('now'))
          )`,
          `CREATE INDEX IF NOT EXISTS idx_stripe_events_company ON stripe_events(company_id)`,
          `CREATE INDEX IF NOT EXISTS idx_stripe_events_type ON stripe_events(event_type)`,
          `CREATE INDEX IF NOT EXISTS idx_jobs_featured ON jobs(is_featured, featured_until)`,
        ];
        const results: { sql: string; ok: boolean; error?: string }[] = [];
        for (const sql of stmts) {
          try {
            await db.prepare(sql).run();
            results.push({ sql: sql.slice(0, 60) + '...', ok: true });
          } catch (e: any) {
            results.push({ sql: sql.slice(0, 60) + '...', ok: false, error: e.message });
          }
        }
        slog('info', 'Stripe migration executed', { results: results.length, ok: results.filter(r => r.ok).length });
        return json({ migrated: true, results });
      }

      /* ═══ STATS ═══ */
      if (p === '/stats' && m === 'GET') {
        const [cos, jobs, cands, apps, ints, offers] = await Promise.all([
          db.prepare('SELECT COUNT(*) as cnt FROM companies').first() as any,
          db.prepare('SELECT COUNT(*) as cnt FROM jobs').first() as any,
          db.prepare('SELECT COUNT(*) as cnt FROM candidates').first() as any,
          db.prepare('SELECT COUNT(*) as cnt FROM applications').first() as any,
          db.prepare('SELECT COUNT(*) as cnt FROM interviews').first() as any,
          db.prepare('SELECT COUNT(*) as cnt FROM offers').first() as any,
        ]);
        return json({ companies: cos?.cnt || 0, jobs: jobs?.cnt || 0, candidates: cands?.cnt || 0, applications: apps?.cnt || 0, interviews: ints?.cnt || 0, offers: offers?.cnt || 0 });
      }

      /* ═══ ACTIVITY ═══ */
      if (p === '/activity' && m === 'GET') {
        const coId = url.searchParams.get('company_id');
        const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
        const q = coId ? 'SELECT * FROM activity_log WHERE company_id=? ORDER BY created_at DESC LIMIT ?' : 'SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?';
        const r = coId ? await db.prepare(q).bind(coId, limit).all() : await db.prepare(q).bind(limit).all();
        return json({ activity: r.results });
      }

      } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      const stack = err instanceof Error ? err.stack : undefined;
      slog('error', 'Unhandled request error', { method: m, path: p, error: msg, stack });
      return json({ error: 'Internal server error', message: msg, path: p }, 500);
    }

    return json({ error: 'Not found', path: p }, 404);
    } catch (e: any) {
      if (e.message?.includes('JSON')) {
        return json({ error: 'Invalid JSON body' }, 400);
      }
      console.error(`[echo-recruiting] Unhandled error: ${e.message}`);
      return json({ error: 'Internal server error' }, 500);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const db = env.DB;
    const companies = await db.prepare("SELECT id FROM companies WHERE status='active'").all();
    const today = new Date().toISOString().split('T')[0];
    for (const co of companies.results as any[]) {
      const [openJobs, totalApps, newApps, ints, offers, hires] = await Promise.all([
        db.prepare("SELECT COUNT(*) as cnt FROM jobs WHERE company_id=? AND status='open'").bind(co.id).first() as any,
        db.prepare("SELECT COUNT(*) as cnt FROM applications WHERE company_id=? AND status='active'").bind(co.id).first() as any,
        db.prepare("SELECT COUNT(*) as cnt FROM applications WHERE company_id=? AND applied_at >= date('now','-7 days')").bind(co.id).first() as any,
        db.prepare("SELECT COUNT(*) as cnt FROM interviews WHERE company_id=? AND scheduled_at >= date('now','-7 days')").bind(co.id).first() as any,
        db.prepare("SELECT COUNT(*) as cnt FROM offers WHERE company_id=? AND sent_at >= date('now','-7 days')").bind(co.id).first() as any,
        db.prepare("SELECT COUNT(*) as cnt FROM applications WHERE company_id=? AND stage='hired' AND stage_changed_at >= date('now','-7 days')").bind(co.id).first() as any,
      ]);
      await db.prepare('INSERT OR REPLACE INTO analytics_daily (company_id,date,open_jobs,total_applications,new_applications,interviews_scheduled,offers_sent,hires) VALUES (?,?,?,?,?,?,?,?)').bind(co.id, today, openJobs?.cnt || 0, totalApps?.cnt || 0, newApps?.cnt || 0, ints?.cnt || 0, offers?.cnt || 0, hires?.cnt || 0).run();
    }
  },
};
