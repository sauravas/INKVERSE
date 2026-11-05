import sqlite3, threading, time, uuid
from .config import DB_PATH

_local = threading.local()

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS subjects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  exam_date TEXT,
  -- readiness thresholds, per subject, deterministic
  req_syllabus REAL NOT NULL DEFAULT 0.85,
  req_important REAL NOT NULL DEFAULT 1.0,
  req_recall REAL NOT NULL DEFAULT 0.75,
  created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS modules (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  position INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  module_id TEXT REFERENCES modules(id) ON DELETE CASCADE,
  subject_id TEXT REFERENCES subjects(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  answer_md TEXT,
  answer_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending|studied|revised|mastered
  important INTEGER NOT NULL DEFAULT 0,
  revisions INTEGER NOT NULL DEFAULT 0,
  recall_correct INTEGER NOT NULL DEFAULT 0,
  recall_total INTEGER NOT NULL DEFAULT 0,
  last_reviewed REAL,
  page_id TEXT,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  title TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  strokes TEXT NOT NULL DEFAULT '[]',
  updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS explanations (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  step_index INTEGER,
  step_text TEXT,
  ask TEXT NOT NULL,
  answer_json TEXT,
  created_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_q_module ON questions(module_id);
CREATE INDEX IF NOT EXISTS idx_q_subject ON questions(subject_id);
CREATE INDEX IF NOT EXISTS idx_m_subject ON modules(subject_id);

-- Phase 2 --------------------------------------------------------------------

-- an imported document: a question bank, syllabus or set of notes
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  subject_id TEXT REFERENCES subjects(id) ON DELETE CASCADE,
  filename TEXT,
  kind TEXT NOT NULL DEFAULT 'questions',   -- questions|syllabus|notes
  method TEXT,                               -- text|ocr|mixed
  pages INTEGER,
  text TEXT,
  created_at REAL NOT NULL
);

-- one student attempt at a question: the notes that get kept and shared
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  strokes TEXT NOT NULL DEFAULT '[]',
  image TEXT,                                -- PNG data URL of the attempt
  hint_json TEXT,
  outcome TEXT,                              -- knew|hint|answer
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempt_q ON attempts(question_id);

-- read-only share links for a module's (or subject's) notes
CREATE TABLE IF NOT EXISTS shares (
  token TEXT PRIMARY KEY,
  subject_id TEXT REFERENCES subjects(id) ON DELETE CASCADE,
  module_id TEXT REFERENCES modules(id) ON DELETE CASCADE,
  title TEXT,
  created_at REAL NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);

-- retrieval index over imported material (BM25, no embedding model needed,
-- so grounding never competes with the vision/text models for GPU memory)
-- prepared study notes: one set per module, written as structured steps
CREATE TABLE IF NOT EXISTS study_notes (
  id TEXT PRIMARY KEY,
  subject_id TEXT REFERENCES subjects(id) ON DELETE CASCADE,
  module_id TEXT UNIQUE REFERENCES modules(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  steps_json TEXT NOT NULL DEFAULT '[]',
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);

-- what the student did to their notes: highlights, pen ink, and questions
-- asked about a passage (with the explanation, so the thread survives)
CREATE TABLE IF NOT EXISTS note_marks (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES study_notes(id) ON DELETE CASCADE,
  section_index INTEGER NOT NULL,
  kind TEXT NOT NULL,                      -- highlight|ink|question
  quote TEXT,
  ask TEXT,
  data TEXT,                               -- ink strokes, or answer steps
  created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_marks_note ON note_marks(note_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
  text, heading, source_id UNINDEXED, subject_id UNINDEXED,
  module_id UNINDEXED, tokenize = 'porter unicode61'
);
"""

# columns added after the first release; applied idempotently on startup
MIGRATIONS = [
    ("questions", "source_id", "TEXT"),
    ("questions", "position", "INTEGER NOT NULL DEFAULT 0"),
    ("questions", "marks", "TEXT"),
    # set when a subject arrived as a shared bundle, e.g. "Shared by Asha"
    ("subjects", "origin", "TEXT"),
]


def conn() -> sqlite3.Connection:
    c = getattr(_local, "c", None)
    if c is None:
        c = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys=ON")
        _local.c = c
    return c


def init():
    c = conn()
    c.executescript(SCHEMA)
    for table, col, decl in MIGRATIONS:
        have = {r["name"] for r in c.execute(f"PRAGMA table_info({table})")}
        if col not in have:
            c.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
    c.commit()


def nid() -> str:
    return uuid.uuid4().hex[:12]


def now() -> float:
    return time.time()


def rows(sql, args=()):
    return [dict(r) for r in conn().execute(sql, args).fetchall()]


def one(sql, args=()):
    r = conn().execute(sql, args).fetchone()
    return dict(r) if r else None


def run(sql, args=()):
    c = conn()
    cur = c.execute(sql, args)
    c.commit()
    return cur
