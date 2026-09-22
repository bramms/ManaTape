"""Перевірка локальних домовленостей документації, не валідатор специфікації OKF."""

import re
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import unquote, urlsplit

from ruamel.yaml import YAML
from ruamel.yaml.error import YAMLError


SKIP = {"private", "venv", "node_modules", "__pycache__"}
LINKS = re.compile(r'!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))[^)\n]*\)|^\s*\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))', re.M)


def frontmatter(text):
    lines = text.splitlines()
    if not lines or lines[0] != "---":
        return None
    if "---" not in lines[1:]:
        raise ValueError("незавершений YAML frontmatter")
    return YAML(typ="safe").load("\n".join(lines[1:lines.index("---", 1)]))


def local_links(text):
    # ponytail: прості inline/reference links; повний Markdown-парсер потрібен лише для складнішого синтаксису.
    text = re.sub(r"(?ms)^```.*?^```\s*$|^~~~.*?^~~~\s*$", "", text)
    text = re.sub(r"`[^`\n]+`", "", text)
    for match in LINKS.finditer(text):
        target = urlsplit(next(value for value in match.groups() if value is not None))
        if not target.scheme and not target.netloc and target.path and not target.path.startswith("/"):
            yield unquote(target.path)


def check(root):
    root = root.resolve()
    index, log = root / "docs/index.md", root / "docs/log.md"
    files = sorted({*root.glob("*.md"), *(root / "docs").rglob("*.md"), *(root / "integrations").rglob("*.md")})
    files = [path for path in files if not any(part.startswith(".") or part in SKIP for part in path.relative_to(root).parts)]
    errors, indexed = [], set()
    concepts = {path for path in files if path.is_relative_to(root / "docs") and path not in (index, log)}
    for path in (index, log):
        if not path.is_file():
            errors.append(f"{path.relative_to(root)}: обов’язковий файл відсутній")
    for path in files:
        name, text = path.relative_to(root), path.read_text(encoding="utf-8")
        if path.is_relative_to(root / "docs"):
            try:
                metadata = frontmatter(text)
                if path == log:
                    if text.startswith("---\n"):
                        errors.append(f"{name}: log.md має бути без frontmatter")
                elif path == index:
                    if metadata != {"okf_version": "0.2"}:
                        errors.append(f"{name}: frontmatter має містити лише okf_version: '0.2'")
                elif not isinstance(metadata, dict) or any(not isinstance(metadata.get(key), str) or not metadata[key].strip() for key in ("type", "title", "description")):
                    errors.append(f"{name}: потрібні непорожні рядки type, title, description у frontmatter")
                elif "status" in metadata and metadata["status"] not in ("draft", "stable", "deprecated"):
                    errors.append(f"{name}: status має бути draft, stable або deprecated")
            except (ValueError, YAMLError) as error:
                errors.append(f"{name}: некоректний frontmatter ({error})")
        for target in local_links(text):
            resolved = (path.parent / target).resolve()
            if not resolved.is_relative_to(root):
                errors.append(f"{name}: локальне посилання виходить за репозиторій: {target}")
            elif not resolved.exists():
                errors.append(f"{name}: ціль посилання відсутня: {target}")
            if path == index:
                indexed.add(resolved)
    for path in sorted(concepts - indexed):
        errors.append(f"docs/index.md: немає посилання на {path.relative_to(root / 'docs')}")
    return errors


def self_test():
    with TemporaryDirectory() as directory:
        root = Path(directory)
        (root / "docs").mkdir()
        (root / "docs/index.md").write_text("---\nokf_version: '0.2'\n---\n[Тема](topic.md#розділ)\n", encoding="utf-8")
        (root / "docs/log.md").write_text("# Журнал\n", encoding="utf-8")
        topic = root / "docs/topic.md"
        topic.write_text("---\ntype: guide\ntitle: Тема\ndescription: Приклад\nstatus: stable\n---\n", encoding="utf-8")
        assert check(root) == []
        topic.write_text(topic.read_text(encoding="utf-8").replace("stable", "unknown") + "![Знімок](missing.png)\n", encoding="utf-8")
        errors = check(root)
        assert len(errors) == 2 and any("status" in error for error in errors) and any("missing.png" in error for error in errors)
        assert list(local_links('`[код](skip.md)`\n```md\n[x](skip.md)\n```\n[x](<some%20file.md>)\n[x](https://example.test)\n[x](#якір)')) == ["some file.md"]


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        self_test()
        print("Самоперевірка документаційного checker: OK")
    elif sys.argv[1:]:
        sys.exit("Використання: check_docs.py [--self-test]")
    else:
        failures = check(Path(__file__).resolve().parents[1])
        print("\n".join(failures) if failures else "Документація: локальні домовленості й посилання перевірено")
        sys.exit(bool(failures))
