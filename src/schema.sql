-- Echo Recruiting v1.0.0 — AI-Powered Applicant Tracking System
-- D1 Schema

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  industry TEXT,
  website TEXT,
  logo_url TEXT,
  careers_page TEXT,
  settings JSON DEFAULT '{}',
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  head TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(company_id, name)
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  department_id INTEGER,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  requirements TEXT,
  responsibilities TEXT,
  location TEXT,
  location_type TEXT DEFAULT 'onsite',
  employment_type TEXT DEFAULT 'full_time',
  salary_min REAL,
  salary_max REAL,
  salary_currency TEXT DEFAULT 'USD',
  experience_level TEXT DEFAULT 'mid',
  skills JSON DEFAULT '[]',
  benefits JSON DEFAULT '[]',
  pipeline_stages JSON DEFAULT '["applied","screening","phone_screen","interview","technical","offer","hired"]',
  hiring_manager TEXT,
  recruiter TEXT,
  headcount INTEGER DEFAULT 1,
  filled INTEGER DEFAULT 0,
  is_public INTEGER DEFAULT 1,
  status TEXT DEFAULT 'open',
  published_at TEXT,
  closes_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(company_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company_id, status);

CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  location TEXT,
  linkedin_url TEXT,
  portfolio_url TEXT,
  resume_url TEXT,
  resume_text TEXT,
  skills JSON DEFAULT '[]',
  experience_years REAL,
  current_company TEXT,
  current_title TEXT,
  source TEXT DEFAULT 'direct',
  tags JSON DEFAULT '[]',
  notes TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(company_id, email)
);
CREATE INDEX IF NOT EXISTS idx_candidates_company ON candidates(company_id, status);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  candidate_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  stage TEXT DEFAULT 'applied',
  cover_letter TEXT,
  answers JSON DEFAULT '[]',
  ai_score REAL,
  ai_summary TEXT,
  rejection_reason TEXT,
  referred_by TEXT,
  status TEXT DEFAULT 'active',
  applied_at TEXT DEFAULT (datetime('now')),
  stage_changed_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(job_id, candidate_id)
);
CREATE INDEX IF NOT EXISTS idx_applications_job ON applications(job_id, stage);
CREATE INDEX IF NOT EXISTS idx_applications_candidate ON applications(candidate_id);

CREATE TABLE IF NOT EXISTS interviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  interviewer TEXT NOT NULL,
  interview_type TEXT DEFAULT 'video',
  scheduled_at TEXT,
  duration_min INTEGER DEFAULT 60,
  location TEXT,
  meeting_link TEXT,
  notes TEXT,
  status TEXT DEFAULT 'scheduled',
  completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_interviews_app ON interviews(application_id);

CREATE TABLE IF NOT EXISTS scorecards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  interview_id INTEGER NOT NULL,
  application_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  reviewer TEXT NOT NULL,
  overall_rating INTEGER DEFAULT 0,
  ratings JSON DEFAULT '{}',
  strengths TEXT,
  weaknesses TEXT,
  recommendation TEXT DEFAULT 'undecided',
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  candidate_id INTEGER NOT NULL,
  job_title TEXT NOT NULL,
  salary REAL,
  salary_currency TEXT DEFAULT 'USD',
  equity TEXT,
  bonus TEXT,
  start_date TEXT,
  expiry_date TEXT,
  benefits JSON DEFAULT '[]',
  letter_url TEXT,
  status TEXT DEFAULT 'draft',
  sent_at TEXT,
  responded_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS talent_pool (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  candidate_id INTEGER NOT NULL,
  pool_name TEXT DEFAULT 'general',
  added_by TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(company_id, candidate_id, pool_name)
);

CREATE TABLE IF NOT EXISTS hiring_team (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  job_id INTEGER,
  user_email TEXT NOT NULL,
  user_name TEXT,
  role TEXT DEFAULT 'interviewer',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(company_id, job_id, user_email)
);

CREATE TABLE IF NOT EXISTS analytics_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  open_jobs INTEGER DEFAULT 0,
  total_applications INTEGER DEFAULT 0,
  new_applications INTEGER DEFAULT 0,
  interviews_scheduled INTEGER DEFAULT 0,
  offers_sent INTEGER DEFAULT 0,
  hires INTEGER DEFAULT 0,
  UNIQUE(company_id, date)
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER,
  actor TEXT,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
