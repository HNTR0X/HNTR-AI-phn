"""
╔══════════════════════════════════════════════════════╗
║              SIVARR AI TUTOR  v4.0                   ║
║     Your Growth. Your Journey. Your Future.          ║
║     Founded by Oladunni Testimony                    ║
║     Built for Lead City University                   ║
╚══════════════════════════════════════════════════════╝

Features:
  CORE        → Q&A, Math, Progress, Memory, Cache, Fact-check
  QUIZ        → Multiple choice, Difficulty levels, Question bank
  REVISION    → Wrong answer review and clearing
  WRITING     → Essays, Stories, Poems, Proofreading, Summaries,
                Translation, Assignment structure
  STUDY TOOLS → Study notes, Flashcards, Timetable, Exam questions
  CRITICAL    → Debate mode, Devil's advocate, Case study analysis
  CAREER      → CV writer, Interview prep, Career paths, LinkedIn bio
  PRODUCTIVITY→ To-do list, Daily goals, Study timer
  FUN         → Trivia, Word of the day, Brain teasers, Motivation
"""

import ast
import datetime
import json
import os
import random
import re
import shutil
import socket
import time
import warnings

warnings.filterwarnings("ignore")

try:
    import google.generativeai as genai
    GEMINI_AVAILABLE = True
except ImportError:
    GEMINI_AVAILABLE = False

# ═══════════════════════════════════════════════════════════════
#  CONFIGURATION
# ═══════════════════════════════════════════════════════════════

VERSION       = "4.0"
CACHE_EXPIRY  = 30
HISTORY_LIMIT = 40
BANK_LIMIT    = 20

GEMINI_MODELS = [
    "gemini-1.5-flash", "gemini-1.5-pro",
    "gemini-pro", "gemini-1.0-pro",
]

DIFFICULTY_LEVELS = ["easy", "medium", "hard"]

MATH_TRIGGERS = [
    "solve", "calculate", "differentiate", "integrate", "expand",
    "factorise", "factorize", "simplify", "equation", "algebra",
    "quadratic", "derivative", "integral", "calculus", "gradient",
    "inequality", "simultaneous", "matrix", "fraction", "percentage",
    "ratio", "proof", "theorem", "logarithm", "log", "sin", "cos",
    "tan", "trigonometry", "polynomial", "expression", "formula",
    "find x", "find the value", "work out", "what is the area",
    "volume", "perimeter", "probability", "statistics",
    "mean", "median", "mode",
]

TOPIC_STRIP_WORDS = ["what is", "define", "explain", "solve", "calculate"]

UNCERTAINTY_PHRASES = [
    "i'm not sure", "i am not sure", "i'm not certain", "i cannot verify",
    "i don't know", "i do not know", "it's unclear", "may not be accurate",
    "cannot confirm", "you should verify", "double check", "consult a",
    "check with", "limited information", "not entirely sure",
]

IDENTITY_TRIGGERS = [
    "who are you", "what are you", "what is sivarr", "who is sivarr",
    "tell me about yourself", "about you", "what can you do",
    "what do you do", "are you an ai", "introduce yourself",
    "what are your features", "about sivarr",
]

LIBRARY_PATH = "knowledge_library.json"
BANK_PATH    = "question_bank.json"
TODOS_PATH   = "todos.json"
ENV_PATH     = ".env"

WORD_OF_DAY_LIST = [
    ("Ephemeral",   "lasting for a very short time"),
    ("Perspicacious","having a ready insight; shrewd"),
    ("Sycophant",   "a person who flatters powerful people to gain advantage"),
    ("Ubiquitous",  "present everywhere at the same time"),
    ("Tenacious",   "holding firmly to something; persistent"),
    ("Eloquent",    "fluent and persuasive in speaking or writing"),
    ("Pragmatic",   "dealing with things in a practical, realistic way"),
    ("Resilient",   "able to recover quickly from difficulties"),
    ("Cogent",      "clear, logical, and convincing"),
    ("Astute",      "having an ability to accurately assess situations"),
]

MOTIVATIONAL_QUOTES = [
    "The secret of getting ahead is getting started. — Mark Twain",
    "It always seems impossible until it's done. — Nelson Mandela",
    "Don't watch the clock; do what it does. Keep going. — Sam Levenson",
    "Success is the sum of small efforts repeated day in and day out.",
    "You don't have to be great to start, but you have to start to be great.",
    "Believe you can and you're halfway there. — Theodore Roosevelt",
    "Hard work beats talent when talent doesn't work hard.",
    "Push yourself because no one else is going to do it for you.",
]

BRAIN_TEASERS = [
    ("I speak without a mouth and hear without ears. I have no body but come alive with wind. What am I?", "An echo"),
    ("The more you take, the more you leave behind. What am I?", "Footsteps"),
    ("What has keys but no locks, space but no room, and you can enter but can't go inside?", "A keyboard"),
    ("I have cities but no houses, mountains but no trees, water but no fish. What am I?", "A map"),
    ("What can travel around the world while staying in a corner?", "A stamp"),
    ("The more you have of it, the less you see. What is it?", "Darkness"),
]

# ═══════════════════════════════════════════════════════════════
#  AI PROMPTS
# ═══════════════════════════════════════════════════════════════

SYSTEM_PROMPT = f"""\
You are the Sivarr AI — a casual, brilliant, and versatile learning companion
for university students at Lead City University.

About Sivarr:
• Founded by Oladunni Testimony, a Lead City University student.
• Mission: student → skilled professional → employed talent → career growth.
• Version: {VERSION}

Core rules:
1. Be casual and encouraging — like a smart friend, not a textbook.
2. Keep answers SHORT — 2 to 4 sentences unless the task needs more.
3. Show step-by-step only when explicitly asked.
4. Answer ANY question on any subject.
5. If unsure, say so clearly — never confidently guess wrong.
6. For creative writing tasks — be expressive, vivid, and engaging.
7. For career tasks — be professional, specific, and actionable.
"""

MATH_PROMPT = """\
You are Sivarr's math expert.
1. State the final answer clearly and concisely.
2. Do NOT show steps unless asked.
3. One line is enough for simple problems e.g. "x = 5".
4. Be casual — a quick "easy!" is fine.
5. If unsure, say so.
"""

QUIZ_PROMPT = """\
Generate a {difficulty} multiple choice question about: {topic}
Difficulty: easy=basic recall, medium=application, hard=analysis
Reply ONLY with valid JSON:
{{
  "question": "...",
  "options": {{"A": "...", "B": "...", "C": "...", "D": "..."}},
  "answer": "A",
  "explanation": "One sentence."
}}"""

SUGGESTION_PROMPT = """\
You are Sivarr's study advisor. Student: {name}
Studied: {topics} | Weakest: {weak} | Quiz: {quiz_summary} | Difficulty: {difficulty}
Recommend exactly 3 specific topics. Numbered list, one sentence each. Be encouraging.
"""

# ── Writing prompts ───────────────────────────────────────────

ESSAY_PROMPT = """\
Write a well-structured {essay_type} essay on: {topic}
Length: {length}
Tone: {tone}
Include: introduction, body paragraphs, conclusion.
Make it engaging and academically appropriate for a university student.
"""

STORY_PROMPT = """\
Write a {genre} story about: {topic}
Length: {length}
Make it vivid, engaging, and with a clear beginning, middle, and end.
"""

POEM_PROMPT = """\
Write a {style} poem about: {topic}
Make it expressive, creative, and emotionally resonant.
"""

PROOFREAD_PROMPT = """\
Proofread and correct the following text. Fix all grammar, spelling, punctuation,
and sentence structure errors. Return the corrected version followed by a brief
summary of the main changes made.

Text:
{text}
"""

SUMMARISE_PROMPT = """\
Summarise the following text clearly and concisely in {length}.
Capture all the key points without losing important details.

Text:
{text}
"""

TRANSLATE_PROMPT = """\
Translate the following text to {language}. Keep the tone and meaning intact.

Text:
{text}
"""

STRUCTURE_PROMPT = """\
Help structure a {doc_type} on: {topic}
Provide a detailed outline with sections, subsections, and brief notes
on what to cover in each part. Make it practical for a university student.
"""

# ── Study tool prompts ────────────────────────────────────────

NOTES_PROMPT = """\
Generate comprehensive study notes on: {topic}
Format clearly with headings, key points, and examples.
Make it concise but thorough — perfect for exam revision.
"""

FLASHCARD_PROMPT = """\
Generate {count} flashcards on: {topic}
Format ONLY as valid JSON — no extra text:
[
  {{"front": "Question or term", "back": "Answer or definition"}},
  ...
]
"""

TIMETABLE_PROMPT = """\
Create a study timetable for a student with these exams:
{exams}
Available study days: {days}
Hours per day: {hours}
Include breaks, revision sessions, and past paper practice.
Make it realistic and balanced.
"""

EXAM_QUESTIONS_PROMPT = """\
Generate {count} likely exam questions on: {topic}
Mix of question types: definitions, short answer, and essay questions.
Base them on common university exam patterns.
Number each question clearly.
"""

# ── Critical thinking prompts ─────────────────────────────────

DEBATE_PROMPT = """\
You are a skilled debater arguing {side} on this topic: {topic}
Make 3 strong, well-reasoned arguments for your side.
Be persuasive, use evidence, and anticipate counterarguments.
Keep it engaging and intellectually stimulating.
"""

DEVILS_ADVOCATE_PROMPT = """\
The student said: "{statement}"
Play devil's advocate — challenge this view with 2-3 strong counterarguments.
Be respectful but intellectually rigorous. End with a question to make them think deeper.
"""

CASE_STUDY_PROMPT = """\
Analyse this scenario as a university-level case study:
{scenario}
Provide: key issues, stakeholders, analysis, and recommendations.
Be thorough but concise. Use clear headings.
"""

# ── Career prompts ────────────────────────────────────────────

CV_PROMPT = """\
Write a professional CV for:
Name: {name}
Course/Field: {field}
Skills: {skills}
Experience: {experience}
Include: personal statement, education section placeholder, skills, and experience.
Format it clearly and professionally.
"""

INTERVIEW_PROMPT = """\
Generate 5 realistic interview questions for a {role} position.
For each question provide: the question, what the interviewer is looking for,
and a strong sample answer. Make it practical and specific.
"""

CAREER_PATH_PROMPT = """\
A student is studying {subject} at university.
Suggest 5 specific career paths they could pursue.
For each: job title, what they'd do day-to-day, required skills, and average salary range.
Be encouraging and realistic.
"""

LINKEDIN_PROMPT = """\
Write a professional LinkedIn bio for:
Name: {name}
Field: {field}
Goals: {goals}
Keep it under 300 words, first person, professional but personable.
"""

# ═══════════════════════════════════════════════════════════════
#  ENVIRONMENT & SETUP
# ═══════════════════════════════════════════════════════════════

def load_env() -> None:
    if not os.path.exists(ENV_PATH):
        return
    with open(ENV_PATH) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            os.environ.setdefault(key.strip(), val.strip())


def first_time_setup() -> None:
    if os.path.exists(ENV_PATH):
        return
    print("─" * 46)
    print("  🔐 First-time setup — API Key Required")
    print("─" * 46)
    print("  Get a free key at: https://aistudio.google.com/app/apikey\n")
    key = input("  Paste your Gemini API key: ").strip()
    if not key:
        print("  No key entered. Exiting.")
        exit()
    with open(ENV_PATH, "w") as f:
        f.write(f"GEMINI_API_KEY={key}\n")
    gitignore = ".gitignore"
    existing = open(gitignore).read() if os.path.exists(gitignore) else ""
    if ".env" not in existing:
        with open(gitignore, "a") as f:
            f.write("\n.env\n")
    print("\n  ✅ Key saved to .env (protected by .gitignore)\n")
    load_env()


def check_internet() -> bool:
    try:
        socket.setdefaulttimeout(5)
        socket.create_connection(("8.8.8.8", 53))
        return True
    except OSError:
        return False


def friendly_error(err) -> str:
    msg = str(err).lower()
    if "api key" in msg or "invalid" in msg:
        return "❌ Invalid API key — check your .env file."
    if "quota" in msg or "limit" in msg:
        return "❌ Gemini quota exceeded — wait a moment."
    if "network" in msg or "connection" in msg or "timeout" in msg:
        return "❌ Connection lost — check your internet."
    if "404" in msg or "not found" in msg:
        return "❌ Model unavailable — restart Sivarr."
    return f"❌ Unexpected error: {err}"


# ═══════════════════════════════════════════════════════════════
#  MATH UTILITIES
# ═══════════════════════════════════════════════════════════════

_SAFE_NODES = (
    ast.Expression, ast.BinOp, ast.UnaryOp, ast.Constant,
    ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow,
    ast.USub, ast.UAdd,
)

def _eval_expr(expr: str) -> object:
    expr = expr.replace("^", "**").replace(" ", "")
    try:
        tree = ast.parse(expr, mode="eval")
        if any(not isinstance(n, _SAFE_NODES) for n in ast.walk(tree)):
            return None
        return eval(compile(tree, "<string>", "eval"), {"__builtins__": {}}, {})
    except Exception:
        return None


def solve_locally(text: str) -> object:
    if not re.fullmatch(r"[\d+\-*/().^ \s]+", text.strip()):
        return None
    for c in [text] + re.findall(r"[\d+\-*/().^ ]+", text):
        result = _eval_expr(c.strip())
        if result is not None:
            display = int(result) if isinstance(result, float) and result.is_integer() else result
            return f"Result = {display}"
    return None


def is_math(text: str) -> bool:
    return any(t in text.lower() for t in MATH_TRIGGERS)


# ═══════════════════════════════════════════════════════════════
#  KNOWLEDGE CACHE
# ═══════════════════════════════════════════════════════════════

def load_library() -> dict:
    if os.path.exists(LIBRARY_PATH):
        with open(LIBRARY_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_library(lib: dict) -> None:
    _atomic_write(LIBRARY_PATH, lib)


def get_cached(lib: dict, topic: str) -> object:
    entry = lib.get(topic)
    if not entry:
        return None
    if isinstance(entry, str):
        return entry
    age = (datetime.date.today() -
           datetime.date.fromisoformat(entry.get("date", "2000-01-01"))).days
    return entry["answer"] if age <= CACHE_EXPIRY else None


def set_cached(lib: dict, topic: str, answer: str) -> None:
    lib[topic] = {"answer": answer, "date": datetime.date.today().isoformat()}


# ═══════════════════════════════════════════════════════════════
#  QUESTION BANK
# ═══════════════════════════════════════════════════════════════

def load_bank() -> dict:
    if os.path.exists(BANK_PATH):
        with open(BANK_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_bank(bank: dict) -> None:
    _atomic_write(BANK_PATH, bank)


def get_from_bank(bank: dict, topic: str, diff: str, used: list) -> object:
    key = f"{topic}_{diff}"
    unused = [q for q in bank.get(key, []) if q["question"] not in used]
    return random.choice(unused) if unused else None


def add_to_bank(bank: dict, topic: str, diff: str, q: dict) -> None:
    key = f"{topic}_{diff}"
    bank.setdefault(key, [])
    if q["question"] not in [x["question"] for x in bank[key]]:
        bank[key] = (bank[key] + [q])[-BANK_LIMIT:]


# ═══════════════════════════════════════════════════════════════
#  STUDENT PROGRESS
# ═══════════════════════════════════════════════════════════════

def load_progress(sid: str) -> dict:
    path = f"{sid}_progress.json"
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return {
        "sessions": 0, "questions": 0, "topics": {},
        "quizzes": [], "wrong_answers": [], "chat_history": [],
        "difficulty": "medium", "name": "", "matric": "",
        "todos": [], "goals": [],
    }


def save_progress(sid: str, p: dict) -> None:
    path = f"{sid}_progress.json"
    if os.path.exists(path):
        shutil.copy2(path, f"{sid}_progress.backup.json")
    with open(path, "w") as f:
        json.dump(p, f, indent=2)


def record_topic(topic: str, p: dict, sid: str) -> None:
    p["questions"] += 1
    p["topics"][topic] = p["topics"].get(topic, 0) + 1
    save_progress(sid, p)


def add_to_history(p: dict, sid: str, role: str, msg: str) -> None:
    p.setdefault("chat_history", []).append({
        "role": role, "message": msg,
        "time": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
    })
    p["chat_history"] = p["chat_history"][-HISTORY_LIMIT:]
    save_progress(sid, p)


def weak_topics(p: dict) -> list:
    return sorted(p["topics"], key=lambda t: p["topics"][t])[:3]


def build_memory(p: dict) -> str:
    history = p.get("chat_history", [])
    topics  = list(p.get("topics", {}).keys())
    if not history and not topics:
        return ""
    lines = ["Previous session context:"]
    for h in history[-10:]:
        lines.append(f"  {'Student' if h['role']=='user' else 'Sivarr'}: {h['message']}")
    if topics:
        lines.append(f"Topics studied: {', '.join(topics[-5:])}")
    return "\n".join(lines)


def strip_topic(q: str) -> str:
    for w in TOPIC_STRIP_WORDS:
        q = q.lower().replace(w, "")
    return q.strip()


def is_uncertain(text: str) -> bool:
    return any(p in text.lower() for p in UNCERTAINTY_PHRASES)


def show_progress(p: dict) -> None:
    quizzes = p.get("quizzes", [])
    avg = (sum(q["score"] for q in quizzes) / len(quizzes) * 100) if quizzes else 0
    wrong = p.get("wrong_answers", [])
    todos = [t for t in p.get("todos", []) if not t.get("done")]
    goals = p.get("goals", [])

    print(f"\n{'─'*42}")
    print(f"  📊  PROGRESS — {p.get('name','?')}  ({p.get('matric','?')})")
    print(f"{'─'*42}")
    print(f"  Difficulty    : {p.get('difficulty','medium').title()}")
    print(f"  Sessions      : {p['sessions']}")
    print(f"  Questions     : {p['questions']}")
    print(f"  Topics        : {', '.join(p['topics']) or 'none yet'}")
    print(f"  Weak areas    : {', '.join(weak_topics(p)) or 'none'}")
    if quizzes:
        last = quizzes[-1]
        print(f"  Quizzes taken : {len(quizzes)}  |  Avg: {avg:.0f}%")
        print(f"  Last quiz     : {last['pct']}% — {last['topic']} ({last.get('difficulty','?')})")
    if wrong:
        print(f"  To revise     : {len(wrong)} wrong answer(s)  →  type \"revise\"")
    if todos:
        print(f"  Pending todos : {len(todos)}  →  type \"todo\"")
    if goals:
        today = datetime.date.today().isoformat()
        today_goals = [g for g in goals if g.get("date") == today]
        if today_goals:
            done = sum(1 for g in today_goals if g.get("done"))
            print(f"  Today's goals : {done}/{len(today_goals)} completed  →  type \"goals\"")
    print(f"{'─'*42}\n")


# ═══════════════════════════════════════════════════════════════
#  GEMINI
# ═══════════════════════════════════════════════════════════════

def init_gemini(api_key: str) -> str:
    genai.configure(api_key=api_key)
    try:
        available = [
            m.name.replace("models/", "") for m in genai.list_models()
            if "generateContent" in m.supported_generation_methods
        ]
        for m in GEMINI_MODELS:
            if m in available:
                return m
        return available[0] if available else GEMINI_MODELS[0]
    except Exception:
        return GEMINI_MODELS[0]


def new_chat(model: str, system: str):
    m = genai.GenerativeModel(
        model_name=model,
        system_instruction=system,
        generation_config=genai.GenerationConfig(
            temperature=0.7, max_output_tokens=500
        ),
    )
    return m.start_chat(history=[])


def chat_ask(session, question: str) -> object:
    try:
        return session.send_message(question).text.strip()
    except Exception as e:
        return f"[error:{e}]"


def single_ask(model: str, prompt: str, system: str = None,
               temp: float = 0.7, tokens: int = 800) -> object:
    try:
        m = genai.GenerativeModel(
            model_name=model,
            system_instruction=system,
            generation_config=genai.GenerationConfig(
                temperature=temp, max_output_tokens=tokens
            ),
        )
        return m.generate_content(prompt).text.strip()
    except Exception:
        return None


# ═══════════════════════════════════════════════════════════════
#  QUIZ & REVISION
# ═══════════════════════════════════════════════════════════════

def generate_question(model: str, topic: str, diff: str,
                      bank: dict, used: list) -> object:
    q = get_from_bank(bank, topic, diff, used)
    if q:
        return q
    raw = single_ask(model, QUIZ_PROMPT.format(topic=topic, difficulty=diff), temp=0.9, tokens=300)
    if not raw:
        return None
    try:
        raw = re.sub(r"```(?:json)?", "", raw).strip().rstrip("`")
        q   = json.loads(raw)
        add_to_bank(bank, topic, diff, q)
        save_bank(bank)
        return q
    except Exception:
        return None


def run_quiz(model: str, p: dict, sid: str, bank: dict) -> None:
    topics = list(p["topics"].keys())
    if not topics:
        print("\nSivarr: Ask me some questions first, then come back for a quiz! 📚\n")
        return

    diff        = p.get("difficulty", "medium")
    quiz_topics = [random.choice(topics) for _ in range(5)]
    dominant    = max(set(quiz_topics), key=quiz_topics.count)
    used, score = [], 0

    print(f"\n{'─'*46}")
    print(f"     📝  SIVARR QUIZ — 5 Questions  [{diff.upper()}]")
    print(f"{'─'*46}")
    print("  Answer with A, B, C, or D.\n")

    for i, topic in enumerate(quiz_topics, 1):
        print(f"  Q{i} [{topic}] Generating...", end="\r")
        q = generate_question(model, topic, diff, bank, used)
        if not q:
            print(f"  Q{i} — Skipped.                              ")
            continue
        used.append(q["question"])
        print(f"  Q{i}. {q['question']}                    ")
        for letter, opt in q["options"].items():
            print(f"      {letter}) {opt}")
        while True:
            ans = input("  Your answer: ").strip().upper()
            if ans in ("A", "B", "C", "D"):
                break
            print("  Enter A, B, C, or D.")
        correct = q["answer"].upper()
        if ans == correct:
            print(f"  ✅ Correct! {q['explanation']}\n")
            score += 1
        else:
            print(f"  ❌ Wrong. Correct: {correct}. {q['explanation']}\n")
            p.setdefault("wrong_answers", []).append({
                "topic": topic, "question": q["question"],
                "your_answer": ans, "correct": correct,
                "explanation": q["explanation"], "difficulty": diff,
                "date": datetime.date.today().isoformat(),
            })

    pct = int(score / 5 * 100)
    print(f"{'─'*46}")
    print(f"  Score: {score}/5 ({pct}%)  [{diff.upper()}]")
    if   pct == 100: print("  🏆 Perfect! Outstanding!")
    elif pct >= 80:  print("  🌟 Great job!")
    elif pct >= 60:  print("  👍 Good effort — keep going!")
    else:            print("  💪 Keep practising — you'll get there!")
    idx = DIFFICULTY_LEVELS.index(diff)
    if pct == 100 and idx < 2:
        print(f"  🔥 Try \"difficulty {DIFFICULTY_LEVELS[idx+1]}\" to level up!")
    elif pct < 40 and idx > 0:
        print(f"  💡 Try \"difficulty {DIFFICULTY_LEVELS[idx-1]}\" to build confidence.")
    wrong_n = len(p.get("wrong_answers", []))
    if wrong_n:
        print(f"  📖 {wrong_n} wrong answer(s) saved — type \"revise\".")
    print(f"{'─'*46}\n")
    p.setdefault("quizzes", []).append({
        "topic": dominant, "score": score / 5, "pct": pct, "difficulty": diff,
    })
    save_progress(sid, p)


def run_revision(p: dict, sid: str) -> None:
    wrong = p.get("wrong_answers", [])
    if not wrong:
        print("\nSivarr: No wrong answers yet — keep quizzing! 🎯\n")
        return
    print(f"\n{'─'*46}")
    print(f"  📖  REVISION — {len(wrong)} question(s)")
    print(f"{'─'*46}\n")
    cleared = []
    for i, w in enumerate(wrong, 1):
        print(f"  Q{i}. [{w['topic']} — {w.get('difficulty','?')}]")
        print(f"  {w['question']}")
        print(f"  ❌ You said : {w['your_answer']}")
        print(f"  ✅ Correct  : {w['correct']}")
        print(f"  💡 Why      : {w['explanation']}")
        if input("  Got it now? (y/n): ").strip().lower() == "y":
            cleared.append(i - 1)
        print()
    for idx in reversed(cleared):
        wrong.pop(idx)
    p["wrong_answers"] = wrong
    save_progress(sid, p)
    print(f"  ✅ {len(cleared)} cleared. {len(wrong)} remaining. Keep it up! 💪\n")


# ═══════════════════════════════════════════════════════════════
#  WRITING & LANGUAGE  (Group 1)
# ═══════════════════════════════════════════════════════════════

def write_essay(model: str, p: dict, sid: str) -> None:
    """Generate a structured essay on a topic of the student's choice."""
    print("\n  ✍️  ESSAY WRITER")
    print("  ─────────────────────────────────────")
    topic      = input("  Topic          : ").strip()
    essay_type = input("  Type (argumentative/descriptive/narrative) [argumentative]: ").strip() or "argumentative"
    length     = input("  Length (short/medium/long) [medium]: ").strip() or "medium"
    tone       = input("  Tone (academic/casual/formal) [academic]: ").strip() or "academic"

    length_map = {"short": "300-400 words", "medium": "500-700 words", "long": "800-1000 words"}
    word_count = length_map.get(length, "500-700 words")

    print("\n  Sivarr: Writing your essay...\n")
    result = single_ask(model, ESSAY_PROMPT.format(
        essay_type=essay_type, topic=topic, length=word_count, tone=tone
    ), temp=0.7, tokens=1200)
    if result:
        print(result)
        # Save to file
        filename = f"essay_{topic[:20].replace(' ','_')}_{datetime.date.today()}.txt"
        with open(filename, "w") as f:
            f.write(f"Essay: {topic}\nType: {essay_type} | Tone: {tone}\n\n{result}")
        print(f"\n  💾 Saved to: {filename}\n")
        record_topic("writing", p, sid)
    else:
        print("  Couldn't generate essay — try again.\n")


def write_story(model: str, p: dict, sid: str) -> None:
    """Generate a creative story."""
    print("\n  📖  STORY WRITER")
    print("  ─────────────────────────────────────")
    topic  = input("  Story idea or title : ").strip()
    genre  = input("  Genre (adventure/romance/sci-fi/thriller/comedy) [adventure]: ").strip() or "adventure"
    length = input("  Length (short/medium/long) [short]: ").strip() or "short"

    length_map = {"short": "300-500 words", "medium": "600-900 words", "long": "1000-1500 words"}
    word_count = length_map.get(length, "300-500 words")

    print("\n  Sivarr: Writing your story...\n")
    result = single_ask(model, STORY_PROMPT.format(
        genre=genre, topic=topic, length=word_count
    ), temp=0.9, tokens=1500)
    if result:
        print(result)
        filename = f"story_{topic[:20].replace(' ','_')}_{datetime.date.today()}.txt"
        with open(filename, "w") as f:
            f.write(f"Story: {topic}\nGenre: {genre}\n\n{result}")
        print(f"\n  💾 Saved to: {filename}\n")
        record_topic("creative writing", p, sid)
    else:
        print("  Couldn't generate story — try again.\n")


def write_poem(model: str, p: dict, sid: str) -> None:
    """Generate a poem."""
    print("\n  🎭  POEM WRITER")
    print("  ─────────────────────────────────────")
    topic = input("  Topic or theme : ").strip()
    style = input("  Style (rhyming/free verse/haiku/sonnet) [free verse]: ").strip() or "free verse"

    print("\n  Sivarr: Writing your poem...\n")
    result = single_ask(model, POEM_PROMPT.format(style=style, topic=topic), temp=0.9, tokens=400)
    if result:
        print(result)
        record_topic("poetry", p, sid)
    else:
        print("  Couldn't generate poem — try again.\n")
    print()


def proofread_text(model: str, p: dict, sid: str) -> None:
    """Proofread and correct student text."""
    print("\n  🔍  PROOFREADER")
    print("  ─────────────────────────────────────")
    print("  Paste your text below. Type END on a new line when done.\n")
    lines = []
    while True:
        line = input()
        if line.strip().upper() == "END":
            break
        lines.append(line)
    text = "\n".join(lines).strip()
    if not text:
        print("  No text entered.\n")
        return
    print("\n  Sivarr: Proofreading...\n")
    result = single_ask(model, PROOFREAD_PROMPT.format(text=text), temp=0.3, tokens=1000)
    if result:
        print(result)
        record_topic("proofreading", p, sid)
    else:
        print("  Couldn't proofread — try again.\n")
    print()


def summarise_text(model: str, p: dict, sid: str) -> None:
    """Summarise a long piece of text."""
    print("\n  📋  SUMMARISER")
    print("  ─────────────────────────────────────")
    length = input("  Summary length (1 paragraph / bullet points / 1 sentence) [1 paragraph]: ").strip() or "1 paragraph"
    print("  Paste your text. Type END on a new line when done.\n")
    lines = []
    while True:
        line = input()
        if line.strip().upper() == "END":
            break
        lines.append(line)
    text = "\n".join(lines).strip()
    if not text:
        print("  No text entered.\n")
        return
    print("\n  Sivarr: Summarising...\n")
    result = single_ask(model, SUMMARISE_PROMPT.format(text=text, length=length), temp=0.4, tokens=500)
    if result:
        print(f"\n{result}\n")
        record_topic("summarising", p, sid)
    else:
        print("  Couldn't summarise — try again.\n")


def translate_text(model: str, p: dict, sid: str) -> None:
    """Translate text to another language."""
    print("\n  🌍  TRANSLATOR")
    print("  ─────────────────────────────────────")
    language = input("  Translate to (e.g. French, Yoruba, Spanish): ").strip()
    if not language:
        print("  No language entered.\n")
        return
    print("  Paste your text. Type END on a new line when done.\n")
    lines = []
    while True:
        line = input()
        if line.strip().upper() == "END":
            break
        lines.append(line)
    text = "\n".join(lines).strip()
    if not text:
        print("  No text entered.\n")
        return
    print(f"\n  Sivarr: Translating to {language}...\n")
    result = single_ask(model, TRANSLATE_PROMPT.format(text=text, language=language), temp=0.3, tokens=800)
    if result:
        print(f"\n{result}\n")
        record_topic("translation", p, sid)
    else:
        print("  Couldn't translate — try again.\n")


def structure_assignment(model: str, p: dict, sid: str) -> None:
    """Help structure an assignment or report."""
    print("\n  📐  ASSIGNMENT STRUCTURE")
    print("  ─────────────────────────────────────")
    doc_type = input("  Document type (essay/report/research paper/presentation) [essay]: ").strip() or "essay"
    topic    = input("  Topic : ").strip()
    if not topic:
        print("  No topic entered.\n")
        return
    print(f"\n  Sivarr: Building structure for your {doc_type}...\n")
    result = single_ask(model, STRUCTURE_PROMPT.format(doc_type=doc_type, topic=topic), temp=0.5, tokens=700)
    if result:
        print(f"\n{result}\n")
        record_topic("assignment structure", p, sid)
    else:
        print("  Couldn't generate structure — try again.\n")


# ═══════════════════════════════════════════════════════════════
#  STUDY TOOLS  (Group 2)
# ═══════════════════════════════════════════════════════════════

def generate_notes(model: str, p: dict, sid: str) -> None:
    """Generate comprehensive study notes on a topic."""
    print("\n  📚  STUDY NOTES GENERATOR")
    print("  ─────────────────────────────────────")
    topic = input("  Topic : ").strip()
    if not topic:
        print("  No topic entered.\n")
        return
    print(f"\n  Sivarr: Generating notes on {topic}...\n")
    result = single_ask(model, NOTES_PROMPT.format(topic=topic), temp=0.5, tokens=1000)
    if result:
        print(result)
        filename = f"notes_{topic[:20].replace(' ','_')}_{datetime.date.today()}.txt"
        with open(filename, "w") as f:
            f.write(f"Study Notes: {topic}\n{'='*40}\n\n{result}")
        print(f"\n  💾 Saved to: {filename}\n")
        record_topic(topic, p, sid)
    else:
        print("  Couldn't generate notes — try again.\n")


def generate_flashcards(model: str, p: dict, sid: str) -> None:
    """Generate flashcards for a topic."""
    print("\n  🃏  FLASHCARD GENERATOR")
    print("  ─────────────────────────────────────")
    topic = input("  Topic         : ").strip()
    count = input("  How many? [10]: ").strip() or "10"
    if not topic:
        print("  No topic entered.\n")
        return
    print(f"\n  Sivarr: Generating {count} flashcards on {topic}...\n")
    raw = single_ask(model, FLASHCARD_PROMPT.format(topic=topic, count=count), temp=0.6, tokens=800)
    if not raw:
        print("  Couldn't generate flashcards — try again.\n")
        return
    try:
        raw   = re.sub(r"```(?:json)?", "", raw).strip().rstrip("`")
        cards = json.loads(raw)
        print(f"  Generated {len(cards)} flashcards!\n")
        print("  Press ENTER to flip each card. Type 'stop' to exit.\n")
        for i, card in enumerate(cards, 1):
            print(f"  [{i}/{len(cards)}] FRONT: {card['front']}")
            ans = input("  Your answer (or press ENTER to reveal): ").strip()
            if ans.lower() == "stop":
                break
            print(f"  BACK  : {card['back']}\n")
        filename = f"flashcards_{topic[:20].replace(' ','_')}.json"
        with open(filename, "w") as f:
            json.dump(cards, f, indent=2)
        print(f"  💾 Flashcards saved to: {filename}\n")
        record_topic(topic, p, sid)
    except Exception:
        print("  Couldn't parse flashcards — try again.\n")


def generate_timetable(model: str, p: dict, sid: str) -> None:
    """Generate a personalised study timetable."""
    print("\n  📅  STUDY TIMETABLE GENERATOR")
    print("  ─────────────────────────────────────")
    print("  Enter your exams (e.g. Mathematics - 20 March, Physics - 25 March)")
    print("  Type END when done.\n")
    exams = []
    while True:
        line = input("  Exam: ").strip()
        if line.upper() == "END" or not line:
            break
        exams.append(line)
    if not exams:
        print("  No exams entered.\n")
        return
    days  = input("  Available study days (e.g. Mon-Fri or Mon,Wed,Fri): ").strip() or "Monday to Friday"
    hours = input("  Study hours per day [3]: ").strip() or "3"
    print("\n  Sivarr: Building your timetable...\n")
    result = single_ask(model, TIMETABLE_PROMPT.format(
        exams="\n".join(exams), days=days, hours=hours
    ), temp=0.4, tokens=1000)
    if result:
        print(result)
        filename = f"timetable_{datetime.date.today()}.txt"
        with open(filename, "w") as f:
            f.write(f"Study Timetable\n{'='*40}\n\n{result}")
        print(f"\n  💾 Saved to: {filename}\n")
        record_topic("timetable", p, sid)
    else:
        print("  Couldn't generate timetable — try again.\n")


def generate_exam_questions(model: str, p: dict, sid: str) -> None:
    """Generate likely exam questions on a topic."""
    print("\n  📝  EXAM QUESTION GENERATOR")
    print("  ─────────────────────────────────────")
    topic = input("  Topic         : ").strip()
    count = input("  How many? [10]: ").strip() or "10"
    if not topic:
        print("  No topic entered.\n")
        return
    print(f"\n  Sivarr: Generating exam questions on {topic}...\n")
    result = single_ask(model, EXAM_QUESTIONS_PROMPT.format(topic=topic, count=count), temp=0.7, tokens=800)
    if result:
        print(result)
        filename = f"exam_q_{topic[:20].replace(' ','_')}_{datetime.date.today()}.txt"
        with open(filename, "w") as f:
            f.write(f"Exam Questions: {topic}\n{'='*40}\n\n{result}")
        print(f"\n  💾 Saved to: {filename}\n")
        record_topic(topic, p, sid)
    else:
        print("  Couldn't generate questions — try again.\n")


# ═══════════════════════════════════════════════════════════════
#  CRITICAL THINKING  (Group 3)
# ═══════════════════════════════════════════════════════════════

def run_debate(model: str, p: dict, sid: str) -> None:
    """Debate mode — Sivarr argues one side, student argues the other."""
    print("\n  🗣️  DEBATE MODE")
    print("  ─────────────────────────────────────")
    topic = input("  Debate topic : ").strip()
    if not topic:
        print("  No topic entered.\n")
        return
    side  = input("  Sivarr argues (for/against) [for]: ").strip() or "for"
    opp   = "against" if side == "for" else "for"

    print(f"\n  Sivarr will argue {side.upper()} — you argue {opp.upper()}.\n")
    result = single_ask(model, DEBATE_PROMPT.format(side=side, topic=topic), temp=0.8, tokens=600)
    if result:
        print(f"\nSivarr ({side}):\n{result}\n")
        print("─" * 46)
        student_arg = input("Your counter-argument: ").strip()
        if student_arg:
            followup = single_ask(model, f"""
You just argued {side} on: {topic}
The student responded: {student_arg}
Give a brief, sharp rebuttal in 2-3 sentences. Stay in character.
""", temp=0.8, tokens=200)
            if followup:
                print(f"\nSivarr: {followup}\n")
        record_topic("debate", p, sid)
    else:
        print("  Couldn't start debate — try again.\n")


def devils_advocate(model: str, p: dict, sid: str) -> None:
    """Challenge the student's thinking."""
    print("\n  😈  DEVIL'S ADVOCATE")
    print("  ─────────────────────────────────────")
    statement = input("  State your opinion or argument: ").strip()
    if not statement:
        print("  Nothing entered.\n")
        return
    print("\n  Sivarr: Challenging your view...\n")
    result = single_ask(model, DEVILS_ADVOCATE_PROMPT.format(statement=statement), temp=0.8, tokens=400)
    if result:
        print(f"\n{result}\n")
        record_topic("critical thinking", p, sid)
    else:
        print("  Couldn't generate challenge — try again.\n")


def case_study(model: str, p: dict, sid: str) -> None:
    """Analyse a scenario as a case study."""
    print("\n  🔬  CASE STUDY ANALYSER")
    print("  ─────────────────────────────────────")
    print("  Describe your scenario. Type END on a new line when done.\n")
    lines = []
    while True:
        line = input()
        if line.strip().upper() == "END":
            break
        lines.append(line)
    scenario = "\n".join(lines).strip()
    if not scenario:
        print("  No scenario entered.\n")
        return
    print("\n  Sivarr: Analysing case study...\n")
    result = single_ask(model, CASE_STUDY_PROMPT.format(scenario=scenario), temp=0.5, tokens=800)
    if result:
        print(f"\n{result}\n")
        record_topic("case study", p, sid)
    else:
        print("  Couldn't analyse — try again.\n")


# ═══════════════════════════════════════════════════════════════
#  CAREER & PERSONAL GROWTH  (Group 4)
# ═══════════════════════════════════════════════════════════════

def write_cv(model: str, p: dict, sid: str) -> None:
    """Generate a professional CV."""
    print("\n  📄  CV WRITER")
    print("  ─────────────────────────────────────")
    name       = p.get("name", input("  Your name    : ").strip())
    field      = input("  Course/Field : ").strip()
    skills     = input("  Key skills (comma separated): ").strip()
    experience = input("  Experience (or 'none'): ").strip() or "none"
    if not field:
        print("  Field required.\n")
        return
    print("\n  Sivarr: Writing your CV...\n")
    result = single_ask(model, CV_PROMPT.format(
        name=name, field=field, skills=skills, experience=experience
    ), temp=0.4, tokens=1000)
    if result:
        print(result)
        filename = f"cv_{name.replace(' ','_')}_{datetime.date.today()}.txt"
        with open(filename, "w") as f:
            f.write(result)
        print(f"\n  💾 Saved to: {filename}\n")
        record_topic("career", p, sid)
    else:
        print("  Couldn't generate CV — try again.\n")


def interview_prep(model: str, p: dict, sid: str) -> None:
    """Generate mock interview questions and answers."""
    print("\n  🎤  INTERVIEW PREP")
    print("  ─────────────────────────────────────")
    role = input("  Job role/position: ").strip()
    if not role:
        print("  No role entered.\n")
        return
    print(f"\n  Sivarr: Generating interview questions for {role}...\n")
    result = single_ask(model, INTERVIEW_PROMPT.format(role=role), temp=0.6, tokens=1000)
    if result:
        print(result)
        record_topic("interview prep", p, sid)
    else:
        print("  Couldn't generate questions — try again.\n")
    print()


def career_paths(model: str, p: dict, sid: str) -> None:
    """Suggest career paths based on subject."""
    print("\n  🚀  CAREER PATH EXPLORER")
    print("  ─────────────────────────────────────")
    subject = input("  Your subject/course: ").strip()
    if not subject:
        print("  No subject entered.\n")
        return
    print(f"\n  Sivarr: Exploring careers for {subject} students...\n")
    result = single_ask(model, CAREER_PATH_PROMPT.format(subject=subject), temp=0.6, tokens=800)
    if result:
        print(result)
        record_topic("career paths", p, sid)
    else:
        print("  Couldn't generate paths — try again.\n")
    print()


def write_linkedin(model: str, p: dict, sid: str) -> None:
    """Generate a LinkedIn bio."""
    print("\n  💼  LINKEDIN BIO WRITER")
    print("  ─────────────────────────────────────")
    name  = p.get("name", input("  Your name : ").strip())
    field = input("  Field/Course : ").strip()
    goals = input("  Career goals : ").strip()
    if not field:
        print("  Field required.\n")
        return
    print("\n  Sivarr: Writing your LinkedIn bio...\n")
    result = single_ask(model, LINKEDIN_PROMPT.format(name=name, field=field, goals=goals), temp=0.6, tokens=400)
    if result:
        print(f"\n{result}\n")
        record_topic("linkedin", p, sid)
    else:
        print("  Couldn't generate bio — try again.\n")


# ═══════════════════════════════════════════════════════════════
#  PRODUCTIVITY  (Group 5)
# ═══════════════════════════════════════════════════════════════

def manage_todos(p: dict, sid: str) -> None:
    """Simple to-do list manager."""
    print("\n  ✅  TO-DO LIST")
    print("  ─────────────────────────────────────")
    todos = p.setdefault("todos", [])
    pending = [t for t in todos if not t.get("done")]
    done    = [t for t in todos if t.get("done")]

    if pending:
        print(f"\n  Pending ({len(pending)}):")
        for i, t in enumerate(pending, 1):
            print(f"    {i}. {t['task']}")
    else:
        print("\n  No pending tasks! 🎉")

    if done:
        print(f"\n  Completed ({len(done)}):")
        for t in done[-3:]:
            print(f"    ✓ {t['task']}")

    print("\n  Options: add / done <number> / clear / back")
    while True:
        cmd = input("\n  > ").strip().lower()
        if cmd == "back" or cmd == "":
            break
        elif cmd == "add":
            task = input("  New task: ").strip()
            if task:
                todos.append({"task": task, "done": False, "added": datetime.date.today().isoformat()})
                save_progress(sid, p)
                print(f"  ✅ Added: {task}")
        elif cmd.startswith("done "):
            try:
                idx = int(cmd.split()[1]) - 1
                if 0 <= idx < len(pending):
                    pending[idx]["done"] = True
                    save_progress(sid, p)
                    print(f"  ✓ Marked done: {pending[idx]['task']}")
                    pending = [t for t in todos if not t.get("done")]
            except (ValueError, IndexError):
                print("  Invalid number.")
        elif cmd == "clear":
            p["todos"] = [t for t in todos if not t.get("done")]
            save_progress(sid, p)
            print("  Completed tasks cleared.")
        else:
            print("  Commands: add / done <number> / clear / back")
    print()


def manage_goals(p: dict, sid: str) -> None:
    """Set and track daily study goals."""
    today = datetime.date.today().isoformat()
    print("\n  🎯  DAILY GOALS")
    print("  ─────────────────────────────────────")
    goals = p.setdefault("goals", [])
    today_goals = [g for g in goals if g.get("date") == today]

    if today_goals:
        done_count = sum(1 for g in today_goals if g.get("done"))
        print(f"\n  Today's goals ({done_count}/{len(today_goals)} done):")
        for i, g in enumerate(today_goals, 1):
            status = "✅" if g.get("done") else "⬜"
            print(f"    {status} {i}. {g['goal']}")
    else:
        print("\n  No goals set for today yet.")

    print("\n  Options: add / done <number> / back")
    while True:
        cmd = input("\n  > ").strip().lower()
        if cmd == "back" or cmd == "":
            break
        elif cmd == "add":
            goal = input("  Today's goal: ").strip()
            if goal:
                goals.append({"goal": goal, "done": False, "date": today})
                save_progress(sid, p)
                today_goals = [g for g in goals if g.get("date") == today]
                print(f"  🎯 Goal added: {goal}")
        elif cmd.startswith("done "):
            try:
                idx = int(cmd.split()[1]) - 1
                if 0 <= idx < len(today_goals):
                    today_goals[idx]["done"] = True
                    save_progress(sid, p)
                    print(f"  ✅ {today_goals[idx]['goal']}")
            except (ValueError, IndexError):
                print("  Invalid number.")
        else:
            print("  Commands: add / done <number> / back")
    print()


def study_timer(p: dict, sid: str) -> None:
    """Pomodoro-style study timer."""
    print("\n  ⏱️  STUDY TIMER")
    print("  ─────────────────────────────────────")
    print("  Pomodoro: 25 min study → 5 min break")
    duration = input("  Study minutes [25]: ").strip() or "25"
    try:
        mins = int(duration)
    except ValueError:
        mins = 25
    subject = input("  What are you studying? : ").strip() or "general study"
    print(f"\n  ⏱️  Starting {mins}-minute timer for: {subject}")
    print("  Press Ctrl+C to stop early.\n")
    try:
        for remaining in range(mins * 60, 0, -1):
            m, s = divmod(remaining, 60)
            print(f"  ⏳ {m:02d}:{s:02d} remaining...   ", end="\r")
            time.sleep(1)
        print(f"\n\n  ✅ Done! {mins} minutes of {subject} complete.")
        print("  🔔 Take a 5-minute break — you earned it! 🎉\n")
        record_topic(subject, p, sid)
    except KeyboardInterrupt:
        print("\n\n  Timer stopped. Good work so far! 💪\n")


# ═══════════════════════════════════════════════════════════════
#  FUN & ENGAGEMENT  (Group 6)
# ═══════════════════════════════════════════════════════════════

def run_trivia(model: str, p: dict, sid: str) -> None:
    """Quick general knowledge trivia round."""
    print("\n  🎮  TRIVIA MODE — 5 Questions")
    print("  ─────────────────────────────────────")
    category = input("  Category (science/history/sports/general) [general]: ").strip() or "general"
    raw = single_ask(model, f"""
Generate 5 fun trivia questions on {category} knowledge.
For each, give the question and the correct answer.
Format ONLY as valid JSON:
[
  {{"question": "...", "answer": "..."}},
  ...
]
""", temp=0.9, tokens=600)
    if not raw:
        print("  Couldn't load trivia — try again.\n")
        return
    try:
        raw      = re.sub(r"```(?:json)?", "", raw).strip().rstrip("`")
        questions = json.loads(raw)
        score    = 0
        print()
        for i, q in enumerate(questions[:5], 1):
            print(f"  Q{i}: {q['question']}")
            ans = input("  Your answer: ").strip()
            correct = q["answer"].lower()
            if ans.lower() in correct or correct in ans.lower():
                print("  ✅ Correct!\n")
                score += 1
            else:
                print(f"  ❌ Answer: {q['answer']}\n")
        print(f"  🏁 Trivia done! Score: {score}/5")
        if score == 5:  print("  🏆 Perfect — you're a genius!")
        elif score >= 3: print("  🌟 Nice work!")
        else:            print("  📚 Keep learning — you'll get there!")
        print()
        record_topic("trivia", p, sid)
    except Exception:
        print("  Couldn't parse trivia — try again.\n")


def word_of_the_day() -> None:
    """Display a vocabulary word of the day."""
    word, definition = random.choice(WORD_OF_DAY_LIST)
    print(f"\n  📖  WORD OF THE DAY")
    print(f"  ─────────────────────────────────────")
    print(f"  Word       : {word}")
    print(f"  Definition : {definition}")
    print(f"  Example    : \"Her {word.lower()} approach impressed everyone.\"\n")


def brain_teaser() -> None:
    """Give the student a brain teaser."""
    riddle, answer = random.choice(BRAIN_TEASERS)
    print(f"\n  🧩  BRAIN TEASER")
    print(f"  ─────────────────────────────────────")
    print(f"  {riddle}\n")
    input("  Think about it... Press ENTER for the answer.")
    print(f"\n  💡 Answer: {answer}\n")


def motivational_quote() -> None:
    """Show a motivational quote."""
    quote = random.choice(MOTIVATIONAL_QUOTES)
    print(f"\n  💪  {quote}\n")


# ═══════════════════════════════════════════════════════════════
#  TOPIC SUGGESTIONS
# ═══════════════════════════════════════════════════════════════

def suggest_topics(model: str, name: str, p: dict) -> None:
    topics = list(p["topics"].keys())
    if not topics:
        print("\nSivarr: Study a few topics first and I'll tailor suggestions!\n")
        return
    quizzes = p.get("quizzes", [])
    qs = (f"avg {sum(q['score'] for q in quizzes)/len(quizzes)*100:.0f}% across {len(quizzes)} quizzes"
          if quizzes else "no quizzes yet")
    result = single_ask(model, SUGGESTION_PROMPT.format(
        name=name, topics=", ".join(topics),
        weak=", ".join(weak_topics(p)) or "none",
        quiz_summary=qs, difficulty=p.get("difficulty", "medium"),
    ), temp=0.6, tokens=250)
    print("\nSivarr: Here's what I recommend studying next:\n")
    print(result if result else "  Couldn't generate suggestions — try again.")
    print()


# ═══════════════════════════════════════════════════════════════
#  HELPERS
# ═══════════════════════════════════════════════════════════════

def _atomic_write(path: str, data: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    shutil.move(tmp, path)


def identity_card() -> str:
    return f"""
Sivarr: Hey! 👋 I'm the Sivarr AI — your all-in-one learning companion!

  🏢 Company  : Sivarr
  👤 Founder  : Oladunni Testimony  (Lead City University)
  🎯 Mission  : student → skilled professional → employed talent → career growth
  🌍 Vision   : Starting at Lead City University, expanding to more soon
  ⚙️  Version  : v{VERSION}

  Core:
    📚  Answer any question      🧮  Solve math
    📝  Quiz (Easy/Med/Hard)     📖  Revise wrong answers
    💡  Study suggestions        📊  Progress tracking
    🧠  Cross-session memory

  Writing & Language:
    ✍️   Essay writer             📖  Story writer
    🎭  Poem writer              🔍  Proofreader
    📋  Text summariser          🌍  Translator
    📐  Assignment structure

  Study Tools:
    📚  Study notes              🃏  Flashcard generator
    📅  Study timetable          📝  Exam question generator

  Critical Thinking:
    🗣️   Debate mode              😈  Devil's advocate
    🔬  Case study analyser

  Career & Growth:
    📄  CV writer                🎤  Interview prep
    🚀  Career path explorer     💼  LinkedIn bio writer

  Productivity:
    ✅  To-do list               🎯  Daily goals
    ⏱️   Study timer

  Fun:
    🎮  Trivia                   📖  Word of the day
    🧩  Brain teaser             💪  Motivational quote

  Type any command or just ask me anything! 🚀
"""


def print_commands() -> None:
    print("""
  ── COMMANDS ────────────────────────────────────────
  LEARNING    : quiz · revise · suggest · progress
  WRITING     : essay · story · poem · proofread
                summarise · translate · structure
  STUDY TOOLS : notes · flashcards · timetable · examq
  CRITICAL    : debate · devil · casestudy
  CAREER      : cv · interview · careers · linkedin
  PRODUCTIVITY: todo · goals · timer
  FUN         : trivia · word · teaser · motivate
  SETTINGS    : difficulty easy/medium/hard
  OTHER       : exit
  ────────────────────────────────────────────────────
""")


# ═══════════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════════

def main() -> None:
    print("\n" + "═" * 48)
    print("           🚀  SIVARR AI  v4.0")
    print("    Your Growth. Your Journey. Your Future.")
    print("═" * 48 + "\n")

    first_time_setup()
    load_env()

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        print("❌  No API key found. Add GEMINI_API_KEY to your .env file.\n")
        return

    if not GEMINI_AVAILABLE:
        print("❌  Gemini missing.  Run: pip install google-generativeai\n")
        return

    print("  Checking internet...", end=" ", flush=True)
    if not check_internet():
        print("❌\n\n  No connection — connect and restart.\n")
        return
    print("✓")

    print()
    name   = input("  Student name   : ").strip()
    matric = input("  Matric number  : ").strip()
    if not name or not matric:
        print("\n  Name and matric required. Exiting.\n")
        return

    sid          = f"{name.lower()}_{matric.lower()}"
    display_name = name.title()

    p = load_progress(sid)
    p["sessions"] += 1
    p["name"]   = display_name
    p["matric"] = matric.upper()
    save_progress(sid, p)

    lib  = load_library()
    bank = load_bank()

    returning = p["sessions"] > 1
    print(f"\n  {'Welcome back' if returning else 'Welcome'}, {display_name}!")
    print(f"  Matric: {matric.upper()}  |  Difficulty: {p.get('difficulty','medium').title()}")

    if returning:
        recent = list(p.get("topics", {}).keys())[-3:]
        if recent:
            print(f"  Last studied : {', '.join(recent)}")
        wrong_n = len(p.get("wrong_answers", []))
        if wrong_n:
            print(f"  To revise    : {wrong_n} wrong answer(s)  →  type \"revise\"")

    # Daily motivation on login
    motivational_quote()
    print_commands()

    print("  Connecting to Gemini...", end=" ", flush=True)
    try:
        model     = init_gemini(api_key)
        memory    = build_memory(p)
        system    = SYSTEM_PROMPT + (f"\n\n{memory}" if memory else "")
        chat      = new_chat(model, system)
        math_chat = new_chat(model, MATH_PROMPT)
        print(f"✓  ({model})\n")
    except Exception as e:
        print(f"\n  {friendly_error(e)}\n")
        return

    # ── Main loop ─────────────────────────────────────────────
    while True:
        try:
            user_input = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nSivarr: Goodbye! Keep growing! 🚀\n")
            break

        if not user_input:
            continue

        cmd = user_input.lower()

        # ── Exit ──────────────────────────────────────────────
        if cmd in {"exit", "quit", "done"}:
            print("Sivarr: Goodbye! Keep learning! 🚀\n")
            break

        # ── Core commands ─────────────────────────────────────
        if cmd == "progress":
            show_progress(p)
            continue
        if cmd == "quiz":
            run_quiz(model, p, sid, bank)
            continue
        if cmd == "revise":
            run_revision(p, sid)
            continue
        if cmd in {"suggest", "suggestions"}:
            suggest_topics(model, display_name, p)
            continue
        if cmd.startswith("difficulty "):
            level = cmd.replace("difficulty ", "").strip()
            if level in DIFFICULTY_LEVELS:
                p["difficulty"] = level
                save_progress(sid, p)
                print(f"Sivarr: Difficulty set to {level.title()}! 🎯\n")
            else:
                print("Sivarr: Choose from — easy, medium, hard\n")
            continue
        if cmd == "commands" or cmd == "help":
            print_commands()
            continue
        if any(t in cmd for t in IDENTITY_TRIGGERS):
            print(identity_card())
            continue

        # ── Writing & Language ────────────────────────────────
        if cmd == "essay":
            write_essay(model, p, sid)
            continue
        if cmd == "story":
            write_story(model, p, sid)
            continue
        if cmd == "poem":
            write_poem(model, p, sid)
            continue
        if cmd == "proofread":
            proofread_text(model, p, sid)
            continue
        if cmd == "summarise" or cmd == "summarize":
            summarise_text(model, p, sid)
            continue
        if cmd == "translate":
            translate_text(model, p, sid)
            continue
        if cmd == "structure":
            structure_assignment(model, p, sid)
            continue

        # ── Study Tools ───────────────────────────────────────
        if cmd == "notes":
            generate_notes(model, p, sid)
            continue
        if cmd == "flashcards":
            generate_flashcards(model, p, sid)
            continue
        if cmd == "timetable":
            generate_timetable(model, p, sid)
            continue
        if cmd == "examq":
            generate_exam_questions(model, p, sid)
            continue

        # ── Critical Thinking ─────────────────────────────────
        if cmd == "debate":
            run_debate(model, p, sid)
            continue
        if cmd == "devil":
            devils_advocate(model, p, sid)
            continue
        if cmd == "casestudy":
            case_study(model, p, sid)
            continue

        # ── Career ────────────────────────────────────────────
        if cmd == "cv":
            write_cv(model, p, sid)
            continue
        if cmd == "interview":
            interview_prep(model, p, sid)
            continue
        if cmd == "careers":
            career_paths(model, p, sid)
            continue
        if cmd == "linkedin":
            write_linkedin(model, p, sid)
            continue

        # ── Productivity ──────────────────────────────────────
        if cmd == "todo":
            manage_todos(p, sid)
            continue
        if cmd == "goals":
            manage_goals(p, sid)
            continue
        if cmd == "timer":
            study_timer(p, sid)
            continue

        # ── Fun ───────────────────────────────────────────────
        if cmd == "trivia":
            run_trivia(model, p, sid)
            continue
        if cmd == "word":
            word_of_the_day()
            continue
        if cmd == "teaser":
            brain_teaser()
            continue
        if cmd == "motivate":
            motivational_quote()
            continue

        # ── Math ──────────────────────────────────────────────
        local = solve_locally(user_input)
        if local:
            print(f"Sivarr: {local}\n")
            record_topic("math", p, sid)
            continue

        if is_math(cmd):
            print("Sivarr: ", end="", flush=True)
            ans = chat_ask(math_chat, user_input)
            if ans and not ans.startswith("[error"):
                print(f"{ans}\n")
                if is_uncertain(ans):
                    print("  ⚠️  Not 100% certain — verify with your lecturer.\n")
                record_topic("math", p, sid)
                add_to_history(p, sid, "user", user_input)
                add_to_history(p, sid, "sivarr", ans)
            else:
                print(f"\n  {friendly_error(Exception(ans))}\n")
            continue

        # ── Cache ─────────────────────────────────────────────
        topic  = strip_topic(cmd)
        cached = get_cached(lib, topic)
        if cached:
            print(f"\nSivarr: {cached}\n")
            record_topic(topic, p, sid)
            continue

        # ── General Gemini chat ───────────────────────────────
        print("Sivarr: ", end="", flush=True)
        try:
            ans = chat_ask(chat, user_input)
        except Exception as e:
            print(f"\n  {friendly_error(e)}\n")
            continue

        if ans and not ans.startswith("[error"):
            print(f"{ans}\n")
            if is_uncertain(ans):
                print("  ⚠️  Not 100% certain — verify with your lecturer.\n")
            if not is_uncertain(ans) and topic and any(
                kw in cmd for kw in ["what is", "define", "explain"]
            ):
                set_cached(lib, topic, ans)
                save_library(lib)
            record_topic(topic or "general", p, sid)
            add_to_history(p, sid, "user", user_input)
            add_to_history(p, sid, "sivarr", ans)
        else:
            print(f"\n  {friendly_error(Exception(ans or 'No response'))}\n")


if __name__ == "__main__":
    main()
