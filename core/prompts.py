"""Which weekly prompt is showing (Q37).

Pure: the clock is passed in, so tests can stand on any Monday they like.
"""

from datetime import datetime, timedelta, timezone

from core.config import PROMPT_UTC_OFFSET_HOURS, WEEKLY_PROMPTS


def weekly_prompt(now=None, prompts=WEEKLY_PROMPTS, offset_hours=PROMPT_UTC_OFFSET_HOURS):
    """{"key": "2026-W41", "text": ..., "until": ISO time the week ends (UTC)}.

    The week is the ISO week in Japan time, so it turns over at Monday 00:00
    there and not at 09:00. The prompt is chosen by counting weeks from a fixed
    Monday rather than by the ISO week number, which restarts every January
    and would show the first few prompts twice in a row across New Year.
    """
    if not prompts:
        return None
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    zone = timezone(timedelta(hours=offset_hours))
    local = now.astimezone(zone)
    monday = (local - timedelta(days=local.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    epoch = datetime(2024, 1, 1, tzinfo=zone)  # a Monday
    weeks = (monday - epoch).days // 7
    year, week, _ = local.isocalendar()
    return {
        "key": f"{year}-W{week:02d}",
        "text": prompts[weeks % len(prompts)],
        "until": (monday + timedelta(days=7)).astimezone(timezone.utc).isoformat(),
    }
