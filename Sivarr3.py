import ast
import json
import os
import re
import shutil
import warnings
import random
import socket
import datetime

warnings.filterwarnings("ignore")

# ─────────────────────────── Fix 1: API Key Security (.env) ──────

def load_env(path=".env"):
    """Load key=value pairs from a .env file into os.environ."""
    if not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            os.environ.setdefault(key.strip(), val.strip())

load_env()

try:
    import google.generativeai as genai
    GEMINI_AVAILABLE = True
except ImportError:
    GEMINI_AVAILABLE = False
    print("⚠️  google-generativeai not installed.")
    print("    Run: pip3 install google-generativeai")

# ─────────────────────────── Constants ───────────────────────────

LIBRARY_PATH = "knowledge_library.json"
QUESTION_BANK_PATH = "question_bank.json"
CACHE_EXPIRY_DAYS = 30
TOPIC_KEYWORDS = ["what is", "define", "explain", "solve", "calculate"]
MATH_ALLOWED_NODES = (
    ast.Expression, ast.BinOp, ast.UnaryOp, ast.Constant,
    ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow,
    ast.USub, ast.UAdd,
)

MATH_TRIGGERS = [
    "solve", "calculate", "differentiate", "integrate", "expand", "factorise",
    "factorize", "simplify", "equation", "algebra", "quadratic", "derivative",
    "integral", "calculus", "gradient", "inequality", "simultaneous", "matrix",
    "fraction", "percentage", "ratio", "proof", "theorem", "logarithm", "log",
    "sin", "cos", "tan", "trigonometry", "polynomial", "expression", "formula",
    "find x", "find the value", "work out", "what is the area", "volume",
    "perimeter", "probability", "statistics", "mean", "median", "mode"
]

DIFFICULTY_LEVELS = ["easy", "medium", "hard"]

# Fix 2: Uncertainty phrases Gemini uses when unsure
UNCERTAINTY_PHRASES = [
    "i'm not sure", "i am not sure", "i'm not certain", "i cannot verify",
    "i don't know", "i do not know", "it's unclear", "unclear",
    "may not be accurate", "cannot confirm", "might be", "possibly",
    "i believe but", "not entirely sure", "limited information",
    "you should verify", "double check", "consult a", "check with"
]

# ─────────────────────────── Sivarr Identity ─────────────────────

SIVARR_VERSION = "3.0"
UNIVERSITY = "Lead City University"
MOTTO = "Knowledge for Self Reliance"

COMPANY_INFO = {
    "name": "Sivarr",
    "founder": "Oladunni Testimony",
    "founded_at": "Lead City University",
    "mission": "A growth ecosystem that supports people from student → skilled professional → employed talent → long-term career growth.",
    "current_focus": "Universities — starting with Lead City University, with plans to expand to more universities soon.",
    "version": SIVARR_VERSION,
}

SYSTEM_PROMPT = f"""You are the Sivarr AI assistant — the intelligent learning companion built into the Sivarr platform.

About Sivarr (the company):
- Sivarr is a growth ecosystem founded by Oladunni Testimony, a student of Lead City University.
- Mission: To support people from student → skilled professional → employed talent → long-term career growth.
- Currently focused on universities, starting with Lead City University, expanding to more soon.
- Version: {SIVARR_VERSION}

When asked about yourself or Sivarr — answer proudly using the above.

Behavior rules:
1. Be casual, fun, and encouraging — like a smart friend.
2. Keep answers SHORT — 2 to 4 sentences by default.
3. Only give step-by-step explanations if explicitly asked.
4. Answer ANY question on any subject.
5. For math: final answer only. Show working only if asked.
6. Expand only if user asks for "more" or "explain further".
7. If you are NOT sure about something, clearly say so and recommend the student verify it.
8. Never be stiff or overly formal — keep it real."""

MATH_SYSTEM_PROMPT = f"""You are Sivarr, the math expert AI tutor for {UNIVERSITY}.

Rules:
1. Solve and state the final answer clearly and concisely.
2. Do NOT show steps unless asked.
3. For simple problems, one line is enough: e.g. "x = 5"
4. Be casual and encouraging.
5. If genuinely unsure, say so clearly rather than guessing."""

QUIZ_PROMPT = """Generate a multiple choice quiz question about: {topic}
Difficulty level: {difficulty}

Difficulty guidelines:
- easy: basic recall, simple definitions, straightforward facts
- medium: application of concepts, moderate reasoning
- hard: analysis, complex reasoning, multi-step thinking

Respond ONLY with valid JSON, nothing else:
{{
  "question": "The question here?",
  "options": {{
    "A": "First option",
    "B": "Second option",
    "C": "Third option",
    "D": "Fourth option"
  }},
  "answer": "A",
  "explanation": "One sentence explaining why.",
  "difficulty": "{difficulty}"
}}"""

SUGGESTION_PROMPT = """You are Sivarr, an AI tutor advisor.

Student: {name}
Topics studied: {topics}
Weakest topics: {weak}
Quiz scores: {quiz_summary}
Current difficulty level: {difficulty}

Recommend exactly 3 topics to study next. Be specific and tailored.
Format: numbered list, one topic per line, one sentence explaining why.
Keep it encouraging and concise."""

# ─────────────────────────── Fix 1: .env Setup Helper ────────────

def setup_env_file():
    """Create a .env file if it doesn't exist and prompt for API key."""
    if os.path.exists(".env"):
        return
    print("━" * 45)
    print("  🔐 First time setup — API Key Configuration")
    print("━" * 45)
    print("Your API key will be saved to a .env file.")
    print("This keeps it secure and out of your code.\n")
    print("Get a free key at: https://aistudio.google.com/app/apikey\n")
    key = input("Paste your Gemini API key: ").strip()
    if not key:
        print("No key entered. Exiting.")
        exit()
    with open(".env", "w") as f:
        f.write(f"GEMINI_API_KEY={key}\n")
    # Add .env to .gitignore automatically
    gitignore = ".gitignore"
    if os.path.exists(gitignore):
        with open(gitignore) as f:
            content = f.read()
        if ".env" not in content:
            with open(gitignore, "a") as f:
                f.write("\n.env\n")
    else:
        with open(gitignore, "w") as f:
            f.write(".env\n")
    print("\n✅ API key saved to .env (and added to .gitignore for safety)\n")
    load_env()

# ─────────────────────────── Internet Check ──────────────────────

def check_internet() -> bool:
    try:
        socket.setdefaulttimeout(5)
        socket.create_connection(("8.8.8.8", 53))
        return True
    except OSError:
        return False

# ─────────────────────────── Math Detection ──────────────────────

def is_math_question(text: str) -> bool:
    return any(trigger in text.lower() for trigger in MATH_TRIGGERS)


def _safe_eval(expr: str) -> float | None:
    expr = expr.replace("^", "**").replace(" ", "")
    try:
        tree = ast.parse(expr, mode="eval")
        if any(not isinstance(n, MATH_ALLOWED_NODES) for n in ast.walk(tree)):
            return None
        return eval(compile(tree, "<string>", "eval"), {"__builtins__": {}}, {})
    except Exception:
        return None


def solve_math_local(text: str) -> str | None:
    if re.fullmatch(r"[\d+\-*/().^ \s]+", text.strip()):
        for candidate in [text] + re.findall(r"[\d+\-*/().^ ]+", text):
            candidate = candidate.strip()
            if not any(c.isdigit() for c in candidate):
                continue
            result = _safe_eval(candidate)
            if result is not None:
                formatted = int(result) if isinstance(result, float) and result.is_integer() else result
                return f"Result = {formatted}"
    return None

# ─────────────────────────── Fix 2: Fact Checking ────────────────

def check_confidence(answer: str) -> tuple[bool, str]:
    """
    Detect if Gemini's answer contains uncertainty signals.
    Returns (is_uncertain, warning_message)
    """
    lower = answer.lower()
    flagged = [p for p in UNCERTAINTY_PHRASES if p in lower]
    if flagged:
        return True, "⚠️  Sivarr isn't fully certain about this — please verify with your lecturer or a trusted source."
    return False, ""

# ─────────────────────────── Knowledge Cache ─────────────────────

def load_library() -> dict:
    if os.path.exists(LIBRARY_PATH):
        with open(LIBRARY_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_library(library: dict) -> None:
    tmp = LIBRARY_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(library, f, indent=2, ensure_ascii=False)
    shutil.move(tmp, LIBRARY_PATH)


def get_cached(library: dict, topic: str) -> str | None:
    entry = library.get(topic)
    if not entry:
        return None
    if isinstance(entry, str):
        return entry
    cached_date = datetime.date.fromisoformat(entry.get("date", "2000-01-01"))
    if (datetime.date.today() - cached_date).days > CACHE_EXPIRY_DAYS:
        return None
    return entry.get("answer")


def set_cached(library: dict, topic: str, answer: str) -> None:
    library[topic] = {"answer": answer, "date": datetime.date.today().isoformat()}

# ─────────────────────────── Fix 3: Question Bank ────────────────

def load_question_bank() -> dict:
    if os.path.exists(QUESTION_BANK_PATH):
        with open(QUESTION_BANK_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_question_bank(bank: dict) -> None:
    tmp = QUESTION_BANK_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(bank, f, indent=2, ensure_ascii=False)
    shutil.move(tmp, QUESTION_BANK_PATH)


def get_banked_question(bank: dict, topic: str, difficulty: str, used: list) -> dict | None:
    """Return a stored question for this topic/difficulty that hasn't been used yet."""
    key = f"{topic}_{difficulty}"
    questions = bank.get(key, [])
    unused = [q for q in questions if q["question"] not in used]
    return random.choice(unused) if unused else None


def bank_question(bank: dict, topic: str, difficulty: str, question: dict) -> None:
    """Store a newly generated question in the bank."""
    key = f"{topic}_{difficulty}"
    bank.setdefault(key, [])
    # Avoid duplicates
    existing = [q["question"] for q in bank[key]]
    if question["question"] not in existing:
        bank[key].append(question)
        # Cap at 20 questions per topic/difficulty
        bank[key] = bank[key][-20:]

# ─────────────────────────── Progress Tracking ───────────────────

def load_progress(student: str) -> dict:
    path = f"{student}_progress.json"
    if os.path.exists(path):
        with open(path, "r") as f:
            return json.load(f)
    return {
        "sessions": 0, "topics": {}, "questions": 0,
        "quizzes": [], "wrong_answers": [], "chat_history": [],
        "difficulty": "medium"
    }


def save_progress(student: str, progress: dict) -> None:
    path = f"{student}_progress.json"
    backup = f"{student}_progress.backup.json"
    if os.path.exists(path):
        shutil.copy2(path, backup)
    with open(path, "w") as f:
        json.dump(progress, f, indent=2)


def record_topic(topic: str, progress: dict, student: str) -> None:
    progress["questions"] += 1
    progress["topics"][topic] = progress["topics"].get(topic, 0) + 1
    save_progress(student, progress)


def weak_topics(progress: dict) -> list:
    return sorted(progress["topics"], key=lambda t: progress["topics"][t])[:3]


def show_progress(progress: dict) -> None:
    quizzes = progress.get("quizzes", [])
    avg_score = (sum(q["score"] for q in quizzes) / len(quizzes) * 100) if quizzes else 0
    wrong = progress.get("wrong_answers", [])
    difficulty = progress.get("difficulty", "medium")
    print(f"\n  Name          : {progress.get('name', 'Unknown')}")
    print(f"  Matric        : {progress.get('matric', 'N/A')}")
    print(f"  Difficulty    : {difficulty.title()}")
    print(f"  Sessions      : {progress['sessions']}")
    print(f"  Questions     : {progress['questions']}")
    print(f"  Topics covered: {', '.join(progress['topics']) or 'none yet'}")
    print(f"  Needs review  : {', '.join(weak_topics(progress)) or 'none yet'}")
    if quizzes:
        last = quizzes[-1]
        print(f"  Quizzes taken : {len(quizzes)}")
        print(f"  Avg quiz score: {avg_score:.0f}%")
        print(f"  Last quiz     : {last['pct']}% on {last['topic']} ({last.get('difficulty','medium')})")
    if wrong:
        print(f"  Wrong answers : {len(wrong)} saved (type \"revise\" to review)")
    print()

# ─────────────────────────── Fix 5: Cross-Session Memory ─────────

def build_memory_context(progress: dict) -> str:
    """Build a memory summary from past chat history to feed into Gemini."""
    history = progress.get("chat_history", [])
    if not history:
        return ""
    topics = list(progress.get("topics", {}).keys())
    recent = history[-10:]  # Last 5 exchanges
    lines = ["Previous conversation context (for continuity):"]
    for h in recent:
        role = "Student" if h["role"] == "user" else "Sivarr"
        lines.append(f"  {role}: {h['message']}")
    if topics:
        lines.append(f"Topics this student has studied: {', '.join(topics[-5:])}")
    return "\n".join(lines)


def save_chat_history(progress: dict, student: str, role: str, message: str) -> None:
    history = progress.setdefault("chat_history", [])
    history.append({
        "role": role,
        "message": message,
        "time": datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    })
    progress["chat_history"] = history[-40:]
    save_progress(student, progress)


def show_last_session(progress: dict) -> None:
    history = progress.get("chat_history", [])
    if not history:
        return
    last_topics = list(progress.get("topics", {}).keys())[-3:]
    if last_topics:
        print(f"  📚 Recently studied: {', '.join(last_topics)}")
    wrong_count = len(progress.get("wrong_answers", []))
    if wrong_count:
        print(f"  📖 You have {wrong_count} wrong answer(s) to revise.")
    print()

# ─────────────────────────── Topic Extraction ────────────────────

def extract_topic(question: str) -> str:
    q = question.lower()
    for kw in TOPIC_KEYWORDS:
        q = q.replace(kw, "")
    return q.strip()

# ─────────────────────────── Gemini Setup ────────────────────────

def setup_gemini(api_key: str) -> str:
    genai.configure(api_key=api_key)
    candidates = ["gemini-1.5-flash", "gemini-1.5-pro", "gemini-pro", "gemini-1.0-pro"]
    try:
        available = [m.name.replace("models/", "") for m in genai.list_models()
                     if "generateContent" in m.supported_generation_methods]
        for c in candidates:
            if c in available:
                return c
        return available[0] if available else candidates[0]
    except Exception:
        return candidates[0]


def make_chat(model_name: str, system: str):
    model = genai.GenerativeModel(
        model_name=model_name,
        system_instruction=system,
        generation_config=genai.GenerationConfig(temperature=0.7, max_output_tokens=300)
    )
    return model.start_chat(history=[])


def ask_gemini(chat_session, question: str) -> str | None:
    try:
        response = chat_session.send_message(question)
        return response.text.strip()
    except Exception as e:
        return f"[Gemini error: {e}]"


def call_gemini_once(model_name: str, prompt: str, system: str = None,
                     temperature: float = 0.7, max_tokens: int = 400) -> str | None:
    try:
        model = genai.GenerativeModel(
            model_name=model_name,
            system_instruction=system,
            generation_config=genai.GenerationConfig(temperature=temperature, max_output_tokens=max_tokens)
        )
        return model.generate_content(prompt).text.strip()
    except Exception:
        return None

# ─────────────────────────── Math Solver ─────────────────────────

def solve_math_gemini(math_chat, question: str) -> str | None:
    try:
        return math_chat.send_message(question).text.strip()
    except Exception as e:
        return f"[Math error: {e}]"

# ─────────────────────────── Topic Suggestions ───────────────────

def suggest_topics(model_name: str, student: str, progress: dict) -> None:
    topics = list(progress["topics"].keys())
    if not topics:
        print("\nSivarr: Study some topics first and I'll suggest what to learn next!\n")
        return
    quizzes = progress.get("quizzes", [])
    quiz_summary = (
        f"Average {sum(q['score'] for q in quizzes)/len(quizzes)*100:.0f}% across {len(quizzes)} quizzes"
        if quizzes else "No quizzes yet"
    )
    prompt = SUGGESTION_PROMPT.format(
        name=student, topics=", ".join(topics),
        weak=", ".join(weak_topics(progress)) or "none",
        quiz_summary=quiz_summary,
        difficulty=progress.get("difficulty", "medium")
    )
    print("\nSivarr: Based on your progress, here's what I recommend:\n")
    result = call_gemini_once(model_name, prompt, temperature=0.6, max_tokens=250)
    print(result if result else "  Couldn't generate suggestions right now.")
    print()

# ─────────────────────────── Fix 3+4: Quiz with Bank & Difficulty ─

def generate_quiz_question(model_name: str, topic: str, difficulty: str,
                            bank: dict, used_questions: list) -> dict | None:
    # Fix 3: Try question bank first
    banked = get_banked_question(bank, topic, difficulty, used_questions)
    if banked:
        return banked

    # Generate fresh question
    prompt = QUIZ_PROMPT.format(topic=topic, difficulty=difficulty)
    raw = call_gemini_once(model_name, prompt, temperature=0.9, max_tokens=300)
    if not raw:
        return None
    try:
        raw = re.sub(r"```(?:json)?", "", raw).strip().rstrip("`").strip()
        q = json.loads(raw)
        # Fix 3: Save to bank for reuse
        bank_question(bank, topic, difficulty, q)
        save_question_bank(bank)
        return q
    except Exception:
        return None


def run_quiz(model_name: str, progress: dict, student: str, bank: dict) -> None:
    topics = list(progress["topics"].keys())
    if not topics:
        print("\nSivarr: Ask me some questions first, then come back for a quiz!\n")
        return

    # Fix 4: Use student's difficulty level
    difficulty = progress.get("difficulty", "medium")

    print("\n" + "─" * 45)
    print(f"     📝  SIVARR QUIZ — 5 Questions [{difficulty.upper()}]")
    print("─" * 45)
    print("Answer with A, B, C, or D.\n")

    score = 0
    used_questions = []
    quiz_topics = [random.choice(topics) for _ in range(5)]
    dominant_topic = max(set(quiz_topics), key=quiz_topics.count)

    for i, topic in enumerate(quiz_topics, 1):
        print(f"Q{i} [{topic}] — Generating...", end="\r")
        q = generate_quiz_question(model_name, topic, difficulty, bank, used_questions)

        if not q:
            print(f"Q{i} — Skipped.                              ")
            continue

        used_questions.append(q["question"])
        print(f"Q{i}. {q['question']}                    ")
        for letter, option in q["options"].items():
            print(f"   {letter}) {option}")

        while True:
            ans = input("   Your answer: ").strip().upper()
            if ans in ("A", "B", "C", "D"):
                break
            print("   Please enter A, B, C, or D.")

        correct = q["answer"].upper()
        if ans == correct:
            print(f"   ✅ Correct! {q['explanation']}\n")
            score += 1
        else:
            print(f"   ❌ Wrong. Answer: {correct}. {q['explanation']}\n")
            progress.setdefault("wrong_answers", []).append({
                "topic": topic, "question": q["question"],
                "your_answer": ans, "correct": correct,
                "explanation": q["explanation"],
                "difficulty": difficulty,
                "date": datetime.date.today().isoformat()
            })

    pct = int(score / 5 * 100)
    print("─" * 45)
    print(f"  Quiz complete! You scored {score}/5 ({pct}%) [{difficulty.upper()}]")
    if pct == 100:   print("  🏆 Perfect score! Outstanding!")
    elif pct >= 80:  print("  🌟 Great job!")
    elif pct >= 60:  print("  👍 Good effort! Keep studying.")
    else:            print("  💪 Keep going — practice makes perfect!")

    # Fix 4: Suggest difficulty adjustment
    if pct == 100 and difficulty != "hard":
        next_level = DIFFICULTY_LEVELS[DIFFICULTY_LEVELS.index(difficulty) + 1]
        print(f"  🔥 You're crushing {difficulty}! Type \"difficulty {next_level}\" to level up.")
    elif pct < 40 and difficulty != "easy":
        prev_level = DIFFICULTY_LEVELS[DIFFICULTY_LEVELS.index(difficulty) - 1]
        print(f"  💡 Try \"difficulty {prev_level}\" to build confidence first.")

    wrong_count = len(progress.get("wrong_answers", []))
    if wrong_count:
        print(f"  📖 {wrong_count} wrong answer(s) saved — type \"revise\" to review.")
    print("─" * 45 + "\n")

    progress.setdefault("quizzes", []).append({
        "topic": dominant_topic, "score": score / 5,
        "pct": pct, "difficulty": difficulty
    })
    save_progress(student, progress)

# ─────────────────────────── Revision Mode ───────────────────────

def revise_wrong_answers(progress: dict, student: str) -> None:
    wrong = progress.get("wrong_answers", [])
    if not wrong:
        print("\nSivarr: No wrong answers saved yet — ace those quizzes! 🎯\n")
        return
    print(f"\n{'─' * 45}")
    print(f"  📖 REVISION — {len(wrong)} question(s) to review")
    print(f"{'─' * 45}\n")
    cleared = []
    for i, w in enumerate(wrong, 1):
        diff = w.get("difficulty", "medium")
        print(f"Q{i}. [{w['topic']} — {diff}] {w['question']}")
        print(f"   ❌ You answered : {w['your_answer']}")
        print(f"   ✅ Correct      : {w['correct']}")
        print(f"   💡 Why          : {w['explanation']}")
        mark = input("   Got it now? (y/n): ").strip().lower()
        if mark == "y":
            cleared.append(i - 1)
        print()
    for idx in reversed(cleared):
        wrong.pop(idx)
    progress["wrong_answers"] = wrong
    save_progress(student, progress)
    print(f"Sivarr: Done! {len(cleared)} cleared. {len(wrong)} remaining. 💪\n")

# ─────────────────────────── Error Messages ──────────────────────

def friendly_error(e: Exception) -> str:
    msg = str(e).lower()
    if "api key" in msg or "invalid" in msg:
        return "❌ API key issue. Check your .env file and make sure the key is correct."
    if "quota" in msg or "limit" in msg:
        return "❌ Gemini quota exceeded. Wait a bit or check aistudio.google.com."
    if "network" in msg or "connection" in msg or "timeout" in msg:
        return "❌ Connection issue. Check your internet and try again."
    if "404" in msg or "not found" in msg:
        return "❌ Model not found. Restart — Sivarr will auto-select a working model."
    return f"❌ Something went wrong: {e}"

# ─────────────────────────── Main ────────────────────────────────

def main() -> None:
    print("=" * 45)
    print("         🚀 SIVARR AI  v3.0")
    print("    Your Growth. Your Journey. Your Future.")
    print("=" * 45 + "\n")

    # Fix 1: Secure API key setup
    setup_env_file()
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        print("❌ No API key found. Add GEMINI_API_KEY to your .env file.")
        return

    # Internet check
    print("Checking connection...", end=" ", flush=True)
    if not check_internet():
        print("❌\nNo internet connection. Please connect and restart.\n")
        return
    print("✓")

    if not GEMINI_AVAILABLE:
        print("\nRun: pip3 install google-generativeai\n")
        return

    # Student login
    name = input("\nEnter student name: ").strip()
    if not name:
        print("Name cannot be empty.")
        return
    matric = input("Enter matric number: ").strip()
    if not matric:
        print("Matric number cannot be empty.")
        return

    student_id = f"{name.lower()}_{matric.lower()}"
    display_name = name.title()

    progress = load_progress(student_id)
    progress["sessions"] += 1
    progress["name"] = display_name
    progress["matric"] = matric.upper()
    progress["_id"] = student_id
    save_progress(student_id, progress)

    library = load_library()
    bank = load_question_bank()

    is_returning = progress["sessions"] > 1
    print(f"\n{'Welcome back' if is_returning else 'Welcome'}, {display_name}! (Matric: {matric.upper()})")
    difficulty = progress.get("difficulty", "medium")
    print(f"Quiz difficulty: {difficulty.title()} | Change with \"difficulty easy/medium/hard\"")
    if is_returning:
        show_last_session(progress)

    print('\nCommands: "quiz" | "revise" | "suggest" | "progress" | "difficulty <level>" | "exit"\n')
    print("Connecting to Gemini...", end=" ", flush=True)

    try:
        model_name = setup_gemini(api_key)
        print(f"Connected ✓  (model: {model_name})\n")

        # Fix 5: Build memory context from past sessions
        memory = build_memory_context(progress)
        system_with_memory = SYSTEM_PROMPT + (f"\n\n{memory}" if memory else "")

        chat = make_chat(model_name, system_with_memory)
        math_chat = make_chat(model_name, MATH_SYSTEM_PROMPT)
    except Exception as e:
        print(f"\n{friendly_error(e)}")
        return

    identity_triggers = [
        "who are you", "what are you", "what is sivarr", "who is sivarr",
        "tell me about yourself", "about you", "what can you do",
        "what do you do", "are you an ai", "introduce yourself",
        "what are your features", "sivarr meaning", "about sivarr"
    ]

    while True:
        try:
            user_input = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nSivarr: Goodbye! Keep growing! 🚀")
            break

        if not user_input:
            continue

        normalized = user_input.lower()

        if normalized in {"done", "exit", "quit"}:
            print("Sivarr: Goodbye! Keep learning! 🚀")
            break

        if normalized == "progress":
            show_progress(progress)
            continue

        if normalized == "quiz":
            run_quiz(model_name, progress, student_id, bank)
            continue

        if normalized == "revise":
            revise_wrong_answers(progress, student_id)
            continue

        if normalized in {"suggest", "suggestions", "what should i study", "what to study"}:
            suggest_topics(model_name, display_name, progress)
            continue

        # Fix 4: Difficulty command
        if normalized.startswith("difficulty "):
            level = normalized.replace("difficulty ", "").strip()
            if level in DIFFICULTY_LEVELS:
                progress["difficulty"] = level
                save_progress(student_id, progress)
                print(f"Sivarr: Quiz difficulty set to {level.title()}! 🎯\n")
            else:
                print("Sivarr: Valid levels are: easy, medium, hard\n")
            continue

        # Identity
        if any(trigger in normalized for trigger in identity_triggers):
            print(f"""
Sivarr: Hey! 👋 I'm the Sivarr AI — your learning companion on the Sivarr platform!

🏢 Company  : Sivarr
👤 Founder  : {COMPANY_INFO["founder"]} (Lead City University student)
🎯 Mission  : {COMPANY_INFO["mission"]}
🌍 Vision   : Starting with Lead City University, expanding to more universities soon.
🤖 My role  : AI assistant embedded in Sivarr to help students like you grow.
⚙️  Version  : v{SIVARR_VERSION}

What I can do:
  📚 Answer questions on ANY subject
  🧮 Solve math — arithmetic to calculus
  📝 Quiz you (Easy / Medium / Hard)
  📖 Revise wrong quiz answers
  💡 Suggest what to study next
  📊 Track your progress
  🧠 Remember our past conversations

Sivarr's goal? Student → skilled professional → career success. Let's go! 🚀
""")
            continue

        # Fast local arithmetic
        local_result = solve_math_local(user_input)
        if local_result:
            print(f"Sivarr: {local_result}\n")
            record_topic("math", progress, student_id)
            continue

        # Math via Gemini
        if is_math_question(normalized):
            print("Sivarr: ", end="", flush=True)
            answer = solve_math_gemini(math_chat, user_input)
            if answer and not answer.startswith("["):
                # Fix 2: Fact check math answers too
                uncertain, warning = check_confidence(answer)
                print(f"{answer}\n")
                if uncertain:
                    print(f"  {warning}\n")
                record_topic("math", progress, student_id)
                save_chat_history(progress, student_id, "user", user_input)
                save_chat_history(progress, student_id, "sivarr", answer)
            else:
                print(f"{friendly_error(Exception(answer))}\n")
            continue

        # Local cache check
        topic = extract_topic(normalized)
        cached = get_cached(library, topic)
        if cached:
            print(f"\nSivarr: {cached}\n")
            record_topic(topic, progress, student_id)
            continue

        # General Gemini chat
        print("Sivarr: ", end="", flush=True)
        try:
            answer = ask_gemini(chat, user_input)
        except Exception as e:
            print(f"\n{friendly_error(e)}\n")
            continue

        if answer and not answer.startswith("[Gemini error"):
            # Fix 2: Check confidence of answer
            uncertain, warning = check_confidence(answer)
            print(f"{answer}\n")
            if uncertain:
                print(f"  {warning}\n")

            if any(kw in normalized for kw in ["what is", "define", "explain"]) and topic:
                if not uncertain:  # Don't cache uncertain answers
                    set_cached(library, topic, answer)
                    save_library(library)

            record_topic(topic or "general", progress, student_id)
            save_chat_history(progress, student_id, "user", user_input)
            save_chat_history(progress, student_id, "sivarr", answer)
        else:
            print(f"{friendly_error(Exception(answer or 'No response'))}\n")


if __name__ == "__main__":
    main()
