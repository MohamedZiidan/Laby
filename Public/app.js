// Laby MVP front-end (vanilla JS, hash routing, RTL/Arabic)
const $ = (s, r = document) => r.querySelector(s);
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

let token = localStorage.getItem('laby_token');
let me = null;
let config = { minVoiceSeconds: 60, aiMode: 'demo' };

// ---------- helpers ----------
let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 3500);
}

async function api(path, { method = 'GET', body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if (form) payload = form;
  else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch('/api' + path, { method, headers, body: payload });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && token) { logout(false); }
    throw new Error(data.error || 'حدث خطأ غير متوقع');
  }
  return data;
}

function uploadForm(path, form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api' + path);
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      xhr.status >= 200 && xhr.status < 300 ? resolve(data) : reject(new Error(data.error || 'فشل الرفع'));
    };
    xhr.onerror = () => reject(new Error('انقطع الاتصال أثناء الرفع'));
    xhr.send(form);
  });
}

function setSession(t, user) {
  token = t; me = user;
  localStorage.setItem('laby_token', t);
}
function logout(redirect = true) {
  token = null; me = null;
  localStorage.removeItem('laby_token');
  renderNav();
  if (redirect) location.hash = '#/';
}

function renderNav() {
  $('#nav').innerHTML = `
    <a class="brand" href="#/">LABY<i></i></a>
    <a class="link" href="#/">الكورسات</a>
    ${me ? `
      ${me.role === 'instructor' ? '<a class="link" href="#/studio">استوديو المدرب</a>' : '<a class="link" href="#/dashboard">بصمة المهارة</a>'}
      <span class="chip">⚡ ${me.xp} XP</span>
      <span class="chip">🔥 ${me.streak}</span>
      <a class="link" href="#" id="logout">خروج</a>` : `
      <a class="link" href="#/login">دخول</a>
      <a class="link" href="#/register">حساب جديد</a>`}`;
  $('#logout')?.addEventListener('click', (e) => { e.preventDefault(); logout(); });
}

async function refreshMe() {
  if (!token) return;
  try { me = (await api('/me')).user; } catch { me = null; }
  renderNav();
}

function statusPill(s, locked) {
  if (locked) return '<span class="pill lock">🔒 مقفل</span>';
  if (s === 'completed') return '<span class="pill done">✓ مكتمل</span>';
  if (s === 'solution_passed') return '<span class="pill mid">بانتظار الشرح الصوتي</span>';
  return '<span class="pill open">مفتوح</span>';
}

function videoEmbed(src) {
  if (!src) return '<div class="novideo">لا يوجد فيديو لهذا اللاب بعد</div>';
  const yt = src.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/);
  if (yt) return `<iframe class="video" src="https://www.youtube.com/embed/${yt[1]}" allowfullscreen></iframe>`;
  const vm = src.match(/vimeo\.com\/(\d+)/);
  if (vm) return `<iframe class="video" src="https://player.vimeo.com/video/${vm[1]}" allowfullscreen></iframe>`;
  return `<video controls preload="metadata" src="${esc(src)}"></video>`;
}

function guard(fn, { instructor = false } = {}) {
  return async (...a) => {
    if (!token) { location.hash = '#/login'; return; }
    if (!me) await refreshMe();
    if (!me) { location.hash = '#/login'; return; }
    if (instructor && me.role !== 'instructor') { app.innerHTML = '<div class="card">هذه الصفحة للمدربين فقط.</div>'; return; }
    return fn(...a);
  };
}

// ---------- pages ----------
async function pageHome() {
  const { courses } = await api('/courses');
  app.innerHTML = `
    <section class="hero">
      <h1 class="display">LABY</h1>
      <div class="tag">Apply to Learn. Explain to Master</div>
      <p>كل كورس سلسلة من "المعامل" المغلقة: شاهد مفهوماً واحداً، طبّقه في تحدي حقيقي، ينقد الـ AI حلك، ثم اشرح فهمك بصوتك لتفتح اللاب التالي.</p>
      ${me ? '' : '<a class="btn" href="#/register">ابدأ الآن</a>'}
    </section>
    <h2>الكورسات</h2>
    <div class="grid">
      ${courses.map((c) => `
        <a class="card" href="#/course/${c.id}" style="text-decoration:none;color:inherit">
          <h3>${esc(c.title)}</h3>
          <p class="muted small">${esc(c.description || '')}</p>
          <span class="pill open">${c.lab_count} معمل</span> <span class="muted small">· ${esc(c.instructor_name)}</span>
        </a>`).join('') || '<div class="card muted">لا توجد كورسات بعد.</div>'}
    </div>`;
}

function authPage(mode) {
  const reg = mode === 'register';
  app.innerHTML = `
    <form class="card auth" id="f">
      <h2>${reg ? 'حساب جديد' : 'تسجيل الدخول'}</h2>
      ${reg ? '<label>الاسم</label><input name="name" required>' : ''}
      <label>البريد الإلكتروني</label><input name="email" type="email" required dir="ltr">
      <label>كلمة المرور</label><input name="password" type="password" minlength="6" required dir="ltr">
      ${reg ? `<label>نوع الحساب</label>
        <select name="role" id="role"><option value="student">متدرب</option><option value="instructor">مدرب</option></select>
        <div id="codeBox" hidden><label>كود المدرب (إن وُجد)</label><input name="instructor_code" dir="ltr"></div>` : ''}
      <p><button>${reg ? 'إنشاء الحساب' : 'دخول'}</button></p>
      
    </form>`;
  $('#role')?.addEventListener('change', (e) => ($('#codeBox').hidden = e.target.value !== 'instructor'));
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    try {
      const r = await api(`/auth/${mode}`, { method: 'POST', body });
      setSession(r.token, r.user);
      renderNav();
      location.hash = r.user.role === 'instructor' ? '#/studio' : '#/';
    } catch (err) { toast(err.message, true); }
  });
}

const pageCourse = guard(async (id) => {
  const { course, labs } = await api(`/courses/${id}`);
  app.innerHTML = `
    <a href="#/" class="small">← كل الكورسات</a>
    <h1>${esc(course.title)}</h1>
    <p class="muted">${esc(course.description || '')} · المدرب: ${esc(course.instructor_name)}</p>
    ${labs.map((l) => `
      <div class="card lab-item ${l.locked ? 'locked' : ''}">
        <div class="num">${String(l.position).padStart(2, '0')}</div>
        <div class="grow"><b>${esc(l.title)}</b><div class="muted small">${esc(l.concept || '')}</div></div>
        ${statusPill(l.status, l.locked)}
        ${l.locked ? '' : `<a class="btn small" href="#/lab/${l.id}">${l.status === 'completed' ? 'مراجعة' : 'ادخل اللاب'}</a>`}
      </div>`).join('') || '<div class="card muted">لا توجد معامل في هذا الكورس بعد.</div>'}`;
});

const pageLab = guard(async (id, flash) => {
  let d;
  try { d = await api(`/labs/${id}`); } catch (e) { app.innerHTML = `<div class="card">${esc(e.message)}</div>`; return; }
  const { lab, course, status, attempts, nextLabId, seal } = d;
  const stage = status === 'completed' ? 5 : status === 'solution_passed' ? 4 : 2;
  const names = ['1 · السياق', '2 · الاشتباك', '3 · الفلترة', '4 · بصمة الفهم'];
  const lastAttempt = attempts[attempts.length - 1];

  app.innerHTML = `
    <a href="#/course/${course.id}" class="small">← ${esc(course.title)}</a>
    <h1>لاب ${lab.position}: ${esc(lab.title)}</h1>
    <div class="steps">${names.map((n, i) => `<div class="${i + 1 < stage ? 'ok' : i + 1 === stage || (stage === 2 && i === 2 && attempts.length) ? 'on' : ''}">${n}</div>`).join('')}</div>
    ${flash ? `<div class="feedback ${flash.cls || ''}"><b>${esc(flash.title)}</b>\n${esc(flash.text)}</div>` : ''}

    <div class="card"><h3>1 · مرحلة التلقي (Micro-learning)</h3>${videoEmbed(lab.video)}</div>

    <div class="card">
      <h3>2 · مرحلة الاشتباك (Action Lab)</h3>
      <div class="challenge">${esc(lab.challenge)}</div>
      ${attempts.length && status === 'in_progress' ? `<div class="feedback retry"><b>ملاحظات الـ AI على محاولتك ${lastAttempt.attempt_no}</b>\n${esc(lastAttempt.feedback)}</div>` : ''}
      ${status === 'in_progress' ? `
        <label for="sol">حلك</label>
        <textarea id="sol" placeholder="اكتب حلك وخطواتك وسبب اختيارك..."></textarea>
        <p><button id="submit">أرسل الحل للـ AI</button> <span class="muted small" id="wait"></span></p>` : ''}
      ${attempts.length > 1 || status !== 'in_progress' ? `<details><summary class="small">سجل المحاولات (${attempts.length})</summary>
        ${attempts.map((a) => `<div class="attempt"><b>محاولة ${a.attempt_no}</b> — ${a.verdict === 'pass' ? '✓ مقبول' : '↻ إعادة'} (${a.score}/100)<br>${esc(a.feedback)}</div>`).join('')}</details>` : ''}
    </div>

    ${status === 'solution_passed' ? `
    <div class="card navy">
      <h3>4 · بصمة الفهم (The Vocal Seal)</h3>
      <p>حلك مقبول تقنياً. سجّل شرحاً صوتياً لا يقل عن <b>${d.minVoiceSeconds} ثانية</b>: ماذا فهمت ولماذا اخترت هذه الإجابة؟</p>
      <div class="row">
        <span class="timer" id="timer">00:00</span> <span id="recdot"></span>
        <button id="rec">🎙️ ابدأ التسجيل</button>
        <button id="stop" class="ghost" style="color:#fff;border-color:#fff" disabled>إيقاف</button>
        <label class="btn ghost" style="margin:0;color:#fff;border-color:#fff">رفع ملف صوتي<input type="file" id="file" accept="audio/*" hidden></label>
      </div>
      <audio id="preview" controls hidden style="width:100%;margin-top:.8rem"></audio>
      <p><button id="send" disabled style="background:var(--sky);color:#08294d">أرسل الشرح</button> <span id="vwait" class="small"></span></p>
      <div id="vres"></div>
    </div>` : ''}

    ${status === 'completed' ? `
    <div class="card">
      <h3>✓ اللاب مكتمل</h3>
      ${seal ? `<div class="feedback pass">وضوح الشرح: ${seal.clarity_score}/100\n${esc(seal.feedback)}</div>` : ''}
      ${nextLabId ? `<a class="btn" href="#/lab/${nextLabId}">اللاب التالي ←</a>` : `<a class="btn" href="#/course/${course.id}">انتهيت من الكورس 🎉</a>`}
    </div>` : ''}`;

  $('#submit')?.addEventListener('click', async (e) => {
    const solution = $('#sol').value;
    e.target.disabled = true; $('#wait').textContent = 'الـ AI يراجع حلك...';
    try {
      const r = await api(`/labs/${id}/submit`, { method: 'POST', body: { solution } });
      await refreshMe();
      pageLab(id, r.verdict === 'pass'
        ? { cls: 'pass', title: `✓ حل مقبول (${r.score}/100)`, text: r.feedback }
        : { cls: 'retry', title: `↻ حاول مرة أخرى (${r.score}/100) — تم تعديل معطيات التحدي`, text: r.feedback });
    } catch (err) { toast(err.message, true); e.target.disabled = false; $('#wait').textContent = ''; }
  });

  if (status === 'solution_passed') setupRecorder(id, d.minVoiceSeconds);
});

function setupRecorder(labId, minSec) {
  let mediaRec, chunks = [], t0, tick, blob = null, duration = 0;
  const timer = $('#timer'), send = $('#send'), prev = $('#preview');

  const ready = (b, dur) => {
    blob = b; duration = dur;
    prev.src = URL.createObjectURL(b); prev.hidden = false;
    send.disabled = dur < minSec;
    $('#vres').innerHTML = dur < minSec ? `<p class="small">مدة التسجيل ${fmtTime(dur)} — المطلوب ${fmtTime(minSec)} على الأقل.</p>` : '';
  };

  $('#rec').addEventListener('click', async () => {
    if (!navigator.mediaDevices?.getUserMedia) return toast('المتصفح لا يدعم التسجيل. ارفع ملفاً صوتياً بدلاً من ذلك.', true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRec = new MediaRecorder(stream);
      chunks = [];
      mediaRec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      mediaRec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        clearInterval(tick); $('#recdot').innerHTML = '';
        ready(new Blob(chunks, { type: mediaRec.mimeType || 'audio/webm' }), (Date.now() - t0) / 1000);
      };
      mediaRec.start();
      t0 = Date.now();
      tick = setInterval(() => (timer.textContent = fmtTime((Date.now() - t0) / 1000)), 250);
      $('#recdot').innerHTML = '<span class="rec-dot"></span>';
      $('#rec').disabled = true; $('#stop').disabled = false; send.disabled = true;
    } catch { toast('لم يتم السماح بالوصول للميكروفون', true); }
  });

  $('#stop').addEventListener('click', () => {
    mediaRec?.state === 'recording' && mediaRec.stop();
    $('#rec').disabled = false; $('#stop').disabled = true;
  });

  $('#file').addEventListener('change', (e) => {
    const f = e.target.files[0]; if (!f) return;
    const a = new Audio(URL.createObjectURL(f));
    a.onloadedmetadata = () => { timer.textContent = fmtTime(a.duration); ready(f, a.duration); };
    a.onerror = () => toast('تعذّر قراءة الملف الصوتي', true);
  });

  send.addEventListener('click', async () => {
    const form = new FormData();
    const ext = (blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : blob.type.includes('wav') ? 'wav' : blob.type.includes('mpeg') ? 'mp3' : 'webm');
    form.append('audio', blob, `seal.${ext}`);
    form.append('duration', String(Math.round(duration)));
    send.disabled = true; $('#vwait').textContent = 'جاري تحليل شرحك...';
    try {
      const r = await api(`/labs/${labId}/voice`, { method: 'POST', form });
      if (!r.completed) {
        $('#vwait').textContent = '';
        $('#vres').innerHTML = `<div class="feedback retry" style="color:var(--text)"><b>الشرح يحتاج تحسيناً (${r.clarity_score}/100)</b>\n${esc(r.feedback)}</div>`;
        send.disabled = false;
        return;
      }
      await refreshMe();
      pageLab(labId, { cls: 'pass', title: `🎉 +${r.xp_earned} XP — تم فتح اللاب التالي`, text: r.feedback });
    } catch (err) { toast(err.message, true); send.disabled = false; $('#vwait').textContent = ''; }
  });
}

const pageDashboard = guard(async () => {
  const d = await api('/me/skill-dna');
  app.innerHTML = `
    <h1>بصمة المهارة (Skill DNA)</h1>
    <div class="grid">
      <div class="card stat"><b>${d.user.xp}</b><span>نقاط XP</span></div>
      <div class="card stat"><b>${d.user.streak}</b><span>أيام متتالية</span></div>
      <div class="card stat"><b>${d.completed}</b><span>معامل مكتملة</span></div>
      <div class="card stat"><b>${d.avgAttempts ?? '—'}</b><span>متوسط المحاولات لكل لاب</span></div>
      <div class="card stat"><b>${d.avgClarity ?? '—'}</b><span>متوسط وضوح الشرح</span></div>
    </div>
    <div class="card"><h3>رحلتك</h3>
      <table><tr><th>اللاب</th><th>الحالة</th><th>المحاولات</th><th>أفضل نتيجة</th><th>الوضوح</th><th>XP</th></tr>
      ${d.labs.map((l) => `<tr><td>${esc(l.title)}<div class="muted small">${esc(l.course_title)}</div></td><td>${statusPill(l.status)}</td><td>${l.attempts}</td><td>${l.best_score ?? '—'}</td><td>${l.clarity ?? '—'}</td><td>${l.xp_earned}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">لم تبدأ أي لاب بعد.</td></tr>'}
      </table></div>`;
});

const pageStudio = guard(async () => {
  const { courses } = await api('/studio/courses');
  app.innerHTML = `
    <h1>استوديو المدرب</h1>
    <div class="card"><h3>كورس جديد</h3>
      <form id="newCourse">
        <label>اسم الكورس</label><input name="title" required>
        <label>وصف مختصر</label><input name="description">
        <p><button>إنشاء الكورس</button></p>
      </form></div>
    ${courses.map((c) => `
      <div class="card">
        <h3>${esc(c.title)}</h3>
        ${c.labs.map((l) => `<div class="row" style="justify-content:space-between;border-bottom:1px solid #e0e6ee"><span><b>${l.position}.</b> ${esc(l.title)} ${l.video_path || l.video_url ? '🎬' : '<span class="muted small">(بدون فيديو)</span>'}</span>
          <button class="danger small" data-del="${l.id}">حذف</button></div>`).join('') || '<p class="muted">لا توجد معامل بعد.</p>'}
        <details class="lab-form"><summary>+ إضافة لاب (الاسم ← الفيديو ← تحدي اللاب)</summary>
          <form data-course="${c.id}" class="labForm">
            <label>اسم اللاب</label><input name="title" required>
            <label>المفهوم الذي يشرحه (سطر واحد)</label><input name="concept">
            <label>الفيديو المصوّر (mp4 / webm)</label><input type="file" name="video" accept="video/*">
            <label>أو رابط فيديو (YouTube / Vimeo / ملف مباشر)</label><input name="video_url" dir="ltr" placeholder="https://...">
            <label>تحدي اللاب</label><textarea name="challenge" required placeholder="مثال: أمامك ميزانية 100$، وزعها على حملة إعلانية لمنتج X..."></textarea>
            <div class="bar" hidden><i></i></div>
            <p><button>رفع وحفظ اللاب</button></p>
          </form>
        </details>
      </div>`).join('')}`;

  $('#newCourse').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/courses', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast('تم إنشاء الكورس'); pageStudio(); }
    catch (err) { toast(err.message, true); }
  });
  document.querySelectorAll('.labForm').forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(f);
    if (!form.get('video')?.size) form.delete('video');
    const bar = $('.bar', f), fill = $('.bar i', f), btn = $('button', f);
    bar.hidden = false; btn.disabled = true;
    try {
      await uploadForm(`/courses/${f.dataset.course}/labs`, form, (p) => (fill.style.width = p + '%'));
      toast('تم حفظ اللاب'); pageStudio();
    } catch (err) { toast(err.message, true); btn.disabled = false; bar.hidden = true; }
  }));
  document.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('حذف هذا اللاب نهائياً؟')) return;
    try { await api(`/labs/${b.dataset.del}`, { method: 'DELETE' }); pageStudio(); } catch (err) { toast(err.message, true); }
  }));
}, { instructor: true });

// ---------- router ----------
async function route() {
  const [, page, id] = location.hash.replace(/^#/, '').split('/');
  try {
    if (!page) await pageHome();
    else if (page === 'login') authPage('login');
    else if (page === 'register') authPage('register');
    else if (page === 'course') await pageCourse(id);
    else if (page === 'lab') await pageLab(id);
    else if (page === 'dashboard') await pageDashboard();
    else if (page === 'studio') await pageStudio();
    else app.innerHTML = '<div class="card">الصفحة غير موجودة</div>';
  } catch (e) { app.innerHTML = `<div class="card">${esc(e.message)}</div>`; }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
(async () => {
  try { config = await (await fetch('/api/config')).json(); } catch {}
  await refreshMe();
  renderNav();
  route();
})();
