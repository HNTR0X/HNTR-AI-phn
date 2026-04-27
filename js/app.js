// ═══════════════════════════ STATE ═══════════════════════════
const S = {
  sid: null, name: '', matric: '', diff: 'medium',
  topics: [], weak: [], quizActive: false,
  quizQ: 0, quizScore: 0, curQ: null, wrongAnswers: [],
  stats: { questions: 0, quizzes: 0, sessions: 1, wrong: 0 },
};

const API = async (url, body) => {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
};

const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const $ = id => document.getElementById(id);

// ═══════════════════════════ PROFILE PICTURE ════════════════════

const PFP_KEY = () => `sivarr_pfp_${S.sid || 'guest'}`;

function uploadProfilePic(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { toast('Image too large — max 2MB.'); input.value = ''; return; }

  const reader = new FileReader();
  reader.onload = e => {
    // Resize to 200x200 via canvas before saving
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 200; canvas.height = 200;
      const ctx = canvas.getContext('2d');
      // Crop to square from center
      const size = Math.min(img.width, img.height);
      const sx   = (img.width  - size) / 2;
      const sy   = (img.height - size) / 2;
      ctx.drawImage(img, sx, sy, size, size, 0, 0, 200, 200);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      localStorage.setItem(PFP_KEY(), dataUrl);
      applyProfilePic(dataUrl);
      toast('Profile photo updated ✓');
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
  input.value = '';
}

function applyProfilePic(dataUrl) {
  // All avatar elements to update
  const avatarIds = ['tb-av', 'tb-av-big', 'snav-av'];
  avatarIds.forEach(id => {
    const el = $(id);
    if (!el) return;
    if (dataUrl) {
      el.innerHTML = `<img src="${dataUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
      el.style.background = 'none';
      el.style.padding    = '0';
    } else {
      el.innerHTML = S.name?.[0]?.toUpperCase() || '?';
      el.style.background = 'linear-gradient(135deg,var(--accent),var(--accent2))';
    }
  });
}

function loadProfilePic() {
  const saved = localStorage.getItem(PFP_KEY());
  if (saved) applyProfilePic(saved);
}


let CURRENT_ROLE = 'student';
let AUTH_TAB     = 'login';

function setRole(role) {
  CURRENT_ROLE = role;
  const isLec = role === 'lecturer';

  $('role-student').style.cssText  = `padding:10px;border-radius:10px;font-family:var(--font);font-weight:700;font-size:.88rem;cursor:pointer;transition:all .2s;border:${!isLec?'2px solid var(--accent)':'1px solid var(--border)'};background:${!isLec?'#4f6ef715':'none'};color:${!isLec?'var(--accent)':'var(--muted)'}`;
  $('role-lecturer').style.cssText = `padding:10px;border-radius:10px;font-family:var(--font);font-weight:700;font-size:.88rem;cursor:pointer;transition:all .2s;border:${isLec?'2px solid var(--accent)':'1px solid var(--border)'};background:${isLec?'#4f6ef715':'none'};color:${isLec?'var(--accent)':'var(--muted)'}`;
  $('student-fields').style.display  = isLec ? 'none'  : 'block';
  $('lecturer-fields').style.display = isLec ? 'block' : 'none';
  $('auth-tabs').style.display       = isLec ? 'none'  : 'grid';
  $('login-heading').textContent     = isLec ? 'Lecturer Login' : (AUTH_TAB === 'register' ? 'Create Account' : 'Welcome back');
  $('login-btn').textContent         = isLec ? 'Access Dashboard' : (AUTH_TAB === 'register' ? 'Create Account' : 'Sign In');
  $('login-err').textContent         = '';
}

function setAuthTab(tab) {
  AUTH_TAB    = tab;
  const isReg = tab === 'register';
  $('auth-tab-login').style.cssText    = `padding:8px;border-radius:9px;font-family:var(--font);font-weight:700;font-size:.85rem;cursor:pointer;transition:all .2s;border:${!isReg?'2px solid var(--accent)':'1px solid var(--border)'};background:${!isReg?'#4f6ef715':'none'};color:${!isReg?'var(--accent)':'var(--muted)'}`;
  $('auth-tab-register').style.cssText = `padding:8px;border-radius:9px;font-family:var(--font);font-weight:700;font-size:.85rem;cursor:pointer;transition:all .2s;border:${isReg?'2px solid var(--accent)':'1px solid var(--border)'};background:${isReg?'#4f6ef715':'none'};color:${isReg?'var(--accent)':'var(--muted)'}`;
  $('register-fields').style.display  = isReg ? 'block' : 'none';
  $('login-heading').textContent       = isReg ? 'Create Account' : 'Welcome back';
  $('login-btn').textContent           = isReg ? 'Create Account' : 'Sign In';
  $('login-err').textContent           = '';
}

function togglePwVis(inputId, btnId) {
  const inp = $(inputId);
  const btn = $(btnId);
  if (!inp) return;
  inp.type = inp.type === 'password' ? 'text' : 'password';
  if (btn) btn.textContent = inp.type === 'password' ? '👁' : '🙈';
}

async function doLogin(prefillName, prefillMatric) {
  const err = $('login-err');
  const btn = $('login-btn');
  if (err) err.textContent = '';

  // ── Lecturer path ─────────────────────────────────────────
  if (CURRENT_ROLE === 'lecturer') {
    const name = $('lec-name-login')?.value.trim();
    const pw   = $('lec-pw-login')?.value.trim();
    if (!name || !pw) { if (err) err.textContent = 'Enter your name and password.'; return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Checking...'; }
    try {
      const r = await fetch('/api/lecturer/login', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ name, password: pw })
      });
      if (!r.ok) throw new Error('Invalid password');
      const d = await r.json();
      localStorage.setItem('sivarr_lec_token', d.token);
      localStorage.setItem('sivarr_lec_name',  name);
      window.location.href = '/lecturer';
    } catch(e) {
      if (err) err.textContent = 'Incorrect password. Try again.';
      if (btn) { btn.disabled = false; btn.textContent = 'Access Dashboard'; }
    }
    return;
  }

  // ── Student path ──────────────────────────────────────────
  const name   = prefillName   || $('ln')?.value.trim();
  const matric = prefillMatric || $('lm')?.value.trim();
  const pw     = $('l-pw')?.value || '';
  const email  = $('l-email')?.value?.trim() || '';
  const phone  = $('l-phone')?.value?.trim() || '';

  if (!name || !matric) { if (err) err.textContent = 'Enter your name and matric number.'; return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Please wait...'; }

  try {
    const r = await API('/api/login', { name, matric, password: pw, email, phone, action: AUTH_TAB });

    S.sid    = r.sid;   S.name   = r.name;  S.matric = r.matric;
    S.diff   = r.difficulty; S.topics = r.topics; S.weak = r.weak;
    S.stats  = { questions: r.questions, quizzes: r.quizzes, sessions: r.sessions, wrong: r.wrong_count };
    S.uploadedFiles = r.uploaded_files || [];
    S.plan   = r.plan || 'free';

    saveSession(name, matric);

    $('tb-av').textContent   = r.name[0].toUpperCase();
    $('tb-name').textContent = r.name;
    const snavAv   = $('snav-av');     if (snavAv)   snavAv.textContent   = r.name[0].toUpperCase();
    const snavName = $('snav-name');   if (snavName) snavName.textContent = r.name;
    const pdName   = $('pd-name');     if (pdName)   pdName.textContent   = r.name;
    const pdMatric = $('pd-matric');   if (pdMatric) pdMatric.textContent = r.matric;
    const tbAvBig  = $('tb-av-big');   if (tbAvBig)  tbAvBig.textContent  = r.name[0].toUpperCase();
    const mobAv    = $('mob-snav-av'); if (mobAv)    mobAv.textContent    = r.name[0].toUpperCase();
    const mobName  = $('mob-snav-name'); if (mobName) mobName.textContent = r.name;
    loadProfilePic();
    snavToggle('ai', $('snav-sec-ai'));
    updateDiff(r.difficulty);
    updateSBStats();
    renderTopics(r.topics, r.weak);
    renderFileList();
    loadWrong();

    $('login-screen').style.display = 'none';
    const dash= $('dashboard');
    $('dashboard').style.display    = 'flex';
    document.body.classList.add('dashboard-active');

    const greet = $('welcome-greeting');
    if (greet) {
      const hr  = new Date().getHours();
      const tod = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
      greet.textContent = `${tod}, ${r.name.split(' ')[0]}`;
    }
    loadAnnouncements();

    try {
      const ann = await fetch('/api/lecturer/announcements');
      const ad  = await ann.json();
      if (ad.announcements?.length) {
        const latest = ad.announcements[0];
        addMsg('sivarr', `📢 Announcement from your lecturer:\n\n"${latest.message}"\n\n— ${latest.author}, ${latest.date}`);
      }
    } catch(e) {}

  } catch(e) {
    const msg = e.message || '';
    const text = msg.includes('409') ? 'Account already exists — sign in instead.' :
                 msg.includes('401') ? 'Incorrect password.' :
                 msg.includes('400') ? 'Password must be at least 6 characters.' :
                 msg.includes('422') ? 'Check your name and matric number.' :
                 'Login failed — ' + (msg || 'check your connection');
    if (err) err.textContent = text;
    console.error('Login error:', e);
    if (btn) { btn.disabled = false; btn.textContent = AUTH_TAB === 'register' ? 'Create Account' : 'Sign In'; }
    clearSession();
  }
  if (btn) { btn.disabled = false; btn.textContent = AUTH_TAB === 'register' ? 'Create Account' : 'Sign In'; }
}

// ═══════════════════════════ ANNOUNCEMENTS ══════════════════════
async function loadAnnouncements() {
  try {
    const r = await fetch('/api/announcements/active');
    const d = await r.json();
    const anns = d.announcements || [];
    if (!anns.length) return;

    // Don't show announcements the student has already dismissed
    const dismissed = JSON.parse(localStorage.getItem('sivarr_dismissed_anns') || '[]');
    const unseen = anns.filter(a => !dismissed.includes(a.date + a.text.slice(0,20)));
    if (!unseen.length) return;

    const TYPE_COLORS = {
      info:     { bg: '#4f6ef715', border: '#4f6ef740', color: '#4f6ef7',  icon: '📘' },
      warning:  { bg: '#f59e0b15', border: '#f59e0b40', color: '#f59e0b',  icon: '⚠️' },
      deadline: { bg: '#ef444415', border: '#ef444440', color: '#ef4444',  icon: '⏰' },
      exam:     { bg: '#7c3aed15', border: '#7c3aed40', color: '#7c3aed',  icon: '📝' },
    };

    // Remove existing popup if any
    const existing = document.getElementById('ann-popup');
    if (existing) existing.remove();

    const latest = unseen[unseen.length - 1];
    const style  = TYPE_COLORS[latest.type] || TYPE_COLORS.info;
    const key    = latest.date + latest.text.slice(0,20);

    // Create popup
    const popup = document.createElement('div');
    popup.id = 'ann-popup';
    popup.innerHTML = `
      <div id="ann-popup-inner">
        <div style="display:flex;align-items:flex-start;gap:10px">
          <span style="font-size:1.3rem;flex-shrink:0">${style.icon}</span>
          <div style="flex:1;min-width:0">
            <div style="font-size:.72rem;font-weight:700;color:${style.color};text-transform:uppercase;
              letter-spacing:.05em;margin-bottom:3px">
              From your lecturer
              ${unseen.length > 1 ? `<span style="background:${style.color};color:#fff;border-radius:20px;
                padding:1px 7px;font-size:.65rem;margin-left:6px">${unseen.length} new</span>` : ''}
            </div>
            <div style="font-size:.88rem;line-height:1.5;color:var(--text)">${esc(latest.text)}</div>
            <div style="font-size:.72rem;color:var(--muted);margin-top:4px">${latest.date}</div>
          </div>
          <button onclick="dismissAnnouncement('${key}')"
            style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:1rem;
              flex-shrink:0;padding:2px 4px;line-height:1;transition:color .15s"
            onmouseover="this.style.color='var(--text)'"
            onmouseout="this.style.color='var(--muted)'">✕</button>
        </div>
        ${unseen.length > 1 ? `
        <div style="margin-top:10px;padding-top:10px;border-top:1px solid ${style.border}">
          <button onclick="showAllAnnouncements()" style="background:none;border:none;
            color:${style.color};font-size:.78rem;font-weight:600;cursor:pointer;font-family:var(--font)">
            View all ${unseen.length} announcements →
          </button>
        </div>` : ''}
      </div>`;

    // Styles for the popup
    popup.style.cssText = `
      position: fixed;
      top: 0;
      left: 50%;
      transform: translateX(-50%) translateY(-100%);
      width: min(460px, calc(100vw - 2rem));
      background: var(--card);
      border: 1px solid ${style.border};
      border-top: none;
      border-radius: 0 0 16px 16px;
      padding: 1rem 1.1rem;
      z-index: 300;
      box-shadow: 0 8px 32px rgba(0,0,0,.4);
      transition: transform .4s cubic-bezier(0.34, 1.56, 0.64, 1);
    `;

    document.body.appendChild(popup);

    // Animate drop down
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        popup.style.transform = 'translateX(-50%) translateY(0)';
      });
    });

    // Auto dismiss after 8 seconds
    setTimeout(() => dismissAnnouncement(key), 8000);

  } catch {}
}

function dismissAnnouncement(key) {
  const popup = document.getElementById('ann-popup');
  if (!popup) return;
  popup.style.transform = 'translateX(-50%) translateY(-110%)';
  setTimeout(() => popup.remove(), 400);
  // Remember dismissed
  const dismissed = JSON.parse(localStorage.getItem('sivarr_dismissed_anns') || '[]');
  if (!dismissed.includes(key)) dismissed.push(key);
  // Keep only last 50
  localStorage.setItem('sivarr_dismissed_anns', JSON.stringify(dismissed.slice(-50)));
}

function showAllAnnouncements() {
  dismissAnnouncement('');
  fetch('/api/announcements/active')
    .then(r => r.json())
    .then(d => {
      const anns = d.announcements || [];
      const TYPE_ICONS = {info:'📘', warning:'⚠️', deadline:'⏰', exam:'📝'};
      addMsg('sivarr', '📢 Announcements from your lecturer:\n\n' +
        anns.map((a,i) => `${TYPE_ICONS[a.type]||'📘'} ${a.text}\n— ${a.date}`).join('\n\n'));
    }).catch(() => {});
}

// ═══════════════════════════ SESSION PERSISTENCE ══════════════
// Save login to localStorage so user stays logged in on return

function saveSession(name, matric) {
  localStorage.setItem('sivarr_name',   name);
  localStorage.setItem('sivarr_matric', matric);
  localStorage.setItem('sivarr_ts',     Date.now());
}

function clearSession() {
  localStorage.removeItem('sivarr_name');
  localStorage.removeItem('sivarr_matric');
  localStorage.removeItem('sivarr_ts');
}

function getSavedSession() {
  const name   = localStorage.getItem('sivarr_name');
  const matric = localStorage.getItem('sivarr_matric');
  const ts     = localStorage.getItem('sivarr_ts');
  // Session expires after 30 days
  if (!name || !matric || !ts) return null;
  if (Date.now() - parseInt(ts) > 30 * 24 * 60 * 60 * 1000) {
    clearSession(); return null;
  }
  return { name, matric };
}

// ═══════════════════════════ LOGIN ════════════════════════════
// Add logout button handler
function logout() {
  clearSession();
  document.body.classList.remove('dashboard-active');
  location.reload();
}

// Auto-login on page load if session exists
window.addEventListener('DOMContentLoaded', () => {
  // Clear any stale lecturer tokens — lecturer login is on /lecturer page
  localStorage.removeItem('sivarr_lecturer_token');
  localStorage.removeItem('sivarr_lecturer_name');

  const saved = getSavedSession();
  if (saved) {
    const btn = $('login-btn');
    if (btn) { btn.textContent = 'Resuming session...'; btn.disabled = true; }
    doLogin(saved.name, saved.matric);
  }
});

['ln','lm'].forEach((id,i) => {
  const el = $(id);
  if (el) el.addEventListener('keydown', e => {
    if (e.key === 'Enter') i === 0 ? $('lm').focus() : doLogin();
  });
});

// ═══════════════════════════ ATTACHMENTS ════════════════════════

let ATTACHMENTS = []; // { name, type, content (base64 or text) }

function toggleAttachMenu() {
  const menu = $('attach-menu');
  const btn  = $('attach-btn');
  if (!menu) return;
  const open = menu.style.display === 'block';
  menu.style.display = open ? 'none' : 'block';
  btn.style.borderColor = open ? 'var(--border)' : 'var(--accent)';
  btn.style.color       = open ? 'var(--muted)'  : 'var(--accent)';
}

function triggerAttach(type) {
  $('attach-menu').style.display = 'none';
  $('attach-btn').style.borderColor = 'var(--border)';
  $('attach-btn').style.color       = 'var(--muted)';
  const inputMap = { image:'attach-image-input', pdf:'attach-pdf-input', file:'attach-file-input', doc:'attach-doc-input' };
  $(inputMap[type])?.click();
}

function handleAttach(input, type) {
  const file = input.files[0];
  if (!file) return;

  const MAX = 5 * 1024 * 1024;
  if (file.size > MAX) { toast('File too large — max 5MB.'); input.value = ''; return; }

  const reader = new FileReader();

  if (type === 'image') {
    reader.onload = e => {
      ATTACHMENTS.push({ name: file.name, type: 'image', content: e.target.result });
      renderAttachPreview();
      toast(`Image attached: ${file.name}`);
    };
    reader.readAsDataURL(file);
  } else {
    reader.onload = e => {
      ATTACHMENTS.push({ name: file.name, type, content: e.target.result });
      renderAttachPreview();
      toast(`Attached: ${file.name}`);
    };
    reader.readAsText(file);
  }
  input.value = '';
}

function renderAttachPreview() {
  const strip = $('attach-preview');
  if (!strip) return;
  if (!ATTACHMENTS.length) { strip.style.display = 'none'; return; }
  strip.style.display = 'flex';
  strip.innerHTML = ATTACHMENTS.map((a, i) => `
    <div class="attach-chip">
      <span>${a.type === 'image' ? '🖼️' : a.type === 'pdf' ? '📄' : '📎'}</span>
      ${esc(a.name)}
      <button onclick="removeAttach(${i})">✕</button>
    </div>`).join('');
}

function removeAttach(idx) {
  ATTACHMENTS.splice(idx, 1);
  renderAttachPreview();
}

// Close attach menu when clicking outside
document.addEventListener('click', e => {
  const menu = $('attach-menu');
  const btn  = $('attach-btn');
  if (menu && btn && !menu.contains(e.target) && e.target !== btn) {
    menu.style.display = 'none';
    btn.style.borderColor = 'var(--border)';
    btn.style.color       = 'var(--muted)';
  }
});


async function send() {
  const ci = $('ci'), msg = ci.value.trim();
  if (!msg && !ATTACHMENTS.length) return;
  if (!S.sid) return;

  // Build message with attachment context
  let fullMsg = msg;
  if (ATTACHMENTS.length) {
    const attachContext = ATTACHMENTS.map(a => {
      if (a.type === 'image') return `[Image attached: ${a.name}]`;
      return `[File attached: ${a.name}]\n\nContent:\n${a.content.slice(0, 3000)}`;
    }).join('\n\n');
    fullMsg = msg ? `${msg}\n\n${attachContext}` : attachContext;
  }

  // Show user message with attachment chips
  const displayMsg = msg || `📎 ${ATTACHMENTS.map(a => a.name).join(', ')}`;
  addMsg('user', displayMsg);
  if (ATTACHMENTS.length) {
    ATTACHMENTS = [];
    renderAttachPreview();
  }

  ci.value = ''; ci.style.height = 'auto';
  const t = addTyping();
  $('sb').disabled = true;
  try {
    const r = await API('/api/chat', { sid: S.sid, message: fullMsg });
    t.remove();
    addMsg('sivarr', r.reply, r.uncertain);
    S.stats.questions++;
    updateSBStats();
    refreshTopics();
  } catch(e) {
    t.remove();
    addMsg('sivarr', 'Connection issue — check your internet and try again.');
  }
  $('sb').disabled = false;
  scrollMsgs();
}

function quickPrompt(text) {
  // Hide welcome screen, set input, and send
  const welcome = $('chat-welcome');
  if (welcome) welcome.style.display = 'none';
  const ci = $('ci');
  if (ci) { ci.value = text; ci.style.height = 'auto'; }
  send();
}

function addMsg(role, text, uncertain = false) {
  const welcome = $('chat-welcome');
  if (welcome) welcome.style.display = 'none';

  const w = $('msgs'), d = document.createElement('div');
  d.className = `msg ${role}`;
  const av      = role === 'sivarr' ? 'Sr' : S.name[0]?.toUpperCase() || 'U';
  const rendered = role === 'sivarr' ? renderMarkdown(text) : esc(text);
  d.innerHTML = `
    <div class="msg-av">${av}</div>
    <div style="min-width:0;flex:1">
      <div class="msg-bub md-body">${rendered}</div>
      ${uncertain ? `<div class="uncertain">⚠️ Verify this with your lecturer</div>` : ''}
      ${role === 'sivarr' ? `<button class="action-btn" style="margin-top:5px;font-size:.68rem" onclick="downloadText(this.closest('.msg').querySelector('.msg-bub').innerText)">⬇ Download</button>` : ''}
    </div>`;
  w.appendChild(d);
  scrollMsgs();
  return d;
}

function addTyping() {
  const w = $('msgs'), d = document.createElement('div');
  d.className = 'msg sivarr';
  d.innerHTML = `<div class="msg-av">Sr</div>
    <div class="typing"><span></span><span></span><span></span></div>`;
  w.appendChild(d);
  scrollMsgs();
  return d;
}

function scrollMsgs() {
  const m = $('msgs'); m.scrollTop = m.scrollHeight;
}

function ckd(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
}

// ═══════════════════════════ QUIZ ═════════════════════════════
function startQuiz() {
  const typed = $('quiz-topic-input') ? $('quiz-topic-input').value.trim() : '';

  // If no studied topics AND no typed topic, show helpful message
  if (!S.topics.length && !typed) {
    toast('Type a topic above or ask me questions in Chat first!');
    return;
  }

  // Store custom topic for this quiz session
  S.quizCustomTopic = typed || '';
  S.quizActive = true;
  S.quizQ      = 0;
  S.quizScore  = 0;
  loadQ();
}

async function loadQ() {
  const qw = $('qw');
  if (!qw) return;

  let topic = S.quizCustomTopic || '';
  if (!topic && S.topics.length) topic = S.topics[Math.floor(Math.random() * S.topics.length)];
  if (!topic) topic = 'general knowledge';

  qw.innerHTML = `
    <div style="padding:3rem 1rem;text-align:center">
      <div style="font-size:1.8rem;margin-bottom:.75rem">⏳</div>
      <div style="color:var(--muted);font-size:.9rem">Generating question ${S.quizQ+1} of 5...</div>
      <div style="font-size:.78rem;color:var(--muted2);margin-top:.3rem">${esc(topic)}</div>
    </div>`;

  try {
    const r = await fetch(`/api/quiz/question?sid=${encodeURIComponent(S.sid)}&topic=${encodeURIComponent(topic)}&difficulty=${encodeURIComponent(S.diff)}`);
    if (!r.ok) throw new Error(`Server error ${r.status}`);
    const q = await r.json();
    if (q.error) { toast(q.error); resetQuiz(); return; }
    S.curQ = q;
    renderQ(q);
  } catch(e) {
    qw.innerHTML = `
      <div style="padding:2rem;text-align:center">
        <div style="font-size:1.5rem;margin-bottom:.5rem">⚠️</div>
        <div style="color:var(--muted);font-size:.88rem;margin-bottom:1rem">Couldn't generate question — AI may be busy.</div>
        <button class="btn-start" style="padding:8px 20px;font-size:.82rem" onclick="loadQ()">Try Again</button>
        <button style="margin-left:8px;background:none;border:1px solid var(--border);border-radius:8px;padding:8px 16px;color:var(--muted);font-size:.82rem;cursor:pointer" onclick="resetQuiz()">Cancel</button>
      </div>`;
  }
}

function renderQ(q) {
  const pct = S.quizQ/5*100;
  $('qw').innerHTML = `
    <div class="q-header">
      <h3>Question ${S.quizQ+1} <span style="color:var(--muted);font-weight:400">of 5</span></h3>
      <span style="font-size:.75rem;color:var(--muted)">[${S.diff.toUpperCase()}]</span>
    </div>
    <div class="prog-bar"><div class="prog-fill" style="width:${pct}%"></div></div>
    <div class="q-card">
      <h4>${esc(q.question)}</h4>
      <div class="opts">
        ${['A','B','C','D'].map(l=>`
          <button class="opt-btn" onclick="answer('${l}')" data-l="${l}">
            <span class="opt-letter">${l}</span>${esc(q.options[l])}
          </button>`).join('')}
      </div>
      <div class="expl" id="expl"></div>
    </div>`;
}

async function answer(letter) {
  const q = S.curQ, correct = letter === q.answer;
  document.querySelectorAll('.opt-btn').forEach(b => {
    b.disabled = true;
    if (b.dataset.l === q.answer) b.classList.add('correct');
    if (b.dataset.l === letter && !correct) b.classList.add('wrong');
  });
  const ex = $('expl');
  ex.textContent = (correct ? '✅ ' : '❌ ') + q.explanation;
  ex.style.display = 'block';
  if (correct) S.quizScore++;
  await API('/api/quiz/submit', {
    sid: S.sid, topic: q.topic || S.topics[0],
    difficulty: S.diff, answer: letter,
    question: q.question, correct: q.answer, explanation: q.explanation,
  });
  S.quizQ++;
  setTimeout(() => S.quizQ >= 5 ? showResult() : loadQ(), 1800);
}

async function showResult() {
  const pct = Math.round(S.quizScore/5*100);
  const emoji = pct===100?'🏆':pct>=80?'🌟':pct>=60?'👍':'💪';
  const msg = pct===100?'Perfect score! Outstanding!':pct>=80?'Great job!':pct>=60?'Good effort — keep going!':'Keep practising!';
  await API('/api/quiz/complete', { sid: S.sid, score: S.quizScore, topic: S.topics[0]||'general', difficulty: S.diff });
  $('qw').innerHTML = `
    <div class="score-card">
      <div style="font-size:2.5rem;margin-bottom:.5rem">${emoji}</div>
      <div class="score-num">${S.quizScore}/5</div>
      <div style="color:var(--muted);margin:.4rem 0">${pct}% · ${S.diff.toUpperCase()}</div>
      <div style="font-weight:500;margin-bottom:1.5rem">${msg}</div>
      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-bottom:1rem">
        <button class="action-btn" onclick="shareResult(${S.quizScore},'${S.topics[0]||'general'}')">🔗 Share Result</button>
      </div>
      <button class="btn-start" onclick="startQuiz()">Take Another Quiz</button>
    </div>`;
  S.stats.quizzes++; updateSBStats(); loadWrong(); S.quizActive = false;
}

function resetQuiz() {
  S.quizActive = false;
  S.quizCustomTopic = '';
  $('qw').innerHTML = `
    <div class="quiz-start-card">
      <div style="font-size:2.5rem">📝</div>
      <h2>Test your knowledge</h2>
      <p style="margin-bottom:1rem">Difficulty: <strong style="color:var(--accent)">${S.diff.charAt(0).toUpperCase()+S.diff.slice(1)}</strong></p>
      <div style="margin-bottom:1rem;text-align:left">
        <label style="font-size:.75rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:6px">Topic (optional)</label>
        <input id="quiz-topic-input" type="text"
          placeholder="e.g. Photosynthesis, Newton's laws..."
          style="width:100%;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px 13px;color:var(--text);font-family:var(--font-body);font-size:.88rem;outline:none"
          onkeydown="if(event.key==='Enter') startQuiz()">
        <p style="font-size:.72rem;color:var(--muted);margin-top:5px">Leave blank to quiz from your studied topics</p>
      </div>
      <button class="btn-start" onclick="startQuiz()">Start Quiz</button>
    </div>`;
}

// ═══════════════════════════ SUGGESTIONS ═══════════════════════
async function getSuggestions() {
  const _st = $('sug-txt'); if (_st) _st.textContent = 'Thinking...';
  try {
    const r = await fetch(`/api/suggest?sid=${S.sid}`);
    const d = await r.json();
    if (_st) _st.textContent = d.suggestion;
  } catch { const _stc = $('sug-txt'); if (_stc) _stc.textContent = 'Couldn\'t load suggestions — try again.'; }
}

// ═══════════════════════════ WRONG ANSWERS ══════════════════════
async function loadWrong() {
  try {
    const r = await fetch(`/api/wrong?sid=${S.sid}`);
    const d = await r.json();
    S.wrongAnswers = d.wrong;
    const wc   = $('wc');   if (wc)   wc.textContent   = d.wrong.length;
    const wcm  = $('wc-m'); if (wcm)  wcm.textContent  = d.wrong.length;
    const sqw  = $('sq-w'); if (sqw)  sqw.textContent  = d.wrong.length;
    const list = $('wrong-list');
    const listm = $('wrong-list-m');
    const html = !d.wrong.length
      ? `<span style="color:var(--muted);font-size:.78rem">No wrong answers yet — keep quizzing!</span>`
      : d.wrong.map((w,i) => `
          <div class="wrong-item">
            <div class="wrong-q">${esc(w.question)}</div>
            <div class="wrong-ans">You: ${w.your_answer} · Correct: <span>${w.correct}</span></div>
            <div style="color:var(--muted);font-size:.7rem;margin-top:2px">${esc(w.explanation)}</div>
            <button class="btn-clear" onclick="clearWrong(${i})">✓ Got it</button>
          </div>`).join('');
    if (list)  list.innerHTML  = html;
    if (listm) listm.innerHTML = html;
  } catch(e) { console.error('loadWrong error:', e); }
}

async function clearWrong(idx) {
  await API('/api/wrong/clear', { sid: S.sid, index: idx });
  loadWrong(); toast('Removed from revision ✓');
}

// ═══════════════════════════ STATS ══════════════════════════════
async function loadStats() {
  const r = await fetch(`/api/progress?sid=${S.sid}`);
  const d = await r.json();

  // Build sparkline SVG
  const hist = d.quiz_history || [];
  let sparkSVG = '';
  if (hist.length > 1) {
    const W = 300, H = 48, pad = 6;
    const max = Math.max(...hist.map(q => q.pct), 1);
    const pts = hist.map((q, i) => {
      const x = pad + (i / (hist.length - 1)) * (W - pad * 2);
      const y = H - pad - (q.pct / max) * (H - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const area = `${W - pad},${H} ${pad},${H}`;
    sparkSVG = `
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:48px;margin-top:8px">
        <defs>
          <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#4f6ef7" stop-opacity=".3"/>
            <stop offset="100%" stop-color="#4f6ef7" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <polygon points="${pts.join(' ')} ${area}" fill="url(#sg)"/>
        <polyline points="${pts.join(' ')}" fill="none" stroke="#4f6ef7"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="${pts[pts.length-1].split(',')[0]}"
                cy="${pts[pts.length-1].split(',')[1]}"
                r="3.5" fill="#7c3aed"/>
      </svg>`;
  }

  // Topic mastery bars
  const mastery = d.topic_mastery || {};
  const masteryHTML = Object.entries(mastery).length
    ? Object.entries(mastery).sort((a, b) => b[1] - a[1]).slice(0, 7).map(([t, pct]) => `
        <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border)">
          <span style="font-size:.75rem;color:var(--muted);width:90px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t)}</span>
          <div style="flex:1;height:5px;background:var(--border);border-radius:3px;overflow:hidden">
            <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,var(--accent),var(--accent2));border-radius:3px;transition:width .6s ease"></div>
          </div>
          <span style="font-size:.7rem;color:var(--muted);width:28px;text-align:right">${pct}%</span>
        </div>`).join('')
    : '<span style="font-size:.78rem;color:var(--muted)">Ask questions to build topic mastery.</span>';

  // Badges
  const badges  = d.badges || [];
  const badgesHTML = badges.length
    ? badges.map(b => `<span style="background:#4f6ef718;border:1px solid #4f6ef730;border-radius:20px;padding:3px 10px;font-size:.7rem;font-weight:700;color:var(--accent);font-family:var(--font);margin:2px;display:inline-block">🏅 ${esc(b)}</span>`).join('')
    : '<span style="font-size:.78rem;color:var(--muted)">Complete quizzes to earn badges.</span>';

  // Streak colour
  const sc = (d.streak || 0) >= 7 ? '#f59e0b' : (d.streak || 0) >= 3 ? '#fb923c' : 'var(--muted)';
  const xp  = d.xp || 0;
  const lvl = d.level || 1;

  $('sw').innerHTML = `

    <!-- Hero -->
    <div style="background:linear-gradient(135deg,#4f6ef718,#7c3aed12);border:1px solid #4f6ef730;border-radius:16px;padding:1.1rem;margin-bottom:.875rem">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.5rem">
        <div>
          <div style="font-family:var(--font);font-size:.68rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em">Level ${lvl}</div>
          <div style="font-family:var(--font);font-size:1.2rem;font-weight:800;letter-spacing:-.02em">${esc(d.name?.split(' ')[0] || 'Student')}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:1.3rem">🔥</div>
          <div style="font-family:var(--font);font-size:.82rem;font-weight:800;color:${sc}">${d.streak || 0} day streak</div>
        </div>
      </div>
      <div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden">
        <div style="height:100%;width:${xp % 100}%;background:linear-gradient(90deg,var(--accent),var(--accent2));border-radius:3px;transition:width .8s ease"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:.68rem;color:var(--muted);margin-top:3px">
        <span>${xp} XP</span><span>${100 - (xp % 100)} XP to Level ${lvl + 1}</span>
      </div>
    </div>

    <!-- Stats grid -->
    <div class="stats-grid" style="margin-bottom:.875rem">
      <div class="stat-card" style="--sc:#4f6ef7"><div class="sc-label">Questions</div><div class="sc-val" style="color:#4f6ef7">${d.questions}</div></div>
      <div class="stat-card" style="--sc:#7c3aed"><div class="sc-label">Quizzes</div><div class="sc-val" style="color:#7c3aed">${d.quizzes_taken}</div></div>
      <div class="stat-card" style="--sc:#22c55e"><div class="sc-label">Avg Score</div><div class="sc-val" style="color:#22c55e">${d.avg_score}%</div></div>
      <div class="stat-card" style="--sc:#f59e0b"><div class="sc-label">This Week</div><div class="sc-val" style="color:#f59e0b">${d.sessions_week || 0}</div></div>
    </div>

    <!-- Quiz trend -->
    ${hist.length > 1 ? `
    <div class="r-card" style="margin-bottom:.875rem">
      <div class="r-title">📈 Quiz Score Trend <span style="color:var(--muted);font-weight:400;font-size:.72rem">(last ${hist.length})</span></div>
      ${sparkSVG}
      <div style="display:flex;justify-content:space-between;font-size:.68rem;color:var(--muted);margin-top:4px">
        <span>Earliest</span><span>Latest: ${hist[hist.length-1]?.pct || 0}%</span>
      </div>
    </div>` : ''}

    <!-- Topic mastery -->
    <div class="r-card" style="margin-bottom:.875rem">
      <div class="r-title">📚 Topic Mastery</div>
      <div style="margin-top:.5rem">${masteryHTML}</div>
    </div>

    <!-- Weak areas -->
    ${d.weak?.length ? `
    <div style="background:linear-gradient(135deg,#ef444410,transparent);border:1px solid #ef444430;border-radius:12px;padding:.875rem;margin-bottom:.875rem" id="weak-section">
      <div style="font-size:.72rem;font-weight:700;color:var(--red);text-transform:uppercase;letter-spacing:.05em;margin-bottom:.5rem">⚠️ Needs Work</div>
      <div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:.625rem">
        ${d.weak.map(t => `<span style="background:#ef444415;border:1px solid #ef444430;border-radius:20px;padding:3px 10px;font-size:.72rem;color:var(--red);font-weight:600">${esc(t)}</span>`).join('')}
      </div>
      <button onclick="nav('chat',null);setTimeout(()=>{const ci=$('ci');if(ci){ci.value='Help me improve my understanding of ${esc(d.weak[0]||'')}';ci.focus();}},300)"
        style="width:100%;background:none;border:1px solid #ef444440;border-radius:8px;padding:7px;color:var(--red);font-family:var(--font);font-size:.75rem;font-weight:700;cursor:pointer">
        Study weak topics with AI →
      </button>
    </div>` : ''}

    <!-- Badges -->
    <div class="r-card" style="margin-bottom:.875rem">
      <div class="r-title">🏅 Badges</div>
      <div style="margin-top:.5rem;display:flex;flex-wrap:wrap;gap:3px">${badgesHTML}</div>
    </div>

    <!-- Best topic -->
    ${d.best_topic ? `
    <div style="background:linear-gradient(135deg,#22c55e10,transparent);border:1px solid #22c55e30;border-radius:12px;padding:.875rem;display:flex;align-items:center;gap:10px">
      <div style="font-size:1.4rem">⭐</div>
      <div>
        <div style="font-family:var(--font);font-size:.8rem;font-weight:700;color:var(--green)">Strongest Topic</div>
        <div style="font-size:.78rem;color:var(--text);margin-top:1px">${esc(d.best_topic)}</div>
      </div>
    </div>` : ''}
  `;
  }

async function loadProgress() {
  const r = await fetch(`/api/progress?sid=${S.sid}`);
  const d = await r.json();
  const pw = $('pw'); if (!pw) return;

  // Sparkline
  const hist   = d.quiz_history || [];
  const W = 280, H = 44, pad = 4;
  let sparkSVG = '';
  if (hist.length > 1) {
    const max = Math.max(...hist.map(q=>q.pct), 1);
    const pts = hist.map((q,i) => {
      const x = pad + (i/(hist.length-1))*(W-pad*2);
      const y = H - pad - (q.pct/max)*(H-pad*2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const areaClose = `${W-pad},${H} ${pad},${H}`;
    sparkSVG = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:44px;margin-top:6px">
      <defs><linearGradient id="pr-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#4f6ef7" stop-opacity="0.3"/>
        <stop offset="100%" stop-color="#4f6ef7" stop-opacity="0"/>
      </linearGradient></defs>
      <polygon points="${pts.join(' ')} ${areaClose}" fill="url(#pr-grad)"/>
      <polyline points="${pts.join(' ')}" fill="none" stroke="#4f6ef7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      ${pts.map((p,i) => i===pts.length-1 ? `<circle cx="${p.split(',')[0]}" cy="${p.split(',')[1]}" r="3.5" fill="#7c3aed"/>` : '').join('')}
    </svg>`;
  }

  // XP level
  const xp    = d.xp    || 0;
  const level = d.level || 1;
  const xpPct = (xp % 100);

  // Topic mastery rows
  const mastery = d.topic_mastery || {};
  const masteryHTML = Object.entries(mastery).length
    ? Object.entries(mastery).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([t,pct])=>`
        <div class="pr-topic-row">
          <span style="font-size:.78rem;color:var(--muted);width:100px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t)}</span>
          <div class="pr-topic-bar-wrap"><div class="pr-topic-bar-fill" style="width:${pct}%"></div></div>
          <span style="font-size:.72rem;color:var(--muted);width:30px;text-align:right">${pct}%</span>
        </div>`).join('')
    : '<span style="font-size:.78rem;color:var(--muted)">Chat and quiz to build topic mastery.</span>';

  // Badges
  const badges = d.badges || [];
  const badgesHTML = badges.length
    ? badges.map(b=>`<span class="pr-badge">🏅 ${esc(b)}</span>`).join('')
    : '<span style="font-size:.78rem;color:var(--muted)">Complete quizzes to earn badges.</span>';

  // Streak fire
  const streakColor = d.streak >= 7 ? '#f59e0b' : d.streak >= 3 ? '#fb923c' : 'var(--muted)';

  pw.innerHTML = `
    <!-- Hero: Level + Streak -->
    <div class="pr-hero">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.5rem">
        <div>
          <div style="font-family:var(--font);font-size:.72rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em">Level ${level}</div>
          <div style="font-family:var(--font);font-size:1.3rem;font-weight:800;letter-spacing:-.02em">${d.name?.split(' ')[0] || 'Student'}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:1.4rem">🔥</div>
          <div style="font-family:var(--font);font-size:.85rem;font-weight:800;color:${streakColor}">${d.streak || 0} day streak</div>
        </div>
      </div>
      <div class="pr-level-bar"><div class="pr-level-fill" style="width:${xpPct}%"></div></div>
      <div style="display:flex;justify-content:space-between;font-size:.68rem;color:var(--muted)">
        <span>${xp} XP</span>
        <span>${100 - xpPct} XP to Level ${level+1}</span>
      </div>
    </div>

    <!-- Stats grid -->
    <div class="pr-stat-row">
      <div class="pr-stat" style="--pr-color:#4f6ef7">
        <div class="pr-stat-val">${d.questions}</div>
        <div class="pr-stat-lbl">Questions asked</div>
      </div>
      <div class="pr-stat" style="--pr-color:#7c3aed">
        <div class="pr-stat-val">${d.quizzes_taken}</div>
        <div class="pr-stat-lbl">Quizzes taken</div>
      </div>
      <div class="pr-stat" style="--pr-color:#22c55e">
        <div class="pr-stat-val">${d.avg_score}%</div>
        <div class="pr-stat-lbl">Average score</div>
      </div>
      <div class="pr-stat" style="--pr-color:#f59e0b">
        <div class="pr-stat-val">${d.sessions_week || 0}</div>
        <div class="pr-stat-lbl">Sessions this week</div>
      </div>
    </div>

    <!-- Quiz trend sparkline -->
    ${hist.length > 1 ? `
    <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1rem;margin-bottom:.875rem">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="font-size:.75rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">📈 Quiz Score Trend</div>
        <div style="font-size:.72rem;color:var(--accent)">${hist.length} quizzes</div>
      </div>
      ${sparkSVG}
    </div>` : ''}

    <!-- Topic mastery -->
    <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1rem;margin-bottom:.875rem">
      <div style="font-size:.75rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:.75rem">📚 Topic Mastery</div>
      ${masteryHTML}
    </div>

    <!-- Weak areas -->
    ${d.weak?.length ? `
    <div style="background:linear-gradient(135deg,#ef444410,transparent);border:1px solid #ef444430;border-radius:12px;padding:1rem;margin-bottom:.875rem" id="weak-section">
      <div style="font-size:.75rem;font-weight:700;color:var(--red);text-transform:uppercase;letter-spacing:.05em;margin-bottom:.625rem">⚠️ Needs Work</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${d.weak.map(t=>`<span style="background:#ef444415;border:1px solid #ef444430;border-radius:20px;padding:3px 10px;font-size:.72rem;color:var(--red);font-weight:600">${esc(t)}</span>`).join('')}
      </div>
      <button onclick="nav('chat',null);setTimeout(()=>{const ci=$('ci');if(ci){ci.value='Help me improve at '+${JSON.stringify(d.weak[0])};ci.focus();}},300)" style="width:100%;margin-top:.75rem;background:none;border:1px solid #ef444440;border-radius:8px;padding:7px;color:var(--red);font-family:var(--font);font-size:.75rem;font-weight:700;cursor:pointer;transition:all .15s">
        Study weak topics with AI →
      </button>
    </div>` : ''}

    <!-- Badges -->
    <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1rem;margin-bottom:.875rem">
      <div style="font-size:.75rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:.625rem">🏅 Badges</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px">${badgesHTML}</div>
    </div>

    <!-- Best topic -->
    ${d.best_topic ? `
    <div style="background:linear-gradient(135deg,#22c55e10,transparent);border:1px solid #22c55e30;border-radius:12px;padding:.875rem;margin-bottom:.875rem;display:flex;align-items:center;gap:12px">
      <div style="font-size:1.5rem">⭐</div>
      <div>
        <div style="font-family:var(--font);font-size:.82rem;font-weight:700;color:var(--green)">Strongest Topic</div>
        <div style="font-size:.78rem;color:var(--text);margin-top:1px">${esc(d.best_topic)}</div>
      </div>
    </div>` : ''}
  `;
}

// ═══════════════════════ GOALS ═════════════════════════════

let GL_GOALS = [];

async function glLoad() {
  try {
    const r = await fetch(`/api/goals?sid=${S.sid}`);
    const d = await r.json();
    GL_GOALS = d.goals || [];
    glRender();
  } catch(e) { GL_GOALS = []; glRender(); }
}

function glRender() {
  const list = $('gl-list'); if (!list) return;
  if (!GL_GOALS.length) {
    list.innerHTML = `<div style="text-align:center;padding:3rem 1rem;color:var(--muted)">
      <div style="font-size:2rem;margin-bottom:.5rem">🎯</div>
      <div style="font-size:.85rem">No goals yet — set your first target!</div>
    </div>`; return;
  }

  const today = new Date();
  list.innerHTML = GL_GOALS.map(g => {
    const daysLeft = g.deadline
      ? Math.ceil((new Date(g.deadline) - today) / 86400000) : null;
    const urgency  = daysLeft !== null && daysLeft <= 3 ? 'var(--red)' :
                     daysLeft !== null && daysLeft <= 7 ? 'var(--yellow)' : 'var(--muted)';
    const pct = g.progress || 0;
    return `
      <div class="gl-card ${g.completed ? 'done' : ''}">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
          <div style="flex:1">
            <div class="gl-title">${g.completed ? '✅ ' : ''}${esc(g.title)}</div>
            <div class="gl-meta">
              ${g.subject ? `📚 ${esc(g.subject)} · ` : ''}
              🎯 Target: ${g.target_score}%
              ${daysLeft !== null ? ` · <span style="color:${urgency}">${daysLeft > 0 ? daysLeft+' days left' : daysLeft === 0 ? 'Today!' : 'Overdue'}</span>` : ''}
            </div>
          </div>
          <div style="font-family:var(--font);font-size:.85rem;font-weight:800;color:var(--accent)">${pct}%</div>
        </div>
        <div class="gl-prog-wrap">
          <div class="gl-prog-fill ${g.completed?'done':''}" style="width:${pct}%"></div>
        </div>
        <div style="font-size:.68rem;color:var(--muted)">${pct}% of target reached</div>
        <div class="gl-actions">
          <button class="gl-action-btn" onclick="glUpdateProgress('${g.id}',${pct})">📈 Update</button>
          <button class="gl-action-btn done-btn" onclick="glMarkDone('${g.id}')">${g.completed ? '↩ Reopen' : '✓ Done'}</button>
          <button class="gl-action-btn del-btn" onclick="glDelete('${g.id}')">🗑</button>
        </div>
      </div>`;
  }).join('');
}

function glToggleForm() {
  $('gl-add-form').classList.toggle('open');
  if ($('gl-add-form').classList.contains('open')) {
    $('gl-title')?.focus();
    $('gl-deadline').min = new Date().toISOString().split('T')[0];
  }
}

async function glSaveGoal() {
  const title   = $('gl-title')?.value.trim();
  const subject = $('gl-subject')?.value.trim();
  const target  = parseInt($('gl-target')?.value) || 70;
  const deadline = $('gl-deadline')?.value;
  if (!title) { toast('Enter a goal title.'); return; }
  try {
    const r = await API('/api/goals/add', {sid:S.sid, title, subject, target_score:target, deadline});
    GL_GOALS.push(r.goal);
    glRender();
    $('gl-add-form').classList.remove('open');
    $('gl-title').value = ''; $('gl-subject').value = '';
    $('gl-target').value = '70'; $('gl-deadline').value = '';
    toast('Goal added! 🎯');
  } catch(e) { toast('Could not save goal.'); }
}

async function glUpdateProgress(id, current) {
  const val = prompt(`Update progress (0-100%). Currently ${current}%:`);
  if (val === null) return;
  const pct = Math.min(Math.max(parseInt(val)||0, 0), 100);
  try {
    await API('/api/goals/update', {sid:S.sid, id, progress:pct, completed: pct>=100});
    const g = GL_GOALS.find(x=>x.id===id);
    if (g) { g.progress = pct; g.completed = pct>=100; }
    glRender();
    if (pct >= 100) toast('Goal completed! 🎉');
    else toast(`Progress updated to ${pct}% ✓`);
  } catch(e) { toast('Update failed.'); }
}

async function glMarkDone(id) {
  const g = GL_GOALS.find(x=>x.id===id);
  if (!g) return;
  const completed = !g.completed;
  try {
    await API('/api/goals/update', {sid:S.sid, id, progress: completed?100:g.progress, completed});
    g.completed = completed;
    if (completed) g.progress = 100;
    glRender();
    toast(completed ? 'Goal completed! 🎉' : 'Goal reopened');
  } catch(e) { toast('Update failed.'); }
}

async function glDelete(id) {
  if (!confirm('Delete this goal?')) return;
  try {
    await API('/api/goals/delete', {sid:S.sid, id});
    GL_GOALS = GL_GOALS.filter(x=>x.id!==id);
    glRender();
    toast('Goal deleted');
  } catch(e) { toast('Delete failed.'); }
}

// ═══════════════════════ DOCUMENT HUB ══════════════════════

const DH_KEY    = () => `sivarr_docs_${S.sid || 'guest'}`;
let   DH_ACTIVE = null;
let   DH_SAVE_TIMER = null;

function dhLoadDocs() {
  try { return JSON.parse(localStorage.getItem(DH_KEY()) || '[]'); }
  catch { return []; }
}
function dhSaveDocs(docs) { localStorage.setItem(DH_KEY(), JSON.stringify(docs)); }

function dhInit() {
  dhBackToList();
  dhRenderList();
}

function dhRenderList() {
  const docs = dhLoadDocs();
  const el   = $('dh-docs-list'); if (!el) return;
  if (!docs.length) {
    el.innerHTML = `<div style="text-align:center;padding:3rem 1rem;color:var(--muted)">
      <div style="font-size:2rem;margin-bottom:.5rem">📄</div>
      <div style="font-size:.85rem">No documents yet.<br>Create your first rich note.</div>
    </div>`; return;
  }
  el.innerHTML = docs.sort((a,b)=>b.updated-a.updated).map(d=>`
    <div class="dh-doc-item" onclick="dhOpenDoc('${d.id}')">
      <div style="font-size:1.1rem">📄</div>
      <div style="flex:1;overflow:hidden">
        <div class="dh-doc-title">${esc(d.title||'Untitled')}</div>
        <div class="dh-doc-date">${new Date(d.updated).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})}</div>
      </div>
      <button onclick="event.stopPropagation();dhDeleteDoc('${d.id}')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:.8rem;padding:4px;transition:color .15s" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--muted)'">🗑</button>
    </div>`).join('');
}

function dhNewDoc() {
  DH_ACTIVE = {id: Date.now().toString(36), title:'', content:'', updated: Date.now()};
  dhShowEditor();
  $('dh-doc-title-input').value = '';
  $('dh-editor').innerHTML = '';
  $('dh-doc-title-input').focus();
}

function dhOpenDoc(id) {
  const docs = dhLoadDocs();
  DH_ACTIVE  = docs.find(d=>d.id===id);
  if (!DH_ACTIVE) return;
  dhShowEditor();
  $('dh-doc-title-input').value = DH_ACTIVE.title || '';
  $('dh-editor').innerHTML      = DH_ACTIVE.content || '';
  dhUpdateWordCount();
}

function dhShowEditor() {
  $('dh-list-view').style.display   = 'none';
  $('dh-editor-view').style.display = 'flex';
  $('dh-save-status').textContent   = 'Saved';
  $('dh-save-status').style.color   = 'var(--green)';
}

function dhBackToList() {
  if (DH_ACTIVE) dhSaveDoc(true);
  $('dh-editor-view').style.display = 'none';
  $('dh-list-view').style.display   = 'block';
  DH_ACTIVE = null;
  dhRenderList();
}

function dhSaveDoc(silent = false) {
  if (!DH_ACTIVE) return;
  DH_ACTIVE.title   = $('dh-doc-title-input')?.value.trim() || 'Untitled';
  DH_ACTIVE.content = $('dh-editor')?.innerHTML || '';
  DH_ACTIVE.updated = Date.now();
  const docs  = dhLoadDocs();
  const idx   = docs.findIndex(d=>d.id===DH_ACTIVE.id);
  if (idx >= 0) docs[idx] = DH_ACTIVE;
  else docs.push(DH_ACTIVE);
  dhSaveDocs(docs);
  if (!silent) {
    toast('Document saved ✓');
    const st = $('dh-save-status');
    if (st) { st.textContent = 'Saved'; st.style.color = 'var(--green)'; }
  }
}

function dhAutoSave() {
  const st = $('dh-save-status');
  if (st) { st.textContent = 'Unsaved changes'; st.style.color = 'var(--yellow)'; }
  dhUpdateWordCount();
  clearTimeout(DH_SAVE_TIMER);
  DH_SAVE_TIMER = setTimeout(() => dhSaveDoc(true), 2000);
}

function dhUpdateWordCount() {
  const el = $('dh-editor'); if (!el) return;
  const words = el.innerText.trim().split(/\s+/).filter(Boolean).length;
  const wc    = $('dh-word-count'); if (wc) wc.textContent = `${words} word${words!==1?'s':''}`;
}

function dhFormat(cmd) { document.execCommand(cmd, false, null); $('dh-editor').focus(); }

function dhBlock(tag) {
  const editor = $('dh-editor'); if (!editor) return;
  const sel    = window.getSelection();
  if (!sel.rangeCount) return;
  const text   = sel.toString() || 'Heading';
  const el     = document.createElement(tag === 'blockquote' ? 'blockquote' : tag);
  el.textContent = text;
  const range  = sel.getRangeAt(0);
  range.deleteContents();
  range.insertNode(el);
  editor.focus();
  dhAutoSave();
}

function dhInsertCode() {
  const sel  = window.getSelection();
  const text = sel?.toString() || 'code';
  document.execCommand('insertHTML', false, `<code>${text}</code>`);
  $('dh-editor').focus();
  dhAutoSave();
}

async function dhAISuggest() {
  const content = $('dh-editor')?.innerText.trim();
  if (!content || content.length < 20) { toast('Write some content first for AI to suggest.'); return; }
  toast('AI is reading your doc... ✨');
  try {
    const r = await API('/api/chat', {
      sid: S.sid,
      message: `I'm writing a document. Here's what I have so far:\n\n"${content.slice(0,800)}"\n\nSuggest 2-3 improvements or additions I should make. Be specific and brief.`
    });
    const suggestion = document.createElement('blockquote');
    suggestion.style.cssText = 'border-left:3px solid var(--accent2);padding:.5rem .75rem;background:#7c3aed08;border-radius:0 6px 6px 0;margin:.5rem 0;font-size:.85rem;color:var(--muted)';
    suggestion.innerHTML = `<strong style="color:var(--accent2)">✨ AI Suggestion:</strong><br>${r.reply}`;
    $('dh-editor').appendChild(suggestion);
    dhAutoSave();
  } catch(e) { toast('AI suggestion failed — try again.'); }
}

function dhDeleteDoc(id) {
  if (!confirm('Delete this document?')) return;
  const docs = dhLoadDocs().filter(d=>d.id!==id);
  dhSaveDocs(docs);
  dhRenderList();
  toast('Document deleted');
  }
  // ═══════════════════════ STUDY PLAN ═════════════════════════

  function spLoadSaved() {
  const saved = localStorage.getItem(`sivarr_sp_${S.sid}`);
  if (!saved) return;
  try {
    const data = JSON.parse(saved);
    if (!data?.plan?.length) return;
    // Restore subject + date fields
    const subj = $('sp-subject'); if (subj) subj.value = data.subject || '';
    const dt   = $('sp-date');   if (dt)   dt.value   = data.exam_date || '';
    // Show countdown
    const countdown = $('sp-countdown');
    if (countdown && data.exam_date) {
      const daysLeft = Math.ceil((new Date(data.exam_date) - new Date()) / 86400000);
      if (daysLeft > 0) {
        countdown.style.display = 'flex';
        const dt2 = $('sp-days-text'); if (dt2) dt2.textContent = `${daysLeft} day${daysLeft!==1?'s':''} until your exam`;
        const el  = $('sp-exam-label'); if (el) el.textContent = `${data.subject} · ${new Date(data.exam_date).toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}`;
      }
    }
    renderStudyPlan(data);
    const btn = $('sp-btn'); if (btn) btn.textContent = '✨ Regenerate Plan';
  } catch(e) {}
  }

let SP_HOURS = 1;

function setSPHours(h, btn) {
  SP_HOURS = h;
  document.querySelectorAll('.sp-hrs-btn').forEach(b => b.classList.remove('sp-hrs-active'));
  if (btn) btn.classList.add('sp-hrs-active');
}

async function generateStudyPlan() {
  const subject = $('sp-subject')?.value.trim();
  const date    = $('sp-date')?.value;
  const err     = $('sp-err');
  const btn     = $('sp-btn');
  const result  = $('sp-result');
  const countdown = $('sp-countdown');

  err.textContent = '';

  if (!subject) { err.textContent = 'Please enter a subject or course.'; return; }
  if (!date)    { err.textContent = 'Please pick your exam date.'; return; }

  const today   = new Date(); today.setHours(0,0,0,0);
  const examDay = new Date(date);
  const daysLeft = Math.round((examDay - today) / 86400000);

  if (daysLeft < 1) { err.textContent = 'Exam date must be in the future.'; return; }

  // Show countdown
  countdown.style.display = 'flex';
  $('sp-days-text').textContent = `${daysLeft} day${daysLeft !== 1 ? 's' : ''} until your exam`;
  $('sp-exam-label').textContent = `${subject} · ${examDay.toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' })}`;

  btn.disabled = true;
  btn.textContent = '⏳ Generating your plan...';
  result.style.display = 'none';

  try {
    const res = await fetch('/api/studyplan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid: S.sid, subject, exam_date: date, hours_per_day: SP_HOURS })
    });

    if (!res.ok) {
      const e = await res.json();
      throw new Error(e.detail || 'Failed to generate plan.');
    }

    const data = await res.json();
    localStorage.setItem(`sivarr_sp_${S.sid}`, JSON.stringify(data));
    renderStudyPlan(data);

  } catch(e) {
    err.textContent = e.message || 'Something went wrong. Try again.';
    countdown.style.display = 'none';
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Regenerate Plan';
  }
}

function renderStudyPlan(data) {
  const result = $('sp-result');
  const plan   = data.plan || [];

  if (!plan.length) {
    result.innerHTML = '<p style="color:var(--muted);font-size:.85rem">Could not generate plan. Try again.</p>';
    result.style.display = 'block';
    return;
  }

  const saved = JSON.parse(localStorage.getItem(`sp_checks_${S.sid}`) || '{}');

  result.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem">
      <div style="font-family:var(--font);font-size:.85rem;font-weight:700;color:var(--text)">
        📅 ${plan.length}-Day Plan · ${data.subject}
      </div>
      <button onclick="downloadStudyPlan()" style="background:none;border:1px solid var(--border);border-radius:8px;padding:5px 12px;color:var(--muted);font-size:.72rem;cursor:pointer;font-family:var(--font);font-weight:700;transition:all .15s"
        onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'"
        onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--muted)'">
        ⬇ Export
      </button>
    </div>

    ${plan.map((day, di) => `
      <div class="sp-day-card" id="sp-day-${di}">
        <div class="sp-day-header">
          <span class="sp-day-num">Day ${day.day} · ${esc(day.date || '')}</span>
          <span class="sp-hours-badge">⏱ ${day.hours || SP_HOURS}h</span>
        </div>
        <div class="sp-day-focus">📖 ${esc(day.focus || '')}</div>
        <div>
          ${(day.tasks || []).map((task, ti) => {
            const key = `${di}_${ti}`;
            const done = saved[key] ? 'done' : '';
            return `
              <div class="sp-task">
                <div class="sp-task-check ${done}" onclick="toggleSPTask('${di}','${ti}',this)">
                  ${done ? '✓' : ''}
                </div>
                <span style="${done ? 'text-decoration:line-through;opacity:.5' : ''}" id="sp-task-text-${di}-${ti}">${esc(task)}</span>
              </div>`;
          }).join('')}
        </div>
      </div>
    `).join('')}

    <div style="background:linear-gradient(135deg,#22c55e10,transparent);border:1px solid #22c55e30;border-radius:12px;padding:.875rem;margin-top:.5rem;text-align:center">
      <div style="font-size:1.2rem;margin-bottom:4px">💪</div>
      <div style="font-family:var(--font);font-size:.82rem;font-weight:700;color:#22c55e">You've got this, ${S.name.split(' ')[0]}!</div>
      <div style="font-size:.72rem;color:var(--muted);margin-top:2px">Tick off tasks as you go. Sivarr's got your back 24/7.</div>
    </div>
  `;

  result.style.display = 'block';
  result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function toggleSPTask(di, ti, el) {
  const key   = `${di}_${ti}`;
  const saved = JSON.parse(localStorage.getItem(`sp_checks_${S.sid}`) || '{}');
  const done  = !saved[key];
  saved[key]  = done;
  localStorage.setItem(`sp_checks_${S.sid}`, JSON.stringify(saved));
  el.classList.toggle('done', done);
  el.textContent = done ? '✓' : '';
  const txt = $(`sp-task-text-${di}-${ti}`);
  if (txt) txt.style.cssText = done ? 'text-decoration:line-through;opacity:.5' : '';
}

function downloadStudyPlan() {
  const subject  = $('sp-subject')?.value.trim() || 'Study Plan';
  const cards    = document.querySelectorAll('.sp-day-card');
  let text = `SIVARR STUDY PLAN — ${subject.toUpperCase()}\n`;
  text += `Generated: ${new Date().toLocaleDateString()}\n`;
  text += '='.repeat(40) + '\n\n';
  cards.forEach(card => {
    const num   = card.querySelector('.sp-day-num')?.textContent || '';
    const focus = card.querySelector('.sp-day-focus')?.textContent || '';
    const tasks = [...card.querySelectorAll('.sp-task span')].map(t => `  • ${t.textContent.trim()}`).join('\n');
    text += `${num}\n${focus}\n${tasks}\n\n`;
  });
  const blob = new Blob([text], { type: 'text/plain' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `sivarr-studyplan-${subject.replace(/\s+/g,'-').toLowerCase()}.txt`;
  a.click();
}

  // ═══════════════════════ CONTENT HUB ════════════════════════

const CH_KEY = () => `sivarr_ch_${S.sid || 'guest'}`;
let CH_ACTIVE_PLATFORM = null;
let CH_PERIOD = 7;

const CH_PLATFORMS = {
  instagram: { name: 'Instagram', icon: '📸', color: '#e1306c' },
  tiktok:    { name: 'TikTok',    icon: '🎵', color: '#69c9d0' },
  youtube:   { name: 'YouTube',   icon: '▶️', color: '#ff0000' },
  twitter:   { name: 'X/Twitter', icon: '𝕏',  color: '#1da1f2' },
  linkedin:  { name: 'LinkedIn',  icon: '💼', color: '#0077b5' },
};

const CH_METRICS_DEF = [
  { key:'followers',     label:'Followers',       color:'#4f6ef7', icon:'👥' },
  { key:'followers_new', label:'New Followers',   color:'#22c55e', icon:'📈' },
  { key:'followers_lost',label:'Lost Followers',  color:'#ef4444', icon:'📉' },
  { key:'views',         label:'Views',           color:'#a78bfa', icon:'👁' },
  { key:'reach',         label:'Reach',           color:'#f59e0b', icon:'📡' },
  { key:'likes',         label:'Likes',           color:'#f472b6', icon:'❤️' },
  { key:'comments',      label:'Comments',        color:'#34d399', icon:'💬' },
  { key:'shares',        label:'Shares',          color:'#60a5fa', icon:'🔁' },
  { key:'saves',         label:'Saves',           color:'#fb923c', icon:'🔖' },
];

function chLoadData() {
  try { return JSON.parse(localStorage.getItem(CH_KEY()) || '{}'); }
  catch { return {}; }
}
function chSaveData(d) { localStorage.setItem(CH_KEY(), JSON.stringify(d)); }

function chInit() {
  const data = chLoadData();
  const connected = Object.keys(data.platforms || {});
  if (connected.length === 0) {
    $('ch-connect-screen').style.display = 'block';
    $('ch-dashboard').style.display = 'none';
  } else {
    $('ch-connect-screen').style.display = 'none';
    $('ch-dashboard').style.display = 'block';
    CH_ACTIVE_PLATFORM = CH_ACTIVE_PLATFORM || connected[0];
    chRenderTabs(connected);
    chRenderDashboard();
  }
  // Sync badge states
  connected.forEach(p => {
    const badge = $(`ch-badge-${p}`);
    if (badge) { badge.textContent = 'Connected ✓'; badge.closest('button')?.classList.add('connected'); }
  });
}

function chShowConnect() {
  $('ch-connect-screen').style.display = 'block';
  $('ch-dashboard').style.display = 'none';
}

function chConnect(platform) {
  const data = chLoadData();
  data.platforms = data.platforms || {};

  // Generate realistic mock data for demo
  const base = { instagram:12400, tiktok:8200, youtube:3100, twitter:5600, linkedin:2800 };
  const b = base[platform] || 5000;
  const days = 30;
  const mkSeries = (base, variance) => Array.from({length:days}, (_,i) =>
    Math.max(0, Math.round(base + (Math.random()-0.48) * variance + i * (Math.random()*2-0.5)))
  );

  data.platforms[platform] = {
    connected_at: new Date().toISOString(),
    metrics: {
      followers:      mkSeries(b, b*0.02),
      followers_new:  mkSeries(Math.round(b*0.003), 20),
      followers_lost: mkSeries(Math.round(b*0.001), 8),
      views:          mkSeries(b*4, b*0.8),
      reach:          mkSeries(b*2.5, b*0.5),
      likes:          mkSeries(b*0.08, b*0.02),
      comments:       mkSeries(Math.round(b*0.012), 15),
      shares:         mkSeries(Math.round(b*0.008), 10),
      saves:          mkSeries(Math.round(b*0.015), 12),
    }
  };
  chSaveData(data);

  const badge = $(`ch-badge-${platform}`);
  if (badge) { badge.textContent = 'Connected ✓'; badge.closest('button')?.classList.add('connected'); }
  toast(`${CH_PLATFORMS[platform]?.name} connected! 🎉`);

  CH_ACTIVE_PLATFORM = platform;
  setTimeout(() => chInit(), 400);
}

function chDisconnect() {
  if (!CH_ACTIVE_PLATFORM) return;
  const data = chLoadData();
  delete (data.platforms || {})[CH_ACTIVE_PLATFORM];
  chSaveData(data);
  const badge = $(`ch-badge-${CH_ACTIVE_PLATFORM}`);
  if (badge) { badge.textContent = 'Connect'; badge.closest('button')?.classList.remove('connected'); }
  toast(`Disconnected.`);
  CH_ACTIVE_PLATFORM = null;
  chInit();
}

function chSetPeriod(days, btn) {
  CH_PERIOD = days;
  document.querySelectorAll('#ch-period-tabs .ch-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  chRenderDashboard();
}

function chRenderTabs(connected) {
  const tabs = $('ch-platform-tabs');
  if (!tabs) return;
  tabs.innerHTML = connected.map(p => {
    const pl = CH_PLATFORMS[p] || { name: p, icon: '📊' };
    return `<button class="ch-tab ${p === CH_ACTIVE_PLATFORM ? 'active' : ''}"
      onclick="chSwitchPlatform('${p}',this)">${pl.icon} ${pl.name}</button>`;
  }).join('');
}

function chSwitchPlatform(p, btn) {
  CH_ACTIVE_PLATFORM = p;
  document.querySelectorAll('#ch-platform-tabs .ch-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  chRenderDashboard();
}

function chRenderDashboard() {
  const data = chLoadData();
  const pdata = data.platforms?.[CH_ACTIVE_PLATFORM];
  if (!pdata) return;

  const metrics = pdata.metrics;
  const period  = CH_PERIOD;
  const grid    = $('ch-metrics-grid');
  if (!grid) return;

  // Slice to period
  const slice = obj => Object.fromEntries(
    Object.entries(obj).map(([k,v]) => [k, v.slice(-period)])
  );
  const m = slice(metrics);

  // Compute stats: current = last value, prev = value period ago
  const stat = (arr) => {
    const cur  = arr[arr.length - 1] || 0;
    const prev = arr[0] || 0;
    const delta = cur - prev;
    const pct   = prev ? ((delta / prev) * 100).toFixed(1) : '0.0';
    return { cur, delta, pct };
  };

  const fmt = n => n >= 1000000 ? (n/1000000).toFixed(1)+'M' : n >= 1000 ? (n/1000).toFixed(1)+'K' : n;

  // Render metric cards
  grid.innerHTML = CH_METRICS_DEF.map(def => {
    const s    = stat(m[def.key] || [0]);
    const up   = s.delta >= 0;
    const arrow = up ? '▲' : '▼';
    const cls   = s.delta === 0 ? 'flat' : up ? 'up' : 'down';
    return `
      <div class="ch-metric-card" style="--ch-color:${def.color}">
        <div class="ch-metric-label">${def.icon} ${def.label}</div>
        <div class="ch-metric-val">${fmt(s.cur)}</div>
        <div class="ch-metric-delta ${cls}">${arrow} ${fmt(Math.abs(s.delta))} (${s.pct}%)</div>
      </div>`;
  }).join('');

  // Engagement rate
  const totalFollowers = (m.followers || [0]).at(-1) || 1;
  const totalInteractions = ((m.likes||[0]).at(-1)||0) + ((m.comments||[0]).at(-1)||0) + ((m.shares||[0]).at(-1)||0);
  const engRate = ((totalInteractions / totalFollowers) * 100).toFixed(2);
  const engEl = $('ch-eng-val'); if (engEl) engEl.textContent = engRate + '%';
  const engFill = $('ch-eng-fill'); if (engFill) engFill.style.width = Math.min(parseFloat(engRate)*10, 100) + '%';

  // Sparkline for views
  chDrawSparkline(m.views || [], '#4f6ef7');
  const lbl = $('ch-chart-label'); if (lbl) lbl.textContent = '👁 Views — Last ' + period + ' days';

  // AI Insight
  chGenerateInsight(m, engRate, CH_ACTIVE_PLATFORM);
}

function chDrawSparkline(data, color) {
  const svg = $('ch-chart-svg');
  if (!svg || !data.length) return;
  const W = 300, H = 60, pad = 4;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (W - pad*2);
    const y = H - pad - ((v - min) / range) * (H - pad*2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const areaClose = `${W-pad},${H} ${pad},${H}`;
  svg.innerHTML = `
    <defs>
      <linearGradient id="ch-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <polygon points="${pts.join(' ')} ${areaClose}" fill="url(#ch-grad)"/>
    <polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.8"
      stroke-linecap="round" stroke-linejoin="round"/>
    ${pts.map((p, i) => i === pts.length-1 ?
      `<circle cx="${p.split(',')[0]}" cy="${p.split(',')[1]}" r="3" fill="${color}"/>` : ''
    ).join('')}`;
}

function chGenerateInsight(m, engRate, platform) {
  const insight = $('ch-insight');
  const txt     = $('ch-insight-text');
  if (!insight || !txt) return;

  const pName    = CH_PLATFORMS[platform]?.name || platform;
  const eng      = parseFloat(engRate);
  const views    = (m.views || [0]).at(-1) || 0;
  const newFolls = (m.followers_new || [0]).reduce((a,b) => a+b, 0);
  const comments = (m.comments || [0]).reduce((a,b) => a+b, 0);

  let msg = '';
  if (eng > 5)       msg = `🔥 Your ${pName} engagement rate of ${engRate}% is above average — your audience is highly active. Keep posting consistently to maintain momentum.`;
  else if (eng > 3)  msg = `✅ Solid engagement at ${engRate}% on ${pName}. Focus on replies and saves to push past 5% — that's when the algorithm rewards you most.`;
  else if (eng < 1)  msg = `📉 Your engagement on ${pName} is below 1%. Try shorter content, stronger CTAs, and posting at peak hours (6–9pm local time).`;
  else               msg = `📊 Your ${pName} stats look steady. You gained ${newFolls.toLocaleString()} new followers this period. ${comments > 50 ? 'Great comment engagement!' : 'Try ending posts with a question to boost comments.'}`;

  txt.textContent = msg;
  insight.style.display = 'block';
}

// ═══════════════════════ CREATE NEW ═════════════════════════

function cnOpen() {
  $('cn-modal-bg').classList.add('open');
}
function cnClose(e) {
  if (e.target === $('cn-modal-bg')) $('cn-modal-bg').classList.remove('open');
}
function cnAction(type) {
  $('cn-modal-bg').classList.remove('open');
  setTimeout(() => {
    if (type === 'note') {
      nav('notes', null);
      setTimeout(() => {
        const ta = $('new-note-text'); if (ta) { ta.focus(); ta.scrollIntoView({behavior:'smooth'}); }
      }, 300);
    } else if (type === 'task') {
      nav('flux', null);
      setTimeout(() => {
        const btn = document.querySelector('.sh-add-btn, [onclick*="showAddTask"], [onclick*="openTaskModal"]');
        if (btn) btn.click();
      }, 300);
    } else if (type === 'studyplan') {
      snavSelect('studyplan', 'planner', null);
      setTimeout(() => {
        const el = $('sp-subject'); if (el) el.focus();
      }, 350);
    } else if (type === 'quiz') {
      nav('quiz', null);
      setTimeout(() => {
        const ti = $('quiz-topic-input'); if (ti) ti.focus();
      }, 300);
    } else if (type === 'studydeck') {
      nav('lab', null);
      setTimeout(() => {
        const el = $('lab-file-input-p'); if (el) el.click();
      }, 350);
    } else if (type === 'ask') {
      nav('chat', null);
      setTimeout(() => {
        const ci = $('ci'); if (ci) ci.focus();
      }, 300);
    }
  }, 250);
}

// ═══════════════════════ SETTINGS ═════════════════════════

const ST_KEY = () => `sivarr_st_${S.sid || 'guest'}`;

function stLoad() {
  return JSON.parse(localStorage.getItem(ST_KEY()) || '{}');
}
function stSave(data) {
  localStorage.setItem(ST_KEY(), JSON.stringify(data));
}

function stInit() {
  // Populate profile fields
  const st = stLoad();
  const nameEl   = $('st-name-input');
  const emailEl  = $('st-email-input');
  const phoneEl  = $('st-phone-input');
  const avatarL  = $('st-avatar-letter');
  const nameDisp = $('st-name-display');
  const matDisp  = $('st-matric-display');

  if (nameEl)   nameEl.value   = S.name || '';
  if (emailEl)  emailEl.value  = st.email || '';
  if (phoneEl)  phoneEl.value  = st.phone || '';
  if (avatarL)  avatarL.textContent = S.name ? S.name[0].toUpperCase() : '?';
  if (nameDisp) nameDisp.textContent = S.name || '';
  if (matDisp)  matDisp.textContent  = S.matric || '';

  // Load profile pic into settings avatar
  const saved = localStorage.getItem(`sivarr_pfp_${S.sid}`);
  if (saved) {
    const av = $('st-avatar');
    if (av) { av.style.backgroundImage = `url(${saved})`; av.style.backgroundSize = 'cover'; $('st-avatar-letter').style.display = 'none'; }
  }

  // Theme toggle
  const themeToggle = $('st-theme-toggle');
  if (themeToggle) {
    const isDark = !document.body.classList.contains('light');
    if (isDark) themeToggle.classList.add('on');
    else themeToggle.classList.remove('on');
  }

  // Notification toggles
  ['ann','streak','quiz'].forEach(key => {
    const el = $(`st-notif-${key}`);
    if (el) {
      const val = localStorage.getItem(`sivarr_notif_${key}`);
      if (val === 'off') el.classList.remove('on');
      else el.classList.add('on');
    }
  });

  // Accent colour — restore saved
  const savedAccent = localStorage.getItem('sivarr_accent');
  if (savedAccent) {
    document.querySelectorAll('.st-accent-dot').forEach(d => {
      d.classList.toggle('sel', d.style.background === savedAccent);
    });
  }

  // Usage bars
  stUpdateUsage();
}

function stUpdateUsage() {
  const today = new Date().toISOString().split('T')[0];
  const hist  = JSON.parse(localStorage.getItem(`sivarr_usage_${today}`) || '{"chat":0,"quiz":0}');
  const chatUsed = hist.chat || 0;
  const quizUsed = hist.quiz || 0;
  const chatMax  = S.plan === 'pro' ? 999 : 20;
  const quizMax  = S.plan === 'pro' ? 999 : 5;

  const cu = $('st-usage-chat');    if (cu) cu.textContent = `${chatUsed} / ${chatMax}`;
  const cb = $('st-usage-chat-bar');if (cb) cb.style.width = Math.min((chatUsed/chatMax)*100,100) + '%';
  const qu = $('st-usage-quiz');    if (qu) qu.textContent = `${quizUsed} / ${quizMax}`;
  const qb = $('st-usage-quiz-bar');if (qb) qb.style.width = Math.min((quizUsed/quizMax)*100,100) + '%';

  const badge = $('st-plan-badge');
  if (badge) {
    badge.textContent = S.plan === 'pro' ? '⚡ Pro' : '✦ Free';
    badge.className   = `st-plan-badge ${S.plan === 'pro' ? 'st-plan-pro' : 'st-plan-free'}`;
  }
}

function stSaveProfile() {
  const name  = $('st-name-input')?.value.trim();
  const email = $('st-email-input')?.value.trim();
  const phone = $('st-phone-input')?.value.trim();

  if (!name || name.length < 2) { toast('Name must be at least 2 characters.'); return; }

  const st = stLoad();
  st.email = email;
  st.phone = phone;
  stSave(st);

  S.name = name;
  const nameDisp = $('st-name-display'); if (nameDisp) nameDisp.textContent = name;
  const avatarL  = $('st-avatar-letter'); if (avatarL) avatarL.textContent = name[0].toUpperCase();
  const tbAv   = $('tb-av');   if (tbAv)   tbAv.textContent   = name[0].toUpperCase();
  const tbName = $('tb-name'); if (tbName) tbName.textContent = name;

  toast('Profile saved ✓');
}

function stToggleTheme(btn) {
  btn.classList.toggle('on');
  toggleThemeFromMenu();
}

function stToggleNotif(btn, key) {
  btn.classList.toggle('on');
  localStorage.setItem(`sivarr_notif_${key}`, btn.classList.contains('on') ? 'on' : 'off');
  toast(`${btn.classList.contains('on') ? 'Enabled' : 'Disabled'} notifications`);
}

function stSetAccent(color, color2, el) {
  document.querySelectorAll('.st-accent-dot').forEach(d => d.classList.remove('sel'));
  el.classList.add('sel');
  document.documentElement.style.setProperty('--accent',  color);
  document.documentElement.style.setProperty('--accent2', color2);
  localStorage.setItem('sivarr_accent',  color);
  localStorage.setItem('sivarr_accent2', color2);
  toast('Accent colour updated ✓');
}

function stChangePassword() {
  const pw  = $('st-pw-input')?.value;
  const pw2 = $('st-pw2-input')?.value;
  if (!pw || pw.length < 6) { toast('Password must be at least 6 characters.'); return; }
  if (pw !== pw2)            { toast('Passwords do not match.'); return; }
  toast('Password update coming soon — backend integration needed. 🔧');
}

function stLogoutAll() {
  if (!confirm('Sign out of all devices?')) return;
  clearSession();
  location.reload();
}

function stExportData() {
  const data = {
    name:    S.name,
    matric:  S.matric,
    stats:   S.stats,
    topics:  S.topics,
    exported: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `sivarr-data-${S.matric || 'export'}.json`;
  a.click();
  toast('Data exported ✓');
}

async function stClearChat() {
  if (!confirm('Clear all chat history? This cannot be undone.')) return;
  try {
    await fetch('/api/clear-history', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({sid: S.sid})
    });
  } catch(e) {}
  toast('Chat history cleared ✓');
}

async function stClearWrong() {
  if (!confirm('Clear revision list?')) return;
  try { await API('/api/wrong/clear', {sid: S.sid, idx: 'all'}); } catch(e) {}
  toast('Revision list cleared ✓');
}

async function stResetProgress() {
  if (!confirm('⚠️ Reset ALL progress? This cannot be undone.')) return;
  if (!confirm('Are you absolutely sure? All stats, topics and quiz history will be deleted.')) return;
  try {
    await fetch('/api/reset-progress', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({sid: S.sid})
    });
    toast('Progress reset. Reloading...');
    setTimeout(() => { clearSession(); location.reload(); }, 1500);
  } catch(e) { toast('Reset failed — try again.'); }
}

// Restore accent on load
(function() {
  const a  = localStorage.getItem('sivarr_accent');
  const a2 = localStorage.getItem('sivarr_accent2');
  if (a)  document.documentElement.style.setProperty('--accent',  a);
  if (a2) document.documentElement.style.setProperty('--accent2', a2);
})();

  // ═══════════════════ LEARNING HUB ══════════════════════════

const LH_COURSES = [
  // STEM
  { id:'lh01', title:'Calculus Fundamentals', author:'Dr. Adebayo', emoji:'📐', color:'#4f6ef7', cat:'stem', level:'Beginner', rating:4.8, students:3241, lessons:24, desc:'Master differentiation, integration and applications.' },
  { id:'lh02', title:'Statistics & Probability', author:'Prof. Okonkwo', emoji:'📊', color:'#7c3aed', cat:'stem', level:'Intermediate', rating:4.7, students:2180, lessons:20, desc:'Data analysis and probability from first principles.' },
  { id:'lh03', title:'Physics: Mechanics', author:'Dr. Emeka', emoji:'⚙️', color:'#06b6d4', cat:'stem', level:'Intermediate', rating:4.6, students:1890, lessons:18, desc:'Forces, motion, energy and waves.' },
  { id:'lh04', title:'Organic Chemistry', author:'Dr. Nwosu', emoji:'🧪', color:'#22c55e', cat:'stem', level:'Advanced', rating:4.5, students:1420, lessons:22, desc:'Reactions, mechanisms and lab techniques.' },
  // Tech
  { id:'lh05', title:'Python for Beginners', author:'Chinedu Dev', emoji:'🐍', color:'#f59e0b', cat:'tech', level:'Beginner', rating:4.9, students:5210, lessons:30, desc:'Learn programming from zero with Python.' },
  { id:'lh06', title:'Web Development Bootcamp', author:'Sarah Afolabi', emoji:'💻', color:'#ef4444', cat:'tech', level:'Beginner', rating:4.8, students:4320, lessons:36, desc:'HTML, CSS, JavaScript and React fundamentals.' },
  { id:'lh07', title:'Data Science Essentials', author:'Dr. Mensah', emoji:'🤖', color:'#8b5cf6', cat:'tech', level:'Intermediate', rating:4.7, students:2890, lessons:28, desc:'Data wrangling, ML and visualization.' },
  { id:'lh08', title:'Cybersecurity Basics', author:'Tobi Secure', emoji:'🔐', color:'#64748b', cat:'tech', level:'Beginner', rating:4.6, students:1760, lessons:16, desc:'Stay safe online and understand threats.' },
  // Business
  { id:'lh09', title:'Entrepreneurship 101', author:'Amara Chukwu', emoji:'🚀', color:'#f472b6', cat:'business', level:'Beginner', rating:4.8, students:3890, lessons:20, desc:'From idea to product to paying customers.' },
  { id:'lh10', title:'Financial Accounting', author:'Prof. Adeleke', emoji:'💰', color:'#22c55e', cat:'business', level:'Intermediate', rating:4.6, students:2340, lessons:24, desc:'Balance sheets, P&L and financial statements.' },
  { id:'lh11', title:'Marketing Strategy', author:'Ngozi Brands', emoji:'📣', color:'#f59e0b', cat:'business', level:'Beginner', rating:4.7, students:2890, lessons:18, desc:'Digital, content and growth marketing.' },
  // Design
  { id:'lh12', title:'UI/UX Design Fundamentals', author:'Temi Creates', emoji:'🎨', color:'#ec4899', cat:'design', level:'Beginner', rating:4.9, students:4120, lessons:22, desc:'Figma, wireframing, user research and prototyping.' },
  { id:'lh13', title:'Graphic Design Masterclass', author:'Kofi Art', emoji:'✏️', color:'#a78bfa', cat:'design', level:'Beginner', rating:4.7, students:3210, lessons:26, desc:'Typography, colour theory and branding.' },
  // Languages
  { id:'lh14', title:'French for Beginners', emoji:'🇫🇷', color:'#3b82f6', cat:'languages', author:'Marie Dupont', level:'Beginner', rating:4.6, students:1980, lessons:30, desc:'Speak French confidently in 30 lessons.' },
  { id:'lh15', title:'Yoruba Language & Culture', emoji:'🌍', color:'#22c55e', cat:'languages', author:'Baba Akin', level:'Beginner', rating:4.8, students:1240, lessons:20, desc:'Greetings, grammar and everyday conversation.' },
  // Arts
  { id:'lh16', title:'Creative Writing Workshop', emoji:'📝', color:'#f97316', cat:'arts', author:'Chinua Jr.', level:'Beginner', rating:4.7, students:2100, lessons:16, desc:'Fiction, essays and finding your voice.' },
];

let LH_CAT      = 'all';
let LH_ENROLLED = [];

async function lhInit() {
  try {
    const r = await fetch(`/api/learning-hub/enrolled?sid=${S.sid}`);
    const d = await r.json();
    LH_ENROLLED = d.enrolled || [];
  } catch(e) { LH_ENROLLED = JSON.parse(localStorage.getItem(`lh_enrolled_${S.sid}`) || '[]'); }
  lhRender();
}

function lhSetCat(cat, btn) {
  LH_CAT = cat;
  document.querySelectorAll('.lh-filter').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  lhRender();
}

function lhFilter() {
  lhRender($('lh-search')?.value.trim().toLowerCase());
}

function lhRender(search = '') {
  const grid    = $('lh-grid'); if (!grid) return;
  const contSec = $('lh-continue-section');
  const contList= $('lh-continue-list');
  const label   = $('lh-section-label');
  const count   = $('lh-count');

  let courses = LH_CAT === 'all' ? LH_COURSES : LH_COURSES.filter(c => c.cat === LH_CAT);
  if (search) courses = courses.filter(c =>
    c.title.toLowerCase().includes(search) || c.author.toLowerCase().includes(search) || c.cat.includes(search)
  );

  // Continue learning — enrolled courses
  const enrolled = courses.filter(c => LH_ENROLLED.includes(c.id));
  if (enrolled.length && !search) {
    contSec.style.display = 'block';
    contList.innerHTML = enrolled.slice(0,2).map(c => {
      const prog = parseInt(localStorage.getItem(`lh_prog_${S.sid}_${c.id}`) || '0');
      return `
        <div class="lh-continue-card" onclick="lhOpenCourse('${c.id}')">
          <div class="lh-continue-icon" style="background:${c.color}22">${c.emoji}</div>
          <div style="flex:1;min-width:0">
            <div style="font-family:var(--font);font-size:.85rem;font-weight:700;margin-bottom:2px">${esc(c.title)}</div>
            <div style="font-size:.7rem;color:var(--muted);margin-bottom:5px">by ${esc(c.author)} · ${c.lessons} lessons</div>
            <div class="lh-continue-prog"><div class="lh-continue-fill" style="width:${prog}%"></div></div>
            <div style="font-size:.68rem;color:var(--muted);margin-top:3px">${prog}% complete</div>
          </div>
        </div>`;
    }).join('');
  } else { contSec.style.display = 'none'; }

  // Grid
  const notEnrolled = courses.filter(c => !LH_ENROLLED.includes(c.id));
  const display     = search ? courses : notEnrolled;
  if (label) label.textContent = search ? `Results for "${search}"` : LH_CAT === 'all' ? 'Recommended for You' : LH_CAT.charAt(0).toUpperCase()+LH_CAT.slice(1);
  if (count) count.textContent = `${display.length} course${display.length!==1?'s':''}`;

  if (!display.length) {
    grid.innerHTML = `<div style="grid-column:span 2;text-align:center;padding:2rem;color:var(--muted)">
      <div style="font-size:2rem;margin-bottom:.5rem">🔍</div>
      <div style="font-size:.85rem">No courses found.</div>
    </div>`; return;
  }

  const badgeCls = { Beginner:'lh-badge-beginner', Intermediate:'lh-badge-intermediate', Advanced:'lh-badge-advanced' };
  grid.innerHTML = display.map(c => `
    <div class="lh-course-card" onclick="lhOpenCourse('${c.id}')">
      <div class="lh-course-thumb" style="background:${c.color}18">
        ${c.emoji ? `<span style="font-size:2.5rem">${c.emoji}</span>` : ''}
        <span class="lh-course-badge ${badgeCls[c.level]||''}">${c.level}</span>
      </div>
      <div class="lh-course-body">
        <div class="lh-course-title">${esc(c.title)}</div>
        <div class="lh-course-author">by ${esc(c.author)}</div>
        <div class="lh-course-meta">
          <span class="lh-rating">★ ${c.rating} · ${(c.students/1000).toFixed(1)}k</span>
          ${LH_ENROLLED.includes(c.id) ? '<span class="lh-enrolled-badge">✓ Enrolled</span>' : `<span style="font-size:.7rem;color:var(--muted)">${c.lessons} lessons</span>`}
        </div>
      </div>
    </div>`).join('');
}

function lhOpenCourse(id) {
  const c = LH_COURSES.find(x=>x.id===id); if (!c) return;
  const enrolled = LH_ENROLLED.includes(id);
  const prog     = parseInt(localStorage.getItem(`lh_prog_${S.sid}_${id}`) || '0');

  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:200;display:flex;align-items:flex-end;justify-content:center;backdrop-filter:blur(6px);animation:fadeUp .2s ease';
  modal.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:20px 20px 0 0;width:100%;max-width:520px;padding:1.5rem 1.25rem 2.5rem;max-height:85vh;overflow-y:auto">
      <div style="width:36px;height:4px;background:var(--border2);border-radius:2px;margin:0 auto 1.25rem"></div>
      <div style="display:flex;gap:14px;align-items:flex-start;margin-bottom:1rem">
        <div style="width:56px;height:56px;border-radius:12px;background:${c.color}22;display:flex;align-items:center;justify-content:center;font-size:1.75rem;flex-shrink:0">${c.emoji}</div>
        <div>
          <div style="font-family:var(--font);font-size:1rem;font-weight:800;letter-spacing:-.02em">${esc(c.title)}</div>
          <div style="font-size:.75rem;color:var(--muted);margin-top:2px">by ${esc(c.author)}</div>
          <div style="display:flex;gap:8px;margin-top:5px;flex-wrap:wrap">
            <span style="font-size:.68rem;color:var(--yellow);font-weight:700">★ ${c.rating}</span>
            <span style="font-size:.68rem;color:var(--muted)">${c.lessons} lessons</span>
            <span style="font-size:.68rem;color:var(--muted)">${c.students.toLocaleString()} students</span>
          </div>
        </div>
      </div>
      <p style="font-size:.82rem;color:var(--muted);line-height:1.6;margin-bottom:1rem">${esc(c.desc)}</p>
      ${enrolled ? `
        <div style="margin-bottom:1rem">
          <div style="display:flex;justify-content:space-between;margin-bottom:4px">
            <span style="font-size:.75rem;color:var(--muted)">Your progress</span>
            <span style="font-size:.75rem;font-weight:700;color:var(--accent)">${prog}%</span>
          </div>
          <div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden">
            <div style="height:100%;width:${prog}%;background:linear-gradient(90deg,var(--accent),var(--accent2));border-radius:3px"></div>
          </div>
        </div>
        <div style="display:flex;gap:8px">
          <button onclick="lhUpdateProgress('${id}');this.closest('[style*=fixed]').remove()" style="flex:1;padding:11px;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--accent2));border:none;color:#fff;font-family:var(--font);font-size:.85rem;font-weight:700;cursor:pointer">
            📈 Update Progress
          </button>
          <button onclick="lhUnenroll('${id}');this.closest('[style*=fixed]').remove()" style="padding:11px 14px;border-radius:10px;background:none;border:1px solid var(--border);color:var(--muted);font-family:var(--font);font-size:.82rem;font-weight:700;cursor:pointer">
            Leave
          </button>
        </div>` : `
        <button onclick="lhEnroll('${id}');this.closest('[style*=fixed]').remove()" style="width:100%;padding:12px;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--accent2));border:none;color:#fff;font-family:var(--font);font-size:.88rem;font-weight:700;cursor:pointer">
          ✦ Enroll — Free
        </button>`}
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });
}

async function lhEnroll(id) {
  LH_ENROLLED.push(id);
  localStorage.setItem(`lh_enrolled_${S.sid}`, JSON.stringify(LH_ENROLLED));
  try { await API('/api/learning-hub/enroll', {sid:S.sid, course_id:id}); } catch(e) {}
  lhRender();
  toast('Enrolled! 🎉 Start learning');
}

function lhUnenroll(id) {
  LH_ENROLLED = LH_ENROLLED.filter(x=>x!==id);
  localStorage.setItem(`lh_enrolled_${S.sid}`, JSON.stringify(LH_ENROLLED));
  lhRender();
  toast('Unenrolled');
}

function lhUpdateProgress(id) {
  const val = prompt('Your progress (0-100%):');
  if (val === null) return;
  const pct = Math.min(Math.max(parseInt(val)||0, 0), 100);
  localStorage.setItem(`lh_prog_${S.sid}_${id}`, pct);
  lhRender();
  if (pct >= 100) toast('Course completed! 🏆');
  else toast(`Progress updated to ${pct}% ✓`);
}

// ═══════════════════════ VOICE INPUT ════════════════════════

let VOICE_ACTIVE = false;
let VOICE_REC    = null;

function voiceInit() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { toast('Voice input not supported on this browser.'); return null; }
  const rec        = new SpeechRecognition();
  rec.continuous   = false;
  rec.interimResults= true;
  rec.lang         = 'en-NG';
  return rec;
}

function toggleVoice() {
  if (VOICE_ACTIVE) {
    VOICE_REC?.stop();
    VOICE_ACTIVE = false;
    updateVoiceBtn(false);
    return;
  }
  VOICE_REC = voiceInit();
  if (!VOICE_REC) return;
  VOICE_ACTIVE = true;
  updateVoiceBtn(true);
  toast('Listening... 🎤');

  VOICE_REC.onresult = (e) => {
    const transcript = Array.from(e.results).map(r=>r[0].transcript).join('');
    const ci = $('ci'); if (ci) ci.value = transcript;
  };
  VOICE_REC.onend = () => {
    VOICE_ACTIVE = false;
    updateVoiceBtn(false);
    const ci = $('ci');
    if (ci && ci.value.trim()) {
      toast('Got it — sending... ✓');
      setTimeout(() => send(), 500);
    }
  };
  VOICE_REC.onerror = (e) => {
    VOICE_ACTIVE = false;
    updateVoiceBtn(false);
    toast(e.error === 'not-allowed' ? 'Microphone permission denied.' : 'Voice error — try again.');
  };
  VOICE_REC.start();
}

function updateVoiceBtn(active) {
  const btn = $('voice-btn');
  if (!btn) return;
  btn.textContent = active ? '🔴' : '🎤';
  btn.style.color  = active ? 'var(--red)' : 'var(--muted)';
  btn.style.borderColor = active ? 'var(--red)' : 'var(--border)';
  if (active) btn.style.animation = 'pulse 1s infinite';
  else btn.style.animation = '';
}

// ═════════════════════ STUDY GROUPS ════════════════════════

let SG_ACTIVE   = null;
let SG_INTERVAL = null;

async function sgInit() {
  await sgLoadRooms();
}

async function sgLoadRooms() {
  try {
    const r = await fetch(`/api/group/list?sid=${S.sid}`);
    const d = await r.json();
    sgRenderRooms(d.groups || []);
  } catch(e) { sgRenderRooms([]); }
}

function sgRenderRooms(groups) {
  const el = $('sg-rooms-list'); if (!el) return;
  if (!groups.length) {
    el.innerHTML = `<div style="text-align:center;padding:3rem 1rem;color:var(--muted)">
      <div style="font-size:2rem;margin-bottom:.5rem">👥</div>
      <div style="font-size:.85rem">No groups yet.<br>Create or join one to start studying together.</div>
    </div>`; return;
  }
  el.innerHTML = groups.map(g => `
    <div class="sg-room" onclick="sgOpenChat('${g.id}','${esc(g.name)}')">
      <div class="sg-room-av">${g.name[0].toUpperCase()}</div>
      <div style="flex:1;min-width:0">
        <div class="sg-room-name">${esc(g.name)}</div>
        <div class="sg-room-meta">${g.members?.length||1} member${(g.members?.length||1)!==1?'s':''} · Tap to open</div>
      </div>
      <div style="font-size:.7rem;color:var(--muted)">→</div>
    </div>`).join('');
}

function sgShowCreate() {
  $('sg-create-form').style.display = $('sg-create-form').style.display==='none' ? 'block' : 'none';
  $('sg-join-form').style.display   = 'none';
  $('sg-name-input')?.focus();
}
function sgShowJoin() {
  $('sg-join-form').style.display   = $('sg-join-form').style.display==='none' ? 'block' : 'none';
  $('sg-create-form').style.display = 'none';
  $('sg-join-input')?.focus();
}

async function sgCreate() {
  const name = $('sg-name-input')?.value.trim();
  if (!name) { toast('Enter a group name.'); return; }
  try {
    await API('/api/group/create', {sid:S.sid, name});
    $('sg-create-form').style.display = 'none';
    $('sg-name-input').value = '';
    toast(`Group "${name}" created! Share your ID with friends.`);
    sgLoadRooms();
  } catch(e) { toast('Could not create group.'); }
}

async function sgJoin() {
  const gid = $('sg-join-input')?.value.trim();
  if (!gid) { toast('Paste a group ID.'); return; }
  try {
    await API('/api/group/join', {sid:S.sid, group_id:gid});
    $('sg-join-form').style.display = 'none';
    $('sg-join-input').value = '';
    toast('Joined group! 🎉');
    sgLoadRooms();
  } catch(e) { toast('Invalid group ID or already a member.'); }
}

function sgOpenChat(gid, gname) {
  SG_ACTIVE = {id:gid, name:gname};
  $('sg-list-view').style.display = 'none';
  $('sg-chat-view').style.display = 'flex';
  const av = $('sg-chat-av'); if (av) av.textContent = gname[0].toUpperCase();
  const nm = $('sg-chat-name'); if (nm) nm.textContent = gname;
  const id = $('sg-chat-id'); if (id) id.textContent = `ID: ${gid}`;
  sgLoadMessages();
  clearInterval(SG_INTERVAL);
  SG_INTERVAL = setInterval(sgLoadMessages, 4000);
}

function sgBackToList() {
  clearInterval(SG_INTERVAL);
  SG_ACTIVE = null;
  $('sg-chat-view').style.display = 'none';
  $('sg-list-view').style.display = 'block';
  sgLoadRooms();
}

function sgCopyId() {
  if (!SG_ACTIVE) return;
  navigator.clipboard.writeText(SG_ACTIVE.id).then(()=>toast('Group ID copied ✓'));
}

async function sgLoadMessages() {
  if (!SG_ACTIVE) return;
  try {
    const r = await fetch(`/api/group/messages?group_id=${SG_ACTIVE.id}&sid=${S.sid}`);
    const d = await r.json();
    sgRenderMessages(d.messages || []);
  } catch(e) {}
}

function sgRenderMessages(msgs) {
  const el = $('sg-messages'); if (!el) return;
  const atBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 60;
  el.innerHTML = msgs.length
    ? msgs.map(m => {
        const mine = m.sender === S.sid || m.sender_name === S.name;
        return `
          <div class="sg-msg ${mine?'mine':'theirs'}">
            ${!mine ? `<div class="sg-sender">${esc(m.sender_name||'Student')}</div>` : ''}
            <div class="sg-bubble">${esc(m.text||'')}</div>
          </div>`;
      }).join('')
    : `<div style="text-align:center;padding:2rem;color:var(--muted);font-size:.82rem">No messages yet. Say hello! 👋</div>`;
  if (atBottom) el.scrollTop = el.scrollHeight;
}

async function sgSend() {
  if (!SG_ACTIVE) return;
  const input = $('sg-msg-input');
  const text  = input?.value.trim();
  if (!text) return;
  input.value = '';
  try {
    await API('/api/group/message', {group_id:SG_ACTIVE.id, sid:S.sid, text, sender_name:S.name});
    sgLoadMessages();
  } catch(e) { toast('Send failed — try again.'); }
}

// ═══════════════════════ POMODORO ══════════════════════════

const POM_MODES = { focus:{label:'Focus',mins:25}, short:{label:'Short Break',mins:5}, long:{label:'Long Break',mins:15} };
const POM_KEY   = () => `sivarr_pom_${S.sid||'guest'}`;
let POM_MODE    = 'focus';
let POM_SECS    = 25*60;
let POM_TOTAL   = 25*60;
let POM_RUNNING = false;
let POM_INTERVAL= null;
let POM_SESSION = 0;

function pomStats() {
  try { return JSON.parse(localStorage.getItem(POM_KEY()) || '{"today":0,"total":0,"mins":0,"date":""}'); }
  catch { return {today:0,total:0,mins:0,date:''}; }
}
function pomSaveStats(s) { localStorage.setItem(POM_KEY(), JSON.stringify(s)); }

function pomSetMode(mode, btn) {
  POM_MODE    = mode;
  POM_RUNNING = false;
  clearInterval(POM_INTERVAL);
  POM_SECS  = POM_MODES[mode].mins * 60;
  POM_TOTAL = POM_SECS;
  pomRender();
  document.querySelectorAll('.pom-mode-btn').forEach(b=>b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const sl = $('pom-sublabel'); if (sl) sl.textContent = POM_MODES[mode].label;
  const sb = $('pom-start-btn'); if (sb) sb.textContent = '▶ Start';
}

function pomToggle() {
  if (POM_RUNNING) {
    POM_RUNNING = false;
    clearInterval(POM_INTERVAL);
    const sb = $('pom-start-btn'); if (sb) sb.textContent = '▶ Resume';
  } else {
    POM_RUNNING = true;
    const sb = $('pom-start-btn'); if (sb) sb.textContent = '⏸ Pause';
    POM_INTERVAL = setInterval(() => {
      POM_SECS--;
      pomRender();
      if (POM_SECS <= 0) {
        clearInterval(POM_INTERVAL);
        POM_RUNNING = false;
        pomComplete();
      }
    }, 1000);
  }
}

function pomComplete() {
  const sb = $('pom-start-btn'); if (sb) sb.textContent = '▶ Start';
  if (POM_MODE === 'focus') {
    POM_SESSION++;
    for (let i=0;i<4;i++) {
      const dot = $(`pd${i}`);
      if (dot) dot.classList.toggle('done', i < POM_SESSION % 4);
    }
    const st  = pomStats();
    const today = new Date().toISOString().split('T')[0];
    if (st.date !== today) { st.today = 0; st.date = today; }
    st.today++;
    st.total++;
    st.mins += POM_MODES.focus.mins;
    pomSaveStats(st);
    pomUpdateStatDisplay();
    toast(`Focus session complete! 🎉 ${POM_SESSION % 4 === 0 ? 'Time for a long break.' : 'Great work!'}`);
    if (POM_SESSION % 4 === 0) pomSetMode('long', null);
    else pomSetMode('short', null);
  } else {
    toast('Break over — time to focus! 💪');
    pomSetMode('focus', null);
    document.querySelectorAll('.pom-mode-btn').forEach((b,i) => b.classList.toggle('active', i===0));
  }
}

function pomReset() {
  POM_RUNNING = false;
  clearInterval(POM_INTERVAL);
  POM_SECS  = POM_TOTAL;
  pomRender();
  const sb = $('pom-start-btn'); if (sb) sb.textContent = '▶ Start';
}

function pomSkip() {
  clearInterval(POM_INTERVAL);
  POM_RUNNING = false;
  pomComplete();
}

function pomRender() {
  const mins = Math.floor(POM_SECS/60).toString().padStart(2,'0');
  const secs = (POM_SECS%60).toString().padStart(2,'0');
  const tm   = $('pom-time'); if (tm) tm.textContent = `${mins}:${secs}`;
  const circ = $('pom-ring-fill');
  if (circ) {
    const pct    = POM_SECS / POM_TOTAL;
    const circum = 2 * Math.PI * 88;
    circ.style.strokeDashoffset = circum * (1 - pct);
    circ.style.strokeDasharray  = circum;
    circ.style.stroke = POM_MODE === 'focus' ? 'url(#pomGrad)' : POM_MODE === 'short' ? '#22c55e' : '#f59e0b';
  }
}

function pomUpdateStatDisplay() {
  const st = pomStats();
  const today = new Date().toISOString().split('T')[0];
  const sd = $('pom-stat-today'); if (sd) sd.textContent = st.date===today ? st.today : 0;
  const st2= $('pom-stat-total'); if (st2) st2.textContent = st.total;
  const sm = $('pom-stat-mins');  if (sm) sm.textContent = st.mins;
}

function pomInit() {
  pomSetMode('focus', null);
  document.querySelectorAll('.pom-mode-btn').forEach((b,i)=>b.classList.toggle('active',i===0));
  pomUpdateStatDisplay();
  }
  
// ═══════════════════════════ DIFFICULTY ═════════════════════════
function openDiff() { $('diff-modal').classList.add('open'); }
function closeDiff(e) { if (e.target === $('diff-modal')) $('diff-modal').classList.remove('open'); }

async function setDiff(level) {
  await API('/api/difficulty', { sid: S.sid, level });
  S.diff = level;
  updateDiff(level);
  $('diff-modal').classList.remove('open');
  const qd = $('qd-label'); if (qd) qd.textContent = level.charAt(0).toUpperCase()+level.slice(1);
  toast(`Difficulty: ${level.charAt(0).toUpperCase()+level.slice(1)} 🎯`);
  document.querySelectorAll('.diff-opt').forEach(el => {
    el.classList.toggle('sel', el.querySelector('.dl').textContent.toLowerCase() === level);
  });
}

function updateDiff(level) {
  // Difficulty pill now only lives in quiz section
  const btn = $('diff-btn');
  if (btn) {
    btn.className   = `diff-pill diff-${level}`;
    btn.textContent = level.charAt(0).toUpperCase()+level.slice(1);
  }
  // Update quiz start label too
  const qd = $('qd-label');
  if (qd) qd.textContent = level.charAt(0).toUpperCase()+level.slice(1);
}

// ═══════════════════════════ SNAV (New Sidebar) ═════════════════

const SNAV_SECTION_HEIGHTS = {
  ai: 4, academics: 3, planner: 4, assessments: 3, insights: 3
};

// ═══════════════════════════ MOBILE SIDEBAR ══════════════════

const MOB_SNAV_HEIGHTS = {
  ai: 4, academics: 2, planner: 4,
  assessments: 3, insights: 3, spaces: 2
};

function toggleMobileSidebar() {
  const panel = $('mob-sidebar-panel');
  if (!panel) return;
  panel.classList.contains('open') ? closeMobileSidebar() : openMobileSidebar();
}

function openMobileSidebar() {
  const panel   = $('mob-sidebar-panel');
  const overlay = $('mob-sidebar-overlay');
  const fab     = $('mob-fab');
  if (panel)   panel.classList.add('open');
  if (overlay) overlay.classList.add('visible');
  if (fab)     fab.classList.add('open');
  document.body.style.overflow = 'hidden';
  // Sync avatar + name from topbar
  const av   = $('mob-snav-av');   const tbAv   = $('tb-av');
  const name = $('mob-snav-name'); const tbName = $('tb-name');
  if (av && tbAv) {
    av.innerHTML  = tbAv.innerHTML || '';
    av.textContent = av.innerHTML ? '' : (tbAv.textContent || '?');
    if (tbAv.querySelector('img')) av.innerHTML = tbAv.innerHTML;
    else av.textContent = tbAv.textContent;
  }
  if (name && tbName) name.textContent = tbName.textContent;
}

function closeMobileSidebar() {
  const panel   = $('mob-sidebar-panel');
  const overlay = $('mob-sidebar-overlay');
  const fab     = $('mob-fab');
  if (panel)   panel.classList.remove('open');
  if (overlay) overlay.classList.remove('visible');
  if (fab)     fab.classList.remove('open');
  document.body.style.overflow = '';
}

function mobSnavToggle(sectionId, btn) {
  const items  = $(`mob-items-${sectionId}`);
  const secBtn = $(`mob-sec-${sectionId}`) || btn;
  if (!items) return;
  const isOpen = items.classList.contains('open');
  if (isOpen) {
    items.style.maxHeight = '0px';
    items.classList.remove('open');
    if (secBtn) secBtn.classList.remove('open');
  } else {
    const count = MOB_SNAV_HEIGHTS[sectionId] || 5;
    items.style.maxHeight = (count * 34) + 'px';
    items.classList.add('open');
    if (secBtn) secBtn.classList.add('open');
  }
}

// Navigate and close sidebar
function navMob(panelName) {
  nav(panelName, null);
  closeMobileSidebar();
}

// Navigate to AI chat with a prefilled prompt
function navMobAI(feature) {
  nav('chat', null);
  closeMobileSidebar();
  const prompts = {
    'ask-notes':       () => { setTimeout(() => $('attach-btn')?.click(), 300); },
    'study-help':      () => { setTimeout(() => { const ci = $('ci'); if (ci) { ci.value = 'Help me plan and structure my study tasks'; ci.focus(); }}, 300); },
    'study-plan':      () => { setTimeout(() => { const ci = $('ci'); if (ci) { ci.value = 'Create a personalised weekly study plan for me'; ci.focus(); }}, 300); },
    'weak-areas':      () => { setTimeout(() => getSuggestions && getSuggestions(), 400); },
    'recommendations': () => { setTimeout(() => getSuggestions && getSuggestions(), 400); },
  };
  if (prompts[feature]) prompts[feature]();
}

// Navigate to courses and open exam entry tab
function navMobExamEntry() {
  nav('courses', null);
  closeMobileSidebar();
  setTimeout(() => {
    const examTab = document.querySelector('.ctab[onclick*="exam-entry"]');
    if (examTab) examTab.click();
  }, 350);
}

// Swipe left to close sidebar
(function() {
  let startX = 0, startY = 0;
  document.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener('touchend', e => {
    const dx = startX - e.changedTouches[0].clientX;
    const dy = Math.abs(startY - e.changedTouches[0].clientY);
    const panel = $('mob-sidebar-panel');
    if (panel && panel.classList.contains('open') && dx > 55 && dy < 40) {
      closeMobileSidebar();
    }
  }, { passive: true });
})();

// Auto-open AI section on first load
document.addEventListener('DOMContentLoaded', () => {
  const aiItems  = $('mob-items-ai');
  const aiBtn    = $('mob-sec-ai');
  const count    = MOB_SNAV_HEIGHTS['ai'] || 4;
  if (aiItems) { aiItems.style.maxHeight = (count * 34) + 'px'; aiItems.classList.add('open'); }
  if (aiBtn)   aiBtn.classList.add('open');
});

// ═══════════════════════════ SNAV TOGGLE ═════════════════════
function snavToggle(sectionId, btn) {
  const items = $(`snav-items-${sectionId}`);
  const secBtn = $(`snav-sec-${sectionId}`) || btn;
  if (!items) return;
  const isOpen = items.classList.contains('open');
  if (isOpen) {
    items.style.maxHeight = '0px';
    items.classList.remove('open');
    if (secBtn) secBtn.classList.remove('open');
  } else {
    const count = SNAV_SECTION_HEIGHTS[sectionId] || 5;
    items.style.maxHeight = (count * 34) + 'px';
    items.classList.add('open');
    if (secBtn) secBtn.classList.add('open');
    // Update icon background
    const icon = secBtn ? secBtn.querySelector('.snav-section-icon') : null;
    if (icon) icon.style.background = getSectionColor(sectionId, true);
  }
}

function getSectionColor(sectionId, bg) {
  const map = {
    ai: '#818cf8', academics: '#34d399', planner: '#fb923c',
    assessments: '#f472b6', insights: '#60a5fa'
  };
  const c = map[sectionId] || '#818cf8';
  return bg ? `${c}22` : c;
}

// Route map: snav item id → { panel, trigger }
const SNAV_ROUTE = {
  // AI
  'chat':            () => nav('chat', null),
  'ask-notes':       () => { nav('chat', null); setTimeout(() => $('attach-btn')?.click(), 300); },
  'generate-quiz':   () => nav('quiz', null),
  'study-help-ai':   () => { nav('chat', null); setTimeout(() => {
    const ci = $('ci'); if (ci) { ci.value = 'Help me build a study plan and break down my tasks'; ci.focus(); }
  }, 300); },
  // Academics
  'courses':         () => { nav('courses', null); },
  'materials':       () => { nav('courses', null); setTimeout(() => loadClasses(), 200); },
  'courses':         () => { nav('courses', null); setTimeout(() => loadClasses(), 200); },
  'announcements':   () => nav('announcements', null),
  // Planner
  'tasks':           () => nav('flux', null),
  'notes':           () => nav('notes', null),
  'study-deck':      () => nav('lab', null),
  'studyplan':      () => nav('studyplan', null),
  // Assessments
  'quizzes':         () => nav('quiz', null),
  'exams':           () => { nav('courses', null); setTimeout(() => {
    const examBtn = document.querySelector('.ctab[onclick*="exam-entry"]'); if (examBtn) examBtn.click();
  }, 350); },
  'results':         () => { nav('stats', null); },
  // Insights
  'progress':        () => nav('stats', null),
  'weak-areas':      () => { nav('stats', null); setTimeout(() => {
    const wa = $('weak-section'); if (wa) wa.scrollIntoView({ behavior: 'smooth' });
  }, 400); },
  'recommendations': () => { nav('chat', null); setTimeout(() => getSuggestions(), 400); },
'content-hub':     () => nav('contenthub', null),
  'goals':           () => nav('goals', null),
  'document-hub':    () => nav('documenthub', null),
  'materials':       () => nav('learninghub', null),
  'study-groups':    () => nav('studygroups', null),
  'pomodoro':        () => nav('pomodoro', null),
  'create-new':      () => { cnOpen(); },
  'settings':        () => nav('settings', null),
  };

let SNAV_ACTIVE = 'chat';

function snavSelect(itemId, sectionId, btnEl) {
  // Clear all active states
  document.querySelectorAll('.snav-item').forEach(b => b.classList.remove('active'));
  const dash = $('snav-dash'); if (dash) dash.classList.remove('active');

  // Set active
  const el = $(`snav-${itemId}`) || btnEl;
  if (el) el.classList.add('active');
  SNAV_ACTIVE = itemId;

  // Open the section if not already
  const items = $(`snav-items-${sectionId}`);
  if (items && !items.classList.contains('open')) snavToggle(sectionId, null);

  // Update sidebar footer name (mirror from topbar)
  const snavName = $('snav-name'); const tbName = $('tb-name');
  if (snavName && tbName) snavName.textContent = tbName.textContent;
  const snavAv = $('snav-av'); const tbAv = $('tb-av');
  if (snavAv && tbAv) snavAv.textContent = tbAv.textContent;

  // Execute route
  const route = SNAV_ROUTE[itemId];
  if (route) route();
}

// Keep old nav() active-state logic in sync with new sidebar
function syncSnavFromPanel(name) {
  // Map panel names back to snav item ids
  const panelToSnav = {
    chat: 'chat', quiz: 'quizzes', courses: 'courses',
    announcements: 'announcements', stats: 'progress',
    progress: 'progress', notes: 'notes', flux: 'tasks',
    lab: 'study-deck', goals: 'goals', documenthub: 'document-hub',
  };
  const snavId = panelToSnav[name];
  if (snavId) {
    document.querySelectorAll('.snav-item').forEach(b => b.classList.remove('active'));
    const el = $(`snav-${snavId}`); if (el) el.classList.add('active');
  }
}

// ═══════════════════════════ NAV ════════════════════════════════
function nav(name, btn) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn, .mn-btn').forEach(b => b.classList.remove('active'));
  const p = document.getElementById(`panel-${name}`);
  if (p) p.classList.add('active');
  if (btn) btn.classList.add('active');
  const mob = document.getElementById(`mn-${name}`); if (mob) mob.classList.add('active');
  syncSnavFromPanel(name);
  if (name === 'stats')         loadStats();
  if (name === 'more')          syncMore();
  if (name === 'leaderboard')   loadLeaderboard();
  if (name === 'notes')         loadNotes();
  if (name === 'flux')          loadStudyHelp();
  if (name === 'courses')       loadClasses();
  if (name === 'announcements') loadAllAnnouncements();
  if (name === 'studyplan') {
    $('sp-date') && ($('sp-date').min = new Date().toISOString().split('T')[0]);
    setTimeout(spLoadSaved, 100);
  }
  if (name === 'contenthub') chInit();
  if (name === 'settings')   stInit();
  if (name === 'progress')    loadProgress();
  if (name === 'goals')       glLoad();
  if (name === 'documenthub') dhInit();
  if (name === 'learninghub') lhInit();
  if (name === 'studygroups') sgInit();
  if (name === 'pomodoro')    pomInit();
  if (name === 'quiz' && !S.quizActive) {
    const qd = $('qd-label'); if (qd) qd.textContent = S.diff.charAt(0).toUpperCase()+S.diff.slice(1);
  }
}

// Mobile tab bar navigation with smooth pill scroll
function navTab(name, btn) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById(`panel-${name}`);
  if (panel) panel.classList.add('active');

  document.querySelectorAll('.tab-pill').forEach(p => p.classList.remove('active'));
  if (btn) {
    btn.classList.add('active');
    btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }

  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const desktopBtn = document.querySelector(`.nav-btn[onclick*="'${name}'"]`);
  if (desktopBtn) desktopBtn.classList.add('active');

  if (name === 'stats')         loadStats();
  if (name === 'more')          syncMore();
  if (name === 'leaderboard')   loadLeaderboard();
  if (name === 'notes')         loadNotes();
  if (name === 'flux')     loadStudyHelp();
  if (name === 'courses')       loadClasses();
  if (name === 'announcements') loadAllAnnouncements();
  if (name === 'studyplan') { const d = new Date(); d.setDate(d.getDate()+14); $('sp-date') && ($('sp-date').min = new Date().toISOString().split('T')[0]); }
  if (name === 'contenthub') chInit();
  if (name === 'settings')   stInit();
  if (name === 'progress')    loadProgress();
  if (name === 'goals')       glLoad();
  if (name === 'documenthub') dhInit();
  if (name === 'learninghub') lhInit();
  if (name === 'studygroups') sgInit();
  if (name === 'pomodoro')    pomInit();
  if (name === 'quiz' && !S.quizActive) {
    const qd = $('qd-label'); if (qd) qd.textContent = S.diff.charAt(0).toUpperCase()+S.diff.slice(1);
  }
}

async function getSuggestionsMobile() {
  $('sug-txt-m').textContent = 'Thinking...';
  try {
    const r = await fetch(`/api/suggest?sid=${S.sid}`);
    const d = await r.json();
    $('sug-txt-m').textContent = d.suggestion;
  } catch { $('sug-txt-m').textContent = 'Couldn\'t load — try again.'; }
}

function syncMore() {
  // Sync topics
  const tl = $('topics-list-m');
  if (tl) tl.innerHTML = $('topics-list').innerHTML;
  // Sync wrong answers
  const wl = $('wrong-list-m');
  if (wl) wl.innerHTML = $('wrong-list').innerHTML;
  const wc = $('wc-m');
  if (wc) wc.textContent = $('wc').textContent;
}

// ═══════════════════════════ HELPERS ════════════════════════════
function updateSBStats() {
  $('sq-q').textContent  = S.stats.questions;
  $('sq-qz').textContent = S.stats.quizzes;
  $('sq-s').textContent  = S.stats.sessions;
  $('sq-w').textContent  = S.stats.wrong || 0;
}

function renderTopics(topics, weak) {
  const html = !topics.length
    ? `<span style="color:var(--muted);font-size:.78rem">Ask questions to build your topic list</span>`
    : topics.map(t => `<span class="topic-tag ${weak.includes(t)?'weak':''}">${esc(t)}</span>`).join('');
  const el  = $('topics-list');   if (el)  el.innerHTML  = html;
  const elm = $('topics-list-m'); if (elm) elm.innerHTML = html;
}

async function refreshTopics() {
  const r = await fetch(`/api/progress?sid=${S.sid}`);
  const d = await r.json();
  S.topics = Object.keys(d.topics); S.weak = d.weak;
  renderTopics(S.topics, S.weak);
}

// ═══════════════════════ SWIPE GESTURES ════════════════════════

(function initSwipe() {
  let startX = 0, startY = 0, startTime = 0;
  const PANELS = ['chat','quiz','stats','courses','lab','flux','announcements','notes','studyplan'];
  let currentIdx = 0;

  function getCurrentIdx() {
    const active = document.querySelector('.panel.active');
    if (!active) return 0;
    const id = active.id.replace('panel-','');
    const i  = PANELS.indexOf(id);
    return i >= 0 ? i : currentIdx;
  }

  document.addEventListener('touchstart', e => {
    startX    = e.touches[0].clientX;
    startY    = e.touches[0].clientY;
    startTime = Date.now();
  }, { passive: true });

  document.addEventListener('touchend', e => {
    const dx   = e.changedTouches[0].clientX - startX;
    const dy   = e.changedTouches[0].clientY - startY;
    const dt   = Date.now() - startTime;
    const absDx = Math.abs(dx), absDy = Math.abs(dy);

    // Must be fast, horizontal, and significant
    if (dt > 350 || absDx < 60 || absDy > absDx * 0.8) return;

    // Don't swipe if inside a scrollable area scrolled horizontally
    const target = e.target.closest('.chat-msgs,.quiz-wrap,.stats-wrap,.tab-bar,.lh-filter-bar,.sg-msg-wrap');
    if (target) return;

    currentIdx = getCurrentIdx();

    if (dx < 0 && currentIdx < PANELS.length - 1) {
      // Swipe left = next panel
      nav(PANELS[currentIdx + 1], null);
      currentIdx++;
    } else if (dx > 0 && currentIdx > 0) {
      // Swipe right = previous panel
      nav(PANELS[currentIdx - 1], null);
      currentIdx--;
    }
  }, { passive: true });
})();
  
function toast(msg, ms=2500) {
  const el = $('toast'); el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), ms);
}

async function runStudyHavenP(input) {
  const file = input.files[0];
  if (!file || !S.sid) return;
  await _processLabFile(file, 'panel');
  input.value = '';
}

function handleLabDropP(e) {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) _processLabFile(file, 'panel');
}

function switchLabTabP(tab, btn) {
  ['summary','notes','questions'].forEach(t => {
    const el = $(`lab-${t}-p`); if (el) el.style.display = t === tab ? 'block' : 'none';
  });
  document.querySelectorAll('[onclick*="switchLabTabP"]').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
}

function saveLabAsNoteP()  { _saveLabNote(); }
function downloadLabResultP() { _downloadLab(); }

// toggleSHSidebar kept as no-op — superseded by snavToggle
function toggleSHSidebar(btn) { snavSelect('tasks','planner',null); }

// Init sidebar section heights on load so CSS transitions work
document.addEventListener('DOMContentLoaded', () => {
  Object.entries(SNAV_SECTION_HEIGHTS).forEach(([id, count]) => {
    const el = $(`snav-items-${id}`);
    if (el && el.classList.contains('open')) {
      el.style.maxHeight = (count * 34) + 'px';
    }
  });
});



const SH_KEY  = () => `sivarr_sh_${S.sid || 'guest'}`;
let SH_DRAG   = null;
let SH_VIEW   = 'board';
let SH_ADD_COL = 'todo';

const SH_COLS = {
  todo:       { label: 'Not Started', color: '#94a3b8' },
  inprogress: { label: 'In Progress', color: '#f59e0b' },
  done:       { label: 'Done',        color: '#22c55e' },
};

function getSHData() {
  try { return JSON.parse(localStorage.getItem(SH_KEY()) || '{"tasks":[]}'); }
  catch { return { tasks: [] }; }
}

function saveSHData(data) {
  localStorage.setItem(SH_KEY(), JSON.stringify(data));
}

function loadStudyHelp() {
  // Default to overview on first load
  const overviewBtn = $('sh-view-overview');
  setSHView('overview', overviewBtn);
  renderSHBoard();
}

function setSHView(view, btn) {
  SH_VIEW = view;
  document.querySelectorAll('.sh-view-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  $('sh-overview-view').style.display = view === 'overview' ? 'flex'  : 'none';
  $('sh-board-view').style.display    = view === 'board'    ? 'flex'  : 'none';
  $('sh-list-view').style.display     = view === 'list'     ? 'block' : 'none';
  if (view === 'overview') renderSHOverview();
  if (view === 'list')     renderSHListView();
}

function renderSHOverview() {
  const data   = getSHData();
  const tasks  = data.tasks || [];
  const tbody  = $('sh-overview-rows');
  if (!tbody) return;

  const STATUS = {
    todo:       { label:'Not started', color:'#94a3b8', bg:'#94a3b815' },
    inprogress: { label:'In progress', color:'#4f6ef7', bg:'#4f6ef715' },
    done:       { label:'Done',        color:'#22c55e', bg:'#22c55e15' },
  };
  const PRIORITY = {
    high:   { label:'🔴 High',   color:'#ef4444' },
    medium: { label:'🟡 Medium', color:'#f59e0b' },
    low:    { label:'🟢 Low',    color:'#22c55e' },
    normal: { label:'—',         color:'var(--muted)' },
  };
  const TYPE_ICONS = {
    assignment:'📋', exam:'📝', reading:'📖', project:'🗂', revision:'🔄', other:'⚙️'
  };

  if (!tasks.length) {
    tbody.innerHTML = `<tr><td colspan="11" style="padding:2rem;text-align:center;color:var(--muted);font-size:.84rem">
      No tasks yet — click "+ New task" below to add your first task.</td></tr>`;
    return;
  }

  tbody.innerHTML = tasks.map((t, idx) => {
    const st  = STATUS[t.status]   || STATUS.todo;
    const pr  = PRIORITY[t.priority] || PRIORITY.normal;
    const ico = TYPE_ICONS[t.type] || '⚙️';
    const due = t.date ? (t.time ? `${t.date} ${t.time}` : t.date) : '—';
    const updated = t.updated || t.created || '—';
    const isDone = t.status === 'done';

    return `<tr style="transition:background .1s" onmouseover="this.style.background='var(--surface)'" onmouseout="this.style.background=''">
      <td><div class="sh-cell editable sh-cell-title" style="${isDone ? 'text-decoration:line-through;opacity:.6' : ''}"
            onclick="inlineEdit(${t.id},'title',this)">${esc(t.title)}</div></td>
      <td><div class="sh-cell" onclick="inlineEditSelect(${t.id},'status',this)">
            <span class="sh-status-pill" style="background:${st.bg};color:${st.color}">
              <span style="width:7px;height:7px;border-radius:50%;background:${st.color};flex-shrink:0"></span>
              ${st.label}
            </span></div></td>
      <td><div class="sh-cell editable" onclick="inlineEditSelect(${t.id},'type',this)">${ico} ${esc(t.type || 'other')}</div></td>
      <td><div class="sh-cell editable" style="font-size:.75rem;color:var(--muted)"
            onclick="inlineEdit(${t.id},'desc',this)">${esc(t.desc || '—')}</div></td>
      <td><div class="sh-cell editable" onclick="inlineEdit(${t.id},'assignee',this)">${esc(t.assignee || '—')}</div></td>
      <td><div class="sh-cell editable" style="color:${t.date && !isDone ? 'var(--accent)' : 'var(--muted)'};font-size:.78rem"
            onclick="inlineEditDate(${t.id},this)">${due}</div></td>
      <td><div class="sh-cell" onclick="inlineEditSelect(${t.id},'priority',this)"
            style="color:${pr.color};font-weight:600;font-size:.78rem">${pr.label}</div></td>
      <td><div class="sh-cell" style="justify-content:center">
            ${t.attachName
              ? `<span style="font-size:.7rem;color:var(--accent)">📎 ${esc(t.attachName)}</span>`
              : `<button onclick="triggerSHAttach(${t.id})"
                  style="background:none;border:1px solid var(--border);border-radius:6px;
                         padding:2px 8px;color:var(--muted);font-size:.7rem;cursor:pointer">+ Attach</button>`}
          </div></td>
      <td><div class="sh-cell" style="font-size:.72rem;color:var(--muted)">${esc(updated)}</div></td>
      <td><div class="sh-cell editable" style="font-size:.75rem;color:var(--muted)"
            onclick="inlineEdit(${t.id},'summary',this)">${esc(t.summary || '—')}</div></td>
      <td style="text-align:center">
        <div class="sh-cell" style="justify-content:center">
          <button onclick="moveSHTask(${t.id}, '${isDone ? 'todo' : 'done'}')"
            style="width:22px;height:22px;border-radius:5px;cursor:pointer;font-size:.75rem;
                   background:${isDone ? '#22c55e' : 'none'};
                   border:2px solid ${isDone ? '#22c55e' : 'var(--border)'};
                   color:${isDone ? '#fff' : 'transparent'}">${isDone ? '✓' : ''}</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

// ── Inline editing ────────────────────────────────────────────────────────

function inlineEdit(id, field, cell) {
  const data = getSHData();
  const task = (data.tasks || []).find(t => t.id === id);
  if (!task) return;

  const cur = task[field] || '';
  const isMultiline = field === 'desc' || field === 'summary';

  if (isMultiline) {
    cell.innerHTML = `<textarea style="width:100%;background:var(--card);border:1px solid var(--accent);
      border-radius:5px;padding:4px 7px;color:var(--text);font-family:var(--font-body);font-size:.82rem;
      resize:none;outline:none;min-height:52px" onblur="saveInline(${id},'${field}',this.value)"
      onkeydown="if(event.key==='Escape')renderSHOverview()">${esc(cur)}</textarea>`;
    cell.querySelector('textarea').focus();
  } else {
    cell.innerHTML = `<input value="${esc(cur)}" style="width:100%;background:var(--card);border:1px solid var(--accent);
      border-radius:5px;padding:4px 7px;color:var(--text);font-family:var(--font-body);font-size:.82rem;outline:none"
      onblur="saveInline(${id},'${field}',this.value)"
      onkeydown="if(event.key==='Enter'||event.key==='Escape')this.blur()">`;
    cell.querySelector('input').focus();
    cell.querySelector('input').select();
  }
}

function inlineEditSelect(id, field, cell) {
  const data = getSHData();
  const task = (data.tasks || []).find(t => t.id === id);
  if (!task) return;

  const options = {
    status:   [['todo','Not started'],['inprogress','In progress'],['done','Done']],
    priority: [['normal','— Normal'],['high','🔴 High'],['medium','🟡 Medium'],['low','🟢 Low']],
    type:     [['assignment','📋 Assignment'],['exam','📝 Exam prep'],['reading','📖 Reading'],
               ['project','🗂 Project'],['revision','🔄 Revision'],['other','⚙️ Other']],
  };
  const opts = options[field] || [];

  cell.innerHTML = `<select style="width:100%;background:var(--card);border:1px solid var(--accent);
    border-radius:5px;padding:4px 7px;color:var(--text);font-family:var(--font-body);font-size:.82rem;outline:none"
    onblur="saveInline(${id},'${field}',this.value)"
    onchange="saveInline(${id},'${field}',this.value)">
    ${opts.map(([v,l]) => `<option value="${v}" ${task[field]===v?'selected':''}>${l}</option>`).join('')}
  </select>`;
  cell.querySelector('select').focus();
}

function inlineEditDate(id, cell) {
  const data = getSHData();
  const task = (data.tasks || []).find(t => t.id === id);
  if (!task) return;
  cell.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:3px;padding:4px">
      <input type="date" value="${task.date||''}" style="background:var(--card);border:1px solid var(--accent);
        border-radius:5px;padding:3px 6px;color:var(--text);font-size:.78rem;outline:none"
        onblur="saveDateInline(${id},'date',this.value)"
        onchange="saveDateInline(${id},'date',this.value)">
      <input type="time" value="${task.time||''}" style="background:var(--card);border:1px solid var(--accent);
        border-radius:5px;padding:3px 6px;color:var(--text);font-size:.78rem;outline:none"
        onblur="saveDateInline(${id},'time',this.value)"
        onchange="saveDateInline(${id},'time',this.value)">
    </div>`;
  cell.querySelector('input').focus();
}

function saveInline(id, field, value) {
  const data = getSHData();
  const task = (data.tasks || []).find(t => t.id === id);
  if (!task) return;
  task[field]  = value.trim();
  task.updated = new Date().toLocaleDateString();
  saveSHData(data);
  renderSHOverview();
  renderSHBoard();
}

function saveDateInline(id, field, value) {
  const data = getSHData();
  const task = (data.tasks || []).find(t => t.id === id);
  if (!task) return;
  task[field]  = value;
  task.updated = new Date().toLocaleDateString();
  saveSHData(data);
  // Don't re-render yet — user may still editing time field
}

function triggerSHAttach(id) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.style.display = 'none';
  inp.onchange = () => {
    const file = inp.files[0];
    if (!file) return;
    const data = getSHData();
    const task = (data.tasks||[]).find(t=>t.id===id);
    if (task) { task.attachName = file.name; task.updated = new Date().toLocaleDateString(); }
    saveSHData(data);
    renderSHOverview();
    toast(`Attached: ${file.name}`);
  };
  document.body.appendChild(inp);
  inp.click();
  document.body.removeChild(inp);
}

function handleSHAttach(input) {
  const file = input.files[0];
  if (!file) return;
  const fn = $('sh-modal-file-name');
  if (fn) fn.textContent = file.name;
  input._filename = file.name;
}


function openEditTask(id) {
  const data = getSHData();
  const task = (data.tasks || []).find(t => t.id === id);
  if (!task) return;
  const modal = $('sh-modal-bg');
  modal._editId = id;
  const h = $('sh-modal-heading'); if (h) h.textContent = 'Edit Task';
  $('sh-modal-title').value    = task.title       || '';
  $('sh-modal-status').value   = task.status      || 'todo';
  $('sh-modal-type').value     = task.type        || 'other';
  $('sh-modal-desc').value     = task.desc        || '';
  $('sh-modal-assignee').value = task.assignee    || '';
  $('sh-modal-date').value     = task.date        || '';
  $('sh-modal-time').value     = task.time        || '';
  $('sh-modal-priority').value = task.priority    || 'normal';
  $('sh-modal-summary').value  = task.summary     || '';
  const fn = $('sh-modal-file-name');
  if (fn) fn.textContent = task.attachName || 'No file chosen';
  modal.style.display = 'flex';
  setTimeout(() => $('sh-modal-title')?.focus(), 100);
}

function openAddTask(col) {
  SH_ADD_COL = col || 'todo';
  const modal = $('sh-modal-bg');
  if (!modal) return;
  modal._editId = null;
  const h = $('sh-modal-heading'); if (h) h.textContent = 'New Task';
  $('sh-modal-title').value    = '';
  $('sh-modal-status').value   = SH_ADD_COL;
  $('sh-modal-type').value     = 'other';
  $('sh-modal-desc').value     = '';
  $('sh-modal-assignee').value = '';
  $('sh-modal-date').value     = '';
  $('sh-modal-time').value     = '';
  $('sh-modal-priority').value = 'normal';
  $('sh-modal-summary').value  = '';
  const fn = $('sh-modal-file-name'); if (fn) fn.textContent = 'No file chosen';
  const fi = $('sh-modal-file');      if (fi) { fi.value = ''; fi._filename = ''; }
  modal.style.display = 'flex';
  setTimeout(() => $('sh-modal-title')?.focus(), 100);
}

function closeSHModal() {
  const modal = $('sh-modal-bg');
  if (modal) modal.style.display = 'none';
}

function saveSHModal() {
  const title = $('sh-modal-title')?.value.trim();
  if (!title) { toast('Enter a task name.'); return; }

  const now  = new Date().toLocaleDateString();
  const data = getSHData();
  data.tasks = data.tasks || [];
  const editId = $('sh-modal-bg')._editId;

  const fields = {
    title,
    status:   $('sh-modal-status')?.value   || 'todo',
    type:     $('sh-modal-type')?.value      || 'other',
    desc:     $('sh-modal-desc')?.value.trim()     || '',
    assignee: $('sh-modal-assignee')?.value.trim() || '',
    date:     $('sh-modal-date')?.value      || '',
    time:     $('sh-modal-time')?.value      || '',
    priority: $('sh-modal-priority')?.value  || 'normal',
    summary:  $('sh-modal-summary')?.value.trim()  || '',
    attachName: $('sh-modal-file')?._filename || '',
    updated:  now,
  };

  if (editId) {
    const task = data.tasks.find(t => t.id === editId);
    if (task) Object.assign(task, fields);
    $('sh-modal-bg')._editId = null;
    toast('Task updated ✓');
  } else {
    data.tasks.push({ id: Date.now(), created: now, ...fields });
    toast('Task added ✓');
  }

  saveSHData(data);
  closeSHModal();
  renderSHBoard();
}

function deleteSHTask(id) {
  const data   = getSHData();
  data.tasks   = (data.tasks || []).filter(t => t.id !== id);
  saveSHData(data);
  renderSHBoard();
  if (SH_VIEW === 'list') renderSHListView();
}

function moveSHTask(id, newStatus) {
  const data = getSHData();
  const task = (data.tasks || []).find(t => t.id === id);
  if (task) { task.status = newStatus; saveSHData(data); }
  renderSHBoard();
  if (SH_VIEW === 'list') renderSHListView();
}

// Drag and drop
function shDragOver(e) {
  e.preventDefault();
  e.currentTarget.classList.add('drag-over');
}

function shDrop(e, col) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  if (SH_DRAG !== null) { moveSHTask(SH_DRAG, col); SH_DRAG = null; }
}

function renderSHBoard() {
  const data  = getSHData();
  const tasks = data.tasks || [];
  const done  = tasks.filter(t => t.status === 'done').length;
  const total = tasks.length;
  const pct   = total ? Math.round((done / total) * 100) : 0;

  const tc = $('sh-total-count'); if (tc) tc.textContent = total;
  const dc = $('sh-done-count');  if (dc) dc.textContent = done;
  const pb = $('sh-progress-bar'); if (pb) pb.style.width = pct + '%';
  const pp = $('sh-pct');          if (pp) pp.textContent = pct + '%';

  Object.keys(SH_COLS).forEach(col => {
    const colTasks = tasks.filter(t => t.status === col);
    const body     = $(`sh-col-${col}`);
    const count    = $(`sh-col-count-${col}`);
    if (!body) return;
    if (count) count.textContent = colTasks.length;

    body.innerHTML = colTasks.length ? colTasks.map(t => `
      <div class="sh-card" draggable="true"
        ondragstart="SH_DRAG=${t.id}"
        ondragend="document.querySelectorAll('.sh-col-body').forEach(b=>b.classList.remove('drag-over'))">
        <div class="sh-card-title">${esc(t.title)}</div>
        ${t.notes ? `<div class="sh-card-notes">${esc(t.notes)}</div>` : ''}
        <div class="sh-card-footer">
          ${t.date ? `<span class="sh-card-date">📅 ${t.date}</span>` : ''}
          <span class="sh-priority ${t.priority}">${
            t.priority === 'high' ? '🔴 High' :
            t.priority === 'medium' ? '🟡 Med' :
            t.priority === 'low' ? '🟢 Low' : ''
          }</span>
          <div style="margin-left:auto;display:flex;gap:4px">
            ${col !== 'done' ? `<button onclick="moveSHTask(${t.id},'done')"
              style="background:#22c55e20;border:1px solid #22c55e40;border-radius:5px;
                     color:#22c55e;font-size:.65rem;padding:1px 6px;cursor:pointer">✓</button>` : ''}
            <button onclick="deleteSHTask(${t.id})" class="sh-card-del"
              style="opacity:1;background:none;border:none;color:var(--muted);cursor:pointer;font-size:.75rem">✕</button>
          </div>
        </div>
      </div>`).join('')
      : `<div style="font-size:.75rem;color:var(--muted);padding:8px 4px;text-align:center">No tasks</div>`;
  });

  // Refresh overview if visible
  if (SH_VIEW === 'overview') renderSHOverview();
  if (SH_VIEW === 'list') renderSHListView();
}

function renderSHListView() {
  const data    = getSHData();
  const tasks   = data.tasks || [];
  const container = $('sh-list-container');
  if (!container) return;

  if (!tasks.length) {
    container.innerHTML = '<div style="text-align:center;color:var(--muted);padding:2rem;font-size:.84rem">No tasks yet — click "+ New Task" to get started.</div>';
    return;
  }

  container.innerHTML = `
    <div style="font-size:.72rem;font-weight:700;color:var(--muted);text-transform:uppercase;
                letter-spacing:.06em;padding:6px 12px;display:grid;
                grid-template-columns:12px 1fr 80px 80px 70px 40px;gap:8px;
                border-bottom:1px solid var(--border)">
      <span></span><span>Task</span><span>Status</span><span>Priority</span><span>Due</span><span></span>
    </div>
    ${tasks.map(t => `
    <div class="sh-list-item" style="display:grid;grid-template-columns:12px 1fr 80px 80px 70px 40px;gap:8px;align-items:center">
      <div class="sh-list-status" style="background:${SH_COLS[t.status]?.color || '#94a3b8'}"></div>
      <div>
        <div style="font-weight:600;font-size:.84rem">${esc(t.title)}</div>
        ${t.notes ? `<div style="font-size:.72rem;color:var(--muted)">${esc(t.notes)}</div>` : ''}
      </div>
      <div style="font-size:.72rem;color:${SH_COLS[t.status]?.color || 'var(--muted)'};font-weight:600">${SH_COLS[t.status]?.label || ''}</div>
      <div><span class="sh-priority ${t.priority}">${
        t.priority === 'high' ? '🔴 High' :
        t.priority === 'medium' ? '🟡 Med' :
        t.priority === 'low' ? '🟢 Low' : '—'
      }</span></div>
      <div style="font-size:.72rem;color:var(--accent)">${t.date || '—'}</div>
      <button onclick="deleteSHTask(${t.id})"
        style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:.8rem">✕</button>
    </div>`).join('')}`;
}

async function generateTaskStructure() {
  const inp = $('sh-structure-input');
  const res = $('sh-structure-result');
  const btn = document.querySelector('[onclick="generateTaskStructure()"]');
  const text = inp?.value.trim();
  if (!text) { toast('Describe your task first.'); return; }
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Thinking...'; }
  if (res) res.style.display = 'none';
  try {
    const r = await API('/api/chat', {
      sid: S.sid,
      message: `Break down this task into clear numbered steps a student can follow. Be concise. Task: "${text}"`
    });
    if (res) {
      res.innerHTML = renderMarkdown(r.response || r.reply || r.message || '');
      res.style.display = 'block';
    }
  } catch { toast('Could not generate — try again.'); }
  if (btn) { btn.disabled = false; btn.textContent = 'Generate Steps'; }
}

function createStudyPDF() {
  const title = $('sh-pdf-title')?.value.trim() || 'Study Plan';
  const body  = $('sh-pdf-content')?.value.trim();
  if (!body) { toast('Add some content first.'); return; }
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:Georgia,serif;max-width:700px;margin:40px auto;color:#1a1a2e;line-height:1.7}
h1{font-size:1.6rem;color:#4f6ef7;border-bottom:2px solid #4f6ef7;padding-bottom:8px}
pre{white-space:pre-wrap;font-family:inherit;font-size:.95rem}
.meta{font-size:.8rem;color:#888;margin-bottom:2rem}</style></head>
<body><h1>${title}</h1><div class="meta">Generated by Sivarr AI · ${new Date().toLocaleDateString()}</div>
<pre>${body}</pre></body></html>`;
  const w = window.open('', '_blank');
  w.document.write(html); w.document.close();
  setTimeout(() => w.print(), 300);
}

// Close modal on background click
document.addEventListener('click', e => {
  const modal = $('sh-modal-bg');
  if (modal && e.target === modal) closeSHModal();
});

// ═══════════════════════════ LECTURE LAB ════════════════════════

let LAB_RESULT_TEXT = '';

function parseLabResult(raw) {
  const summaryMatch = raw.match(/##\s*📋\s*SUMMARY([\s\S]*?)(?=##\s*📚|$)/i);
  const notesMatch   = raw.match(/##\s*📚\s*STRUCTURED NOTES([\s\S]*?)(?=##\s*❓|$)/i);
  const questMatch   = raw.match(/##\s*❓\s*PRACTICE QUESTIONS([\s\S]*?)$/i);
  return {
    summary:   summaryMatch ? summaryMatch[1].trim() : raw,
    notes:     notesMatch   ? notesMatch[1].trim()   : '',
    questions: questMatch   ? questMatch[1].trim()   : '',
  };
}

function renderMarkdown(text) {
  if (!text) return '';
  let h = text
    // Code blocks first (before escaping)
    .replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) =>
      `<pre style="background:var(--border);border-radius:8px;padding:.75rem;overflow-x:auto;margin:.4rem 0;font-size:.82rem"><code>${esc(code.trim())}</code></pre>`)
    // Inline code
    .replace(/`([^`]+)`/g, '<code style="background:var(--border);border-radius:4px;padding:1px 6px;font-size:.85em">$1</code>')
    // Escape remaining HTML
    .replace(/&(?!amp;|lt;|gt;|quot;)/g, '&amp;')
    .replace(/<(?!pre|\/pre|code|\/code)/g, '&lt;')
    // Headings
    .replace(/^### (.+)$/gm, '<div style="font-family:var(--font);font-size:.9rem;font-weight:700;margin:.6rem 0 .2rem;color:var(--accent)">$1</div>')
    .replace(/^## (.+)$/gm,  '<div style="font-family:var(--font);font-size:1rem;font-weight:800;margin:.7rem 0 .3rem">$1</div>')
    .replace(/^# (.+)$/gm,   '<div style="font-family:var(--font);font-size:1.1rem;font-weight:800;margin:.75rem 0 .3rem">$1</div>')
    // Bold + italic
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g,     '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,         '<em>$1</em>')
    // Bullet lists
    .replace(/^[\-\*] (.+)$/gm, '<li style="margin:.15rem 0;padding-left:.25rem">$1</li>')
    .replace(/^(\d+)\. (.+)$/gm,'<li style="margin:.15rem 0;padding-left:.25rem">$2</li>')
    // Wrap consecutive <li> in <ul>
    .replace(/(<li[^>]*>.*?<\/li>\n?)+/g, m =>
      `<ul style="padding-left:1.25rem;margin:.35rem 0;list-style:disc">${m}</ul>`)
    // Horizontal rule
    .replace(/^---$/gm, '<hr style="border:none;border-top:1px solid var(--border);margin:.5rem 0">')
    // Line breaks
    .replace(/\n{2,}/g, '<br><br>')
    .replace(/\n/g, '<br>');
  return h;
  }

async function runStudyHaven(input) {
  const file = input.files[0];
  if (!file || !S.sid) return;
  await _processLabFile(file, 'mobile');
  input.value = '';
}

async function runStudyHavenD(input) {
  const file = input.files[0];
  if (!file || !S.sid) return;
  await _processLabFile(file, 'desktop');
  input.value = '';
}

function handleLabDrop(e) {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) _processLabFile(file, 'mobile');
}

function handleLabDropD(e) {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) _processLabFile(file, 'desktop');
}

async function _processLabFile(file, target) {
  const isMobile  = target === 'mobile';
  const isPanel   = target === 'panel';
  const sfxMap    = { mobile: '', desktop: '-d', panel: '-p' };
  const sfx       = sfxMap[target] || '';
  const dropZone  = isMobile ? $('lab-drop-zone') : (isPanel ? $('lab-drop-zone-p') : null);
  const resultDiv = $(`lab-result${sfx}`);
  const fnameEl   = $(`lab-filename${sfx}`);

  if (dropZone) dropZone.innerHTML = `
    <div style="font-size:1.5rem;margin-bottom:.4rem">⏳</div>
    <div style="font-size:.82rem;color:var(--muted)">Processing "${esc(file.name)}"...</div>
    <div style="font-size:.72rem;color:var(--muted2);margin-top:3px">Takes 10-20 seconds</div>`;
  if (resultDiv) resultDiv.style.display = 'none';

  try {
    const fd = new FormData();
    fd.append('sid', S.sid);
    fd.append('file', file);
    const r = await fetch('/api/study-deck', { method: 'POST', body: fd });
    if (!r.ok) { const e = await r.json(); throw new Error(e.detail || 'Processing failed'); }
    const d = await r.json();

    LAB_RESULT_TEXT  = d.result;
    const sections   = parseLabResult(d.result);
    const sfx        = isMobile ? '' : '-d';

    const sum = $(`lab-summary${sfx}`);
    const nts = $(`lab-notes${sfx}`);
    const qst = $(`lab-questions${sfx}`);

    if (sum) sum.innerHTML = renderMarkdown(sections.summary);
    if (nts) nts.innerHTML = renderMarkdown(sections.notes);
    if (qst) qst.innerHTML = renderMarkdown(sections.questions);
    if (fnameEl) fnameEl.textContent = `📄 ${file.name}`;
    if (resultDiv) resultDiv.style.display = 'block';

    if (dropZone) dropZone.innerHTML = `
      <div style="font-size:1.75rem;margin-bottom:.4rem">✅</div>
      <div style="font-size:.82rem;color:var(--muted)">Done! Upload another file</div>
      <div style="font-size:.72rem;color:var(--muted2);margin-top:3px">.txt · .pdf · .md</div>`;

    // Activate first tab for correct context
    if (isPanel) switchLabTabP('summary', document.querySelector('[onclick*="switchLabTabP"]'));
    else if (isMobile) switchLabTab('summary', document.querySelector('.lab-tab'));
    else switchLabTabD('summary', document.querySelector('[onclick*="switchLabTabD"]'));

    toast(`Study pack ready! ✓`);
  } catch(e) {
    toast('Study Deck: ' + e.message);
    if (dropZone) dropZone.innerHTML = `
      <div style="font-size:1.75rem;margin-bottom:.4rem">📄</div>
      <div style="font-size:.82rem;color:var(--muted)">Drop file or tap to upload</div>
      <div style="font-size:.72rem;color:var(--muted2);margin-top:3px">.txt · .pdf · .md</div>`;
  }
}

function switchLabTab(tab, btn) {
  ['summary','notes','questions'].forEach(t => {
    const el = $(`lab-${t}`); if (el) el.style.display = t === tab ? 'block' : 'none';
  });
  document.querySelectorAll('.lab-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
}

function switchLabTabD(tab, btn) {
  ['summary','notes','questions'].forEach(t => {
    const el = $(`lab-${t}-d`); if (el) el.style.display = t === tab ? 'block' : 'none';
  });
  document.querySelectorAll('[onclick*="switchLabTabD"]').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
}

function saveLabAsNote()  { _saveLabNote(); }
function saveLabAsNoteD() { _saveLabNote(); }
function _saveLabNote() {
  if (!LAB_RESULT_TEXT || !S.sid) { toast('No study pack to save.'); return; }
  const notes = JSON.parse(localStorage.getItem(`sivarr_notes_${S.sid}`) || '[]');
  notes.unshift({ text: LAB_RESULT_TEXT, date: new Date().toLocaleString() + ' (Study Deck)' });
  localStorage.setItem(`sivarr_notes_${S.sid}`, JSON.stringify(notes.slice(0,50)));
  toast('Saved to My Notes ✓');
}

function downloadLabResult()  { _downloadLab(); }
function downloadLabResultD() { _downloadLab(); }
function _downloadLab() {
  if (!LAB_RESULT_TEXT) { toast('No study pack yet.'); return; }
  const blob = new Blob([`SIVARR AI — LECTURE LAB\n${'─'.repeat(40)}\n\n${LAB_RESULT_TEXT}`], {type:'text/plain'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sivarr_study_pack_${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ═══════════════════════════ STUDENT EXAM SYSTEM ════════════════

let EXAM_STATE = {
  examId: null, code: null, questions: [], answers: {},
  timerInterval: null, timeLeft: 0, tabSwitches: 0, title: ''
};

async function startStudentExam(examId, code) {
  launchExamMode(examId, code);
}

function selectExamAnswer(qIdx, letter) {
  EXAM_STATE.answers[qIdx] = letter;

  // Update UI — use new exam-option class
  const q = EXAM_STATE.questions[qIdx];
  Object.keys(q.options || {}).forEach(l => {
    const btn = $(`eq-${qIdx}-${l}`);
    if (btn) {
      btn.classList.toggle('exam-option', true);
      btn.classList.toggle('chosen', l === letter);
      // legacy class for old renderExamUI compatibility
      btn.classList.toggle('selected', l === letter);
    }
  });

  // Update progress strip and counter
  const answered = Object.keys(EXAM_STATE.answers).length;
  const total    = EXAM_STATE.questions.length;
  const pct      = (answered / total) * 100;
  const prog1 = $('exam-prog-fill'); if (prog1) prog1.style.width = pct + '%';
  const prog2 = $('exam-prog');      if (prog2) prog2.style.width = pct + '%';
  const ans1  = $('exam-answered-count'); if (ans1) ans1.textContent = answered;
  const ans2  = $('exam-answered');       if (ans2) ans2.textContent = answered;
}

function startExamTimer() {
  const update = () => {
    const t  = EXAM_STATE.timeLeft;
    const m  = Math.floor(t / 60);
    const s  = t % 60;
    const el = $('exam-timer');
    if (el) {
      el.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
      if (t <= 300) {
        el.style.color      = '#ef4444';
        el.style.background = '#ef444415';
        el.style.borderColor = '#ef444430';
      } else if (t <= 600) {
        el.style.color      = '#f59e0b';
        el.style.background = '#f59e0b15';
        el.style.borderColor = '#f59e0b30';
      } else {
        el.style.color      = '#818cf8';
        el.style.background = '#4f6ef715';
        el.style.borderColor = '#4f6ef730';
      }
    }
    if (t <= 0) {
      clearInterval(EXAM_STATE.timerInterval);
      toast('⏰ Time is up! Auto-submitting...');
      submitExam();
      return;
    }
    if (t === 300) toast('⚠️ 5 minutes remaining!');
    if (t === 600) toast('⏰ 10 minutes remaining!');
    EXAM_STATE.timeLeft--;
  };
  update();
  EXAM_STATE.timerInterval = setInterval(update, 1000);
}

function setupAntiCheat() {
  document.removeEventListener('visibilitychange', handleTabSwitch);
  document.addEventListener('visibilitychange', handleTabSwitch);
}

function handleTabSwitch() {
  if (document.hidden && EXAM_STATE.examId) {
    EXAM_STATE.tabSwitches++;
    // New fullscreen IDs
    const warn1 = $('exam-tab-warn');  if (warn1) warn1.style.display = 'flex';
    const cnt1  = $('exam-tab-count'); if (cnt1)  cnt1.textContent    = EXAM_STATE.tabSwitches;
    // Legacy IDs
    const warn2 = $('exam-cheat-warn'); if (warn2) warn2.style.display = 'block';
    const cnt2  = $('cheat-count');     if (cnt2)  cnt2.textContent    = EXAM_STATE.tabSwitches;
  }
}

function confirmSubmitExam() {
  const answered   = Object.keys(EXAM_STATE.answers).length;
  const total      = EXAM_STATE.questions.length;
  const unanswered = total - answered;
  if (unanswered > 0) {
    const ok = confirm(`You have ${unanswered} unanswered question${unanswered>1?'s':''}. Submit anyway?`);
    if (!ok) return;
  }
  submitExam();
}

async function submitExam() {
  clearInterval(EXAM_STATE.timerInterval);
  document.removeEventListener('visibilitychange', handleTabSwitch);

  const overlay = $('exam-fullscreen-overlay');
  if (overlay) overlay.innerHTML = `<div class="exam-body" style="text-align:center;padding-top:3rem">
    <div style="font-size:1.5rem;margin-bottom:.5rem">⏳</div>
    <div style="color:#9ca3af;font-size:.88rem">Submitting your exam...</div>
  </div>`;

  try {
    const r = await fetch('/api/exam/submit', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        sid: S.sid, exam_id: EXAM_STATE.examId,
        answers: EXAM_STATE.answers, tab_switches: EXAM_STATE.tabSwitches
      })
    });
    if (!r.ok) throw new Error((await r.json()).detail || 'Submit failed');
    const d = await r.json();
    renderExamResults(d, overlay);
  } catch(e) {
    if (overlay) overlay.innerHTML = `<div class="exam-body" style="text-align:center;padding-top:3rem">
      <div style="font-size:2rem;margin-bottom:.5rem">⚠️</div>
      <div style="color:#9ca3af;margin-bottom:1.5rem;font-size:.88rem">Submission failed: ${esc(e.message)}</div>
      <button onclick="closeExamMode()" class="btn-start" style="padding:10px 28px">← Back</button>
    </div>`;
  }
  EXAM_STATE.examId = null;
}

function renderExamResults(d, container) {
  const wrap = container || $('exam-fullscreen-overlay');
  if (!wrap) return;
  wrap.style.display = 'flex';

  const grade  = d.grade || 'F';
  const score  = d.score || 0;
  const emoji  = score >= 70 ? '🏆' : score >= 50 ? '👍' : '📚';
  const msg    = score >= 70 ? 'Excellent work!' : score >= 50 ? 'Good effort!' : 'Keep practising!';
  const gColor = grade==='A'?'#22c55e':grade==='B'?'#4f6ef7':grade==='C'?'#f59e0b':'#ef4444';

  wrap.innerHTML = `
    <div class="exam-results-wrap">
      <div style="width:100%;max-width:600px">

        <!-- Score card -->
        <div style="background:#13151c;border:1px solid rgba(255,255,255,0.08);border-radius:20px;
                    padding:2rem;text-align:center;margin-bottom:1.25rem">
          <div style="font-size:3rem;margin-bottom:.5rem">${emoji}</div>
          <div style="font-family:var(--font);font-size:3.5rem;font-weight:800;line-height:1;
                      background:linear-gradient(135deg,var(--accent),var(--accent2));
                      -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text">
            ${score}%
          </div>
          <div style="font-size:1.3rem;font-weight:800;margin:.4rem 0;color:${gColor}">Grade ${grade}</div>
          <div style="color:#9ca3af;font-size:.88rem;margin-bottom:1rem">${msg}</div>
          <div style="display:flex;gap:1.5rem;justify-content:center;flex-wrap:wrap">
            <div style="text-align:center">
              <div style="font-family:var(--font);font-size:1.4rem;font-weight:800;color:#e5e7eb">${d.correct||0}/${d.total||0}</div>
              <div style="font-size:.7rem;color:#6b7280;text-transform:uppercase;letter-spacing:.06em">Correct</div>
            </div>
            ${d.time_taken ? `<div style="text-align:center">
              <div style="font-family:var(--font);font-size:1.4rem;font-weight:800;color:#e5e7eb">${d.time_taken}</div>
              <div style="font-size:.7rem;color:#6b7280;text-transform:uppercase;letter-spacing:.06em">Time</div>
            </div>` : ''}
            ${(d.tab_switches||EXAM_STATE?.tabSwitches||0) > 0 ? `<div style="text-align:center">
              <div style="font-family:var(--font);font-size:1.4rem;font-weight:800;color:#ef4444">${d.tab_switches||EXAM_STATE?.tabSwitches||0}</div>
              <div style="font-size:.7rem;color:#6b7280;text-transform:uppercase;letter-spacing:.06em">Tab switches</div>
            </div>` : ''}
          </div>
        </div>

        <!-- Question breakdown -->
        <div style="font-family:var(--font);font-weight:700;font-size:.9rem;color:#e5e7eb;margin-bottom:.75rem">
          Question Breakdown
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:1.5rem">
          ${(d.breakdown||[]).map((b, i) => `
            <div style="background:${b.is_correct?'#22c55e0d':'#ef44440d'};
                        border:1px solid ${b.is_correct?'#22c55e25':'#ef444425'};
                        border-radius:12px;padding:12px 14px">
              <div style="display:flex;align-items:flex-start;gap:8px">
                <span style="font-size:.9rem;flex-shrink:0">${b.is_correct?'✅':'❌'}</span>
                <div style="flex:1">
                  <div style="font-size:.84rem;font-weight:600;color:#e5e7eb;margin-bottom:4px">
                    Q${i+1}: ${esc(b.question)}
                  </div>
                  ${!b.is_correct ? `
                    <div style="font-size:.75rem;color:#9ca3af">
                      Your answer: <span style="color:#ef4444;font-weight:600">${b.your_answer||'Not answered'}</span>
                      &nbsp;·&nbsp; Correct: <span style="color:#22c55e;font-weight:600">${b.correct}</span>
                    </div>
                    ${b.explanation ? `<div style="font-size:.75rem;color:#6b7280;margin-top:4px;font-style:italic">💡 ${esc(b.explanation)}</div>` : ''}
                  ` : ''}
                </div>
              </div>
            </div>`).join('')}
        </div>

        <button onclick="closeExamMode()"
          style="width:100%;padding:13px;background:var(--accent);color:#fff;border:none;
                 border-radius:10px;font-family:var(--font);font-weight:700;font-size:.9rem;cursor:pointer">
          ← Back to Courses
        </button>
      </div>
    </div>`;
}

async function viewMyExamResult(examId) {
  // Show results in the fullscreen overlay
  let overlay = $('exam-fullscreen-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'exam-fullscreen-overlay';
    overlay.className = 'exam-fullscreen';
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `<div class="exam-body" style="text-align:center;padding-top:3rem">
    <div style="font-size:1.5rem;margin-bottom:.5rem">⏳</div>
    <div style="color:#9ca3af;font-size:.88rem">Loading results...</div>
  </div>`;
  overlay.style.display = 'flex';

  try {
    const r = await fetch(`/api/exam/student-results?sid=${encodeURIComponent(S.sid)}`);
    const d = await r.json();
    const result = (d.results || []).find(res => res.exam_id === examId);
    if (!result) {
      overlay.innerHTML = `<div class="exam-body" style="text-align:center;padding-top:3rem">
        <div style="font-size:2rem;margin-bottom:.5rem">📝</div>
        <div style="color:#9ca3af;margin-bottom:1.5rem">No submission found for this exam.</div>
        <button onclick="closeExamMode()" class="btn-start" style="padding:10px 28px">← Back</button>
      </div>`;
      return;
    }
    renderExamResults(result, overlay);
  } catch {
    overlay.innerHTML = `<div class="exam-body" style="text-align:center;padding-top:3rem">
      <div style="font-size:2rem;margin-bottom:.5rem">⚠️</div>
      <div style="color:#9ca3af;margin-bottom:1.5rem">Could not load results.</div>
      <button onclick="closeExamMode()" class="btn-start" style="padding:10px 28px">← Back</button>
    </div>`;
  }
}

async function enterExamById() {
  const inp = $('exam-id-input');
  const err = $('exam-entry-err');
  const btn = $('exam-entry-btn');
  const id  = inp?.value.trim();

  if (!id) { if (err) err.textContent = 'Enter an Exam ID.'; return; }
  if (err) err.textContent = '';
  if (btn) { btn.disabled = true; btn.textContent = 'Loading...'; }

  try {
    await launchExamMode(id, CURRENT_CLASS?.code || '');
  } catch(e) {
    if (err) err.textContent = e.message || 'Could not start exam.';
  }
  if (btn) { btn.disabled = false; btn.textContent = '▶ Start Exam'; }
}

function renderExamResults(d) {
  const takeView = $('exam-take-view');
  if (!takeView) return;

  const grade   = d.grade;
  const emoji   = d.score >= 70 ? '🏆' : d.score >= 50 ? '👍' : '📚';
  const msg     = d.score >= 70 ? 'Excellent work!' : d.score >= 50 ? 'Good effort!' : 'Keep practising!';
  const gColor  = grade==='A'?'#22c55e':grade==='B'?'#4f6ef7':grade==='C'?'#f59e0b':'#ef4444';

  takeView.innerHTML = `
    <div style="padding:1.5rem">
      <!-- Score card -->
      <div style="background:var(--card);border:1px solid var(--border);border-radius:16px;
                  padding:1.5rem;text-align:center;margin-bottom:1rem">
        <div style="font-size:2.5rem;margin-bottom:.5rem">${emoji}</div>
        <div style="font-family:var(--font);font-size:3rem;font-weight:800;
                    background:linear-gradient(135deg,var(--accent),var(--accent2));
                    -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text">
          ${d.score}%
        </div>
        <div style="font-size:1.1rem;font-weight:700;margin:.25rem 0;color:${gColor}">Grade ${grade}</div>
        <div style="color:var(--muted);font-size:.85rem;margin-bottom:.75rem">${msg}</div>
        <div style="display:flex;gap:1rem;justify-content:center;flex-wrap:wrap">
          <span style="font-size:.82rem;color:var(--muted)">✅ ${d.correct}/${d.total} correct</span>
          ${d.time_taken ? `<span style="font-size:.82rem;color:var(--muted)">⏱ ${d.time_taken}</span>` : ''}
        </div>
      </div>

      <!-- Question breakdown -->
      <div style="font-family:var(--font);font-weight:700;font-size:.9rem;margin-bottom:.75rem">Question Breakdown</div>
      <div style="display:flex;flex-direction:column;gap:8px;max-height:50vh;overflow-y:auto">
        ${d.breakdown.map((b, i) => `
          <div style="background:${b.is_correct ? '#22c55e10' : '#ef444410'};
                      border:1px solid ${b.is_correct ? '#22c55e30' : '#ef444430'};
                      border-radius:10px;padding:10px 12px">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
              <span style="font-size:.85rem">${b.is_correct ? '✅' : '❌'}</span>
              <span style="font-size:.82rem;font-weight:600">Q${i+1}: ${esc(b.question)}</span>
            </div>
            ${!b.is_correct ? `
              <div style="font-size:.75rem;color:var(--muted)">
                Your answer: <span style="color:#ef4444;font-weight:600">${b.your_answer || 'Not answered'}</span> ·
                Correct: <span style="color:#22c55e;font-weight:600">${b.correct}</span>
              </div>
              ${b.explanation ? `<div style="font-size:.75rem;color:var(--muted);margin-top:3px;font-style:italic">${esc(b.explanation)}</div>` : ''}
            ` : ''}
          </div>`).join('')}
      </div>

      <button class="btn-start" style="width:100%;margin-top:1rem;padding:11px"
        onclick="$('exam-take-view').style.display='none';$('exam-list-view').style.display='block'">
        ← Back to Exams
      </button>
    </div>`;
}

async function viewMyExamResult(examId) {
  const takeView = $('exam-take-view');
  const listView = $('exam-list-view');
  if (!takeView) return;
  listView.style.display = 'none';
  takeView.style.display = 'block';
  takeView.innerHTML = `<div class="empty-state"><div class="es-icon">⏳</div><div class="es-text">Loading results...</div></div>`;

  try {
    const r = await fetch(`/api/exam/student-results?sid=${encodeURIComponent(S.sid)}`);
    const d = await r.json();
    const result = (d.results || []).find(r => r.exam_id === examId);
    if (!result) {
      takeView.innerHTML = `<div class="empty-state"><div class="es-icon">📝</div><div class="es-text">No submission found for this exam.</div>
        <button class="btn-start" style="margin-top:1rem;padding:8px 20px" onclick="$('exam-take-view').style.display='none';$('exam-list-view').style.display='block'">← Back</button></div>`;
      return;
    }
    renderExamResults(result);
  } catch(e) {
    takeView.innerHTML = `<div class="empty-state"><div class="es-icon">⚠️</div><div class="es-text">Could not load results.</div></div>`;
  }
}

async function enterExamById() {
  const inp  = $('exam-id-input');
  const err  = $('exam-entry-err');
  const btn  = $('exam-entry-btn');
  const view = $('exam-entry-view');
  const id   = inp?.value.trim();

  if (!id) { if (err) err.textContent = 'Enter an Exam ID.'; return; }
  if (err) err.textContent = '';
  if (btn) { btn.disabled = true; btn.textContent = 'Loading...'; }

  try {
    const r = await fetch('/api/exam/start', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ sid: S.sid, exam_id: id, code: CURRENT_CLASS?.code || '' })
    });

    if (r.status === 409) {
      if (err) err.textContent = 'You have already submitted this exam.';
      if (btn) { btn.disabled = false; btn.textContent = '▶ Start Exam'; }
      return;
    }
    if (!r.ok) {
      const e = await r.json();
      if (err) err.textContent = e.detail || 'Exam not found. Check the ID.';
      if (btn) { btn.disabled = false; btn.textContent = '▶ Start Exam'; }
      return;
    }

    const d = await r.json();
    EXAM_STATE = {
      examId: id, code: CURRENT_CLASS?.code || '',
      questions: d.questions, answers: {},
      timerInterval: null, timeLeft: d.duration * 60,
      tabSwitches: 0, title: d.title
    };

    // Hide the entry form, render exam in view div
    inp.closest('div.r-card, div[style]').style.display = 'none';
    if (!view) return;
    view.style.display = 'block';
    renderExamUI(view);
    startExamTimer();
    setupAntiCheat();
  } catch(e) {
    if (err) err.textContent = 'Connection error — try again.';
    if (btn) { btn.disabled = false; btn.textContent = '▶ Start Exam'; }
  }
}

// ═══════════════════════════ CLASSES ════════════════════════════
let CURRENT_CLASS = null;

async function loadClasses() {
  clearInterval(DISCUSS_INTERVAL);

  const panel = $('panel-courses');
  if (!panel) return;

  // Always rebuild — safe no matter what was showing before
  panel.innerHTML = `
    <div style="padding:1.25rem">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.25rem">
        <div>
          <h2 style="font-family:var(--font);font-size:1.2rem;font-weight:800;letter-spacing:-.02em">🏫 Courses</h2>
          <p style="font-size:.78rem;color:var(--muted);margin-top:2px" id="classes-subtitle">Loading...</p>
        </div>
        <button class="btn-start" style="padding:8px 16px;font-size:.8rem" onclick="showJoinClass()">+ Join Class</button>
      </div>
      <div id="classes-list-area">
        <div class="empty-state"><div class="es-icon">⏳</div><div class="es-text">Loading classes...</div></div>
      </div>
    </div>`;

  const area     = $('classes-list-area');
  const subtitle = $('classes-subtitle');

  if (!S.sid) {
    area.innerHTML = '<div class="empty-state"><div class="es-icon">⚠️</div><div class="es-text">Please log in first.</div></div>';
    return;
  }

  try {
    const r = await fetch(`/api/class/student?sid=${encodeURIComponent(S.sid)}`);
    if (!r.ok) throw new Error(`${r.status}`);
    const d       = await r.json();
    const classes = d.classes || [];

    if (subtitle) subtitle.textContent = `${classes.length} class${classes.length !== 1 ? 'es' : ''} joined`;

    area.innerHTML = classes.length
      ? classes.map(cls => `
          <div class="class-card" onclick="openClass('${esc(cls.code)}')">
            <div class="class-icon">📚</div>
            <div class="class-info">
              <div class="class-name">${esc(cls.name)}</div>
              <div class="class-meta">${esc(cls.subject || '')} · ${esc(cls.lecturer || '')}</div>
            </div>
            <span style="color:var(--muted);font-size:1.1rem">›</span>
          </div>`).join('')
      : `<div class="empty-state">
           <div class="es-icon">🏫</div>
           <div class="es-text">No classes yet — tap "+ Join Class" and enter your lecturer's code!</div>
         </div>`;

  } catch(e) {
    area.innerHTML = `
      <div class="empty-state">
        <div class="es-icon">⚠️</div>
        <div class="es-text" style="margin-bottom:1rem">Couldn't load classes.</div>
        <button class="btn-start" style="padding:8px 20px;font-size:.82rem" onclick="loadClasses()">↻ Try Again</button>
      </div>`;
  }
}

function renderClassesList(classes) {
  const root = $('classes-root');
  if (!root) return;
  root.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.25rem">
      <div>
        <h2 style="font-family:var(--font);font-size:1.2rem;font-weight:800;letter-spacing:-.02em">🏫 Courses</h2>
        <p style="font-size:.78rem;color:var(--muted);margin-top:2px">${classes.length} class${classes.length !== 1 ? 'es' : ''} joined</p>
      </div>
      <button class="btn-start" style="padding:8px 16px;font-size:.8rem" onclick="showJoinClass()">+ Join Class</button>
    </div>
    ${classes.length ? classes.map(cls => `
      <div class="class-card" onclick="openClass('${esc(cls.code)}')">
        <div class="class-icon">📚</div>
        <div class="class-info">
          <div class="class-name">${esc(cls.name)}</div>
          <div class="class-meta">${esc(cls.subject || '')} · ${esc(cls.lecturer || '')}</div>
        </div>
        <span style="color:var(--muted);font-size:1.1rem">›</span>
      </div>`).join('') : `
      <div class="empty-state" style="margin-top:1rem">
        <div class="es-icon">🏫</div>
        <div class="es-text">No classes yet — tap "+ Join Class" and enter your lecturer's code!</div>
      </div>`}`;
}

function showJoinClass() {
  const panel = $('panel-courses');
  if (!panel) return;
  panel.innerHTML = `
    <div style="flex:1;overflow-y:auto;padding:1.25rem">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:1.25rem">
        <button onclick="loadClasses()"
          style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:1.2rem;padding:2px 6px">←</button>
        <h2 style="font-family:var(--font);font-size:1.1rem;font-weight:800">Join a Class</h2>
      </div>
      <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:1.5rem;text-align:center">
        <div style="font-size:2.5rem;margin-bottom:.75rem">🔑</div>
        <p style="color:var(--muted);font-size:.85rem;margin-bottom:1.25rem">Enter the class code from your lecturer</p>
        <input
          type="text"
          id="join-code-inp"
          maxlength="8"
          placeholder="e.g. 4AFN9P"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="characters"
          spellcheck="false"
          style="width:100%;background:var(--surface);border:2px solid var(--border);border-radius:12px;
                 padding:14px;color:var(--text);font-family:var(--font);font-size:1.4rem;font-weight:800;
                 letter-spacing:.25em;text-align:center;text-transform:uppercase;outline:none;
                 margin-bottom:8px;box-sizing:border-box;transition:border-color .2s"
          onfocus="this.style.borderColor='var(--accent)'"
          onblur="this.style.borderColor='var(--border)'"
          onkeydown="if(event.key==='Enter') submitJoinClass()">
        <div id="join-err-msg" style="color:var(--red);font-size:.8rem;min-height:18px;margin-bottom:8px"></div>
        <button id="join-submit-btn" class="btn-start" style="width:100%;padding:12px"
          onclick="submitJoinClass()">Join Class</button>
      </div>
    </div>`;

  setTimeout(() => {
    const inp = $('join-code-inp');
    if (!inp) return;
    inp.focus();
    inp.addEventListener('input', function() {
      const pos = this.selectionStart;
      this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g,'');
      this.setSelectionRange(pos, pos);
    });
  }, 100);
}

async function submitJoinClass() {
  const inp  = $('join-code-inp');
  const btn  = $('join-submit-btn');
  const err  = $('join-err-msg');
  const code = (inp?.value || '').trim().toUpperCase();

  if (code.length < 4) {
    if (err) err.textContent = 'Enter a valid class code.';
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Joining...'; }
  if (err) err.textContent = '';

  try {
    const r = await fetch('/api/class/join', {
      method:  'POST',
      headers: {'Content-Type':'application/json'},
      body:    JSON.stringify({ sid: S.sid, code }),
    });
    const d = await r.json();
    if (!r.ok) {
      if (err) err.textContent = d.detail || 'Class not found. Check the code.';
      if (btn) { btn.disabled = false; btn.textContent = 'Join Class'; }
      return;
    }
    toast(`Joined "${d.name}" ✓ 🎉`);
    // Open the class directly — loadClasses() will run when we go back
    setTimeout(() => openClass(code), 500);
  } catch {
    if (err) err.textContent = 'Connection error — try again.';
    if (btn) { btn.disabled = false; btn.textContent = 'Join Class'; }
  }
}

async function openClass(code) {
  const panel = $('panel-courses');
  if (!panel) return;

  // Show loading directly in the panel
  panel.innerHTML = `
    <div style="padding:1.25rem">
      <div class="empty-state"><div class="es-icon">⏳</div><div class="es-text">Loading class...</div></div>
    </div>`;

  try {
    const r = await fetch(`/api/class/detail?code=${encodeURIComponent(code)}&sid=${encodeURIComponent(S.sid)}`);
    if (!r.ok) {
      toast('Could not load class — try again.');
      loadClasses();
      return;
    }
    CURRENT_CLASS      = await r.json();
    CURRENT_CLASS.code = code;
    renderClassDetail(CURRENT_CLASS);
  } catch(e) {
    toast('Connection error — try again.');
    loadClasses();
  }
}

function renderClassDetail(cls) {
  const panel = $('panel-courses');
  if (!panel) return;

  panel.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;padding:.875rem 1.25rem;
                background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0">
      <button onclick="clearInterval(DISCUSS_INTERVAL);loadClasses()"
        style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:1.2rem;
               flex-shrink:0;padding:2px 6px;border-radius:6px">←</button>
      <div style="flex:1;min-width:0">
        <div style="font-family:var(--font);font-weight:700;font-size:.95rem;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(cls.name)}</div>
        <div style="font-size:.72rem;color:var(--muted)">${esc(cls.subject || '')} · ${esc(cls.lecturer || '')}</div>
      </div>
      <button onclick="confirmLeaveClass('${cls.code}')"
        style="background:none;border:1px solid var(--border);border-radius:7px;padding:3px 9px;
               color:var(--muted);font-size:.7rem;cursor:pointer;flex-shrink:0">Leave</button>
    </div>

    <div class="class-tabs" id="class-tabs" style="flex-shrink:0">
      <button class="ctab active" onclick="switchClassTab('materials',this)">📁 Materials</button>
      <button class="ctab" onclick="switchClassTab('announcements',this)">📢 Notices</button>
      <button class="ctab" onclick="switchClassTab('live',this)">🔴 Live</button>
      <button class="ctab" onclick="switchClassTab('exams',this)">📝 Exams</button>
      <button class="ctab" onclick="switchClassTab('exam-entry',this)">🎯 Enter Exam</button>
      <button class="ctab" onclick="switchClassTab('assignments',this)">📋 Tasks</button>
      <button class="ctab" onclick="switchClassTab('discuss',this)">💬 Chat</button>
    </div>

    <div id="class-tab-content" style="flex:1;overflow:hidden;padding:1rem;min-height:0;display:block"></div>`;

  switchClassTab('materials');
}

function switchClassTab(tab, btn) {
  CURRENT_CLASS_TAB = tab;
  clearInterval(DISCUSS_INTERVAL);
  clearInterval(GROUP_INTERVAL);

  // Reset active buttons
  document.querySelectorAll('.ctab').forEach(b => b.classList.remove('active'));
  if (btn) {
    btn.classList.add('active');
  } else {
    document.querySelectorAll('.ctab').forEach(b => {
      if (b.textContent.toLowerCase().includes(tab.slice(0, 4))) b.classList.add('active');
    });
  }

  // Reset content div styles so chat's padding:0 doesn't bleed into other tabs
  const content = $('class-tab-content');
  if (content) {
    content.style.padding      = tab === 'discuss' || tab === 'group-chat' ? '0' : '1rem';
    content.style.display      = tab === 'discuss' ? 'flex' : 'block';
    content.style.flexDirection = tab === 'discuss' ? 'column' : '';
    content.style.overflow     = 'auto';
  }

  // For tabs that show live data, refetch fresh class detail first
  if (['materials','announcements','exams'].includes(tab) && CURRENT_CLASS?.code) {
    fetch(`/api/class/detail?code=${encodeURIComponent(CURRENT_CLASS.code)}&sid=${encodeURIComponent(S.sid)}`)
      .then(r => r.json())
      .then(fresh => {
        CURRENT_CLASS = { ...fresh, code: CURRENT_CLASS.code };
        renderClassTab(tab);
      })
      .catch(() => renderClassTab(tab));
  } else {
    renderClassTab(tab);
  }
}

function renderClassTab(tab) {
  const content = $('class-tab-content');
  if (!content || !CURRENT_CLASS) return;
  const cls = CURRENT_CLASS;

  // ── Materials ──────────────────────────────────────────────
  if (tab === 'materials') {
    const mats = cls.materials || [];
    const ICONS = { link:'🔗', note:'📝', file:'📄' };
    content.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.875rem">
        <div style="font-family:var(--font);font-weight:700;font-size:.9rem">📁 Materials <span style="color:var(--muted);font-weight:400;font-size:.78rem">${mats.length} item${mats.length !== 1 ? 's' : ''}</span></div>
        <button onclick="openClass('${cls.code}')" style="background:none;border:none;color:var(--accent);font-size:.75rem;cursor:pointer">↻ Refresh</button>
      </div>
      ${mats.length ? mats.slice().reverse().map(m => `
        <div class="material-item" onclick="openMaterial('${m.type}','${encodeURIComponent(m.url || m.content || '')}','${encodeURIComponent(m.title || '')}')">
          <span style="font-size:1.2rem">${ICONS[m.type]||'📄'}</span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:.88rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(m.title)}</div>
            <div style="font-size:.7rem;color:var(--muted);margin-top:2px">
              ${m.type.toUpperCase()} · ${m.date || ''}
              ${m.url ? `<span style="color:var(--accent)"> · ${esc(m.url.slice(0,40))}${m.url.length>40?'...':''}</span>` : ''}
            </div>
          </div>
          <span style="color:var(--muted);font-size:1rem;flex-shrink:0">›</span>
        </div>`).join('')
      : '<div class="empty-state"><div class="es-icon">📁</div><div class="es-text">No materials uploaded yet.<br><span style="font-size:.8rem;opacity:.7">Your lecturer will post notes, links and files here.</span></div></div>'}`;
  }

  // ── Announcements ──────────────────────────────────────────
  else if (tab === 'announcements') {
    const anns   = cls.announcements || [];
    const COLORS = { info: '#4f6ef7', warning: '#f59e0b', deadline: '#ef4444', exam: '#7c3aed' };
    const ICONS  = { info: '📘', warning: '⚠️', deadline: '⏰', exam: '📝' };
    content.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.875rem">
        <div style="font-family:var(--font);font-weight:700;font-size:.9rem">📢 Announcements</div>
        <button onclick="openClass('${cls.code}')" style="background:none;border:none;color:var(--accent);font-size:.75rem;cursor:pointer">↻ Refresh</button>
      </div>
      ${anns.length ? anns.slice().reverse().map(a => {
        const c = COLORS[a.type] || COLORS.info;
        return `
        <div style="background:${c}10;border:1px solid ${c}30;border-radius:12px;padding:12px 14px;margin-bottom:8px">
          <div style="display:flex;align-items:flex-start;gap:8px">
            <span style="font-size:1.1rem;flex-shrink:0">${ICONS[a.type]||'📘'}</span>
            <div style="flex:1">
              <div style="font-size:.88rem;line-height:1.55;color:var(--text)">${esc(a.text)}</div>
              <div style="display:flex;align-items:center;gap:6px;margin-top:5px">
                <span style="font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:${c}">${a.type||'info'}</span>
                <span style="font-size:.65rem;color:var(--muted)">·</span>
                <span style="font-size:.68rem;color:var(--muted)">📅 ${a.date}</span>
                ${a.author ? `<span style="font-size:.65rem;color:var(--muted)">· ${esc(a.author)}</span>` : ''}
              </div>
            </div>
          </div>
        </div>`}).join('')
      : '<div class="empty-state"><div class="es-icon">📢</div><div class="es-text">No announcements yet.</div></div>'}`;
  }

  // ── Live ───────────────────────────────────────────────────
  else if (tab === 'live') {
    const live = cls.live_class;
    content.innerHTML = live
      ? `<div class="live-class-banner" onclick="window.open('${esc(live.link)}','_blank')">
           <span style="font-size:1.5rem">🔴</span>
           <div>
             <div style="font-weight:700;color:var(--green)">${esc(live.title)}</div>
             <div style="font-size:.75rem;color:var(--muted)">Set ${live.date} · Tap to join</div>
           </div>
           <span style="color:var(--green);margin-left:auto;font-weight:700">Join →</span>
         </div>
         <p style="font-size:.78rem;color:var(--muted)">Check with your lecturer for the session schedule.</p>`
      : '<div class="empty-state"><div class="es-icon">🔴</div><div class="es-text">No live class link set yet.</div></div>';
  }

  // ── Exams ──────────────────────────────────────────────────
  else if (tab === 'exams') {
    const exams = cls.exams || [];
    if (!exams.length) {
      content.innerHTML = '<div class="empty-state"><div class="es-icon">📝</div><div class="es-text">No exams assigned yet.</div></div>';
      return;
    }
    content.innerHTML = exams.map(e => `
      <div class="assign-item">
        <div class="assign-title">📝 ${esc(e.title)}</div>
        <div style="font-size:.75rem;color:var(--muted);margin-bottom:8px">⏱ ${e.duration||60} mins · ${e.questions_per_student||30} questions · Assigned ${e.date||''}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn-start" style="padding:8px 16px;font-size:.8rem"
            onclick="launchExamMode('${e.id}','${cls.code}')">▶ Take Exam</button>
          <button class="btn-outline" style="padding:8px 16px;font-size:.8rem"
            onclick="viewMyExamResult('${e.id}')">📊 My Results</button>
        </div>
      </div>`).join('');
  }

  // ── Enter Exam by ID ───────────────────────────────────────
  else if (tab === 'exam-entry') {
    content.innerHTML = `
      <div style="max-width:400px">
        <div style="font-family:var(--font);font-weight:700;font-size:.95rem;margin-bottom:.3rem">🎯 Enter Exam by ID</div>
        <p style="font-size:.78rem;color:var(--muted);margin-bottom:1rem">Paste the Exam ID given by your lecturer.</p>
        <input id="exam-id-input" type="text" placeholder="e.g. ab5f5573-b"
          autocomplete="off" spellcheck="false"
          style="width:100%;background:var(--surface);border:2px solid var(--border);border-radius:10px;
                 padding:12px 14px;color:var(--text);font-family:var(--font);font-size:.92rem;outline:none;
                 transition:border-color .2s;box-sizing:border-box;margin-bottom:6px"
          onfocus="this.style.borderColor='var(--accent)'" onblur="this.style.borderColor='var(--border)'"
          onkeydown="if(event.key==='Enter') enterExamById()">
        <div id="exam-entry-err" style="color:var(--red);font-size:.78rem;min-height:16px;margin-bottom:8px"></div>
        <button id="exam-entry-btn" class="btn-start" style="width:100%;padding:11px" onclick="enterExamById()">
          ▶ Start Exam
        </button>
        <div id="exam-entry-view" style="margin-top:1rem"></div>
      </div>`;
  }

  // ── Assignments / Tasks ────────────────────────────────────
  else if (tab === 'assignments') {
    const assigns = cls.assignments || [];
    content.innerHTML = assigns.length
      ? assigns.map(a => `
          <div class="assign-item">
            <div class="assign-title">${esc(a.title)}</div>
            <div class="assign-desc">${esc(a.description)}</div>
            <div class="assign-due">⏰ Due: ${esc(a.due_date)}</div>
            <div style="margin-top:10px">
              <textarea id="sub-${a.id}" class="notes-area" style="min-height:80px;margin-bottom:6px"
                placeholder="Type your submission here..."></textarea>
              <button class="btn-start" style="padding:8px 16px;font-size:.8rem"
                onclick="submitAssignment('${cls.code}','${a.id}')">Submit</button>
            </div>
          </div>`).join('')
      : '<div class="empty-state"><div class="es-icon">📋</div><div class="es-text">No assignments yet.</div></div>';
  }

  // ── Class Chat (WhatsApp-style) ────────────────────────────
  else if (tab === 'discuss') {
    content.innerHTML = `
      <div class="wa-chat-wrap" style="height:100%">
        <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;
                    background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0">
          <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2));
                      display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.8rem;color:#fff">
            ${esc((cls.name||'?')[0].toUpperCase())}
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:.9rem">${esc(cls.name)}</div>
            <div style="font-size:.7rem;color:var(--muted)">Class chat</div>
          </div>
          <button onclick="switchClassTab('group-chat',null)"
            style="background:rgba(79,110,247,0.12);border:1px solid rgba(79,110,247,0.25);
                   border-radius:8px;padding:5px 10px;color:var(--accent);font-size:.72rem;
                   cursor:pointer;font-family:var(--font);font-weight:600;flex-shrink:0">
            👥 Groups
          </button>
        </div>
        <div class="wa-messages" id="discuss-msgs" style="flex:1;overflow-y:auto;min-height:0"></div>
        <div class="wa-input-bar" style="flex-shrink:0">
          <textarea id="discuss-input" class="wa-input" rows="1" placeholder="Type a message..."
            oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,100)+'px'"
            onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendDiscussion()}"></textarea>
          <button class="wa-send-btn" onclick="sendDiscussion()">➤</button>
        </div>
      </div>`;
    loadDiscussion(cls.code);
    DISCUSS_INTERVAL = setInterval(() => loadDiscussion(cls.code), 4000);
  }

  // ── Group Chat ─────────────────────────────────────────────
  else if (tab === 'group-chat') {
    content.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%">
        <div style="display:flex;align-items:center;justify-content:space-between;
                    padding:10px 14px;border-bottom:1px solid var(--border);flex-shrink:0">
          <div style="font-family:var(--font);font-weight:700;font-size:.9rem">👥 Group Chats</div>
          <button onclick="showCreateGroup()"
            style="background:var(--accent);color:#fff;border:none;border-radius:8px;
                   padding:5px 12px;font-size:.75rem;font-weight:700;cursor:pointer;font-family:var(--font)">
            + New Group
          </button>
        </div>
        <div id="group-list-area" style="flex:1;overflow-y:auto;padding:8px"></div>
      </div>`;
    loadGroupList();
  }
}
function openMaterial(type, encodedContent, encodedTitle) {
  const content = decodeURIComponent(encodedContent || '');
  const title   = decodeURIComponent(encodedTitle   || 'Material');
  if (type === 'link') {
    const url = content.startsWith('http') ? content : 'https://' + content;
    window.open(url, '_blank');
  } else {
    const div = document.createElement('div');
    div.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:300;display:flex;align-items:center;justify-content:center;padding:1.5rem;backdrop-filter:blur(6px)';
    div.innerHTML = `
      <div style="background:var(--card);border:1px solid var(--border);border-radius:16px;
                  padding:1.5rem;max-width:540px;width:100%;max-height:78vh;overflow-y:auto;
                  box-shadow:0 24px 60px #00000060">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
          <span style="font-weight:700;font-family:var(--font);font-size:.95rem">📝 ${esc(title)}</span>
          <button onclick="this.closest('div[style*=position]').remove()"
            style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:1.1rem;
                   padding:2px 6px;border-radius:6px;transition:color .15s"
            onmouseover="this.style.color='var(--text)'" onmouseout="this.style.color='var(--muted)'">✕</button>
        </div>
        <div style="white-space:pre-wrap;font-size:.88rem;line-height:1.7;color:var(--text)">${esc(content)}</div>
      </div>`;
    document.body.appendChild(div);
    div.addEventListener('click', e => { if (e.target === div) div.remove(); });
  }
}

async function loadDiscussion(code) {
  const msgs = $('discuss-msgs');
  if (!msgs) return;
  try {
    const r = await fetch(`/api/class/discuss?code=${encodeURIComponent(code)}`);
    const d = await r.json();
    const messages = d.messages || [];
    if (!messages.length) {
      msgs.innerHTML = `<div style="text-align:center;padding:2rem">
        <div style="font-size:2rem;margin-bottom:.5rem">💬</div>
        <div style="font-size:.84rem;color:var(--muted)">No messages yet — say hello!</div>
      </div>`;
      return;
    }
    const atBottom = msgs.scrollHeight - msgs.scrollTop <= msgs.clientHeight + 60;
    let lastDate = '';
    msgs.innerHTML = messages.map(m => {
      const mine    = m.sid === S.sid;
      const msgDate = m.date ? m.date.split(' ')[0] : '';
      let divider   = '';
      if (msgDate !== lastDate) {
        lastDate  = msgDate;
        const today     = new Date().toISOString().slice(0,10);
        const yesterday = new Date(Date.now()-86400000).toISOString().slice(0,10);
        const label = msgDate === today ? 'Today' : msgDate === yesterday ? 'Yesterday' : msgDate;
        divider = `<div class="wa-date-divider"><span>${label}</span></div>`;
      }
      const time = m.date ? m.date.split(' ')[1] || '' : '';
      return `${divider}
      <div class="wa-msg-row ${mine ? 'mine' : ''}">
        <div class="wa-av ${mine ? 'mine' : ''}">${(m.name||'?')[0].toUpperCase()}</div>
        <div class="wa-bubble ${mine ? 'mine' : 'theirs'}">
          ${!mine ? `<div class="wa-sender">${esc(m.name)}</div>` : ''}
          <div>${esc(m.message)}</div>
          <div class="wa-time">${time}</div>
        </div>
      </div>`;
    }).join('');
    if (atBottom) msgs.scrollTop = msgs.scrollHeight;
  } catch {}
}

async function sendDiscussion() {
  const input = $('discuss-input');
  const msg   = input?.value.trim();
  if (!msg || !CURRENT_CLASS) return;
  input.value = '';
  input.style.height = 'auto';
  // Optimistic UI — show immediately
  const msgs = $('discuss-msgs');
  if (msgs) {
    const now  = new Date().toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'});
    const div  = document.createElement('div');
    div.className = 'wa-msg-row mine';
    div.innerHTML = `
      <div class="wa-av mine">${S.name?.[0]?.toUpperCase()||'U'}</div>
      <div class="wa-bubble mine">
        <div>${esc(msg)}</div>
        <div class="wa-time">${now}</div>
      </div>`;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }
  try {
    await fetch('/api/class/discuss', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ sid: S.sid, code: CURRENT_CLASS.code, message: msg, name: S.name })
    });
  } catch { toast('Could not send message.'); }
}

// ── Group Chat JS ──────────────────────────────────────────────

let CURRENT_GROUP = null;
let GROUP_INTERVAL = null;

async function loadGroupList() {
  const area = $('group-list-area');
  if (!area) return;
  try {
    const r = await fetch(`/api/group/list?sid=${encodeURIComponent(S.sid)}`);
    const d = await r.json();
    const groups = d.groups || [];
    if (!groups.length) {
      area.innerHTML = `
        <div class="empty-state" style="margin-top:1.5rem">
          <div class="es-icon">👥</div>
          <div class="es-text">No groups yet.<br><span style="font-size:.78rem;opacity:.7">Create one or ask a classmate to share their group ID.</span></div>
        </div>
        <div style="margin-top:1rem;text-align:center">
          <input id="join-group-inp" class="sh-input" placeholder="Enter Group ID to join..."
            style="max-width:260px;margin-bottom:8px">
          <button class="btn-start" style="padding:7px 16px;font-size:.8rem;display:block;margin:0 auto"
            onclick="joinGroupById()">Join Group</button>
        </div>`;
      return;
    }
    area.innerHTML = `
      ${groups.map(g => `
        <div class="group-item" onclick="openGroupChat('${g.id}','${esc(g.name)}')">
          <div class="group-av">${g.name[0].toUpperCase()}</div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:.88rem">${esc(g.name)}</div>
            <div style="font-size:.72rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
              ${esc(g.last_msg || 'No messages yet')}
            </div>
          </div>
          <div style="font-size:.65rem;color:var(--muted);flex-shrink:0;margin-left:8px">
            👥 ${g.member_count}
          </div>
        </div>`).join('')}
      <div style="margin-top:.75rem;padding:.875rem;background:var(--surface);border:1px solid var(--border);border-radius:10px">
        <div style="font-size:.75rem;font-weight:600;color:var(--muted);margin-bottom:6px">Join another group</div>
        <div style="display:flex;gap:8px">
          <input id="join-group-inp" class="sh-input" placeholder="Group ID..." style="flex:1;font-size:.82rem">
          <button class="sh-add-btn" onclick="joinGroupById()">Join</button>
        </div>
      </div>`;
  } catch { if (area) area.innerHTML = '<div style="color:var(--muted);padding:1rem;font-size:.84rem">Could not load groups.</div>'; }
}

function showCreateGroup() {
  const area = $('group-list-area');
  if (!area) return;
  area.innerHTML = `
    <div style="padding:.5rem 0">
      <div style="font-family:var(--font);font-weight:700;font-size:.9rem;margin-bottom:.75rem">Create Group Chat</div>
      <input id="new-group-name" class="sh-input" placeholder="Group name e.g. Study Squad, BIO 201..."
        style="margin-bottom:8px" onkeydown="if(event.key==='Enter') createGroup()">
      <button class="btn-start" style="width:100%;padding:10px" onclick="createGroup()">Create Group</button>
      <button onclick="loadGroupList()" style="width:100%;margin-top:6px;background:none;border:1px solid var(--border);
        border-radius:8px;padding:9px;color:var(--muted);cursor:pointer;font-family:var(--font-body);font-size:.84rem">Cancel</button>
      <p style="font-size:.72rem;color:var(--muted);margin-top:.75rem;line-height:1.5">
        💡 Share your Group ID with classmates so they can join. Full username-based invites coming soon.
      </p>
    </div>`;
  $('new-group-name').focus();
}

async function createGroup() {
  const name = $('new-group-name')?.value.trim();
  if (!name) { toast('Enter a group name.'); return; }
  try {
    const r = await fetch('/api/group/create', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ sid: S.sid, name })
    });
    const d = await r.json();
    toast(`Group "${name}" created ✓ ID: ${d.group_id}`);
    // Show the ID so they can share it
    const area = $('group-list-area');
    if (area) {
      area.innerHTML = `
        <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1.25rem;text-align:center">
          <div style="font-size:1.5rem;margin-bottom:.5rem">🎉</div>
          <div style="font-family:var(--font);font-weight:700;margin-bottom:.5rem">Group Created!</div>
          <div style="font-size:.78rem;color:var(--muted);margin-bottom:.75rem">Share this ID with classmates:</div>
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;
                      padding:10px;font-family:monospace;font-size:.9rem;letter-spacing:.05em;margin-bottom:.75rem">${d.group_id}</div>
          <button onclick="navigator.clipboard.writeText('${d.group_id}').then(()=>toast('ID copied ✓'))"
            class="btn-start" style="padding:8px 20px;font-size:.8rem;margin-bottom:8px">📋 Copy ID</button>
          <br>
          <button onclick="openGroupChat('${d.group_id}','${esc(name)}')"
            class="btn-start" style="padding:8px 20px;font-size:.8rem;background:#22c55e">Open Chat →</button>
        </div>`;
    }
  } catch { toast('Could not create group.'); }
}

async function joinGroupById() {
  const gid = $('join-group-inp')?.value.trim();
  if (!gid) { toast('Enter a Group ID.'); return; }
  try {
    const r = await fetch('/api/group/join', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ sid: S.sid, group_id: gid })
    });
    if (!r.ok) { const e = await r.json(); toast(e.detail || 'Group not found.'); return; }
    const d = await r.json();
    toast(`Joined "${d.name}" ✓`);
    loadGroupList();
  } catch { toast('Could not join group.'); }
}

function openGroupChat(gid, gname) {
  CURRENT_GROUP = { id: gid, name: gname };
  clearInterval(GROUP_INTERVAL);
  const content = $('class-tab-content');
  if (!content) return;
  content.style.padding       = '0';
  content.style.display       = 'flex';
  content.style.flexDirection = 'column';
  content.style.overflow      = 'hidden';
  content.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;
                background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0">
      <button onclick="clearInterval(GROUP_INTERVAL);switchClassTab('group-chat',null)"
        style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:1.1rem;padding:2px 6px">←</button>
      <div class="group-av" style="width:32px;height:32px;font-size:.75rem;flex-shrink:0">${gname[0].toUpperCase()}</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:.9rem">${esc(gname)}</div>
        <div style="font-size:.68rem;color:var(--muted)">
          ID: ${gid}
          <button onclick="navigator.clipboard.writeText('${gid}').then(()=>toast('ID copied ✓'))"
            style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:.68rem;padding:0 3px">copy</button>
        </div>
      </div>
    </div>
    <div class="wa-messages" id="group-msgs" style="flex:1;overflow-y:auto;min-height:0"></div>
    <div class="wa-input-bar" style="flex-shrink:0">
      <textarea id="group-input" class="wa-input" rows="1" placeholder="Message..."
        oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,100)+'px'"
        onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendGroupMessage()}"></textarea>
      <button class="wa-send-btn" onclick="sendGroupMessage()">➤</button>
    </div>`;
  loadGroupMessages();
  GROUP_INTERVAL = setInterval(loadGroupMessages, 4000);
}

async function loadGroupMessages() {
  const msgs = $('group-msgs');
  if (!msgs || !CURRENT_GROUP) return;
  try {
    const r = await fetch(`/api/group/messages?group_id=${CURRENT_GROUP.id}&sid=${encodeURIComponent(S.sid)}`);
    const d = await r.json();
    const messages = d.messages || [];
    const atBottom = msgs.scrollHeight - msgs.scrollTop <= msgs.clientHeight + 60;
    if (!messages.length) {
      msgs.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--muted);font-size:.84rem">No messages yet — say hello! 👋</div>`;
      return;
    }
    let lastDate = '';
    msgs.innerHTML = messages.map(m => {
      const mine    = m.sid === S.sid;
      const msgDate = m.date ? m.date.split(' ')[0] : '';
      let divider   = '';
      if (msgDate !== lastDate) {
        lastDate = msgDate;
        const today = new Date().toISOString().slice(0,10);
        const label = msgDate === today ? 'Today' : msgDate;
        divider = `<div class="wa-date-divider"><span>${label}</span></div>`;
      }
      const time = m.date ? m.date.split(' ')[1] || '' : '';
      return `${divider}
      <div class="wa-msg-row ${mine ? 'mine' : ''}">
        <div class="wa-av ${mine ? 'mine' : ''}">${(m.name||'?')[0].toUpperCase()}</div>
        <div class="wa-bubble ${mine ? 'mine' : 'theirs'}">
          ${!mine ? `<div class="wa-sender">${esc(m.name)}</div>` : ''}
          <div>${esc(m.message)}</div>
          <div class="wa-time">${time}</div>
        </div>
      </div>`;
    }).join('');
    if (atBottom) msgs.scrollTop = msgs.scrollHeight;
  } catch {}
}

async function sendGroupMessage() {
  const input = $('group-input');
  const msg   = input?.value.trim();
  if (!msg || !CURRENT_GROUP) return;
  input.value = '';
  input.style.height = 'auto';
  const msgs = $('group-msgs');
  if (msgs) {
    const now = new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
    const div = document.createElement('div');
    div.className = 'wa-msg-row mine';
    div.innerHTML = `
      <div class="wa-av mine">${S.name?.[0]?.toUpperCase()||'U'}</div>
      <div class="wa-bubble mine"><div>${esc(msg)}</div><div class="wa-time">${now}</div></div>`;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }
  try {
    await fetch('/api/group/message', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ sid: S.sid, group_id: CURRENT_GROUP.id, message: msg, name: S.name })
    });
  } catch { toast('Could not send.'); }
}

// ── Exam.net-style full-screen exam mode ───────────────────────

async function launchExamMode(examId, code) {
  // Show a full-screen overlay
  let overlay = $('exam-fullscreen-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'exam-fullscreen-overlay';
    overlay.className = 'exam-fullscreen';
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `<div class="exam-body" style="padding-top:2rem;text-align:center">
    <div style="font-size:1.5rem;margin-bottom:.5rem">⏳</div>
    <div style="color:var(--muted);font-size:.88rem">Loading exam...</div>
  </div>`;
  overlay.style.display = 'flex';

  try {
    const r = await fetch('/api/exam/start', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ sid: S.sid, exam_id: examId, code })
    });
    if (r.status === 409) {
      overlay.innerHTML = `<div class="exam-body" style="text-align:center;padding-top:3rem">
        <div style="font-size:2.5rem;margin-bottom:.75rem">✅</div>
        <div style="font-family:var(--font);font-weight:700;font-size:1.1rem;margin-bottom:.5rem">Already Submitted</div>
        <div style="color:var(--muted);font-size:.84rem;margin-bottom:1.5rem">You have already completed this exam.</div>
        <button onclick="closeExamMode()" class="btn-start" style="padding:10px 28px">← Back</button>
      </div>`; return;
    }
    if (!r.ok) throw new Error((await r.json()).detail || 'Failed to load exam');
    const d = await r.json();
    EXAM_STATE = { examId, code, questions: d.questions, answers: {}, timerInterval: null,
                   timeLeft: d.duration * 60, tabSwitches: 0, title: d.title };
    renderExamModeUI(overlay);
    startExamTimer();
    setupAntiCheat();
  } catch(e) {
    overlay.innerHTML = `<div class="exam-body" style="text-align:center;padding-top:3rem">
      <div style="font-size:2rem;margin-bottom:.5rem">⚠️</div>
      <div style="color:var(--muted);font-size:.84rem;margin-bottom:1.5rem">${esc(e.message)}</div>
      <button onclick="closeExamMode()" class="btn-start" style="padding:10px 28px">← Back</button>
    </div>`;
  }
}

function closeExamMode() {
  clearInterval(EXAM_STATE?.timerInterval);
  document.removeEventListener('visibilitychange', handleTabSwitch);
  const overlay = $('exam-fullscreen-overlay');
  if (overlay) { overlay.style.display = 'none'; overlay.innerHTML = ''; }
}

function renderExamModeUI(overlay) {
  const q   = EXAM_STATE.questions;
  const tot = q.length;
  overlay.innerHTML = `
    <!-- Progress strip -->
    <div class="exam-progress-strip"><div id="exam-prog-fill" class="exam-progress-fill" style="width:0%"></div></div>

    <!-- Top bar -->
    <div class="exam-topbar">
      <div>
        <div style="font-family:var(--font);font-weight:700;font-size:.9rem;color:#e5e7eb;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px">
          ${esc(EXAM_STATE.title)}
        </div>
        <div style="font-size:.7rem;color:#6b7280;margin-top:1px">
          <span id="exam-answered-count">0</span>/${tot} answered
        </div>
      </div>
      <!-- Tab switch warning -->
      <div id="exam-tab-warn" style="display:none;background:#ef444415;border:1px solid #ef444430;
           border-radius:8px;padding:4px 10px;font-size:.72rem;color:#ef4444">
        ⚠️ Tab switch: <span id="exam-tab-count">0</span>x
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <div id="exam-timer" class="exam-timer-pill"
          style="background:#4f6ef715;color:#818cf8;border:1px solid #4f6ef730">--:--</div>
        <button onclick="confirmSubmitExam()"
          style="background:#22c55e;color:#fff;border:none;border-radius:8px;
                 padding:7px 14px;font-family:var(--font);font-weight:700;font-size:.82rem;cursor:pointer">
          Submit
        </button>
      </div>
    </div>

    <!-- Questions body -->
    <div class="exam-body" id="exam-questions-body">
      ${q.map((question, i) => `
        <div class="exam-q-block" id="eq-${i}">
          <div class="exam-q-label">Question ${i+1} of ${tot}</div>
          <div class="exam-q-text">${esc(question.question)}</div>
          <div>
            ${Object.entries(question.options || {}).map(([letter, text]) => `
              <button class="exam-option" id="eq-${i}-${letter}"
                onclick="selectExamAnswer(${i},'${letter}')">
                <span class="exam-opt-key">${letter}</span>
                <span>${esc(text)}</span>
              </button>`).join('')}
          </div>
        </div>`).join('')}
      <div style="text-align:center;padding:1.5rem 0 3rem">
        <button onclick="confirmSubmitExam()"
          style="background:var(--accent);color:#fff;border:none;border-radius:10px;
                 padding:13px 40px;font-family:var(--font);font-weight:700;font-size:.9rem;cursor:pointer">
          Submit Exam
        </button>
      </div>
    </div>`;
}



async function submitAssignment(code, assignId) {
  const ta      = $(`sub-${assignId}`);
  const content = ta?.value.trim();
  if (!content) { toast('Write your submission first.'); return; }
  try {
    const r = await fetch('/api/class/submit', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ sid: S.sid, code, assignment_id: assignId, content })
    });
    if (!r.ok) throw new Error();
    toast('Assignment submitted ✓');
    if (ta) ta.value = '';
  } catch { toast('Submission failed — try again.'); }
}

async function confirmLeaveClass(code) {
  if (!confirm('Leave this class?')) return;
  await fetch('/api/class/leave', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ sid: S.sid, code })
  });
  toast('Left class ✓');
  clearInterval(DISCUSS_INTERVAL);
  loadClasses();
}


async function loadLeaderboard() {
  const list = $('leaderboard-list');
  if (!S.sid) return;

  list.innerHTML = '<div class="empty-state"><div class="es-icon">⏳</div><div class="es-text">Loading...</div></div>';

  try {
    const r = await fetch('/api/leaderboard');
    const d = await r.json();
    const students = d.leaderboard || [];

    if (!students.length) {
      list.innerHTML = '<div class="empty-state"><div class="es-icon">🏆</div><div class="es-text">No rankings yet — take a quiz to appear here!</div></div>';
      return;
    }

    const medals = ['🥇','🥈','🥉'];
    list.innerHTML = students.map((s, i) => {
      const isMe = s.sid === S.sid;
      const rank = i + 1;
      return `
        <div class="lb-item ${isMe ? 'me' : ''}">
          <div class="lb-rank">${rank <= 3 ? medals[rank-1] : rank}</div>
          <div class="lb-avatar">${s.name[0].toUpperCase()}</div>
          <div class="lb-info">
            <div class="lb-name">${esc(s.name)} ${isMe ? '<span style="color:var(--accent);font-size:.7rem">(you)</span>' : ''}</div>
            <div class="lb-meta">${s.quizzes} quiz${s.quizzes !== 1 ? 'zes' : ''} · ${s.questions} questions</div>
          </div>
          <div class="lb-score">${s.avg_score}%</div>
        </div>`;
    }).join('');

    // Show my rank card
    const myRank = students.findIndex(s => s.sid === S.sid);
    if (myRank !== -1) {
      const me = students[myRank];
      $('my-rank-card').style.display = 'block';
      { const _e = $('my-rank-num'); if (_e) _e.textContent = `#${myRank + 1}`; }
      { const _e = $('my-rank-name'); if (_e) _e.textContent = me.name; }
      { const _e = $('my-rank-score'); if (_e) _e.textContent = `${me.avg_score}% avg · ${me.quizzes} quizzes`; }
    }

  } catch(e) {
    list.innerHTML = '<div class="empty-state"><div class="es-icon">⚠️</div><div class="es-text">Couldn\'t load leaderboard — try again.</div></div>';
  }
}

// ═══════════════════════════ NOTES ══════════════════════════════
function loadNotes() {
  const notes = JSON.parse(localStorage.getItem(`sivarr_notes_${S.sid}`) || '[]');
  renderNotes(notes);
  noteRenderTagBar(notes);
}

function renderNotes(notes, filter = '') {
  const list = $('notes-list'); if (!list) return;
  let display = notes;
  if (filter === '__search__') {
    const q = $('note-search')?.value.trim().toLowerCase();
    display  = q ? notes.filter(n => n.text.toLowerCase().includes(q) || (n.tag||'').toLowerCase().includes(q)) : notes;
  } else if (filter) {
    display = notes.filter(n => (n.tag||'').toLowerCase() === filter.toLowerCase());
  }
  if (!display.length) {
    list.innerHTML = `<div class="empty-state"><div class="es-icon">📓</div><div class="es-text">${filter ? 'No notes with this tag.' : 'No notes yet — tap New Note!'}</div></div>`;
    return;
  }
  list.innerHTML = display.map((n, i) => {
    const realIdx = notes.indexOf(n);
    const lines   = n.text.split('\n');
    const title   = lines[0].slice(0, 55) + (lines[0].length > 55 || lines.length > 1 ? '...' : '');
    const words   = n.text.trim().split(/\s+/).length;
    return `
      <div class="note-accordion" id="note-acc-${i}">
        <div class="note-acc-header" onclick="toggleNote(${i})">
          <div style="flex:1;min-width:0">
            <div class="note-acc-title">${esc(title)}</div>
            <div style="display:flex;align-items:center;gap:6px;margin-top:2px">
              ${n.tag ? `<span style="background:#4f6ef715;border:1px solid #4f6ef730;border-radius:10px;padding:1px 7px;font-size:.65rem;color:var(--accent);font-weight:700">${esc(n.tag)}</span>` : ''}
              <span class="note-acc-date">📅 ${n.date}</span>
              <span style="font-size:.65rem;color:var(--muted)">${words} words</span>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:5px;flex-shrink:0">
            <button onclick="event.stopPropagation();noteEdit(${realIdx})"
              style="background:none;border:1px solid var(--border);border-radius:6px;padding:3px 8px;color:var(--muted);font-size:.7rem;cursor:pointer;transition:all .15s"
              onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'"
              onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--muted)'">Edit</button>
            <button onclick="event.stopPropagation();deleteNote(${realIdx})"
              style="background:none;border:1px solid var(--border);border-radius:6px;padding:3px 8px;color:var(--muted);font-size:.7rem;cursor:pointer;transition:all .15s"
              onmouseover="this.style.borderColor='var(--red)';this.style.color='var(--red)'"
              onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--muted)'">Delete</button>
            <span class="note-acc-arrow" id="note-arrow-${i}">▼</span>
          </div>
        </div>
        <div class="note-acc-body" id="note-body-${i}" style="display:none">
          <div style="white-space:pre-wrap;font-size:.86rem;line-height:1.7;padding:.75rem 0;color:var(--text)">${esc(n.text)}</div>
        </div>
      </div>`;
  }).join('');
}

  function noteToggleForm() {
  const form = $('note-write-form');
  const open = form.style.display === 'none' || !form.style.display;
  form.style.display = open ? 'block' : 'none';
  if (open) {
    $('new-note-text').focus();
    delete $('new-note-text').dataset.editIdx;
    if ($('note-tag-input')) $('note-tag-input').value = '';
    if ($('new-note-text')) $('new-note-text').value = '';
    noteCharCount();
  }
}

function noteCharCount() {
  const ta  = $('new-note-text'); if (!ta) return;
  const wc  = ta.value.trim().split(/\s+/).filter(Boolean).length;
  const el  = $('note-char-count'); if (el) el.textContent = `${wc} word${wc!==1?'s':''}`;
}

function noteSearch() {
  const notes = JSON.parse(localStorage.getItem(`sivarr_notes_${S.sid}`) || '[]');
  renderNotes(notes, '__search__');
}

function noteRenderTagBar(notes) {
  const bar = $('note-tag-bar'); if (!bar) return;
  const tags = [...new Set(notes.map(n => n.tag).filter(Boolean))];
  if (!tags.length) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  bar.innerHTML = [`<button onclick="noteFilterTag('',this)" style="padding:4px 12px;border-radius:20px;border:1px solid var(--border);background:var(--card);color:var(--muted);font-family:var(--font);font-size:.72rem;font-weight:700;cursor:pointer;white-space:nowrap;transition:all .15s" class="note-tag-filter active">All</button>`,
    ...tags.map(t => `<button onclick="noteFilterTag('${esc(t)}',this)" style="padding:4px 12px;border-radius:20px;border:1px solid var(--border);background:var(--card);color:var(--muted);font-family:var(--font);font-size:.72rem;font-weight:700;cursor:pointer;white-space:nowrap;transition:all .15s" class="note-tag-filter">${esc(t)}</button>`)
  ].join('');
}

function noteFilterTag(tag, btn) {
  document.querySelectorAll('.note-tag-filter').forEach(b => {
    b.style.background = 'var(--card)'; b.style.color = 'var(--muted)'; b.style.borderColor = 'var(--border)';
  });
  btn.style.background = 'linear-gradient(135deg,var(--accent),var(--accent2))';
  btn.style.color = '#fff'; btn.style.borderColor = 'transparent';
  const notes = JSON.parse(localStorage.getItem(`sivarr_notes_${S.sid}`) || '[]');
  renderNotes(notes, tag);
}

function noteEdit(idx) {
  const notes = JSON.parse(localStorage.getItem(`sivarr_notes_${S.sid}`) || '[]');
  const note  = notes[idx]; if (!note) return;
  const ta    = $('new-note-text');
  const form  = $('note-write-form');
  if (ta) { ta.value = note.text; ta.dataset.editIdx = idx; }
  if ($('note-tag-input')) $('note-tag-input').value = note.tag || '';
  if (form) form.style.display = 'block';
  noteCharCount();
  ta?.focus();
  form?.scrollIntoView({ behavior: 'smooth' });
}
  
function toggleNote(idx) {
  const body  = $(`note-body-${idx}`);
  const arrow = $(`note-arrow-${idx}`);
  if (!body) return;
  const open = body.style.display === 'block';
  body.style.display  = open ? 'none' : 'block';
  if (arrow) arrow.textContent = open ? '▼' : '▲';
}

function saveNote() {
  const ta   = $('new-note-text');
  const text = ta?.value.trim();
  const tag  = $('note-tag-input')?.value.trim() || '';
  if (!text) { toast('Write something first!'); return; }

  const raw     = localStorage.getItem(`sivarr_notes_${S.sid}`) || '[]';
  const notes   = JSON.parse(raw);
  const editIdx = (ta.dataset.editIdx !== undefined && ta.dataset.editIdx !== '')
    ? parseInt(ta.dataset.editIdx) : -1;

  if (editIdx >= 0 && editIdx < notes.length) {
    notes[editIdx].text = text;
    notes[editIdx].tag  = tag;
    notes[editIdx].date = new Date().toLocaleString() + ' (edited)';
    delete ta.dataset.editIdx;
    toast('Note updated ✓');
  } else {
    notes.unshift({ text, tag, date: new Date().toLocaleString() });
    toast('Note saved ✓');
  }

  const trimmed = notes.slice(0, 100);
  localStorage.setItem(`sivarr_notes_${S.sid}`, JSON.stringify(trimmed));
  ta.value = '';
  if ($('note-tag-input')) $('note-tag-input').value = '';
  noteCharCount();
  $('note-write-form').style.display = 'none';
  renderNotes(trimmed);
  noteRenderTagBar(trimmed);
}

function deleteNote(idx) {
  const raw   = localStorage.getItem(`sivarr_notes_${S.sid}`) || '[]';
  const notes = JSON.parse(raw);
  notes.splice(idx, 1);
  localStorage.setItem(`sivarr_notes_${S.sid}`, JSON.stringify(notes));
  renderNotes(notes);
  toast('Note deleted');
}

// Character counter for notes
document.addEventListener('DOMContentLoaded', () => {
  const ta = document.getElementById('new-note-text');
  if (ta) {
    ta.addEventListener('input', () => {
      const len = ta.value.length;
      const counter = $('note-char-count');
      if (counter) {
        counter.textContent = `${len} / 1000`;
        counter.style.color = len > 900 ? 'var(--yellow)' : len > 999 ? 'var(--red)' : 'var(--muted)';
      }
    });
  }
});


// ═══════════════════════════ PROFILE DROPDOWN ═══════════════════
function toggleProfile() {
  const trigger  = $('profile-trigger');
  const dropdown = $('profile-dropdown');
  if (!trigger || !dropdown) return;
  const isOpen = dropdown.classList.contains('open');
  if (isOpen) { closeProfile(); }
  else { trigger.classList.add('open'); dropdown.classList.add('open'); }
}

function closeProfile() {
  const t = $('profile-trigger'); if (t) t.classList.remove('open');
  const d = $('profile-dropdown'); if (d) d.classList.remove('open');
}

document.addEventListener('click', e => {
  const menu = $('profile-menu');
  if (menu && !menu.contains(e.target)) closeProfile();
});

function toggleThemeFromMenu() {
  const isLight = document.body.classList.toggle('light');
  const sw      = $('pd-toggle-sw');
  const icon    = $('pd-theme-icon');
  const label   = $('pd-theme-label');
  if (sw)    sw.classList.toggle('on', isLight);
  if (icon)  icon.textContent  = isLight ? '☀️' : '🌙';
  if (label) label.textContent = isLight ? 'Light Mode' : 'Dark Mode';
  localStorage.setItem('sivarr_theme', isLight ? 'light' : 'dark');
}

function toggleTheme() { toggleThemeFromMenu(); }

// Apply saved theme on load
window.addEventListener('DOMContentLoaded', () => {
  if (localStorage.getItem('sivarr_theme') === 'light') {
    document.body.classList.add('light');
    const sw    = $('pd-toggle-sw');    if (sw)    sw.classList.add('on');
    const icon  = $('pd-theme-icon');   if (icon)  icon.textContent  = '☀️';
    const label = $('pd-theme-label');  if (label) label.textContent = 'Light Mode';
  }
});

// ═══════════════════════════ FILE UPLOAD ════════════════════════
async function uploadFile(input) {
  const file = input.files[0];
  if (!file || !S.sid) return;
  const zone = $('upload-zone');
  zone.innerHTML = `<div class="uz-icon">⏳</div><div class="uz-text">Uploading ${file.name}...</div>`;

  const formData = new FormData();
  formData.append('sid', S.sid);
  formData.append('file', file);

  try {
    const r = await fetch('/api/upload', { method: 'POST', body: formData });
    if (!r.ok) { const e = await r.json(); throw new Error(e.detail || 'Upload failed'); }
    const d = await r.json();

    // Reset zone
    zone.innerHTML = `<div class="uz-icon">📄</div><div class="uz-text">Drop a file or tap to upload</div><div class="uz-sub">.txt · .pdf · .md supported</div>`;

    // Show summary in chat
    addMsg('sivarr', `📎 File uploaded: ${d.filename}\n\n${d.summary}`);

    // Update file list
    S.uploadedFiles = S.uploadedFiles || [];
    S.uploadedFiles.push({ id: d.file_id, name: d.filename });
    renderFileList();

    toast(`${file.name} uploaded ✓`);
  } catch(e) {
    zone.innerHTML = `<div class="uz-icon">📄</div><div class="uz-text">Drop a file or tap to upload</div><div class="uz-sub">.txt · .pdf · .md supported</div>`;
    toast('Upload failed: ' + e.message);
  }
  input.value = '';
}

function handleDrop(e) {
  e.preventDefault();
  $('upload-zone').classList.remove('drag');
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const dt = new DataTransfer();
  dt.items.add(file);
  $('file-input').files = dt.files;
  uploadFile($('file-input'));
}

function renderFileList() {
  const list = $('file-list');
  if (!list || !S.uploadedFiles || !S.uploadedFiles.length) return;
  list.innerHTML = S.uploadedFiles.map(f => `
    <div class="file-item">
      <div>
        <div class="fi-name">📄 ${esc(f.name)}</div>
      </div>
      <button class="btn-file-quiz" onclick="quizFromFile('${f.id}')">Quiz me</button>
    </div>`).join('');
}

function quizFromFile(fileId) {
  S.quizFileId = fileId;
  nav('quiz', $('mn-quiz') || document.querySelector('.nav-btn[onclick*="quiz"]'));
  startQuizFromFile(fileId);
}

async function startQuizFromFile(fileId) {
  S.quizActive = true; S.quizQ = 0; S.quizScore = 0; S.quizFileId = fileId;
  const qw = $('qw');
  qw.innerHTML = `<div style="padding:2rem;text-align:center;color:var(--muted)">Generating question 1/5 from your document...</div>`;
  const r = await fetch(`/api/quiz/question?sid=${S.sid}&difficulty=${S.diff}&file_id=${fileId}`);
  const q = await r.json();
  if (q.error) { toast(q.error); resetQuiz(); return; }
  S.curQ = q;
  renderQ(q);
}

// ═══════════════════════════ DOWNLOAD ═══════════════════════════
function downloadText(text) {
  const clean = text.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"');
  const blob = new Blob([`Sivarr AI Response\n${'─'.repeat(40)}\n\n${clean}\n\nDownloaded from Sivarr AI`], {type:'text/plain'});
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `sivarr_answer_${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ═══════════════════════════ SHARE ══════════════════════════════
async function shareResult(score, topic) {
  try {
    const r = await API('/api/share', {
      name: S.name, score: score, topic: topic,
      difficulty: S.diff, type: 'quiz',
    });
    const url = window.location.origin + r.url;
    // Copy to clipboard
    await navigator.clipboard.writeText(url);
    toast('Share link copied to clipboard! 🔗');
  } catch(e) {
    toast('Could not create share link — try again.');
  }
      }

