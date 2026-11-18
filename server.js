import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { db, hashPassword, verifyPassword } from './db.js';
import { aiMode, runGatekeeper, runVoiceReview, transcribe } from './ai.js';

const PORT = Number(process.env.PORT) || 3000;
const MIN_VOICE = Number(process.env.MIN_VOICE_SECONDS ?? 60);
const MAX_VIDEO_MB = Number(process.env.MAX_VIDEO_MB) || 500;

const UPLOADS = path.resolve('uploads');
const VIDEOS_DIR = path.join(UPLOADS, 'videos');
const AUDIO_DIR = path.join(UPLOADS, 'audio');
fs.mkdirSync(VIDEOS_DIR, { recursive: true });
fs.mkdirSync(AUDIO_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/uploads/videos', express.static(VIDEOS_DIR)); // supports Range requests (seeking)
app.use(express.static(path.resolve('public')));

// ---------- helpers ----------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status });

const storage = (dir) =>
  multer.diskStorage({
    destination: (_r, _f, cb) => cb(null, dir),
    filename: (_r, f, cb) =>
      cb(null, crypto.randomUUID() + (path.extname(f.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '')),
  });
const uploadVideo = multer({
  storage: storage(VIDEOS_DIR),
  limits: { fileSize: MAX_VIDEO_MB * 1024 * 1024 },
  fileFilter: (_r, f, cb) => cb(null, f.mimetype.startsWith('video/')),
});
const uploadAudio = multer({
  storage: storage(AUDIO_DIR),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_r, f, cb) => cb(null, f.mimetype.startsWith('audio/') || f.mimetype.startsWith('video/webm')),
});

function auth(required = true) {
  return (req, _res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    const user = token
      ? db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(token)
      : null;
    if (!user && required) return next(fail(401, 'سجّل الدخول أولاً'));
    req.user = user || null;
    next();
  };
}
const instructorOnly = (req, _res, next) =>
  req.user?.role === 'instructor' ? next() : next(fail(403, 'هذه الصفحة للمدربين فقط'));

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, xp: u.xp, streak: u.streak });
const videoSrc = (lab) => (lab.video_path ? `/uploads/videos/${lab.video_path}` : lab.video_url || null);

function newSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?,?)').run(token, userId);
  return token;
}

function touchStreak(user) {
  const today = new Date().toISOString().slice(0, 10);
  if (user.last_active === today) return user.streak;
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const streak = user.last_active === yesterday ? user.streak + 1 : 1;
  db.prepare('UPDATE users SET streak = ?, last_active = ? WHERE id = ?').run(streak, today, user.id);
  return streak;
}

function statusOf(userId, labId) {
  return db.prepare('SELECT status FROM progress WHERE user_id = ? AND lab_id = ?').get(userId, labId)?.status || 'in_progress';
}

// A lab is locked until the previous lab in the course is completed ("The Lab Concept").
function isUnlocked(user, lab, course) {
  if (user.role === 'instructor' && course.instructor_id === user.id) return true;
  if (lab.position === 1) return true;
  const prev = db.prepare('SELECT id FROM labs WHERE course_id = ? AND position < ? ORDER BY position DESC LIMIT 1').get(lab.course_id, lab.position);
  return !prev || statusOf(user.id, prev.id) === 'completed';
}

// ---------- config & auth ----------
app.get('/api/config', (_req, res) => {
  res.json({ minVoiceSeconds: MIN_VOICE, aiMode: aiMode(), transcription: !!process.env.OPENAI_API_KEY });
});

app.post('/api/auth/register', wrap((req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name?.trim() || !/^\S+@\S+\.\S+$/.test(email || '') || (password || '').length < 6)
    throw fail(400, 'تأكد من الاسم والبريد وكلمة مرور 6 أحرف على الأقل');
  const r = role === 'instructor' ? 'instructor' : 'student'; // MVP: open. Restrict in production.
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email.toLowerCase())) throw fail(409, 'البريد مسجّل بالفعل');
  const info = db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)')
    .run(name.trim(), email.toLowerCase(), hashPassword(password), r);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.json({ token: newSession(user.id), user: publicUser(user) });
}));

app.post('/api/auth/login', wrap((req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
  if (!user || !verifyPassword(password || '', user.password_hash)) throw fail(401, 'بيانات الدخول غير صحيحة');
  res.json({ token: newSession(user.id), user: publicUser(user) });
}));

app.get('/api/me', auth(), (req, res) => res.json({ user: publicUser(req.user) }));

// ---------- courses ----------
app.get('/api/courses', auth(false), (_req, res) => {
  const rows = db.prepare(`
    SELECT c.*, u.name AS instructor_name, (SELECT COUNT(*) FROM labs l WHERE l.course_id = c.id) AS lab_count
    FROM courses c JOIN users u ON u.id = c.instructor_id ORDER BY c.id DESC`).all();
  res.json({ courses: rows });
});

app.get('/api/courses/:id', auth(), wrap((req, res) => {
  const course = db.prepare('SELECT c.*, u.name AS instructor_name FROM courses c JOIN users u ON u.id = c.instructor_id WHERE c.id = ?').get(req.params.id);
  if (!course) throw fail(404, 'الكورس غير موجود');
  const labs = db.prepare('SELECT * FROM labs WHERE course_id = ? ORDER BY position').all(course.id).map((l) => ({
    id: l.id,
    position: l.position,
    title: l.title,
    concept: l.concept,
    status: statusOf(req.user.id, l.id),
    locked: !isUnlocked(req.user, l, course),
  }));
  res.json({ course, labs, isOwner: course.instructor_id === req.user.id });
}));

app.get('/api/studio/courses', auth(), instructorOnly, (req, res) => {
  const courses = db.prepare('SELECT * FROM courses WHERE instructor_id = ? ORDER BY id DESC').all(req.user.id).map((c) => ({
    ...c,
    labs: db.prepare('SELECT id, position, title, video_path, video_url FROM labs WHERE course_id = ? ORDER BY position').all(c.id),
  }));
  res.json({ courses });
});

app.post('/api/courses', auth(), instructorOnly, wrap((req, res) => {
  const { title, description } = req.body || {};
  if (!title?.trim()) throw fail(400, 'اسم الكورس مطلوب');
  const info = db.prepare('INSERT INTO courses (title, description, instructor_id) VALUES (?,?,?)').run(title.trim(), description?.trim() || null, req.user.id);
  res.json({ id: info.lastInsertRowid });
}));

app.post('/api/courses/:id/labs', auth(), instructorOnly, uploadVideo.single('video'), wrap((req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id = ? AND instructor_id = ?').get(req.params.id, req.user.id);
  if (!course) throw fail(404, 'الكورس غير موجود أو ليس لك');
  const { title, concept, challenge, video_url } = req.body || {};
  if (!title?.trim() || !challenge?.trim()) {
    if (req.file) fs.unlink(req.file.path, () => {});
    throw fail(400, 'اسم اللاب وتحدي اللاب مطلوبان');
  }
  const position = (db.prepare('SELECT MAX(position) AS m FROM labs WHERE course_id = ?').get(course.id).m || 0) + 1;
  const info = db.prepare('INSERT INTO labs (course_id, position, title, concept, video_path, video_url, challenge) VALUES (?,?,?,?,?,?,?)')
    .run(course.id, position, title.trim(), concept?.trim() || null, req.file?.filename || null, video_url?.trim() || null, challenge.trim());
  res.json({ id: info.lastInsertRowid, position });
}));

app.delete('/api/labs/:id', auth(), instructorOnly, wrap((req, res) => {
  const lab = db.prepare('SELECT l.* FROM labs l JOIN courses c ON c.id = l.course_id WHERE l.id = ? AND c.instructor_id = ?').get(req.params.id, req.user.id);
  if (!lab) throw fail(404, 'غير موجود');
  db.prepare('DELETE FROM labs WHERE id = ?').run(lab.id);
  if (lab.video_path) fs.unlink(path.join(VIDEOS_DIR, lab.video_path), () => {});
  res.json({ ok: true });
}));

// ---------- the Lab journey ----------
function loadLabFor(req) {
  const lab = db.prepare('SELECT * FROM labs WHERE id = ?').get(req.params.id);
  if (!lab) throw fail(404, 'اللاب غير موجود');
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(lab.course_id);
  if (!isUnlocked(req.user, lab, course)) throw fail(403, 'اللاب مقفل: أثبت جدارتك في اللاب السابق أولاً');
  return { lab, course };
}

function currentChallenge(userId, lab) {
  const last = db.prepare('SELECT new_challenge FROM attempts WHERE user_id = ? AND lab_id = ? ORDER BY id DESC LIMIT 1').get(userId, lab.id);
  return last?.new_challenge || lab.challenge;
}

app.get('/api/labs/:id', auth(), wrap((req, res) => {
  const { lab, course } = loadLabFor(req);
  const status = statusOf(req.user.id, lab.id);
  const attempts = db.prepare('SELECT attempt_no, verdict, score, feedback, created_at FROM attempts WHERE user_id = ? AND lab_id = ? ORDER BY id').all(req.user.id, lab.id);
  const next = db.prepare('SELECT id FROM labs WHERE course_id = ? AND position > ? ORDER BY position LIMIT 1').get(lab.course_id, lab.position);
  const seal = db.prepare('SELECT clarity_score, feedback FROM voice_seals WHERE user_id = ? AND lab_id = ? AND understood = 1 ORDER BY id DESC LIMIT 1').get(req.user.id, lab.id);
  res.json({
    lab: { id: lab.id, title: lab.title, concept: lab.concept, position: lab.position, video: videoSrc(lab), challenge: currentChallenge(req.user.id, lab) },
    course: { id: course.id, title: course.title },
    status,
    attempts,
    seal,
    nextLabId: next?.id || null,
    minVoiceSeconds: MIN_VOICE,
  });
}));

// Stage 3: AI Gatekeeper
app.post('/api/labs/:id/submit', auth(), wrap(async (req, res) => {
  const { lab } = loadLabFor(req);
  const solution = String(req.body?.solution || '').trim();
  if (solution.length < 20) throw fail(400, 'اكتب حلاً أوضح (20 حرفاً على الأقل)');
  if (solution.length > 6000) throw fail(400, 'الحل طويل جداً (الحد 6000 حرف)');
  if (statusOf(req.user.id, lab.id) !== 'in_progress') throw fail(400, 'تم قبول حلك بالفعل');

  const recent = db.prepare("SELECT COUNT(*) AS c FROM attempts WHERE user_id = ? AND created_at > datetime('now','-1 hour')").get(req.user.id).c;
  if (recent >= 20) throw fail(429, 'محاولات كثيرة خلال ساعة. خذ استراحة وحاول لاحقاً.');

  const history = db.prepare('SELECT attempt_no, solution, feedback FROM attempts WHERE user_id = ? AND lab_id = ? ORDER BY id DESC LIMIT 3').all(req.user.id, lab.id).reverse();
  const attemptNo = (db.prepare('SELECT COUNT(*) AS c FROM attempts WHERE user_id = ? AND lab_id = ?').get(req.user.id, lab.id).c) + 1;
  const challenge = currentChallenge(req.user.id, lab);

  let result;
  try {
    result = await runGatekeeper({ student: req.user, lab, challenge, solution, history, attemptNo });
  } catch (e) {
    console.error(e);
    throw fail(502, 'تعذّر الاتصال بالـ AI حالياً، حاول مرة أخرى.');
  }

  db.prepare('INSERT INTO attempts (user_id, lab_id, attempt_no, challenge_used, solution, verdict, score, feedback, new_challenge) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(req.user.id, lab.id, attemptNo, challenge, solution, result.verdict, result.score, result.feedback, result.new_challenge);

  if (result.verdict === 'pass') {
    db.prepare("INSERT INTO progress (user_id, lab_id, status) VALUES (?,?,'solution_passed') ON CONFLICT(user_id, lab_id) DO UPDATE SET status = 'solution_passed'").run(req.user.id, lab.id);
  }
  res.json({ ...result, attempt_no: attemptNo });
}));

// Stage 4: Vocal Seal
app.post('/api/labs/:id/voice', auth(), uploadAudio.single('audio'), wrap(async (req, res) => {
  const cleanup = () => req.file && fs.unlink(req.file.path, () => {});
  try {
    const { lab } = loadLabFor(req);
    const status = statusOf(req.user.id, lab.id);
    if (status === 'in_progress') throw fail(400, 'أكمل حل اللاب أولاً');
    if (status === 'completed') throw fail(400, 'اللاب مكتمل بالفعل');
    if (!req.file) throw fail(400, 'لم يصل ملف صوتي');
    const duration = Math.round(Number(req.body?.duration) || 0);
    if (duration < MIN_VOICE) throw fail(400, `الشرح الصوتي لا يقل عن ${MIN_VOICE} ثانية`);

    const passed = db.prepare("SELECT solution, challenge_used FROM attempts WHERE user_id = ? AND lab_id = ? AND verdict = 'pass' ORDER BY id DESC LIMIT 1").get(req.user.id, lab.id);

    let transcript = null;
    try {
      transcript = await transcribe(req.file.path, req.file.mimetype);
    } catch (e) {
      console.error(e);
      throw fail(502, 'تعذّر تحويل الصوت لنص حالياً، حاول مرة أخرى.');
    }

    let review;
    try {
      review = await runVoiceReview({ lab, challenge: passed.challenge_used, solution: passed.solution, transcript, duration });
    } catch (e) {
      console.error(e);
      throw fail(502, 'تعذّر الاتصال بالـ AI حالياً، حاول مرة أخرى.');
    }

    db.prepare('INSERT INTO voice_seals (user_id, lab_id, audio_path, duration, transcript, understood, clarity_score, feedback) VALUES (?,?,?,?,?,?,?,?)')
      .run(req.user.id, lab.id, req.file.filename, duration, transcript, review.understood ? 1 : 0, review.clarity_score, review.feedback);

    if (!review.understood) return res.json({ ...review, completed: false });

    const firstTry = db.prepare('SELECT COUNT(*) AS c FROM attempts WHERE user_id = ? AND lab_id = ?').get(req.user.id, lab.id).c === 1;
    const xp = 100 + (review.clarity_score >= 80 ? 50 : 0) + (firstTry ? 25 : 0);
    db.prepare("UPDATE progress SET status = 'completed', xp_earned = ?, completed_at = datetime('now') WHERE user_id = ? AND lab_id = ?").run(xp, req.user.id, lab.id);
    db.prepare('UPDATE users SET xp = xp + ? WHERE id = ?').run(xp, req.user.id);
    const streak = touchStreak(req.user);
    res.json({ ...review, completed: true, xp_earned: xp, streak });
  } catch (e) {
    cleanup();
    throw e;
  }
}));

// ---------- Skill DNA ----------
app.get('/api/me/skill-dna', auth(), (req, res) => {
  const u = req.user;
  const labs = db.prepare(`
    SELECT l.id, l.title, c.title AS course_title, p.status, p.xp_earned, p.completed_at,
      (SELECT COUNT(*) FROM attempts a WHERE a.user_id = p.user_id AND a.lab_id = l.id) AS attempts,
      (SELECT MAX(score) FROM attempts a WHERE a.user_id = p.user_id AND a.lab_id = l.id) AS best_score,
      (SELECT clarity_score FROM voice_seals v WHERE v.user_id = p.user_id AND v.lab_id = l.id AND v.understood = 1 ORDER BY v.id DESC LIMIT 1) AS clarity
    FROM progress p JOIN labs l ON l.id = p.lab_id JOIN courses c ON c.id = l.course_id
    WHERE p.user_id = ? ORDER BY COALESCE(p.completed_at, '9999') DESC, l.id`).all(u.id);
  const done = labs.filter((l) => l.status === 'completed');
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);
  res.json({
    user: publicUser(u),
    completed: done.length,
    avgAttempts: avg(done.map((l) => l.attempts * 10)) == null ? null : avg(done.map((l) => l.attempts * 10)) / 10,
    avgClarity: avg(done.map((l) => l.clarity).filter((x) => x != null)),
    labs,
  });
});

// ---------- errors ----------
app.use('/api', (_req, _res, next) => next(fail(404, 'المسار غير موجود')));
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'حجم الملف أكبر من المسموح' : 'فشل رفع الملف';
    return res.status(400).json({ error: msg });
  }
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'خطأ في السيرفر' });
});

app.listen(PORT, () => {
  console.log(`Laby MVP running on http://localhost:${PORT}  (AI mode: ${aiMode()})`);
});
