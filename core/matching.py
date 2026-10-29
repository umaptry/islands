"""Who a new post connects to (2026-10-29): pure functions, no database and no state.

A post has a stance, read from its prompt and tags only (never from the body): it asks for
help (need), wants company (want) or tells what the author did or does (have). A pair of
posts that complete each other (need/have, want/have) is shown on a lower cosine than a pair
on the same side, and each pair carries one line saying why. need x need is never shown.
"""

from . import config

NEED_TAG = "助けてほしい"
WANT_TAGS = ("仲間募集中", "参加者募集中")

# kind -> the line shown on the card.
REASONS = {
    ("need", "past"): ("need_have", "あなたの困りごとを、この人は経験しています"),
    ("need", "now"): ("need_have", "あなたの困りごとに、この人はいま取り組んでいます"),
    ("have", "need"): ("have_need", "この人の困りごとに、あなたの経験が役に立つかもしれません"),
    ("want", "past"): ("want_have", "あなたのやってみたいことを、この人は前にやっていました"),
    ("want", "now"): ("want_have", "あなたのやってみたいことを、この人はいまやっています"),
    ("have", "want"): ("have_want", "あなたがしていることを、この人はやってみたいそうです"),
    ("want", "want"): ("want_want", "この人も、同じことをやりたがっています"),
    ("need", "want"): ("need_want", "この人も、同じことに取り組もうとしています"),
    ("want", "need"): ("need_want", "この人も、同じことに取り組もうとしています"),
    ("have", "have"): ("have_have", "あなたと近いことをしている人です"),
}
NEAR = ("near", "近いことを書いている人です")
# kind (new post's author -> older post's author) -> the line the OLDER post's author reads in the
# 'match' notification (notifications.payload.reason).
NOTICE_REASONS = {
    "need_have": "あなたの経験が役に立ちそうな困りごとが投稿されました",
    "have_need": "あなたの困りごとに、経験のある人が投稿しました",
    "want_have": "あなたがやっていたことを、やってみたい人が投稿しました",
    "have_want": "あなたのやってみたいことを、やっている人が投稿しました",
    "want_want": "あなたと同じことをやりたがっている人が投稿しました",
    "need_want": "あなたと同じことに取り組もうとしている人が投稿しました",
    "have_have": "あなたと近いことをしている人が投稿しました",
    "near": "近いことを書いている人が投稿しました",
}
# Priority and which bar each kind has to clear.
PRIORITY = {"need_have": 1, "have_need": 1, "want_have": 1, "have_want": 1,
            "want_want": 2, "need_want": 2, "have_have": 3, "near": 3}
COMPLEMENT = {"need_have", "have_need", "want_have", "have_want"}


def stance_of(prompt, tags):
    """{"need": bool, "want": bool, "have": None | "past" | "now"} for a post's prompt and tags."""
    tags = tags or []
    return {
        "need": prompt == "help" or NEED_TAG in tags,
        "want": prompt == "future" or any(tag in tags for tag in WANT_TAGS),
        "have": prompt if prompt in ("past", "now") else None,
    }


def main_stance(stance):
    """The one side a post is on: need > want > have, else "other"; with the tense for have."""
    if stance["need"]:
        return "need", None
    if stance["want"]:
        return "want", None
    if stance["have"]:
        return "have", stance["have"]
    return "other", None


def judge(me, other):
    """(kind, reason) when `me` -> `other` can connect at all, else None."""
    mine, _ = main_stance(stance_of(me.get("prompt"), me.get("tags")))
    theirs, tense = main_stance(stance_of(other.get("prompt"), other.get("tags")))
    if mine == "need" and theirs == "need":
        return None
    if mine == "other" or theirs == "other":
        return NEAR
    # need/want -> have is told apart by the tense of the other post
    return REASONS.get((mine, tense if theirs == "have" and mine != "have" else theirs))


# Module-level copies so a test can change one bar without touching the config.
MATCH_COSINE_COMPLEMENT = config.MATCH_COSINE_COMPLEMENT
MATCH_COSINE_SAME = config.MATCH_COSINE_SAME


def threshold_of(kind):
    return MATCH_COSINE_COMPLEMENT if kind in COMPLEMENT else MATCH_COSINE_SAME


def lowest_bar():
    """The smallest cosine any kind may be shown at: below it a candidate can be dropped early."""
    return min(MATCH_COSINE_COMPLEMENT, MATCH_COSINE_SAME)


def pick_matches(me, candidates, *, limit=config.MATCH_LIMIT, excluded_authors=()):
    """Up to `limit` candidates, one per author, each with "reason" and "kind" added.

    me: {"author_id", "prompt", "tags"}. candidates: {"id", "author_id", "prompt", "tags",
    "cosine", ...}. Ordered by priority (small first), then cosine (large first).
    """
    skip = set(excluded_authors) | {me.get("author_id")}
    best = {}
    for candidate in candidates:
        author = candidate.get("author_id")
        if author in skip:
            continue
        verdict = judge(me, candidate)
        if verdict is None:
            continue
        kind, reason = verdict
        cosine = candidate.get("cosine")
        if cosine is None or cosine < threshold_of(kind):
            continue
        key = (PRIORITY[kind], -cosine)
        if author not in best or key < best[author][0]:
            best[author] = (key, {**candidate, "reason": reason, "kind": kind})
    ranked = sorted(best.values(), key=lambda item: item[0])
    return [item[1] for item in ranked[:max(0, limit)]]
