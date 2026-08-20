"""Check seed_corpus.jsonl before it is baked into a frozen map.

The map is built once and then never moves, so every corpus problem becomes
permanent. This catches the ones that matter:

  * too short / too few documents for the layout parameters
  * duplicate or near-duplicate lines (they collapse onto one point)
  * lines with fewer than 2 content words (the sparse row would be empty, which
    aborts the build)
  * domain imbalance (a domain with too few lines cannot form an island)
  * repeated sentence templates (clusters by style instead of by content)

Usage:
    python scripts/validate_corpus.py [path]
"""

import io
import json
import sys
from collections import Counter
from difflib import SequenceMatcher
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.config import MIN_TEXT_LENGTH
from core.features import extract_content_terms, normalize_text

DEFAULT_PATH = Path(__file__).resolve().parent / "seed_corpus.jsonl"

RECOMMENDED_MIN = 300
RECOMMENDED_TARGET = 600
RECOMMENDED_MAX = 1000
MAX_TEXT_LENGTH = 120
MIN_CONTENT_TERMS = 2
MIN_PER_DOMAIN = 10
NEAR_DUPLICATE_RATIO = 0.90
MIN_DOMAINS = 30

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def load_corpus(path):
    rows, errors = [], []
    with io.open(path, encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                errors.append((line_number, f"JSONとして読めません: {exc.msg}"))
                continue
            if not isinstance(record, dict) or "text" not in record:
                errors.append((line_number, "'text' フィールドがありません"))
                continue
            rows.append({
                "line": line_number,
                "text": normalize_text(record["text"]),
                "domain": (record.get("domain") or "未分類").strip(),
            })
    return rows, errors


def find_near_duplicates(rows):
    """Blocking on a 6-char prefix keeps this near-linear for ~1000 rows."""
    pairs = []
    buckets = {}
    for row in rows:
        for key in {row["text"][:6], row["text"][-6:]}:
            buckets.setdefault(key, []).append(row)
    seen = set()
    for bucket in buckets.values():
        for i in range(len(bucket)):
            for j in range(i + 1, len(bucket)):
                a, b = bucket[i], bucket[j]
                key = (a["line"], b["line"])
                if key in seen:
                    continue
                seen.add(key)
                if a["text"] == b["text"]:
                    continue  # already reported as an exact duplicate
                ratio = SequenceMatcher(None, a["text"], b["text"]).ratio()
                if ratio >= NEAR_DUPLICATE_RATIO:
                    pairs.append((a, b, ratio))
    return sorted(pairs, key=lambda item: -item[2])


def main(path):
    path = Path(path)
    if not path.exists():
        print(f"[NG] ファイルがありません: {path}")
        print("     scripts/seed_corpus.jsonl に JSONL を置いてください。")
        return 1

    rows, parse_errors = load_corpus(path)
    problems, warnings = [], []

    for line_number, message in parse_errors:
        problems.append(f"L{line_number}: {message}")

    total = len(rows)
    print(f"読み込み: {total} 件  ({path})")

    if total < RECOMMENDED_MIN:
        problems.append(
            f"件数が {total} 件です。最低 {RECOMMENDED_MIN} 件必要です"
            f"（推奨 {RECOMMENDED_TARGET} 件）。"
            " これを下回ると n_neighbors=15 の近傍グラフが組めず島が成立しません。"
        )
    elif total < RECOMMENDED_TARGET:
        warnings.append(f"件数 {total}。推奨は {RECOMMENDED_TARGET} 件です。")
    elif total > RECOMMENDED_MAX:
        warnings.append(f"件数 {total}。{RECOMMENDED_MAX} 件を超えると学習が長くなります。")

    # --- per-row checks -----------------------------------------------------
    lengths, term_counts = [], []
    exact = {}
    for row in rows:
        text, line_number = row["text"], row["line"]
        length = len(text)
        lengths.append(length)

        if length < MIN_TEXT_LENGTH:
            problems.append(f"L{line_number}: {length}字（{MIN_TEXT_LENGTH}字以上必要）: {text[:24]}...")
        elif length > MAX_TEXT_LENGTH:
            warnings.append(f"L{line_number}: {length}字（推奨上限{MAX_TEXT_LENGTH}字）: {text[:24]}...")

        terms = extract_content_terms(text)
        row["terms"] = terms
        term_counts.append(len(terms))
        if len(terms) < MIN_CONTENT_TERMS:
            problems.append(
                f"L{line_number}: 内容語が{len(terms)}語しかありません"
                f"（{MIN_CONTENT_TERMS}語以上必要・ビルドが中断します）: {text[:30]}"
            )

        if text in exact:
            problems.append(f"L{line_number}: L{exact[text]} と完全に同一の文です")
        else:
            exact[text] = line_number

    # --- corpus-level checks -------------------------------------------------
    duplicates = find_near_duplicates(rows)
    for a, b, ratio in duplicates[:20]:
        warnings.append(f"L{a['line']} と L{b['line']} が {ratio:.0%} 一致: {a['text'][:26]}...")
    if len(duplicates) > 20:
        warnings.append(f"...ほか {len(duplicates) - 20} 組の近似重複")

    # `domain` is optional and purely an authoring aid - nothing downstream reads
    # it. Only check balance when the corpus actually carries the field.
    has_domains = any(row["domain"] != "未分類" for row in rows)
    domains = Counter(row["domain"] for row in rows) if has_domains else Counter()
    thin = []
    if has_domains:
        if len(domains) < MIN_DOMAINS:
            warnings.append(f"ドメイン数 {len(domains)}。{MIN_DOMAINS} 以上を推奨します。")
        thin = [(name, count) for name, count in domains.items() if count < MIN_PER_DOMAIN]

    # Style check: identical sentence endings across many rows means the corpus
    # will cluster by phrasing rather than by topic.
    endings = Counter(row["text"][-8:] for row in rows if len(row["text"]) >= 8)
    for ending, count in endings.most_common(5):
        if count > max(8, total * 0.06):
            warnings.append(
                f"文末「...{ending}」が {count} 件（{count / total:.0%}）。"
                " 同じ文型が多いと内容ではなく文体で島ができます。"
            )

    vocabulary = Counter(term for row in rows for term in row.get("terms", []))

    # --- report -------------------------------------------------------------
    print()
    if lengths:
        srt = sorted(lengths)
        print(f"文字数    : 最小 {srt[0]} / 中央 {srt[len(srt)//2]} / 平均 {sum(srt)/len(srt):.1f} / 最大 {srt[-1]}")
    if term_counts:
        srt = sorted(term_counts)
        print(f"内容語数  : 最小 {srt[0]} / 中央 {srt[len(srt)//2]} / 平均 {sum(srt)/len(srt):.1f} / 最大 {srt[-1]}")
    print(f"語彙      : 異なり {len(vocabulary)} 語 / 延べ {sum(vocabulary.values())} 語")
    if has_domains:
        print(f"ドメイン  : {len(domains)} 種")
    if thin:
        print(f"  10件未満: {', '.join(f'{n}({c})' for n, c in sorted(thin, key=lambda x: x[1]))}")

    print()
    if problems:
        print(f"[NG] 修正が必要な問題 {len(problems)} 件")
        for message in problems[:40]:
            print(f"  - {message}")
        if len(problems) > 40:
            print(f"  ...ほか {len(problems) - 40} 件")
    else:
        print("[OK] 致命的な問題はありません")

    if warnings:
        print()
        print(f"[!] 確認推奨 {len(warnings)} 件")
        for message in warnings[:30]:
            print(f"  - {message}")
        if len(warnings) > 30:
            print(f"  ...ほか {len(warnings) - 30} 件")

    print()
    if problems:
        print("=> 上記を直してから scripts/build_seed_map.py を実行してください。")
        return 1
    print("=> ビルド可能です: python scripts/build_seed_map.py")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PATH))
