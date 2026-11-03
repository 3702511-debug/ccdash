#!/usr/bin/env python3
"""Выгружает переписку именованных сессий Claude Code в Markdown рядом с их CLAUDE.md.

Зачем: jsonl в ~/.claude/projects не вечны (инцидент 22.09.2026) и непонятны другим
агентам. Выгрузка лежит в папке сессии — её прочтёт и человек, и Codex.

Куда: <папка с CLAUDE.md сессии>/_история_сессии/<название>.md
  - папка = ближайшая вверх от cwd, где есть CLAUDE.md;
  - если cwd = домашняя папка — берётся из таблицы в ~/CLAUDE.md.
Что попадает: реплики пользователя, ответы Claude, сводки после compact, одной
строкой — какие инструменты вызывались. Выводы инструментов и thinking — нет.
Сессии без /rename (служебные запуски claude -p) пропускаются.

Запуск: python3 export-transcripts.py [--dry-run]
"""
import glob, json, os, re, subprocess, sys
from collections import defaultdict

HOME = os.path.expanduser("~")
PROJECTS = os.path.join(HOME, ".claude", "projects")
OUT_DIR = "_история_сессии"
MIN_USER_MSGS = 3
DRY = "--dry-run" in sys.argv

NOISE = re.compile(r"<(system-reminder|local-command-stdout|local-command-caveat|command-message|command-args)>.*?</\1>", re.S)


def home_table():
    """Название сессии → папка из таблицы в ~/CLAUDE.md."""
    m = {}
    try:
        for line in open(os.path.join(HOME, "CLAUDE.md"), encoding="utf-8"):
            r = re.match(r"\|\s*([^|`]+?)\s*\|\s*`([^`]+)/CLAUDE\.md`", line)
            if r:
                m[r.group(1).lower()] = os.path.expanduser(r.group(2))
    except OSError:
        pass
    return m


def target_dir(title, cwd, table):
    if os.path.realpath(cwd) == os.path.realpath(HOME):
        return table.get(title.lower())
    d = cwd
    while d.startswith(HOME) and d != HOME:
        if os.path.isfile(os.path.join(d, "CLAUDE.md")):
            return d
        d = os.path.dirname(d)
    return cwd if os.path.isdir(cwd) else None


def user_text(content):
    if isinstance(content, str):
        parts = [content]
    else:
        parts = []
        for b in content:
            if b.get("type") == "text":
                parts.append(b["text"])
            elif b.get("type") == "image":
                parts.append("[изображение]")
            elif b.get("type") == "tool_result":
                return None  # ответ инструмента, не реплика
    t = NOISE.sub("", "\n".join(parts))
    t = re.sub(r"<command-name>(.*?)</command-name>", r"\1", t).strip()
    return t or None


def tool_line(b):
    name, inp = b.get("name", "?"), b.get("input") or {}
    what = inp.get("description") or inp.get("file_path") or inp.get("query") or inp.get("url") or inp.get("pattern") or ""
    if not what and name == "Bash":
        what = (inp.get("command") or "")[:120]
    what = str(what).replace("\n", " ")[:160]
    return f"- 🔧 `{name}` {what}".rstrip()


def collect():
    sessions = defaultdict(lambda: {"recs": {}, "sids": set(), "cwd": None})
    # от старых к новым: при нескольких jsonl с одним названием побеждает cwd свежего
    for path in sorted(glob.glob(os.path.join(PROJECTS, "*", "*.jsonl")), key=os.path.getmtime):
        title, recs, cwd = None, [], None
        with open(path, encoding="utf-8", errors="ignore") as f:
            for line in f:
                try:
                    j = json.loads(line)
                except ValueError:
                    continue
                t = j.get("type")
                if t == "custom-title":
                    title = j.get("customTitle") or title
                elif t in ("user", "assistant") and not j.get("isSidechain"):
                    recs.append(j)
                    cwd = cwd or j.get("cwd")  # cwd запуска, а не после cd
        if not title or not cwd:
            continue
        s = sessions[title]
        s["sids"].add(os.path.basename(path)[:-6])
        s["cwd"] = cwd
        for r in recs:
            s["recs"].setdefault(r.get("uuid") or id(r), r)
    return sessions


def render(title, s):
    recs = sorted(s["recs"].values(), key=lambda r: r.get("timestamp", ""))
    out, n_user, tools = [], 0, []

    def flush_tools():
        if tools:
            out.append("<details><summary>инструменты: %d</summary>\n\n%s\n\n</details>\n" % (len(tools), "\n".join(tools)))
            tools.clear()

    for r in recs:
        ts = (r.get("timestamp") or "")[:16].replace("T", " ")
        msg = r.get("message") or {}
        if r["type"] == "user":
            if r.get("isMeta"):
                continue
            txt = user_text(msg.get("content", ""))
            if not txt:
                continue
            flush_tools()
            if r.get("isCompactSummary"):
                out.append(f"<details><summary>📋 Сводка контекста (compact), {ts}</summary>\n\n{txt}\n\n</details>\n")
                continue
            n_user += 1
            out.append(f"### 👤 Пользователь · {ts}\n\n{txt}\n")
        else:
            for b in msg.get("content") or []:
                if b.get("type") == "text" and b["text"].strip():
                    flush_tools()
                    out.append(f"**🤖 Claude:** {b['text'].strip()}\n")
                elif b.get("type") == "tool_use":
                    tools.append(tool_line(b))
    flush_tools()
    if n_user < MIN_USER_MSGS:
        return None, 0
    first, last = recs[0].get("timestamp", "")[:10], recs[-1].get("timestamp", "")[:10]
    head = (
        f"# Переписка сессии «{title}»\n\n"
        f"- Период: {first} — {last}, реплик пользователя: {n_user}\n"
        f"- Claude Code sid: {', '.join(sorted(s['sids']))}\n"
        f"- Рабочая папка: `{s['cwd']}`\n\n"
        "> Автовыгрузка из `~/.claude/projects/*.jsonl` (`cc-dashboard/tools/export-transcripts.py`),\n"
        "> перезаписывается целиком — не редактировать. Главная база знаний — `CLAUDE.md` рядом;\n"
        "> этот файл — для поиска подробностей (grep по ключевым словам), а не для чтения подряд.\n"
        "> Выводы инструментов не сохраняются; сводки compact — в свёрнутых блоках.\n\n---\n\n"
    )
    return head + "\n".join(out), n_user


def git_exclude(d):
    """Если папка в git — не дать выгрузке попасть в коммит (через .git/info/exclude)."""
    try:
        top = subprocess.run(["git", "-C", d, "rev-parse", "--show-toplevel"], capture_output=True, text=True, timeout=5).stdout.strip()
        gdir = subprocess.run(["git", "-C", d, "rev-parse", "--absolute-git-dir"], capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        return
    if not top or not gdir:
        return
    ex = os.path.join(gdir, "info", "exclude")
    rules = [OUT_DIR + "/", "AGENTS.md"]
    have = open(ex, encoding="utf-8").read().split("\n") if os.path.exists(ex) else []
    add = [r for r in rules if r not in have]
    if add and not DRY:
        os.makedirs(os.path.dirname(ex), exist_ok=True)
        with open(ex, "a", encoding="utf-8") as f:
            f.write("\n# cc-dashboard export-transcripts\n" + "\n".join(add) + "\n")


def agents_link(d):
    """Codex читает AGENTS.md — даём ему тот же CLAUDE.md."""
    a, c = os.path.join(d, "AGENTS.md"), os.path.join(d, "CLAUDE.md")
    if os.path.isfile(c) and not os.path.lexists(a) and not DRY:
        os.symlink("CLAUDE.md", a)


def main():
    table = home_table()
    for title, s in sorted(collect().items()):
        d = target_dir(title, s["cwd"], table)
        if not d:
            print(f"?  {title}: не нашёл папку (cwd {s['cwd']})")
            continue
        md, n = render(title, s)
        if not md:
            continue
        safe = re.sub(r'[/\\:*?"<>|]', "_", title)
        dst = os.path.join(d, OUT_DIR, safe + ".md")
        print(f"ok {title}: {n} реплик, {len(md)//1024} КБ → {dst}")
        if DRY:
            continue
        git_exclude(d)
        agents_link(d)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        tmp = dst + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(md)
        os.replace(tmp, dst)


if __name__ == "__main__":
    main()
