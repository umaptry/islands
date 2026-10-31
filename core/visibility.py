"""Whose name the server may print for a given viewer (2026-11-01, D の 2-2).

Once `accounts_read` is closed (supabase/migrations M2), the browser can read an account only when
the person is: the viewer, in a community the viewer is in, a DM partner of the viewer, or (for an
admin) somebody waiting to join a community the viewer administers. The server reads with its own
key and could print anybody, so every place that puts a name on the wire for a viewer asks here
first. The words for a person who may not be shown are HIDDEN_PERSON_NAME.

Before the lockdown (members_only off) every account is readable, so everybody is visible: the
older behaviour stays exactly as it was.

The store is passed in (`store=`); app.py registers the running one with use_store() so a caller
inside the app can leave it out.
"""

from core.config import HIDDEN_PERSON_NAME

_provider = None


def use_store(provider):
    """Register a zero-argument function that returns the store in use right now."""
    global _provider
    _provider = provider


def _resolve(store):
    if store is not None:
        return store
    return _provider() if _provider else None


def _closed(store):
    """True when accounts are closed to outsiders (the same switch as the other members-only rules)."""
    try:
        return bool(store.members_only())
    except Exception:
        return False


def visible_ids(viewer_id, ids, *, store=None):
    """The ids (as strings) among `ids` whose name and face `viewer_id` may be shown."""
    wanted = {str(i) for i in ids if i}
    store = _resolve(store)
    if not wanted or store is None or not _closed(store):
        return wanted
    viewer = str(viewer_id) if viewer_id else None
    if not viewer:
        return set()
    seen = {viewer} & wanted
    rest = wanted - seen
    if rest:
        mates = set()
        for community in store.viewer_communities(viewer):
            mates |= {str(account) for account in store.community_member_ids(community)}
        seen |= rest & mates
        rest -= mates
    if rest and hasattr(store, "dm_partner_ids"):
        seen |= rest & {str(account) for account in store.dm_partner_ids(viewer)}
        rest = wanted - seen
    if rest and hasattr(store, "pending_applicant_ids"):
        seen |= rest & {str(account) for account in store.pending_applicant_ids(viewer)}
    return seen


def display_name_for(viewer_id, account, *, store=None):
    """The name to print for `account` (a dict with `id` and `display_name`, or just an id)."""
    store = _resolve(store)
    if isinstance(account, dict):
        account_id, name = account.get("id"), account.get("display_name")
    else:
        account_id, name = account, None
        if account_id and store is not None:
            name = (store.get_account(account_id) or {}).get("display_name")
    if not account_id:
        return name or ""
    if str(account_id) in visible_ids(viewer_id, [account_id], store=store):
        return name or ""
    return HIDDEN_PERSON_NAME


def mask_person(viewer_id, person, *, store=None, visible=None):
    """A copy of a {id, display_name, icon_id, avatar_path, ...} dict that may be printed for the
    viewer: the name, the face and the profile words of a person who may not be shown are replaced."""
    if not person or not person.get("id"):
        return person
    shown = visible if visible is not None else visible_ids(viewer_id, [person["id"]], store=store)
    if str(person["id"]) in shown:
        return person
    hidden = dict(person)
    hidden["display_name"] = HIDDEN_PERSON_NAME
    hidden["icon_id"] = "0"
    hidden["avatar_path"] = None
    for key in ("affiliation", "bio", "link_url", "topics", "goal", "seeking", "offering",
                "job_title", "age_band"):
        if key in hidden:
            hidden[key] = [] if key == "topics" else None
    return hidden


__all__ = ["display_name_for", "mask_person", "use_store", "visible_ids"]
