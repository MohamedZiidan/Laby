import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dataDir = path.resolve('data');
fs.mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, 'laby.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student','instructor')),
  xp INTEGER NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL DEFAULT 0,
  last_active TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  instructor_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Instructor Framework: (Lab name) -> (Video) -> (Lab challenge)
CREATE TABLE IF NOT EXISTS labs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  concept TEXT,
  video_path TEXT,
  video_url TEXT,
  challenge TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  lab_id INTEGER NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL,
  challenge_used TEXT,
  solution TEXT NOT NULL,
  verdict TEXT NOT NULL,
  score INTEGER,
  feedback TEXT,
  new_challenge TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- status: in_progress | solution_passed | completed
CREATE TABLE IF NOT EXISTS progress (
  user_id INTEGER NOT NULL REFERENCES users(id),
  lab_id INTEGER NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'in_progress',
  xp_earned INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  PRIMARY KEY (user_id, lab_id)
);

CREATE TABLE IF NOT EXISTS voice_seals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  lab_id INTEGER NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
  audio_path TEXT,
  duration INTEGER,
  transcript TEXT,
  understood INTEGER,
  clarity_score INTEGER,
  feedback TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  const real = Buffer.from(hash, 'hex');
  return real.length === test.length && crypto.timingSafeEqual(real, test);
}

// ---- Demo seed (first run only) ----
const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
if (userCount === 0) {
  const inst = db
    .prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)')
    .run('مدرب تجريبي', 'demo@laby.app', hashPassword('demo1234'), 'instructor');
  const course = db
    .prepare('INSERT INTO courses (title, description, instructor_id) VALUES (?,?,?)')
    .run(
      'أساسيات التسويق الرقمي',
      'مسار عملي: من الميزانية الصغيرة إلى حملة إعلانية حقيقية، عبر معامل مغلقة.',
      inst.lastInsertRowid
    );
  const addLab = db.prepare(
    'INSERT INTO labs (course_id, position, title, concept, challenge) VALUES (?,?,?,?,?)'
  );
  addLab.run(
    course.lastInsertRowid,
    1,
    'توزيع الميزانية الإعلانية',
    'كيف توزّع ميزانية صغيرة على قنوات إعلانية مختلفة',
    'أمامك ميزانية 100$ لإطلاق منتج X (زجاجة مياه ذكية للرياضيين). وزّعها على حملة إعلانية عبر القنوات التي تراها مناسبة، واذكر نسبة كل قناة ولماذا اخترتها، وما المؤشر الذي ستقيس به النجاح.'
  );
  addLab.run(
    course.lastInsertRowid,
    2,
    'قياس الأداء وتحسين الحملة',
    'قراءة أرقام الحملة واتخاذ قرار التحسين',
    'بعد 3 أيام من الحملة: الإنفاق 60$، النقرات 400، المبيعات 2 فقط. حلّل المشكلة، وحدّد أين الخلل المحتمل، وما الإجراء الذي ستتخذه بالـ 40$ المتبقية.'
  );
  console.log('Seeded demo instructor: demo@laby.app / demo1234');
}
