"""Where accounts, posts, reactions, comments and notifications live.

Two interchangeable backends behind one interface:

  SupabaseStore  - the deployed app. PostgREST with a Supabase secret key (or
                   the legacy service_role key), held only by the server.
                   Counts and notifications are maintained
                   by triggers in supabase/schema.sql, so writing a reaction
                   here is a single insert and nothing else.
  MemoryStore    - local development and tests. Nothing survives a restart, and
                   every trigger in the schema is reimplemented in Python so
                   the two backends behave the same. That duplication is the
                   price of `uvicorn app:app` working with no services running,
                   which is what makes the app testable at all.

Selected automatically: Supabase if SUPABASE_URL and SUPABASE_SERVICE_KEY are
both set, memory otherwise.

WHAT THIS LAYER IS AND IS NOT
-----------------------------
In the deployed app the browser reads and writes most of this itself, straight
to PostgREST, with its own JWT and RLS deciding what it may touch. This module
is what the SERVER uses: creating a post (because x/y/vec come from the frozen
encoder), naming the landmasses, and the local-mode shim that stands in for
PostgREST when there is no Supabase project at all.
"""

import json
import math
import os
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import numpy as np

from core.config import ENERGY_CELL_SIZE
from core.config import (
    COMMUNITY_ERROR_NAME,
    COMMUNITY_ERROR_RENAME_ADMIN_ONLY,
    COMMUNITY_NAME_MAX,
    DM_BODY_MAX,
    DM_ERROR_SEND,
    DM_ROOM_EXCERPT,
    INVITE_END_OF_DAY_MIN_MINUTES,
    INVITE_ERROR_ADMIN_ONLY,
    INVITE_ERROR_ADMIN_ONLY_LIST,
    INVITE_ERROR_ADMIN_ONLY_REVOKE,
    INVITE_ERROR_EXPIRED,
    INVITE_ERROR_MINUTES,
    INVITE_ERROR_REQUIRED,
    INVITE_ERROR_REVOKED,
    INVITE_ERROR_UNKNOWN,
    INVITE_MINUTES_MAX,
    INVITE_ONLY_CACHE_SECONDS,
    LOCAL_DEMO_COMMUNITY_NAME,
    LOCAL_DEMO_COMMUNITY_SLUG,
    LOCAL_DEMO_INVITE_CODE,
    MEMBERS_ONLY_CACHE_SECONDS,
    RECRUIT_TAG,
    TALK_DAILY_PRESS_LIMIT,
    TALK_ERROR_DAILY_LIMIT,
    TALK_ERROR_LOGIN,
    TALK_ERROR_NOT_PEER,
    TALK_ERROR_SELF,
    TALK_NOTICE_DAYS,
)
from core.energy import computed_energy, total_energy
from core.post_extras import (
    CLOSED_DEADLINE, CLOSED_FULL, ERROR_CLOSED, ERROR_FULL, EXTRA_COLUMNS, closed_state, shape,
)

ACCOUNTS = "accounts"
# posts reach accounts through the author key and, many-to-many, through
# reactions/comments/notifications/reports, so PostgREST needs the key named.
POST_AUTHOR = "accounts!posts_author_id_fkey"
POSTS = "posts"
REACTIONS = "reactions"
COMMENTS = "comments"
NOTIFICATIONS = "notifications"
DM_BLOCKS = "dm_blocks"
REPORTS = "reports"
NOTIFICATION_SETTINGS = "notification_settings"
ISLANDS_STATE = "islands_state"
ISLAND_EVENTS = "island_events"
PUSH_CONFIG = "push_config"
PUSH_SUBSCRIPTIONS = "push_subscriptions"
PUSH_PRESENCE = "push_presence"
REQUEST_TIMEOUT = 10.0

# A dropped connection or a 502 from the PostgREST front end is routine and
# clears on its own. Without a retry every one of them surfaced as a failed post
# in somebody's browser, which is the one thing a live demo cannot afford.
# Only transient classes are retried - a 400 or a 409 is our own bug or a real
# conflict, and repeating it just wastes the visitor's time.
RETRY_ATTEMPTS = 3
RETRY_BACKOFF = 0.4  # seconds, doubled each attempt
RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})

REACTION_KINDS = ("like", "help", "join")

# Columns the map needs. Deliberately excludes vec / vec_c: the vectors never
# leave the server, and the browser is not granted them either (see the column
# grants in supabase/schema.sql).
POST_COLUMNS_BASE = (
    "id,author_id,body,tags,motivation,image_path,x,y,cluster_id,terms,"
    "like_count,help_count,join_count,comment_count,energy,created_at,updated_at"
)
# The 2026-10-20 columns (お題 / 申込期限 / 先着人数). A database that has not had
# the migration yet answers 400 (42703) when they are named, so SupabaseStore
# reads and writes without them until it sees them (see supports_post_extras).
POST_COLUMNS = POST_COLUMNS_BASE + "," + ",".join(EXTRA_COLUMNS)
# The 2026-10-29 columns (ほかのコミュニティにも出す): the mark that joins the copies of one post
# in several communities, and the joins counted over all of them. Read and written only once the
# database has them (see supports_share), like the extras above.
SHARE_COLUMNS = ("share_group", "group_join_count")
SHARE_CHECK_SECONDS = 60
ACCOUNT_COLUMNS = ("id,display_name,affiliation,bio,link_url,icon_id,avatar_path,created_at,"
                   "updated_at,topics,goal,seeking,offering")
# The hidden profile vectors. Written by the server only, never selected for a client.
PROFILE_VECTOR_COLUMNS = ("vec_topics", "vec_goal", "vec_seeking", "vec_offering")
# Naming a landmass needs the words and the position, not the essays.
# author_id and created_at are what island growth and tracking count.
# community_id rides along (2026-10-27): the per-community islands, lines and quiet-post notices
# need to know which community a post belongs to without a second full scan.
TERM_COLUMNS = ("id,author_id,cluster_id,x,y,terms,motivation,like_count,help_count,"
                "join_count,comment_count,energy,created_at,community_id")
NOTIFICATION_COLUMNS = ("id,recipient_id,actor_id,post_id,comment_id,type,created_at,read_at,"
                        "island_id,event_id,payload")
# The columns the 2026-10-12 migration added. A database that has not had it yet
# answers 400 (42703 / PGRST204) when they are named; SupabaseStore then works
# without them (see _has_name_columns), so new code can come up before the SQL.
ISLAND_NAME_COLUMNS = ("name_source", "name_basis", "name_tried_at")
ISLAND_STATE_BASE_COLUMNS = ("id,name,label,tier,score_total,score_recent,score_shown,post_ids,"
                             "author_ids,cx,cy,landmarks,challenger,quiet,active,last_activity_at,"
                             "created_at,updated_at")
ISLAND_STATE_COLUMNS = ISLAND_STATE_BASE_COLUMNS + "," + ",".join(ISLAND_NAME_COLUMNS)
# The column the 2026-10-28 migration added (the one-line intro). Tracked apart from the name
# columns: a database that has the names but not this still keeps AI names.
ISLAND_INTRO_COLUMN = "intro"
# How long a "columns are there" / "columns are missing" check is trusted.
NAME_COLUMNS_CHECK_SECONDS = 60
POST_EXTRAS_CHECK_SECONDS = 60
# The table the 2026-10-26 migration ends up with; the server asks for it (service key)
# to learn whether 「話してみたい」/ DM can be switched on.
TALK_STATS = "talk_stats"
TALK_CHECK_SECONDS = 60
# The 2026-10-26 (second) migration: communities and invite links. The server asks for
# `communities` (service key) to learn whether features.communities can be switched on,
# and reads app_settings.invite_only (cached).
COMMUNITIES = "communities"
COMMUNITY_MEMBERS = "community_members"
APP_SETTINGS = "app_settings"
COMMUNITIES_CHECK_SECONDS = 60
ISLAND_EVENT_COLUMNS = "id,island_id,kind,cause,place,before,after,created_at"
PUSH_CONFIG_COLUMNS = "vapid_public,vapid_private,dispatch_url"
PUSH_SUBSCRIPTION_COLUMNS = "id,account_id,endpoint,p256dh,auth,user_agent,created_at"
# mark_active() caps a claim at this many seconds; a stuck tab cannot silence
# pushes for longer.
PRESENCE_MAX_SECONDS = 120
# ids per in.(...) filter: keeps each request line well under proxy limits.
IN_BATCH = 150

# Members-only posts (2026-10-27, supabase/migrations/20261027000000_members_only_prep.sql and
# ...010000_members_only_lockdown.sql). app_settings.members_only is the switch the lockdown SQL
# sets in the same transaction as the new row-level rules; while it is false every rule below is
# skipped and the server behaves as before.
UNSCOPED_NOTIFICATION_TYPES = ("island", "quiet_post", "similar")   # never written without a community while members_only is on
MEMBERS_ONLY_KEY = "members_only"
# `viewer=SERVICE` (the default) means "the server's own key": no row-level rule applies, exactly
# like the service role in a deployment. A local-mode route passes the signed-in person (or None
# for nobody) and MemoryStore then applies the same rules the SQL policies apply.
SERVICE = object()


def _now():
    return datetime.now(timezone.utc).isoformat()


def _stamp(value):
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def _batches(ids):
    """Distinct ids, sorted, in slices of IN_BATCH."""
    ids = sorted(set(ids))
    return [ids[start:start + IN_BATCH] for start in range(0, len(ids), IN_BATCH)]


def _since(value):
    """An ISO string for a `since` argument given as datetime, string or None."""
    if value is None:
        return "1970-01-01T00:00:00+00:00"
    return value.isoformat() if isinstance(value, datetime) else str(value)


def _parse_vector(value):
    """pgvector's text form "[0.1,0.2]" (or a list) as a list of floats."""
    if value is None:
        return None
    if isinstance(value, str):
        value = json.loads(value)
    return [float(v) for v in value]


def _flatten(row, key=ACCOUNTS, into=None):
    """PostgREST embeds a joined table as a nested object; the client wants it flat.

    Both stores return the same shape because of this: MemoryStore builds the
    flat form directly, and every Supabase read that embeds an account passes
    through here. A caller should never have to ask which backend it is on.
    """
    nested = row.pop(key, None) or {}
    if into is None:
        row["display_name"] = nested.get("display_name", "")
        row["icon_id"] = nested.get("icon_id", "0")
        row["avatar_path"] = nested.get("avatar_path")
    else:
        row[into] = {
            "id": nested.get("id"),
            "display_name": nested.get("display_name", ""),
            "icon_id": nested.get("icon_id", "0"),
            "avatar_path": nested.get("avatar_path"),
        }
    return row


class StoreError(RuntimeError):
    pass


class Refused(StoreError):
    """A rule said no. str(error) is the Japanese sentence the database function
    raises; `status` is the local-mode HTTP code."""

    def __init__(self, message, status=422):
        super().__init__(message)
        self.status = status


class TalkRefused(Refused):
    """A 「話してみたい」/ DM rule said no."""


class CommunityRefused(Refused):
    """An invite / community rule said no (a bad or stopped invite, not an admin, ...)."""


class InviteRequired(CommunityRefused):
    """invite_only is on and this new account has no invite. 403, like the database trigger."""

    def __init__(self, message=INVITE_ERROR_REQUIRED, status=403):
        super().__init__(message, status)


# ---------------------------------------------------------------------------
# memory
# ---------------------------------------------------------------------------

class MemoryStore:
    """In-process store for local development and tests.

    Every count and every notification the schema maintains with a trigger is
    maintained here in the write methods. Keeping them in the same methods that
    do the write - rather than in a separate "recompute" pass - is what keeps
    the two backends observably identical from the API's point of view.
    """

    backend = "memory"

    def __init__(self):
        self._accounts = {}
        self._posts = {}
        self._reactions = {}      # (post_id, actor_id, kind) -> created_at
        self._comments = {}
        self._notifications = {}
        self._reports = {}
        self._profile_vectors = {}  # account_id -> {vec_topics: [...], ...}
        self._last_seen = {}        # account_id -> iso time
        self._settings = {}         # (account_id, category) -> row
        self._islands = {}
        self._island_events = {}
        self._island_run_at = None
        self._views = set()         # (post_id, viewer)
        self._push_pending = []     # notification ids not yet taken by the dispatcher
        self._pushed_at = {}        # notification id -> when the dispatcher took it (pushed_at)
        self._talk_wishes = {}      # (from_id, to_id) -> {event_post_id, created_at}
        self._dm_rooms = {}         # room id -> {id, user_a, user_b, event_post_id, created_at}
        self._dm_messages = []      # oldest first
        self._dm_blocks = set()     # (blocker_id, blocked_id)
        self._talk_stats = {}       # JST day -> {pressed, matched}: counts only
        self._talk_daily_presses = {}   # (account_id, JST day) -> people newly pressed that day
        self._communities = {}      # id -> {id, slug, name, created_by, created_at}
        self._members = {}          # (community_id, account_id) -> {role, joined_at}
        self._invites = {}          # id -> {id, community_id, code, created_by, created_at, expires_at, revoked_at, uses}
        self._invite_claims = {}    # account_id -> {invite_id, claimed_at}: "may make an account"
        self._app_settings = {"invite_only": False, "members_only": False}   # both start false, like the migrations
        self._talk_wish_notices = {}  # (from_id, to_id) -> iso time a talk_wish notice was written
        self._push_config = {"vapid_public": None, "vapid_private": None, "dispatch_url": None}
        self._push_subscriptions = {}  # endpoint -> row
        self._presence = {}         # account_id -> datetime the app is on screen until
        self._lock = threading.RLock()
        # Stands in for the database trigger that pokes /api/push/dispatch.
        # Called with the lock held, so it must only raise a flag and return.
        self.on_notify = None

    # -- accounts ----------------------------------------------------------

    def get_account(self, account_id):
        with self._lock:
            row = self._accounts.get(account_id)
        return dict(row) if row else None

    def list_accounts(self, ids):
        with self._lock:
            return [dict(self._accounts[i]) for i in ids if i in self._accounts]

    def upsert_account(self, account_id, fields):
        with self._lock:
            # The accounts BEFORE INSERT trigger: a NEW account needs an invite while
            # invite_only is on. An account that already has a row always passes.
            if (self._app_settings.get("invite_only") and account_id not in self._accounts
                    and account_id not in self._invite_claims):
                raise InviteRequired()
            row = self._accounts.get(account_id) or {
                "id": account_id,
                "display_name": "",
                "affiliation": None,
                "bio": None,
                "link_url": None,
                "icon_id": "0",
                "avatar_path": None,
                "topics": [],
                "goal": None,
                "seeking": None,
                "offering": None,
                "created_at": _now(),
            }
            # The vectors are kept apart, like the column grant that hides them.
            fields = dict(fields)
            vectors = {key: fields.pop(key) for key in PROFILE_VECTOR_COLUMNS if key in fields}
            if vectors:
                self._profile_vectors.setdefault(account_id, {}).update(vectors)
            # No `is not None` filter: null is how the client clears a field.
            # Dropping it here made 自己紹介 and リンク write-once.
            row.update(fields)
            row["updated_at"] = _now()
            self._accounts[account_id] = row
            return dict(row)

    # -- posts -------------------------------------------------------------

    # -- members-only rules (the SQL policies, in Python) ------------------------

    def members_only(self):
        """app_settings.members_only. False until the lockdown SQL (or a test) sets it."""
        with self._lock:
            return bool(self._app_settings.get(MEMBERS_ONLY_KEY))

    def set_members_only(self, value):
        """The one-line switch (lockdown SQL / rollback SQL in production; tests flip it here)."""
        with self._lock:
            self._app_settings[MEMBERS_ONLY_KEY] = bool(value)

    def _require_scope(self, community):
        """Post-derived data is never asked for "all communities" while members_only is on."""
        if community is None and self._app_settings.get(MEMBERS_ONLY_KEY):
            raise ValueError("community is required while members_only is on")

    def _filtering(self, viewer):
        """True when a row-level rule applies to this read: a viewer was named and the switch is on."""
        return viewer is not SERVICE and bool(self._app_settings.get(MEMBERS_ONLY_KEY))

    def viewer_communities(self, me):
        """The community ids a person belongs to RIGHT NOW (never cached)."""
        if not me:
            return set()
        with self._lock:
            return {cid for (cid, account) in self._members if account == me}

    def community_member_ids(self, community_id):
        with self._lock:
            return {account for (cid, account) in self._members if cid == community_id}

    def community_ids(self):
        with self._lock:
            return sorted(self._communities)

    def _in_community(self, account_id, community_id):
        return bool(account_id) and bool(community_id) and (community_id, account_id) in self._members

    def _is_member_of_post(self, post_id, viewer):
        """is_member_of_post(): the post is live and its community is one the viewer is in.
        NO author clause, and a post with no community belongs to nobody."""
        row = self._posts.get(post_id)
        return bool(row) and not row.get("deleted_at") and self._in_community(viewer, row.get("community_id"))

    def _is_member_of_post_any(self, post_id, viewer):
        """is_member_of_post_any(): like _is_member_of_post, but a soft-deleted post counts (it keeps
        the notification rows about it readable)."""
        row = self._posts.get(post_id)
        return bool(row) and self._in_community(viewer, row.get("community_id"))

    def _can_read_post_row(self, row, viewer):
        """The posts_read policy: live, and (in one of the viewer's communities OR written by the
        viewer). A post with no community is read by its author only."""
        if not row or row.get("deleted_at"):
            return False
        return self._in_community(viewer, row.get("community_id")) or (
            bool(viewer) and row["author_id"] == viewer)

    def leave_community(self, me, community_id):
        """What deleting your own community_members row does (can_leave_community). The last
        admin may not leave. Nothing else is deleted: the person's notifications of that community are only
        hidden by the read rule (as in SQL), so they come back if the person rejoins."""
        if not me:
            raise CommunityRefused(TALK_ERROR_LOGIN, status=401)
        with self._lock:
            member = self._members.get((community_id, me))
            if not member:
                return False
            if member["role"] == "admin" and not any(
                    m["role"] == "admin" and account != me
                    for (cid, account), m in self._members.items() if cid == community_id):
                return False
            del self._members[(community_id, me)]
            return True

    def insert_post(self, record):
        row = dict(record)
        if self._app_settings.get(MEMBERS_ONLY_KEY) and not row.get("community_id"):
            # Phase B makes posts.community_id NOT NULL; until then the server refuses it here.
            raise StoreError("community_id")
        if row.get("share_group") and any(
                other.get("share_group") == row["share_group"] and not other.get("deleted_at")
                and other.get("community_id") == row.get("community_id") and other["id"] != row.get("id")
                for other in self._posts.values()):
            # posts_share_group_community_uidx: one live copy of a post per community.
            raise StoreError("share_group")
        row.setdefault("id", str(uuid.uuid4()))
        row.setdefault("created_at", _now())
        row["updated_at"] = row["created_at"]
        row.setdefault("deleted_at", None)
        row.setdefault("community_id", None)
        for column in ("like_count", "help_count", "join_count", "comment_count"):
            row.setdefault(column, 0)
        row["energy"] = computed_energy(row)
        with self._lock:
            if row["id"] in self._posts:
                return self._public_post(self._posts[row["id"]])
            self._posts[row["id"]] = row
        return self._public_post(row)

    def get_post(self, post_id, with_vec=False, viewer=SERVICE):
        with self._lock:
            row = self._posts.get(post_id)
            if not row or row.get("deleted_at"):
                return None
            if self._filtering(viewer) and not self._can_read_post_row(row, viewer):
                return None
            return self._public_post(row, with_vec=with_vec)

    def update_post(self, post_id, author_id, fields):
        with self._lock:
            row = self._posts.get(post_id)
            if not row or row.get("deleted_at") or row["author_id"] != author_id:
                return None
            row.update(fields)
            row["energy"] = computed_energy(row)
            row["updated_at"] = _now()
            return self._public_post(row)

    def soft_delete_post(self, post_id, author_id):
        with self._lock:
            row = self._posts.get(post_id)
            if not row or row.get("deleted_at") or row["author_id"] != author_id:
                return False
            row["deleted_at"] = _now()
            return True

    # -- the copies of one post in several communities (2026-10-29) --------------

    supports_share = True

    def share_ready(self):
        return True

    def _group_joiners(self, group):
        """post_group_joiners(): the people who joined any live copy of the post, each counted once."""
        with self._lock:     # an RLock: callers that already hold it may call this
            live = {pid for pid, row in self._posts.items()
                    if row.get("share_group") == group and not row.get("deleted_at")}
            return len({actor for (pid, actor, kind) in self._reactions if kind == "join" and pid in live})

    def posts_in_group(self, group):
        """The live copies of one post (every community), oldest first. The server's own read."""
        with self._lock:
            rows = [row for row in self._posts.values()
                    if group and row.get("share_group") == group and not row.get("deleted_at")]
            rows.sort(key=lambda row: row["created_at"])
            return [self._public_post(row) for row in rows]

    def update_post_group(self, group, author_id, fields, skip_id=None):
        """The same change on every live copy of the post written by `author_id` (but `skip_id`)."""
        with self._lock:
            out = []
            for row in self._posts.values():
                if (not group or row.get("share_group") != group or row.get("deleted_at")
                        or row["author_id"] != author_id or row["id"] == skip_id):
                    continue
                row.update(fields)
                row["energy"] = computed_energy(row)
                row["updated_at"] = _now()
                out.append(self._public_post(row))
            return out

    def soft_delete_post_group(self, group, author_id):
        """Every live copy of the post written by `author_id` is deleted. Returns how many."""
        return len(self.update_post_group(group, author_id, {"deleted_at": _now()}))

    def posts_by_author(self, author_id, viewer=SERVICE):
        """A person's live posts, newest first. With a viewer named and members_only on: all of
        them for the person themselves, and for anybody else only the posts whose community the
        viewer is in."""
        with self._lock:
            rows = [
                row for row in self._posts.values()
                if row["author_id"] == author_id and not row.get("deleted_at")
                and (not self._filtering(viewer) or viewer == author_id
                     or self._in_community(viewer, row.get("community_id")))
            ]
        rows.sort(key=lambda row: row["created_at"], reverse=True)
        return [self._joined(row) for row in rows]

    def count_posts(self, community=None, everything=False):
        """Live posts, of one community or (everything=True, or members_only off) of all."""
        if not everything:
            self._require_scope(community)
        with self._lock:
            return sum(1 for row in self._posts.values()
                       if not row.get("deleted_at")
                       and (community is None or row.get("community_id") == community))

    def _live(self):
        return [row for row in self._posts.values() if not row.get("deleted_at")]

    def map_posts(self, min_x, min_y, max_x, max_y, limit, viewer=SERVICE):
        with self._lock:
            rows = [
                row for row in self._live()
                if min_x <= row["x"] <= max_x and min_y <= row["y"] <= max_y
                and (not self._filtering(viewer) or self._in_community(viewer, row.get("community_id")))
            ]
        rows.sort(key=lambda row: (total_energy(row), row["created_at"]), reverse=True)
        return [self._joined(row) for row in rows[:limit]]

    def map_posts_for_community(self, community, min_x, min_y, max_x, max_y, limit):
        """map_posts for the server's own key: the posts of ONE community (the member-filtered
        map_posts has no viewer under the service role). A missing community is an error."""
        if not community:
            raise ValueError("community is required")
        return self.community_map_posts(community, min_x, min_y, max_x, max_y, limit)

    def map_cells(self, min_x, min_y, max_x, max_y, viewer=SERVICE):
        if self._app_settings.get(MEMBERS_ONLY_KEY):
            # Lockdown: the cells are made from every community's posts, so they answer nothing
            # (same signature and grants, zero rows). Per-community cells come in Phase B.
            return []
        cells = {}
        with self._lock:
            rows = list(self._live())
        for row in rows:
            key = (
                int(math.floor(row["x"] / ENERGY_CELL_SIZE)),
                int(math.floor(row["y"] / ENERGY_CELL_SIZE)),
            )
            cell = cells.setdefault(key, {"cell_x": key[0], "cell_y": key[1],
                                          "sum_energy": 0.0, "post_count": 0})
            cell["sum_energy"] += total_energy(row)
            cell["post_count"] += 1
        low_x, low_y = math.floor(min_x / ENERGY_CELL_SIZE), math.floor(min_y / ENERGY_CELL_SIZE)
        high_x, high_y = math.floor(max_x / ENERGY_CELL_SIZE), math.floor(max_y / ENERGY_CELL_SIZE)
        return [
            cell for (cx, cy), cell in cells.items()
            if low_x <= cx <= high_x and low_y <= cy <= high_y
        ]

    def list_terms(self, limit=5000, community=None):
        self._require_scope(community)
        with self._lock:
            live = [row for row in self._live() if community is None or row.get("community_id") == community]
            rows = sorted(live, key=lambda row: -total_energy(row))[:limit]
        keys = TERM_COLUMNS.split(",")
        return [{key: (computed_energy(row) if key == "energy" else row.get(key))
                 for key in keys} for row in rows]

    def terrain_posts(self, community=None):
        self._require_scope(community)
        with self._lock:
            return [self._joined(row) for row in self._live()
                    if community is None or row.get("community_id") == community]

    def post_bodies(self, ids):
        """{post_id: body} for live posts among ids (island naming reads this)."""
        with self._lock:
            return {i: self._posts[i]["body"] for i in ids
                    if i in self._posts and not self._posts[i].get("deleted_at")}

    def nearest_posts(self, post_id, k, community=None):
        """The posts nearest to a saved post. `community` limits the answer to that community's
        posts; while members_only is on a missing community is a ValueError (nothing is returned)."""
        self._require_scope(community)
        with self._lock:
            origin = self._posts.get(post_id)
            if not origin or origin.get("deleted_at"):
                return []
            if community is not None and origin.get("community_id") != community:
                return []   # the SQL function: origin.community_id = p_community, else nothing
            mine = origin.get("vec_c")
        if mine is None:
            return []
        return self._nearest(mine, k, skip=post_id, community=community)

    def nearest_to_vector(self, vector, k, community=None):
        """Neighbours of a text that was never saved (the first-post tryout)."""
        self._require_scope(community)
        return self._nearest(vector, k, community=community)

    def _nearest(self, origin, k, skip=None, community=None):
        import numpy as np

        with self._lock:
            rows = [row for row in self._live() if row["id"] != skip
                    and (community is None or row.get("community_id") == community)]
        mine = np.asarray(origin, dtype=float)
        scored = []
        for row in rows:
            other = row.get("vec_c")
            if other is None:
                continue
            other = np.asarray(other, dtype=float)
            if other.shape != mine.shape:
                continue
            scale = float(np.linalg.norm(mine) * np.linalg.norm(other))
            if scale == 0.0:
                continue
            scored.append((row["id"], float(np.dot(mine, other) / scale)))
        scored.sort(key=lambda pair: -pair[1])
        return scored[:k]

    def pair_similarity(self, a, b):
        # Service-only in a deployment; the caller has already seen that both posts are in one
        # community. Scoped to a's community so it cannot reach into another one.
        with self._lock:
            community = (self._posts.get(a) or {}).get("community_id")
            if self._app_settings.get(MEMBERS_ONLY_KEY) and not community:
                return None
        for post_id, cosine in self.nearest_posts(a, 10_000, community=community):
            if post_id == b:
                return cosine
        return None

    # -- footprints (Q35): a count, never a list ------------------------------

    def record_view(self, post_id, viewer):
        """Count one viewer once. The author never counts. False when skipped."""
        with self._lock:
            row = self._posts.get(post_id)
            if not row or row.get("deleted_at") or row["author_id"] == viewer:
                return False
            self._views.add((post_id, viewer))
            return True

    def view_counts(self, author_id):
        """{post_id: views} for the author's live posts that someone opened."""
        with self._lock:
            mine = {pid for pid, row in self._posts.items()
                    if row["author_id"] == author_id and not row.get("deleted_at")}
            counts = {}
            for post_id, _viewer in self._views:
                if post_id in mine:
                    counts[post_id] = counts.get(post_id, 0) + 1
        return counts

    # -- reactions ---------------------------------------------------------

    def add_reaction(self, post_id, actor_id, kind):
        if kind not in REACTION_KINDS:
            raise StoreError("kind")
        with self._lock:
            post = self._posts.get(post_id)
            if not post or post.get("deleted_at"):
                return False
            if self._app_settings.get(MEMBERS_ONLY_KEY) and not self._is_member_of_post(post_id, actor_id):
                # reactions_insert needs is_member_of_post, and the recruit guard checks that BEFORE
                # it says closed/full: a non-member learns nothing about the post (same as missing).
                return False
            key = (post_id, actor_id, kind)
            if key in self._reactions:
                return False
            if kind == "join":
                # Same rule as the database trigger on reactions: a closed 募集 takes no
                # new join (withdrawing one is always possible). A post put on several communities
                # counts its first-come places over all of them, each person once (2026-10-29).
                capacity, joins = post.get("recruit_capacity"), post.get("join_count")
                group = post.get("share_group")
                if group:
                    joins = self._group_joiners(group)
                    if any(kind_ == "join" and actor == actor_id
                           and (self._posts.get(pid) or {}).get("share_group") == group
                           and not (self._posts.get(pid) or {}).get("deleted_at")
                           for (pid, actor, kind_) in self._reactions):
                        capacity = None    # already in through another copy: no new place is taken
                closed = closed_state(post.get("recruit_deadline"), capacity, joins)
                if closed == CLOSED_DEADLINE:
                    raise StoreError(ERROR_CLOSED)
                if closed == CLOSED_FULL:
                    raise StoreError(ERROR_FULL)
            self._reactions[key] = _now()
            post[f"{kind}_count"] = post.get(f"{kind}_count", 0) + 1
            post["energy"] = computed_energy(post)
            if post["author_id"] != actor_id:
                self._notify(post["author_id"], actor_id, post_id, None, kind)
                self._notify_new_connection(actor_id, post["author_id"])
        return True

    def remove_reaction(self, post_id, actor_id, kind):
        with self._lock:
            key = (post_id, actor_id, kind)
            if key not in self._reactions:
                return False
            del self._reactions[key]
            post = self._posts.get(post_id)
            if post:
                post[f"{kind}_count"] = max(0, post.get(f"{kind}_count", 0) - 1)
                post["energy"] = computed_energy(post)
            stale = [
                nid for nid, row in self._notifications.items()
                if row["post_id"] == post_id and row["actor_id"] == actor_id
                and row["type"] == kind and row["read_at"] is None
            ]
            for nid in stale:
                del self._notifications[nid]
        return True

    def _reaction_visible(self, post_id, actor, viewer):
        """reactions_read: a member of the post's community reads every reaction on it, anybody
        else only the rows they pressed themselves. Lock held by the caller."""
        if not self._filtering(viewer):
            return True
        return actor == viewer or self._is_member_of_post(post_id, viewer)

    def joiners_of(self, post_id, viewer=SERVICE):
        """Account ids that pressed 参加 on a post (local mode only).

        With a database the reactions are public and the browser reads them
        directly; this is the stand-in for 「参加者を見てみる」.
        """
        with self._lock:
            return [actor for (pid, actor, kind) in self._reactions
                    if pid == post_id and kind == "join" and self._reaction_visible(pid, actor, viewer)]

    def reactors_of(self, post_id, kind, viewer=SERVICE):
        """The people who pressed one reaction on a post, newest first (local mode only).

        The stand-in for reading reactions with their accounts embedded, which is
        what the browser does against a database: 長押し on your own post's
        いいね / 手伝えるかも.
        """
        if kind not in REACTION_KINDS:
            raise StoreError("kind")
        with self._lock:
            # Two presses in the same instant: the dict keeps the order they came
            # in, so the later one still comes first (not whichever id sorts higher).
            rows = sorted(
                ((created, order, actor)
                 for order, ((pid, actor, k), created) in enumerate(self._reactions.items())
                 if pid == post_id and k == kind and self._reaction_visible(pid, actor, viewer)),
                reverse=True,
            )
            people = []
            for created, _order, actor in rows:
                account = self._accounts.get(actor) or {}
                people.append({
                    "id": actor,
                    "display_name": account.get("display_name") or "",
                    "icon_id": account.get("icon_id") or "0",
                    "avatar_path": account.get("avatar_path"),
                    "created_at": created,
                })
            return people


    def reactions_by_actor(self, actor_id):
        with self._lock:
            return [
                {"post_id": post_id, "kind": kind}
                for (post_id, sender, kind) in self._reactions
                if sender == actor_id
            ]

    # -- comments ----------------------------------------------------------

    def add_comment(self, post_id, author_id, body, reply_to=None):
        with self._lock:
            post = self._posts.get(post_id)
            if not post or post.get("deleted_at"):
                raise StoreError("post")
            if self._app_settings.get(MEMBERS_ONLY_KEY) and not self._is_member_of_post(post_id, author_id):
                raise StoreError("post")   # comments_insert: members only; same words as a missing post
            parent_author = None
            if reply_to is not None:
                parent = self._comments.get(reply_to)
                if not parent or parent["post_id"] != post_id:
                    raise StoreError("reply_to")
                parent_author = parent["author_id"]
            row = {
                "id": str(uuid.uuid4()),
                "post_id": post_id,
                "author_id": author_id,
                "body": body,
                "reply_to": reply_to,
                "created_at": _now(),
                "deleted_at": None,
            }
            self._comments[row["id"]] = row
            post["comment_count"] = post.get("comment_count", 0) + 1
            post["energy"] = computed_energy(post)
            # Same rules as on_comment_change(): the person answered hears
            # 'reply'; the owner hears 'comment' only if they are somebody else.
            owner = post["author_id"]
            if parent_author is not None and parent_author != author_id:
                self._notify(parent_author, author_id, post_id, row["id"], "reply")
                self._notify_new_connection(author_id, parent_author)
            if owner != author_id and owner != parent_author:
                self._notify(owner, author_id, post_id, row["id"], "comment")
            if owner != author_id:
                self._notify_new_connection(author_id, owner)
            return self._with_author(row)

    def list_comments(self, post_id, viewer=SERVICE):
        with self._lock:
            if self._filtering(viewer) and not self._is_member_of_post(post_id, viewer):
                return []
            rows = [
                row for row in self._comments.values()
                if row["post_id"] == post_id and not row["deleted_at"]
            ]
        rows.sort(key=lambda row: row["created_at"])
        return [self._with_author(row) for row in rows]

    def delete_comment(self, comment_id, author_id):
        with self._lock:
            row = self._comments.get(comment_id)
            if not row or row["deleted_at"] or row["author_id"] != author_id:
                return False
            row["deleted_at"] = _now()
            post = self._posts.get(row["post_id"])
            if post:
                post["comment_count"] = max(0, post.get("comment_count", 0) - 1)
                post["energy"] = computed_energy(post)
            return True

    def comments_by_author(self, author_id):
        with self._lock:
            return [
                self._with_author(row) for row in self._comments.values()
                if row["author_id"] == author_id and not row["deleted_at"]
            ]

    # -- notifications -----------------------------------------------------

    def _notify(self, recipient_id, actor_id, post_id, comment_id, kind,
                island_id=None, event_id=None, payload=None, community_id=None):
        if community_id is None and post_id:
            community_id = (self._posts.get(post_id) or {}).get("community_id")
        row = {
            "community_id": community_id,
            "id": str(uuid.uuid4()),
            "recipient_id": recipient_id,
            "actor_id": actor_id,
            "post_id": post_id,
            "comment_id": comment_id,
            "type": kind,
            "island_id": island_id,
            "event_id": event_id,
            "payload": payload,
            "created_at": _now(),
            "read_at": None,
        }
        self._notifications[row["id"]] = row
        self._push_pending.append(row["id"])
        # quiet_post stays in the app (Q34), as poke_push_dispatch() skips it.
        if kind != "quiet_post" and self.on_notify is not None:
            self.on_notify()
        return row

    def _pair_interaction_count(self, a, b):
        """pair_interaction_count() in Python. Caller holds the lock."""
        count = 0
        for (post_id, actor, _) in self._reactions:
            owner = (self._posts.get(post_id) or {}).get("author_id")
            if (actor == a and owner == b) or (actor == b and owner == a):
                count += 1
        for row in self._comments.values():
            if row["deleted_at"]:
                continue
            owner = (self._posts.get(row["post_id"]) or {}).get("author_id")
            parent = self._comments.get(row.get("reply_to")) if row.get("reply_to") else None
            touched = {owner, parent["author_id"] if parent else None}
            if (row["author_id"] == a and b in touched) or (row["author_id"] == b and a in touched):
                count += 1
        return count

    def _notify_new_connection(self, a, b):
        """Retired 2026-10-12: 「新しいつながり」の通知はもう作らない。

        The database function of the same name is a no-op too (migration
        20261012000000). Rows written before stay as they were.
        """
        return

    def insert_notifications(self, rows):
        """Server-written notifications (similar, island)."""
        if self._app_settings.get(MEMBERS_ONLY_KEY):
            rows = [row for row in rows
                    if row.get("community_id") or row["type"] not in UNSCOPED_NOTIFICATION_TYPES]
        with self._lock:
            return [dict(self._notify(
                row["recipient_id"], row.get("actor_id"), row.get("post_id"), None, row["type"],
                row.get("island_id"), row.get("event_id"), row.get("payload"),
                community_id=row.get("community_id"),
            )) for row in rows]

    def recent_notifications(self, kind, since, recipient_id=None, recipient_ids=None):
        """Rows of one type since a time, for the per-day limits (`recipient_ids`: only theirs)."""
        start = _stamp(_since(since))
        wanted = None if recipient_ids is None else set(recipient_ids)
        with self._lock:
            return [
                dict(row) for row in self._notifications.values()
                if row["type"] == kind and _stamp(row["created_at"]) >= start
                and (recipient_id is None or row["recipient_id"] == recipient_id)
                and (wanted is None or row["recipient_id"] in wanted)
            ]

    def blocked_with(self, account_id):
        """Everybody `account_id` blocked or was blocked by (either way), as a set of ids."""
        with self._lock:
            return ({b for (a, b) in self._dm_blocks if a == account_id}
                    | {a for (a, b) in self._dm_blocks if b == account_id})

    def _notification_visible(self, row, viewer):
        """notifications_read: the recipient's own rows, minus those about a post they are not a
        member of, and minus those of a community they are not in. Lock held."""
        if row["post_id"] and not self._is_member_of_post_any(row["post_id"], viewer):
            return False
        community = row.get("community_id")
        return community is None or self._in_community(viewer, community)

    def list_notifications(self, recipient_id, limit=100, viewer=SERVICE):
        with self._lock:
            rows = [
                dict(row) for row in self._notifications.values()
                if row["recipient_id"] == recipient_id
                and (not self._filtering(viewer) or self._notification_visible(row, viewer))
            ]
        rows.sort(key=lambda row: row["created_at"], reverse=True)
        rows = rows[:limit]
        with self._lock:
            for row in rows:
                actor = self._accounts.get(row["actor_id"]) or {}
                row["actor"] = None if row["actor_id"] is None else {
                    "id": row["actor_id"],
                    "display_name": actor.get("display_name", ""),
                    "icon_id": actor.get("icon_id", "0"),
                    "avatar_path": actor.get("avatar_path"),
                }
                comment = self._comments.get(row["comment_id"]) if row["comment_id"] else None
                row["comment_body"] = comment["body"] if comment else None
        return rows

    def mark_notifications_read(self, recipient_id, ids=None):
        stamp = _now()
        changed = 0
        with self._lock:
            for row in self._notifications.values():
                if row["recipient_id"] != recipient_id or row["read_at"]:
                    continue
                if ids is not None and row["id"] not in ids:
                    continue
                row["read_at"] = stamp
                changed += 1
        return changed

    def unread_count(self, recipient_id):
        with self._lock:
            return sum(
                1 for row in self._notifications.values()
                if row["recipient_id"] == recipient_id and not row["read_at"]
            )

    # -- 「話してみたい」and DM (2026-10-26) -------------------------------------
    #
    # The same rules as supabase/migrations/20261026000000_talk_and_dm.sql, in the
    # same order, so local mode refuses what the database refuses. In a deployment
    # the browser calls those functions itself (with the person's JWT, which a
    # service key cannot stand in for), so SupabaseStore only has talk_ready().

    supports_talk = True

    def talk_ready(self):
        return True

    def _is_meeting(self, post):
        return bool(post) and not post.get("deleted_at") and RECRUIT_TAG in (post.get("tags") or [])

    def _is_member(self, post, account_id):
        return post["author_id"] == account_id or (post["id"], account_id, "join") in self._reactions

    def _talk_shared_event(self, a, b):
        """The newest meeting both are in (its author or a joiner), or None. Lock held."""
        strict = self._app_settings.get(MEMBERS_ONLY_KEY)
        meetings = [post for post in self._posts.values()
                    if self._is_meeting(post) and self._is_member(post, a) and self._is_member(post, b)
                    # members_only: BOTH people must be in the community the meeting was posted to.
                    and (not strict or (self._in_community(a, post.get("community_id"))
                                        and self._in_community(b, post.get("community_id"))))]
        if not meetings:
            return None
        return max(meetings, key=lambda post: (_stamp(post["created_at"]), post["id"]))["id"]

    def _talk_same_community(self, a, b):
        """True when both are members of at least one common community. Lock held."""
        return a != b and any(aid == a and (cid, b) in self._members for (cid, aid) in self._members)

    def _talk_blocked(self, a, b):
        return (a, b) in self._dm_blocks or (b, a) in self._dm_blocks

    def _room_between(self, a, b):
        low, high = sorted((a, b))
        for room in self._dm_rooms.values():
            if room["user_a"] == low and room["user_b"] == high:
                return room
        return None

    def _talk_stat(self, column):
        day = (datetime.now(timezone.utc) + timedelta(hours=9)).date().isoformat()
        row = self._talk_stats.setdefault(day, {"pressed": 0, "matched": 0})
        row[column] += 1

    def _talk_count_press(self, me):
        """Count one newly pressed person for today (JST), or refuse the 21st. Lock held.
        Taking a press back does not give the count back."""
        today = (datetime.now(timezone.utc) + timedelta(hours=9)).date()
        key = (me, today.isoformat())
        if self._talk_daily_presses.get(key, 0) >= TALK_DAILY_PRESS_LIMIT:
            raise TalkRefused(TALK_ERROR_DAILY_LIMIT)
        self._talk_daily_presses[key] = self._talk_daily_presses.get(key, 0) + 1

    def talk_peers(self, me):
        """Everybody in a community I am in, plus everybody in a meeting I am in (the meeting
        rule only matters while members_only is off), except me and anyone blocked either way."""
        with self._lock:
            peers = {aid for (cid, mine) in self._members if mine == me
                     for (c2, aid) in self._members if c2 == cid}
            strict = self._app_settings.get(MEMBERS_ONLY_KEY)
            for post in self._posts.values():
                if not self._is_meeting(post) or not self._is_member(post, me):
                    continue
                if strict and not self._in_community(me, post.get("community_id")):
                    continue
                found = {post["author_id"]}
                found.update(actor for (pid, actor, kind) in self._reactions
                             if pid == post["id"] and kind == "join")
                if strict:   # both CTEs of talk_peers(): the other person must be in the community too
                    found = {person for person in found if self._in_community(person, post.get("community_id"))}
                peers.update(found)
            peers.discard(me)
            return sorted(person for person in peers if not self._talk_blocked(me, person))

    def talk_state(self, me):
        """[{target, state: pressed|matched, room_id}]. Never says who pressed me."""
        with self._lock:
            out = [{"target": to_id, "state": "pressed", "room_id": None}
                   for (from_id, to_id) in self._talk_wishes if from_id == me]
            out += [{"target": room["user_b"] if room["user_a"] == me else room["user_a"],
                     "state": "matched", "room_id": room["id"]}
                    for room in self._dm_rooms.values() if me in (room["user_a"], room["user_b"])]
        return out

    def press_talk(self, me, target):
        """{"matched": bool, "room_id": str|None}. Raises TalkRefused (Japanese words).

        A one-sided press and a repeated press answer the same and look the same."""
        if not me:
            raise TalkRefused(TALK_ERROR_LOGIN)
        if not target or target == me:
            raise TalkRefused(TALK_ERROR_SELF)
        with self._lock:
            # A shared community is enough; the newest common meeting (if any) is only the
            # event_post_id of the room / press, None when they have none.
            shared = self._talk_shared_event(me, target)
            if ((shared is None and not self._talk_same_community(me, target))
                    or self._talk_blocked(me, target)):
                raise TalkRefused(TALK_ERROR_NOT_PEER)
            # A press (talk_wishes) is kept until it is withdrawn or matched. Only the
            # record of the anonymous notice has a limit.
            horizon = datetime.now(timezone.utc) - timedelta(days=TALK_NOTICE_DAYS)
            for key in [key for key, at in self._talk_wish_notices.items() if _stamp(at) < horizon]:
                del self._talk_wish_notices[key]
            room = self._room_between(me, target)
            if room:
                return {"matched": True, "room_id": room["id"]}
            # Older than 2 days: the day counts are swept along the way (like the notice records).
            keep_from = ((datetime.now(timezone.utc) + timedelta(hours=9)).date() - timedelta(days=1)).isoformat()
            for key in [key for key in self._talk_daily_presses if key[1] < keep_from]:
                del self._talk_daily_presses[key]
            if (target, me) in self._talk_wishes:
                self._talk_count_press(me)   # pressing back is a new press: one person
                low, high = sorted((me, target))
                room = {"id": str(uuid.uuid4()), "user_a": low, "user_b": high,
                        "event_post_id": shared, "created_at": _now()}
                self._dm_rooms[room["id"]] = room
                self._talk_wishes.pop((me, target), None)
                self._talk_wishes.pop((target, me), None)
                # Both are told, by name (the other person is the actor).
                self._notify(me, target, None, None, "talk_match")
                self._notify(target, me, None, None, "talk_match")
                self._talk_stat("matched")
                return {"matched": True, "room_id": room["id"]}
            if (me, target) not in self._talk_wishes:
                self._talk_count_press(me)   # a new press: one person (refused past the limit)
                self._talk_wishes[(me, target)] = {"event_post_id": shared, "created_at": _now()}
                # Nameless and meeting-less. Not added while the person pressed already has an
                # UNREAD talk_wish (any number of people, one line), and not more than once per
                # 14 days from the same person to the same person (press-withdraw-press cannot
                # be used to keep sending anonymous notices). The record is kept only when a
                # notice was really written.
                unread = any(row["recipient_id"] == target and row["type"] == "talk_wish"
                             and row["read_at"] is None for row in self._notifications.values())
                last = self._talk_wish_notices.get((me, target))
                recent = last is not None and _stamp(last) > horizon
                if not unread and not recent:
                    self._notify(target, None, None, None, "talk_wish")
                    self._talk_wish_notices[(me, target)] = _now()
                self._talk_stat("pressed")
            return {"matched": False, "room_id": None}

    def withdraw_talk(self, me, target):
        """Take back a one-sided press. After a match there is nothing left to take back."""
        if not me:
            raise TalkRefused(TALK_ERROR_LOGIN)
        with self._lock:
            self._talk_wishes.pop((me, target), None)

    def _room_of(self, me, room_id):
        room = self._dm_rooms.get(room_id)
        if not room or me not in (room["user_a"], room["user_b"]):
            return None
        return room

    def dm_room_list(self, me):
        with self._lock:
            rows = []
            for room in self._dm_rooms.values():
                if me not in (room["user_a"], room["user_b"]):
                    continue
                other = room["user_b"] if room["user_a"] == me else room["user_a"]
                account = self._accounts.get(other) or {}
                post = self._posts.get(room["event_post_id"]) if room["event_post_id"] else None
                live = post if post and not post.get("deleted_at") else None
                if live and self._app_settings.get(MEMBERS_ONLY_KEY) and not self._in_community(
                        me, live.get("community_id")):
                    live = None   # the excerpt of a meeting is for members of its community only
                last = next((m for m in reversed(self._dm_messages) if m["room_id"] == room["id"]), None)
                rows.append({
                    "room_id": room["id"], "other_id": other,
                    "other_name": account.get("display_name", ""),
                    "other_icon_id": account.get("icon_id", "0"),
                    "other_avatar_path": account.get("avatar_path"),
                    "event_post_id": live["id"] if live else None,
                    "event_excerpt": live["body"][:DM_ROOM_EXCERPT] if live else None,
                    "last_body": last["body"][:60] if last else None,
                    "last_at": last["created_at"] if last else None,
                    "blocked_by_me": (me, other) in self._dm_blocks,
                    "created_at": room["created_at"],
                })
        rows.sort(key=lambda row: _stamp(row["last_at"] or row["created_at"]), reverse=True)
        return rows

    def dm_messages(self, me, room_id, after=None):
        """The room's messages, oldest first (after: only newer than that time)."""
        with self._lock:
            if not self._room_of(me, room_id):
                raise TalkRefused(DM_ERROR_SEND, status=404)
            since = _stamp(after) if after else None
            return [dict(m) for m in self._dm_messages
                    if m["room_id"] == room_id and (since is None or _stamp(m["created_at"]) > since)]

    def send_dm(self, me, room_id, body):
        text = (body or "").strip(" \t\r\n　")
        if not 1 <= len(text) <= DM_BODY_MAX or len(body) > 4000:
            raise StoreError("body")
        with self._lock:
            room = self._room_of(me, room_id)
            other = None
            if room:
                other = room["user_b"] if room["user_a"] == me else room["user_a"]
            # The words match the database's: not being in the room and being blocked
            # (by either side) are not told apart.
            if not room or self._talk_blocked(me, other):
                raise TalkRefused(DM_ERROR_SEND, status=403)
            stamp = _stamp(_now())
            if self._dm_messages and stamp <= _stamp(self._dm_messages[-1]["created_at"]):
                # The clock can repeat itself (Windows); polling with `created_at > T`
                # would miss the second message. The database's microseconds rarely tie.
                stamp = _stamp(self._dm_messages[-1]["created_at"]) + timedelta(microseconds=1)
            message = {"id": str(uuid.uuid4()), "room_id": room_id, "sender_id": me,
                       "body": body, "created_at": stamp.isoformat()}
            self._dm_messages.append(message)
            # One unread notice per sender within 10 minutes is enough; the text is never in it.
            # (Opening a room directly does not mark it read, so it must not mute for ever.)
            cutoff = datetime.now(timezone.utc) - timedelta(minutes=10)
            if not any(row["recipient_id"] == other and row["actor_id"] == me and row["type"] == "dm"
                       and row["read_at"] is None and _stamp(row["created_at"]) > cutoff
                       for row in self._notifications.values()):
                self._notify(other, me, None, None, "dm")
            return dict(message)

    def block_dm(self, me, blocked_id):
        if not blocked_id or blocked_id == me or blocked_id not in self._accounts:
            raise StoreError("blocked_id")
        with self._lock:
            self._dm_blocks.add((me, blocked_id))

    def unblock_dm(self, me, blocked_id):
        with self._lock:
            self._dm_blocks.discard((me, blocked_id))

    # -- communities and invite links (2026-10-26) --------------------------------
    # Mirrors supabase/migrations/20261026010000_communities_and_invites.sql: the same
    # rules, the same Japanese words. Local mode only; production runs the SQL functions.

    def communities_ready(self):
        return True

    supports_communities = True

    def invite_only(self):
        with self._lock:
            return bool(self._app_settings.get("invite_only"))

    def set_invite_only(self, value):
        """The one-line switch an operator flips in production (tests flip it here)."""
        with self._lock:
            self._app_settings["invite_only"] = bool(value)

    def create_community(self, name, slug, admin_id):
        """What public.create_community does (the operator's one line). Returns the id."""
        name = (name or "").strip()
        if not 1 <= len(name) <= 40:
            raise StoreError("name")
        with self._lock:
            if slug and any(c["slug"] == slug for c in self._communities.values()):
                raise StoreError("slug")
            community = {"id": str(uuid.uuid4()), "slug": slug or None, "name": name,
                         "created_by": admin_id, "created_at": _now()}
            self._communities[community["id"]] = community
            self._members[(community["id"], admin_id)] = {"role": "admin", "joined_at": _now()}
            return community["id"]

    def seed_demo_community(self):
        """The 「デモ」 community and its fixed invite code, made once at local start-up.
        Nobody is in it yet (no admin); a person who claims the code becomes a member."""
        with self._lock:
            for community in self._communities.values():
                if community["slug"] == LOCAL_DEMO_COMMUNITY_SLUG:
                    return community["id"]
            community = {"id": str(uuid.uuid4()), "slug": LOCAL_DEMO_COMMUNITY_SLUG,
                         "name": LOCAL_DEMO_COMMUNITY_NAME, "created_by": None, "created_at": _now()}
            self._communities[community["id"]] = community
            invite = {"id": str(uuid.uuid4()), "community_id": community["id"],
                      "code": LOCAL_DEMO_INVITE_CODE, "created_by": None, "created_at": _now(),
                      "expires_at": (datetime.now(timezone.utc) + timedelta(days=3650)).isoformat(),
                      "revoked_at": None, "uses": 0}
            self._invites[invite["id"]] = invite
            return community["id"]

    def is_community_member(self, community_id, account_id):
        with self._lock:
            return (community_id, account_id) in self._members

    def _is_admin(self, community_id, account_id):
        member = self._members.get((community_id, account_id))
        return bool(member) and member["role"] == "admin"

    def community_info(self, community_id, viewer=SERVICE):
        """{id, name} of a community, or None (a community's name is public; with members_only on
        and a viewer named, communities_read shows a community to its members only)."""
        with self._lock:
            community = self._communities.get(community_id)
            if self._filtering(viewer) and not self._in_community(viewer, community_id):
                return None
            return {"id": community["id"], "name": community["name"]} if community else None

    def my_communities(self, me):
        with self._lock:
            rows = [(m["joined_at"], cid, self._communities[cid], m["role"])
                    for (cid, account), m in self._members.items()
                    if account == me and cid in self._communities]
            rows.sort(key=lambda item: _stamp(item[0]))  # stable: equal clock ticks keep the order they joined in
            return [{"community_id": cid, "slug": c["slug"], "name": c["name"], "role": role}
                    for _, cid, c, role in rows]

    def _invite_by_code(self, code):
        for invite in self._invites.values():
            if invite["code"] == code:
                return invite
        return None

    def check_invite(self, code):
        """{"valid", "community_name", "reason"} and nothing else (no ids, no counts)."""
        with self._lock:
            invite = self._invite_by_code(code or "")
            if not invite:
                return {"valid": False, "community_name": None, "reason": "unknown"}
            name = self._communities[invite["community_id"]]["name"]
            if invite["revoked_at"]:
                return {"valid": False, "community_name": name, "reason": "revoked"}
            if _stamp(invite["expires_at"]) <= datetime.now(timezone.utc):
                return {"valid": False, "community_name": name, "reason": "expired"}
            return {"valid": True, "community_name": name, "reason": None}

    def claim_invite(self, me, code):
        """Join the community of a valid invite and record the claim (which is what lets a
        NEW account be made while invite_only is on). Raises CommunityRefused."""
        if not me:
            raise CommunityRefused(TALK_ERROR_LOGIN, status=401)
        with self._lock:
            invite = self._invite_by_code(code or "")
            if not invite:
                raise CommunityRefused(INVITE_ERROR_UNKNOWN)
            if invite["revoked_at"]:
                raise CommunityRefused(INVITE_ERROR_REVOKED)
            if _stamp(invite["expires_at"]) <= datetime.now(timezone.utc):
                raise CommunityRefused(INVITE_ERROR_EXPIRED)
            community = self._communities[invite["community_id"]]
            key = (community["id"], me)
            if key not in self._members:
                self._members[key] = {"role": "member", "joined_at": _now()}
                invite["uses"] += 1
            self._invite_claims.setdefault(me, {"invite_id": invite["id"], "claimed_at": _now()})
            return {"community_id": community["id"], "community_name": community["name"]}

    @staticmethod
    def _end_of_day_jst(now=None):
        """23:59 today in Japan time (no daylight saving: +9 hours), as an aware UTC time."""
        now = now or datetime.now(timezone.utc)
        jst_day = (now + timedelta(hours=9)).replace(hour=0, minute=0, second=0, microsecond=0)
        return jst_day + timedelta(days=1) - timedelta(minutes=1) - timedelta(hours=9)

    def create_invite(self, me, community_id, minutes, until_end_of_day=False):
        """{"code", "expires_at", "id"}. Admins of that community only."""
        if not me:
            raise CommunityRefused(TALK_ERROR_LOGIN, status=401)
        with self._lock:
            if not community_id or not self._is_admin(community_id, me):
                raise CommunityRefused(INVITE_ERROR_ADMIN_ONLY, status=403)
            now = datetime.now(timezone.utc)
            if until_end_of_day:
                expires = self._end_of_day_jst(now)
                if expires < now + timedelta(minutes=INVITE_END_OF_DAY_MIN_MINUTES):
                    expires += timedelta(days=1)
            else:
                if isinstance(minutes, bool) or not isinstance(minutes, int) \
                        or not 1 <= minutes <= INVITE_MINUTES_MAX:
                    raise CommunityRefused(INVITE_ERROR_MINUTES)
                expires = now + timedelta(minutes=minutes)
            code = uuid.uuid4().hex[:12] + uuid.uuid4().hex[:12]
            invite = {"id": str(uuid.uuid4()), "community_id": community_id,
                      "code": code, "created_by": me,
                      "created_at": now.isoformat(), "expires_at": expires.isoformat(),
                      "revoked_at": None, "uses": 0}
            self._invites[invite["id"]] = invite
            return {"code": invite["code"], "expires_at": invite["expires_at"], "id": invite["id"]}

    def list_invites(self, me, community_id):
        """Newest first, at most 100. Admins of that community only."""
        if not me:
            raise CommunityRefused(TALK_ERROR_LOGIN, status=401)
        with self._lock:
            if not community_id or not self._is_admin(community_id, me):
                raise CommunityRefused(INVITE_ERROR_ADMIN_ONLY_LIST, status=403)
            rows = [i for i in reversed(list(self._invites.values())) if i["community_id"] == community_id]  # newest first even when the clock ticks coarsely
            rows.sort(key=lambda i: _stamp(i["created_at"]), reverse=True)
            return [{key: i[key] for key in ("id", "code", "expires_at", "revoked_at", "uses", "created_at")}
                    for i in rows[:100]]

    def revoke_invite(self, me, invite_id):
        if not me:
            raise CommunityRefused(TALK_ERROR_LOGIN, status=401)
        with self._lock:
            invite = self._invites.get(invite_id)
            if not invite or not self._is_admin(invite["community_id"], me):
                raise CommunityRefused(INVITE_ERROR_ADMIN_ONLY_REVOKE, status=403)
            invite["revoked_at"] = invite["revoked_at"] or _now()

    def rename_community(self, me, community_id, new_name):
        """What public.rename_community does: an admin of that community renames it. The name is
        trimmed (full-width spaces too) and must then be 1..COMMUNITY_NAME_MAX characters.
        Returns the new name."""
        if not me:
            raise CommunityRefused(TALK_ERROR_LOGIN, status=401)
        with self._lock:
            if not community_id or not self._is_admin(community_id, me):
                raise CommunityRefused(COMMUNITY_ERROR_RENAME_ADMIN_ONLY, status=403)
            name = (new_name or "").strip(" \t\r\n\u3000")
            if not 1 <= len(name) <= COMMUNITY_NAME_MAX:
                raise CommunityRefused(COMMUNITY_ERROR_NAME, status=400)
            self._communities[community_id]["name"] = name
            return name

    def expire_invite(self, invite_id):
        """Local-mode dev helper (an expired link for a test or a screenshot)."""
        with self._lock:
            invite = self._invites.get(invite_id)
            if not invite:
                return False
            invite["expires_at"] = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
            return True

    def post_communities(self):
        """{post id: community id} for live posts that belong to a community."""
        with self._lock:
            return {row["id"]: row["community_id"] for row in self._live() if row.get("community_id")}

    def community_map_posts(self, community_id, min_x, min_y, max_x, max_y, limit, viewer=SERVICE):
        """map_posts, but only the posts of this community (a post with none shows nowhere).
        With members_only on and a viewer named: nothing unless the viewer is in that community."""
        with self._lock:
            if self._filtering(viewer) and not self._in_community(viewer, community_id):
                return []
            rows = [
                row for row in self._live()
                if row.get("community_id") == community_id
                and min_x <= row["x"] <= max_x and min_y <= row["y"] <= max_y
            ]
        rows.sort(key=lambda row: (total_energy(row), row["created_at"]), reverse=True)
        return [self._joined(row) for row in rows[:limit]]

    # -- notification settings ---------------------------------------------

    def get_notification_settings(self, account_id):
        with self._lock:
            return [dict(row) for (owner, _), row in self._settings.items() if owner == account_id]

    def put_notification_settings(self, account_id, rows):
        with self._lock:
            for row in rows:
                self._settings[(account_id, row["category"])] = {
                    "account_id": account_id, "category": row["category"],
                    "push": bool(row["push"]), "in_app": bool(row["in_app"]),
                    "updated_at": _now(),
                }
        return self.get_notification_settings(account_id)

    def notification_settings_for(self, account_ids):
        """{account_id: [setting rows]} for everybody about to be told something."""
        wanted = set(account_ids)
        out = {}
        with self._lock:
            for (owner, _), row in self._settings.items():
                if owner in wanted:
                    out.setdefault(owner, []).append(dict(row))
        return out

    # -- web push (段6) ------------------------------------------------------

    def get_push_config(self):
        with self._lock:
            return dict(self._push_config)

    def save_push_keys(self, public, private):
        """Store a VAPID pair unless one is already there; return what is stored.

        Two servers making a pair at once both get the one that landed first.
        """
        with self._lock:
            if not self._push_config["vapid_private"]:
                self._push_config.update({"vapid_public": public, "vapid_private": private})
            return dict(self._push_config)

    def claim_pending_pushes(self):
        """Take every notification the dispatcher has not seen yet, oldest first."""
        with self._lock:
            rows = [dict(self._notifications[i]) for i in self._push_pending
                    if i in self._notifications]
            self._pushed_at.update({row["id"]: _now() for row in rows})
            self._push_pending.clear()
        rows.sort(key=lambda row: row["created_at"])
        return rows

    def release_pushes(self, ids):
        """Give claimed notifications back (pushed_at empty again): the next dispatch takes them."""
        with self._lock:
            for i in ids:
                if i in self._notifications and self._pushed_at.pop(i, None) is not None:
                    self._push_pending.append(i)

    def pushed_matches(self, since, recipient_ids):
        """[{id, recipient_id, pushed_at}] of 'match' rows taken by the dispatcher since `since`."""
        start, wanted = _stamp(_since(since)), set(recipient_ids)
        with self._lock:
            return [{"id": i, "recipient_id": self._notifications[i]["recipient_id"], "pushed_at": at}
                    for i, at in self._pushed_at.items()
                    if i in self._notifications and self._notifications[i]["type"] == "match"
                    and self._notifications[i]["recipient_id"] in wanted and _stamp(at) >= start]

    def push_subscriptions(self, account_ids):
        wanted = set(account_ids)
        with self._lock:
            return [dict(row) for row in self._push_subscriptions.values()
                    if row["account_id"] in wanted]

    def save_push_subscription(self, account_id, endpoint, p256dh, auth, user_agent=None):
        """One row per endpoint: a browser that signs in as somebody else moves over."""
        with self._lock:
            row = self._push_subscriptions.get(endpoint) or {
                "id": str(uuid.uuid4()), "endpoint": endpoint, "created_at": _now(),
            }
            row.update({"account_id": account_id, "p256dh": p256dh, "auth": auth,
                        "user_agent": user_agent})
            self._push_subscriptions[endpoint] = row
            return dict(row)

    def delete_push_subscription(self, endpoint, account_id=None):
        with self._lock:
            row = self._push_subscriptions.get(endpoint)
            if row is None or (account_id is not None and row["account_id"] != account_id):
                return False
            del self._push_subscriptions[endpoint]
            return True

    def mark_active(self, account_id, seconds):
        """mark_active() for the local shim: on screen for `seconds`, 0 clears it."""
        with self._lock:
            if seconds <= 0:
                self._presence.pop(account_id, None)
            else:
                self._presence[account_id] = (datetime.now(timezone.utc)
                                              + timedelta(seconds=min(seconds, PRESENCE_MAX_SECONDS)))

    def active_accounts(self, account_ids):
        """Those of `account_ids` who have the app on screen right now."""
        now = datetime.now(timezone.utc)
        with self._lock:
            return {account for account in account_ids
                    if account in self._presence and self._presence[account] > now}

    def recent_visitors(self, account_ids, since):
        """Those of `account_ids` who opened the app at or after `since`."""
        start = _stamp(_since(since))
        with self._lock:
            return {account for account in account_ids
                    if account in self._last_seen and _stamp(self._last_seen[account]) >= start}

    # -- people layer --------------------------------------------------------

    def profile_vectors(self):
        """Every account's four fields and hidden vectors (server only)."""
        with self._lock:
            out = []
            for account_id, row in self._accounts.items():
                vectors = self._profile_vectors.get(account_id, {})
                out.append({
                    "id": account_id, "topics": list(row.get("topics") or []),
                    "goal": row.get("goal"), "seeking": row.get("seeking"),
                    "offering": row.get("offering"),
                    **{key: vectors.get(key) for key in PROFILE_VECTOR_COLUMNS},
                })
            return out

    def post_centroids(self, community=None):
        """{author_id: {"centroid": [...], "post_count": n}} from live vec_c (of one community)."""
        self._require_scope(community)
        groups = {}
        with self._lock:
            for row in self._live():
                if row.get("vec_c") is None:
                    continue
                if community is not None and row.get("community_id") != community:
                    continue
                groups.setdefault(row["author_id"], []).append(np.asarray(row["vec_c"], dtype=float))
        return {
            author: {"centroid": [float(v) for v in np.mean(vectors, axis=0)],
                     "post_count": len(vectors)}
            for author, vectors in groups.items()
        }

    def interaction_events(self, since=None):
        """interaction_events() in Python: reactions, comments and replies."""
        start = _stamp(_since(since))
        out = []
        with self._lock:
            for (post_id, actor, kind), created_at in self._reactions.items():
                post = self._posts.get(post_id)
                if not post or post.get("deleted_at") or actor == post["author_id"]:
                    continue
                if _stamp(created_at) < start:
                    continue
                out.append({"actor_id": actor, "post_author_id": post["author_id"],
                            "post_id": post_id, "kind": kind, "reply_author_id": None,
                            "created_at": created_at})
            for row in self._comments.values():
                post = self._posts.get(row["post_id"])
                if row["deleted_at"] or not post or post.get("deleted_at"):
                    continue
                if _stamp(row["created_at"]) < start:
                    continue
                parent = self._comments.get(row.get("reply_to")) if row.get("reply_to") else None
                parent_author = parent["author_id"] if parent else None
                if row["author_id"] == post["author_id"] and parent_author in (None, row["author_id"]):
                    continue
                out.append({"actor_id": row["author_id"], "post_author_id": post["author_id"],
                            "post_id": row["post_id"],
                            "kind": "reply" if row.get("reply_to") else "comment",
                            "reply_author_id": parent_author, "created_at": row["created_at"]})
        out.sort(key=lambda event: event["created_at"])
        return out

    def touch_last_seen(self, account_id):
        """Record this visit; return the previous one (None on a first visit)."""
        with self._lock:
            previous = self._last_seen.get(account_id)
            self._last_seen[account_id] = _now()
            return previous

    # -- islands -------------------------------------------------------------

    def island_states(self, active_only=True, communities=None):
        """Saved islands. `communities` (a set of ids) keeps only the islands of those communities;
        an island saved with no community belongs to none of them."""
        with self._lock:
            return [dict(row) for row in self._islands.values()
                    if (row.get("active", True) or not active_only)
                    and (communities is None or row.get("community_id") in communities)]

    supports_island_names = True
    supports_post_extras = True

    def island_names_ready(self):
        return True

    def post_extras_ready(self):
        return True

    def save_island_states(self, rows):
        stamp = _now()
        with self._lock:
            for row in rows:
                saved = dict(self._islands.get(row["id"]) or {"created_at": stamp})
                saved.update(row)
                saved["updated_at"] = stamp
                self._islands[row["id"]] = saved
        return len(rows)

    def add_island_events(self, rows):
        with self._lock:
            for row in rows:
                saved = dict(row)
                saved.setdefault("id", str(uuid.uuid4()))
                saved.setdefault("created_at", _now())
                self._island_events[saved["id"]] = saved
        return len(rows)

    def list_island_events(self, since=None, limit=50, island_ids=None, communities=None):
        start = _stamp(_since(since))
        with self._lock:
            rows = [dict(row) for row in self._island_events.values()
                    if _stamp(row["created_at"]) >= start
                    and (island_ids is None or row["island_id"] in island_ids)
                    and (communities is None or row.get("community_id") in communities)]
        rows.sort(key=lambda row: row["created_at"], reverse=True)
        return rows[:limit]

    def claim_island_run(self, min_seconds):
        """True for one caller per min_seconds, like claim_island_run()."""
        now = datetime.now(timezone.utc)
        with self._lock:
            if self._island_run_at and now - self._island_run_at < timedelta(seconds=min_seconds):
                return False
            self._island_run_at = now
            return True

    # -- reports -----------------------------------------------------------

    def add_report(self, reporter_id, post_id, comment_id, reason):
        row = {
            "id": str(uuid.uuid4()), "reporter_id": reporter_id, "post_id": post_id,
            "comment_id": comment_id, "reason": reason, "created_at": _now(),
        }
        with self._lock:
            if self._app_settings.get(MEMBERS_ONLY_KEY):
                # reports_insert: the post, and the post of the comment, must be ones the reporter
                # is a member of. A foreign comment fails the same way as one that does not exist.
                if post_id and not self._is_member_of_post(post_id, reporter_id):
                    raise StoreError("post")
                if comment_id:
                    comment = self._comments.get(comment_id)
                    # comments_read hides deleted rows, so a deleted comment is "missing" for reports_insert
                    if (not comment or comment.get("deleted_at")
                            or not self._is_member_of_post(comment["post_id"], reporter_id)):
                        raise StoreError("comment")
            self._reports[row["id"]] = row
        return dict(row)

    # -- shaping -----------------------------------------------------------

    def _public_post(self, row, with_vec=False):
        keys = POST_COLUMNS.split(",")
        out = {key: row.get(key) for key in keys}
        out["community_id"] = row.get("community_id")
        out["energy"] = computed_energy(row)
        # posts_share_group_sync: a live copy carries the joins of all copies, anything else none.
        out["share_group"] = row.get("share_group")
        out["group_join_count"] = (self._group_joiners(row["share_group"])
                                   if row.get("share_group") and not row.get("deleted_at") else None)
        out = shape(out)
        if with_vec:
            out["vec"] = row.get("vec")
            out["vec_c"] = row.get("vec_c")
        return out

    def _joined(self, row):
        out = self._public_post(row)
        account = self._accounts.get(row["author_id"]) or {}
        out.update({
            "display_name": account.get("display_name", ""),
            "icon_id": account.get("icon_id", "0"),
            "avatar_path": account.get("avatar_path"),
        })
        return out

    def _with_author(self, row):
        out = {key: row.get(key) for key in ("id", "post_id", "author_id", "body", "reply_to", "created_at")}
        account = self._accounts.get(row["author_id"]) or {}
        out["author"] = {
            "id": row["author_id"],
            "display_name": account.get("display_name", ""),
            "icon_id": account.get("icon_id", "0"),
            "avatar_path": account.get("avatar_path"),
        }
        return out


# ---------------------------------------------------------------------------
# supabase
# ---------------------------------------------------------------------------

class SupabaseStore:
    """PostgREST client. Server-side only, with an elevated API key."""

    backend = "supabase"

    def __init__(self, url, service_key):
        self._root = f"{url.rstrip('/')}/rest/v1"
        self._headers = {
            "apikey": service_key,
            "Content-Type": "application/json",
        }
        # Legacy service_role keys are JWTs and must also be the bearer token.
        # The current sb_secret_* keys are opaque API keys: Supabase's gateway
        # maps them to service_role from the apikey header, while sending one as
        # a bearer token makes PostgREST reject it as a non-JWT.
        if not service_key.startswith("sb_secret_"):
            self._headers["Authorization"] = f"Bearer {service_key}"
        self._client = httpx.Client(timeout=REQUEST_TIMEOUT)
        self._has_name_columns = True      # until the database says otherwise
        self._names_checked_at = None
        self._has_intro_column = True      # same, for islands_state.intro
        self._intro_checked_at = None
        self._has_post_extras = False      # until the database shows the 2026-10-20 columns
        self._extras_checked_at = None
        self._has_talk = False             # until the database shows the 2026-10-26 tables
        self._talk_checked_at = None
        self._has_communities = False      # until the database shows the communities table
        self._communities_checked_at = None
        self._invite_only = False          # app_settings.invite_only, cached
        self._invite_only_checked_at = None
        self._members_only_value = None    # app_settings.members_only: the last answer (None = never read)
        self._members_only_checked_at = None
        self._has_share = False            # until the database shows the 2026-10-29 columns
        self._share_checked_at = None

    def _send(self, method, path, *, label, headers=None, params=None, json=None,
              allow_statuses=()):
        """One request, retried while the failure still looks transient.

        Every call into PostgREST goes through here so the retry policy is
        stated once. The StoreError message deliberately does NOT carry the
        response body: it is rendered straight into the browser, and Supabase
        error text is both meaningless to a visitor and a place where internals
        leak. The body goes to the server log instead.
        """
        merged = dict(self._headers)
        if headers:
            merged.update(headers)
        url = f"{self._root}/{path}"

        delay = RETRY_BACKOFF
        last = ""
        for attempt in range(1, RETRY_ATTEMPTS + 1):
            try:
                response = self._client.request(
                    method, url, headers=merged, params=params, json=json
                )
            except httpx.HTTPError as error:  # timeout, DNS, connection reset
                last = f"{type(error).__name__}: {error}"
            else:
                if response.status_code < 300 or response.status_code in allow_statuses:
                    return response
                last = f"HTTP {response.status_code}: {response.text[:200]}"
                if response.status_code not in RETRY_STATUSES:
                    break

            if attempt < RETRY_ATTEMPTS:
                print(f"[store] {label} attempt {attempt} failed ({last}); retrying", flush=True)
                time.sleep(delay)
                delay *= 2

        print(f"[store] {label} gave up after {RETRY_ATTEMPTS} attempts: {last}", flush=True)
        raise StoreError(label)

    def _get(self, path, params, label="読み込み"):
        return self._send("GET", path, label=label, params=params).json()

    def _rpc(self, name, payload, label="読み込み"):
        return self._send("POST", f"rpc/{name}", label=label, json=payload).json()

    # -- accounts ----------------------------------------------------------

    def get_embedding(self, key):
        rows = self._get("embedding_cache", {"cache_key": f"eq.{key}", "select": "embedding"})
        return rows[0]["embedding"] if rows else None

    def runtime_status(self):
        rows = self._get("map_runtime", {"select": "maintenance,active_version", "singleton": "eq.true"})
        if len(rows) != 1:
            raise StoreError("Map runtime configuration is missing")
        return rows[0]

    def put_embedding(self, key, value):
        self._send("POST", "embedding_cache", label="埋め込みの保存",
                   headers={"Prefer": "resolution=ignore-duplicates"},
                   json={"cache_key": key, "embedding": value})
        return self.get_embedding(key)

    def get_account(self, account_id):
        rows = self._get(ACCOUNTS, {
            "select": ACCOUNT_COLUMNS, "id": f"eq.{account_id}", "limit": "1",
        })
        return rows[0] if rows else None

    def list_accounts(self, ids):
        if not ids:
            return []
        joined = ",".join(ids)
        return self._get(ACCOUNTS, {"select": ACCOUNT_COLUMNS, "id": f"in.({joined})"})

    def upsert_account(self, account_id, fields):
        # fields arrives already filtered by the AccountPatch model, and a null
        # in it is deliberate: merge-duplicates writes exactly the columns sent,
        # so a column that is dropped here can never be emptied again.
        record = dict(fields)
        record["id"] = account_id
        for key in PROFILE_VECTOR_COLUMNS:
            if record.get(key) is not None:
                record[key] = "[" + ",".join(repr(float(v)) for v in record[key]) + "]"
        if not record.get("display_name"):
            # Without the name this can only be a change to an account that exists - and it has
            # to be an UPDATE. merge-duplicates is INSERT ... ON CONFLICT, and Postgres checks NOT
            # NULL on the row it would insert before it looks for the conflict, so the icon-photo
            # step after an e-mail sign-up (icon_id and avatar_path only) was refused with 23502
            # every time (2026-10-28, two new people stuck on 「次へ」).
            response = self._send(
                "PATCH", ACCOUNTS, label="プロフィールの保存",
                headers={"Prefer": "return=representation"},
                params={"id": f"eq.{account_id}", "select": ACCOUNT_COLUMNS},
                json={key: value for key, value in record.items() if key != "id"},
            )
            rows = response.json()
            if rows:
                return rows[0]
            # No such account yet: the insert below refuses it the way it always did.
        response = self._send(
            "POST", ACCOUNTS, label="プロフィールの保存",
            headers={"Prefer": "return=representation,resolution=merge-duplicates"},
            # select keeps the hidden vectors out of the answer.
            params={"on_conflict": "id", "select": ACCOUNT_COLUMNS},
            json=record, allow_statuses=(400,),
        )
        if response.status_code == 400:
            # The accounts BEFORE INSERT trigger (invite_only on, no invite): a Japanese
            # message with hint 'invite_required'. Any other 400 is the failure it always was.
            try:
                refusal = response.json() or {}
            except Exception:
                refusal = {}
            if refusal.get("hint") == "invite_required":
                raise InviteRequired()
            print(f"[store] プロフィールの保存 failed: HTTP 400: {(response.text or '')[:200]}", flush=True)
            raise StoreError("プロフィールの保存")
        body = response.json()
        return body[0] if body else self.get_account(account_id)

    # -- posts -------------------------------------------------------------

    # -- the 2026-10-20 columns (prompt / recruit_deadline / recruit_capacity) ---

    def _post_columns(self):
        columns = POST_COLUMNS if self.supports_post_extras else POST_COLUMNS_BASE
        if self.supports_communities:
            columns += ",community_id"
        return columns + "," + ",".join(SHARE_COLUMNS) if self.supports_share else columns

    @staticmethod
    def _missing_post_extras(response):
        """True when a 400 says posts has no prompt / recruit_* column (yet)."""
        if response.status_code != 400:
            return False
        text = response.text or ""
        try:
            code = str((response.json() or {}).get("code", ""))
        except Exception:
            code = ""
        return code in ("42703", "PGRST204") and any(name in text for name in EXTRA_COLUMNS)

    def post_extras_ready(self):
        """True when posts has the 2026-10-20 columns (cached for a minute).

        Raises StoreError when the database cannot be asked."""
        now = time.monotonic()
        if self._extras_checked_at is not None and now - self._extras_checked_at < POST_EXTRAS_CHECK_SECONDS:
            return self._has_post_extras
        try:
            response = self._send("GET", POSTS, label="投稿の列の確認", allow_statuses=(400,),
                                  params={"select": ",".join(EXTRA_COLUMNS), "limit": "1"})
        except StoreError:
            self._extras_checked_at = now - POST_EXTRAS_CHECK_SECONDS + 10
            raise
        if response.status_code < 300:
            ready = True
        elif self._missing_post_extras(response):
            ready = False
        else:
            # Remember the failure for ~10s (keeping the last answer) so an outage
            # does not make every request retry this check three times.
            self._extras_checked_at = now - POST_EXTRAS_CHECK_SECONDS + 10
            raise StoreError("投稿の列の確認")
        if ready != self._has_post_extras or self._extras_checked_at is None:
            print("[store] posts " + ("has" if ready else "has no")
                  + " prompt / recruit_* columns; post extras are " + ("on" if ready else "off until "
                  "supabase/migrations/20261020000000_post_prompts_and_recruit.sql is run"), flush=True)
        self._has_post_extras = ready
        self._extras_checked_at = now
        return ready

    @property
    def supports_post_extras(self):
        """Whether to read and write the extras. A database that cannot be asked
        right now keeps the last answer (off before the first one)."""
        try:
            return self.post_extras_ready()
        except StoreError:
            return self._has_post_extras

    # -- the copies of one post in several communities (2026-10-29) --------------

    def share_ready(self):
        """True when posts has share_group / group_join_count (cached for a minute).

        Raises StoreError when the database cannot be asked."""
        now = time.monotonic()
        if self._share_checked_at is not None and now - self._share_checked_at < SHARE_CHECK_SECONDS:
            return self._has_share
        try:
            response = self._send("GET", POSTS, label="投稿の列の確認", allow_statuses=(400,),
                                  params={"select": ",".join(SHARE_COLUMNS), "limit": "1"})
        except StoreError:
            self._share_checked_at = now - SHARE_CHECK_SECONDS + 10
            raise
        if response.status_code < 300:
            ready = True
        else:
            text = response.text or ""
            try:
                code = str((response.json() or {}).get("code", ""))
            except Exception:
                code = ""
            if code in ("42703", "PGRST204") and any(name in text for name in SHARE_COLUMNS):
                ready = False
            else:
                self._share_checked_at = now - SHARE_CHECK_SECONDS + 10
                raise StoreError("投稿の列の確認")
        if ready != self._has_share or self._share_checked_at is None:
            print("[store] posts " + ("has" if ready else "has no")
                  + " share_group; sharing a post with other communities is " + ("on" if ready else "off until "
                  "supabase/migrations/20261029000000_share_group.sql is run"), flush=True)
        self._has_share = ready
        self._share_checked_at = now
        return ready

    @property
    def supports_share(self):
        try:
            return self.share_ready()
        except StoreError:
            return self._has_share

    def posts_in_group(self, group):
        """The live copies of one post (every community), oldest first. The server's own read."""
        if not group or not self.supports_share:
            return []
        rows = self._get(POSTS, {
            "select": self._post_columns(), "share_group": f"eq.{group}",
            "deleted_at": "is.null", "order": "created_at.asc",
        })
        return [{"community_id": None, **shape(row)} for row in rows]

    def update_post_group(self, group, author_id, fields, skip_id=None):
        """The same change on every live copy of the post written by `author_id` (but `skip_id`)."""
        fields = self._without_extras(fields)
        if not group or not fields or not self.supports_share:
            return []
        params = {
            "share_group": f"eq.{group}", "author_id": f"eq.{author_id}",
            "deleted_at": "is.null", "select": self._post_columns(),
        }
        if skip_id:
            params["id"] = f"neq.{skip_id}"
        response = self._send("PATCH", POSTS, label="更新", headers={"Prefer": "return=representation"},
                              params=params, json=fields)
        return [shape(row) for row in response.json()]

    def soft_delete_post_group(self, group, author_id):
        """Every live copy of the post written by `author_id` is deleted. Returns how many."""
        return len(self.update_post_group(group, author_id, {"deleted_at": _now()}))

    # -- 「話してみたい」/ DM (2026-10-26) ----------------------------------------
    # The browser calls press_talk, talk_peers, ... itself with the person's JWT (they
    # run as that person, which a service key cannot), so this class only has to know
    # whether the migration has been run: features.talk follows it.

    @staticmethod
    def _missing_talk_table(response):
        if response.status_code not in (400, 404):
            return False
        text = response.text or ""
        try:
            code = str((response.json() or {}).get("code", ""))
        except Exception:
            code = ""
        return code in ("42P01", "PGRST205", "PGRST200") or TALK_STATS in text

    def talk_ready(self):
        """True when talk_stats exists (cached for a minute). Raises StoreError when
        the database cannot be asked."""
        now = time.monotonic()
        if self._talk_checked_at is not None and now - self._talk_checked_at < TALK_CHECK_SECONDS:
            return self._has_talk
        try:
            response = self._send("GET", TALK_STATS, label="話してみたいの表の確認",
                                  allow_statuses=(400, 404),
                                  params={"select": "day", "limit": "1"})
        except StoreError:
            self._talk_checked_at = now - TALK_CHECK_SECONDS + 10
            raise
        if response.status_code < 300:
            ready = True
        elif self._missing_talk_table(response):
            ready = False
        else:
            self._talk_checked_at = now - TALK_CHECK_SECONDS + 10
            raise StoreError("話してみたいの表の確認")
        if ready != self._has_talk or self._talk_checked_at is None:
            print("[store] talk tables " + ("found; 話してみたい / DM are on" if ready else
                  "missing; 話してみたい / DM are off until "
                  "supabase/migrations/20261026000000_talk_and_dm.sql is run"), flush=True)
        self._has_talk = ready
        self._talk_checked_at = now
        return ready

    @property
    def supports_talk(self):
        try:
            return self.talk_ready()
        except StoreError:
            return self._has_talk

    # -- communities and invite links (2026-10-26) --------------------------------
    # The browser calls check_invite, claim_invite, create_invite, ... itself with the
    # person's JWT. This class only has to know (1) whether the migration has been run
    # (features.communities follows it), (2) whether invite_only is on (/api/config), and
    # (3) whether a person belongs to a community (POST /api/posts checks it).

    @staticmethod
    def _missing_communities_table(response):
        if response.status_code not in (400, 404):
            return False
        text = response.text or ""
        try:
            code = str((response.json() or {}).get("code", ""))
        except Exception:
            code = ""
        return code in ("42P01", "PGRST205", "PGRST200") or COMMUNITIES in text

    def communities_ready(self):
        """True when communities exists AND has at least one row (cached for a minute).
        Raises StoreError when the database cannot be asked.

        The row count matters for the order of a release: until the operator has made the
        first community (and moved the people and posts into it, in one block), the new code
        behaves exactly like the old one instead of showing everybody "you are in no
        community"."""
        now = time.monotonic()
        if (self._communities_checked_at is not None
                and now - self._communities_checked_at < COMMUNITIES_CHECK_SECONDS):
            return self._has_communities
        try:
            response = self._send("GET", COMMUNITIES, label="コミュニティの表の確認",
                                  allow_statuses=(400, 404),
                                  params={"select": "id", "limit": "1"})
        except StoreError:
            self._communities_checked_at = now - COMMUNITIES_CHECK_SECONDS + 10
            raise
        if response.status_code < 300:
            try:
                ready = bool(response.json())
            except ValueError:
                ready = False
        elif self._missing_communities_table(response):
            ready = False
        else:
            self._communities_checked_at = now - COMMUNITIES_CHECK_SECONDS + 10
            raise StoreError("コミュニティの表の確認")
        if ready != self._has_communities or self._communities_checked_at is None:
            print("[store] communities: " + ("found a community; communities and invite links are on" if ready else
                  "missing or empty; communities are off until "
                  "supabase/migrations/20261026010000_communities_and_invites.sql is run "
                  "and the first community is made"), flush=True)
        self._has_communities = ready
        self._communities_checked_at = now
        return ready

    @property
    def supports_communities(self):
        try:
            return self.communities_ready()
        except StoreError:
            return self._has_communities

    def invite_only(self):
        """app_settings.invite_only (cached for a minute). False before the migration, and
        when the database cannot be asked (the last answer is kept)."""
        if not self.supports_communities:
            return False
        now = time.monotonic()
        if (self._invite_only_checked_at is not None
                and now - self._invite_only_checked_at < INVITE_ONLY_CACHE_SECONDS):
            return self._invite_only
        try:
            rows = self._get(APP_SETTINGS, {"select": "value", "key": "eq.invite_only", "limit": "1"},
                             label="招待制の設定の確認")
        except StoreError:
            self._invite_only_checked_at = now - INVITE_ONLY_CACHE_SECONDS + 10
            return self._invite_only
        self._invite_only = bool(rows) and rows[0].get("value") is True
        self._invite_only_checked_at = now
        return self._invite_only

    # -- members-only posts (2026-10-27) --------------------------------------------

    @staticmethod
    def _missing_app_settings(response):
        if response.status_code not in (400, 404):
            return False
        text = response.text or ""
        try:
            code = str((response.json() or {}).get("code", ""))
        except Exception:
            code = ""
        return code in ("42P01", "PGRST205") or APP_SETTINGS in text

    def members_only(self):
        """app_settings.members_only, read through the server's key and cached for
        MEMBERS_ONLY_CACHE_SECONDS. False while the table has no such row (every release before the
        lockdown SQL). Raises StoreError when the database cannot be asked: the caller answers 503
        and never guesses (a guess of "off" would open every community)."""
        now = time.monotonic()
        if (self._members_only_checked_at is not None
                and now - self._members_only_checked_at < MEMBERS_ONLY_CACHE_SECONDS):
            return self._members_only_value
        response = self._send("GET", APP_SETTINGS, label="公開範囲の設定の確認", allow_statuses=(400, 404),
                              params={"select": "value", "key": f"eq.{MEMBERS_ONLY_KEY}", "limit": "1"})
        if response.status_code < 300:
            rows = response.json()
            value = bool(rows) and rows[0].get("value") is True
        elif self._missing_app_settings(response):
            value = False
        else:
            raise StoreError("公開範囲の設定の確認")
        if value != self._members_only_value:
            print(f"[store] members_only is now {'ON' if value else 'off'}", flush=True)
        self._members_only_value = value
        self._members_only_checked_at = now
        return value

    def _require_scope(self, community):
        """Post-derived data is never asked for "all communities" while members_only is on (as
        last read by members_only(); the routes read it first)."""
        if community is None and self._members_only_value is True:
            raise ValueError("community is required while members_only is on")

    def viewer_communities(self, me):
        """The community ids a person belongs to RIGHT NOW. Never cached: a person who just
        claimed an invite must see the community on the very next request."""
        if not me:
            return set()
        rows = self._get(COMMUNITY_MEMBERS, {"select": "community_id", "account_id": f"eq.{me}"},
                         label="コミュニティの確認")
        return {row["community_id"] for row in rows}

    def community_member_ids(self, community_id):
        out, last = set(), None
        while True:
            params = {"select": "account_id", "community_id": f"eq.{community_id}",
                      "order": "account_id", "limit": "1000"}
            if last:
                params["account_id"] = f"gt.{last}"
            rows = self._get(COMMUNITY_MEMBERS, params, label="コミュニティの確認")
            out.update(row["account_id"] for row in rows)
            if len(rows) < 1000:
                return out
            last = rows[-1]["account_id"]

    def community_ids(self):
        return sorted(row["id"] for row in self._get(COMMUNITIES, {"select": "id"}, label="コミュニティの読み込み"))

    def post_communities(self):
        """{post id: community id} for live posts that belong to a community ({} before the
        migration). The connection lines and the neighbours of one community's map need it."""
        if not self.supports_communities:
            return {}
        out, last = {}, None
        while True:
            params = {"select": "id,community_id", "community_id": "not.is.null",
                      "deleted_at": "is.null", "order": "id", "limit": "1000"}
            if last:
                params["id"] = f"gt.{last}"
            rows = self._get(POSTS, params, label="コミュニティの投稿の読み込み")
            for row in rows:
                out[row["id"]] = row["community_id"]
            if len(rows) < 1000:
                return out
            last = rows[-1]["id"]

    def is_community_member(self, community_id, account_id):
        rows = self._get(COMMUNITY_MEMBERS, {
            "select": "account_id", "community_id": f"eq.{community_id}",
            "account_id": f"eq.{account_id}", "limit": "1"}, label="コミュニティの確認")
        return bool(rows)

    def _without_extras(self, data):
        if not self.supports_post_extras:
            data = {key: value for key, value in data.items() if key not in EXTRA_COLUMNS}
        if not self.supports_communities:
            data = {key: value for key, value in data.items() if key != "community_id"}
        if not self.supports_share:
            data = {key: value for key, value in data.items() if key not in SHARE_COLUMNS}
        return data

    @staticmethod
    def _prompt_refused(response):
        """True when a 400 is posts_prompt_check refusing a prompt the database does not know yet:
        a prompt added in code (2026-10-28 'help') before its migration was run."""
        if response.status_code != 400:
            return False
        try:
            body = response.json() or {}
        except Exception:
            return False
        return str(body.get("code", "")) == "23514" and "posts_prompt_check" in str(body.get("message", ""))

    def _send_post_fields(self, method, *, label, data, **kwargs):
        """POST / PATCH a post. A prompt the database's check does not know yet is dropped and the
        rest saved (the post keeps its words and tags; only the prompt is not recorded) until
        supabase/migrations/20261029010000_help_prompt.sql is run. Any other refusal fails as before."""
        response = self._send(method, POSTS, label=label, json=data, allow_statuses=(400,), **kwargs)
        if response.status_code != 400:
            return response
        if not (data.get("prompt") and self._prompt_refused(response)):
            print(f"[store] {label} refused: HTTP 400: {response.text[:200]}", flush=True)
            raise StoreError(label)
        print(f"[store] posts_prompt_check does not know the prompt {data['prompt']!r} yet; saved without it "
              "until supabase/migrations/20261029010000_help_prompt.sql is run", flush=True)
        data = {key: value for key, value in data.items() if key != "prompt"}
        if not data:
            return None   # an edit of the prompt alone: nothing left to change
        return self._send(method, POSTS, label=label, json=data, **kwargs)

    def insert_post(self, record):
        response = self._send_post_fields(
            "POST", label="保存",
            headers={"Prefer": "return=representation,resolution=ignore-duplicates"},
            params={"select": self._post_columns()},
            data=self._without_extras(record),
        )
        rows = response.json()
        if rows:
            return {"community_id": None, **shape(rows[0])}
        existing = self.get_post(record["id"])
        if not existing:
            raise StoreError("投稿を保存できませんでした。")
        return existing

    def get_post(self, post_id, with_vec=False):
        select = self._post_columns() + (",vec,vec_c" if with_vec else "")
        rows = self._get(POSTS, {
            "select": select, "id": f"eq.{post_id}", "deleted_at": "is.null", "limit": "1",
        })
        return {"community_id": None, **shape(rows[0])} if rows else None

    def update_post(self, post_id, author_id, fields):
        fields = self._without_extras(fields)
        if not fields:
            return None
        response = self._send_post_fields(
            "PATCH", label="更新",
            headers={"Prefer": "return=representation"},
            params={
                "id": f"eq.{post_id}", "author_id": f"eq.{author_id}",
                "deleted_at": "is.null", "select": self._post_columns(),
            },
            data=fields,
        )
        if response is None:
            rows = self._get(POSTS, {
                "select": self._post_columns(), "id": f"eq.{post_id}", "author_id": f"eq.{author_id}",
                "deleted_at": "is.null", "limit": "1",
            })
        else:
            rows = response.json()
        return shape(rows[0]) if rows else None

    def soft_delete_post(self, post_id, author_id):
        return bool(self.update_post(post_id, author_id, {"deleted_at": _now()}))

    def posts_by_author(self, author_id):
        rows = self._get(POSTS, {
            "select": self._post_columns() + f",{POST_AUTHOR}(id,display_name,icon_id,avatar_path)",
            "author_id": f"eq.{author_id}",
            "deleted_at": "is.null",
            "order": "created_at.desc",
        })
        return [shape(_flatten(row)) for row in rows]

    def count_posts(self, community=None, everything=False):
        if not everything:
            self._require_scope(community)
        params = {"select": "id", "deleted_at": "is.null"}
        if community is not None:
            params["community_id"] = f"eq.{community}"
        response = self._send(
            "GET", POSTS, label="件数の取得",
            headers={"Prefer": "count=exact", "Range": "0-0"},
            params=params,
        )
        # Content-Range looks like "0-0/42"
        return int(response.headers.get("content-range", "*/0").split("/")[-1])

    def map_posts(self, min_x, min_y, max_x, max_y, limit):
        rows = self._rpc("map_posts", {
            "min_x": min_x, "min_y": min_y, "max_x": max_x, "max_y": max_y,
            "limit_n": limit,
        }, label="地図の読み込み")
        # Before the 2026-10-20 SQL the answer has no extras; shape() fills them in.
        return [shape(row) for row in rows]

    def map_posts_for_community(self, community, min_x, min_y, max_x, max_y, limit):
        """The posts of ONE community for the server's own key (map_posts filters by the caller's
        membership, which the service role does not have). service_role only."""
        if not community:
            raise ValueError("community is required")
        rows = self._rpc("map_posts_for_community", {
            "p_community": community, "min_x": min_x, "min_y": min_y, "max_x": max_x,
            "max_y": max_y, "limit_n": limit,
        }, label="地図の読み込み")
        return [shape(row) for row in rows]

    def map_cells(self, min_x, min_y, max_x, max_y):
        return self._rpc("map_cells", {
            "min_x": min_x, "min_y": min_y, "max_x": max_x, "max_y": max_y,
        }, label="地図の読み込み")

    def list_terms(self, limit=5000, community=None):
        self._require_scope(community)
        columns = TERM_COLUMNS if self.supports_communities else TERM_COLUMNS.replace(",community_id", "")
        params = {
            "select": columns,
            "deleted_at": "is.null",
            "order": "energy.desc",
            "limit": str(limit),
        }
        if community is not None:
            params["community_id"] = f"eq.{community}"
        return self._get(POSTS, params, label="領域名の読み込み")

    def post_bodies(self, ids):
        """{post_id: body} for live posts among ids (island naming reads this)."""
        ids = list(ids)
        out = {}
        for start in range(0, len(ids), 40):
            chunk = ",".join(ids[start:start + 40])
            for row in self._get(POSTS, {"select": "id,body", "deleted_at": "is.null",
                                         "id": f"in.({chunk})"}, label="島の名前用の投稿"):
                out[row["id"]] = row["body"]
        return out

    def terrain_posts(self, community=None):
        self._require_scope(community)
        rows = []
        last = None
        while True:
            params = {"select": f"id,x,y,energy,body,tags,{POST_AUTHOR}(display_name)",
                      "deleted_at": "is.null", "order": "id", "limit": "1000"}
            if community is not None:
                params["community_id"] = f"eq.{community}"
            if last:
                params["id"] = f"gt.{last}"
            batch = self._get(POSTS, params, label="地形の読み込み")
            rows.extend(_flatten(row) for row in batch)
            if len(batch) < 1000:
                return rows
            last = batch[-1]["id"]

    def nearest_posts(self, post_id, k, community=None):
        self._require_scope(community)
        payload = {"from_post": post_id, "k": k}
        if community is not None:
            payload["p_community"] = community
        rows = self._rpc("nearest_posts", payload, label="近い人の検索")
        return [(row["id"], float(row["cosine"])) for row in rows]

    def pair_similarity(self, a, b):
        value = self._rpc("pair_similarity", {"a": a, "b": b}, label="似てる度の計算")
        return float(value) if isinstance(value, (int, float)) else None

    def nearest_to_vector(self, vector, k, community=None):
        self._require_scope(community)
        text = "[" + ",".join(f"{float(value):.6f}" for value in vector) + "]"
        payload = {"origin": text, "k": k}
        if community is not None:
            payload["p_community"] = community
        rows = self._rpc("nearest_to_vector", payload, label="近い人の検索")
        return [(row["id"], float(row["cosine"])) for row in rows]

    # -- footprints (Q35) -----------------------------------------------------

    def record_view(self, post_id, viewer):
        rows = self._get(POSTS, {"select": "author_id", "id": f"eq.{post_id}",
                                 "deleted_at": "is.null", "limit": "1"}, label="投稿の確認")
        if not rows or rows[0]["author_id"] == viewer:
            return False
        self._send("POST", "post_views", label="見られた数の記録",
                   headers={"Prefer": "return=minimal,resolution=ignore-duplicates"},
                   params={"on_conflict": "post_id,viewer"},
                   json={"post_id": post_id, "viewer": viewer})
        return True

    def view_counts(self, author_id):
        rows = self._rpc("post_view_counts", {"author": author_id}, label="見られた数の読み込み")
        return {row["post_id"]: int(row["views"]) for row in rows}

    # -- reactions / comments / notifications ------------------------------
    #
    # In the deployed app the browser does all of these itself against
    # PostgREST, so these methods exist for the local shim and for tests. The
    # counts and the notification rows come from the triggers either way, which
    # is why none of them is touched here.

    def add_reaction(self, post_id, actor_id, kind):
        response = self._send(
            "POST", REACTIONS, label="リアクションの保存",
            params={"on_conflict": "post_id,actor_id,kind"},
            headers={"Prefer": "return=representation,resolution=ignore-duplicates"},
            json={"post_id": post_id, "actor_id": actor_id, "kind": kind},
            # Belt and braces: a duplicate must read as "already reacted" rather
            # than an error even if a deployment loses the on_conflict hint.
            allow_statuses=(409,),
        )
        if response.status_code == 409:
            return False
        return bool(response.json() if response.content else [])

    def remove_reaction(self, post_id, actor_id, kind):
        response = self._send(
            "DELETE", REACTIONS, label="リアクションの取り消し",
            headers={"Prefer": "return=representation"},
            params={
                "post_id": f"eq.{post_id}", "actor_id": f"eq.{actor_id}",
                "kind": f"eq.{kind}",
            },
        )
        return bool(response.json())

    def reactions_by_actor(self, actor_id):
        return self._get(REACTIONS, {
            "select": "post_id,kind", "actor_id": f"eq.{actor_id}",
        })

    def add_comment(self, post_id, author_id, body, reply_to=None):
        record = {"post_id": post_id, "author_id": author_id, "body": body}
        if reply_to is not None:
            # The trigger refuses a parent on another post (23514 -> 400); the
            # lookup here only turns that into the same error MemoryStore raises.
            parent = self._get(COMMENTS, {"select": "id", "id": f"eq.{reply_to}",
                                          "post_id": f"eq.{post_id}", "limit": "1"})
            if not parent:
                raise StoreError("reply_to")
            record["reply_to"] = reply_to
        response = self._send(
            "POST", COMMENTS, label="メッセージの送信",
            headers={"Prefer": "return=representation"},
            params={"select": f"id,post_id,author_id,body,reply_to,created_at,"
                              f"{ACCOUNTS}(id,display_name,icon_id,avatar_path)"},
            json=record,
        )
        return _flatten(response.json()[0], into="author")

    def list_comments(self, post_id):
        rows = self._get(COMMENTS, {
            "select": f"id,post_id,author_id,body,reply_to,created_at,"
                      f"{ACCOUNTS}(id,display_name,icon_id,avatar_path)",
            "post_id": f"eq.{post_id}",
            "deleted_at": "is.null",
            "order": "created_at.asc",
        })
        return [_flatten(row, into="author") for row in rows]

    def delete_comment(self, comment_id, author_id):
        response = self._send(
            "PATCH", COMMENTS, label="メッセージの削除",
            headers={"Prefer": "return=representation"},
            params={"id": f"eq.{comment_id}", "author_id": f"eq.{author_id}",
                    "deleted_at": "is.null"},
            json={"deleted_at": _now()},
        )
        return bool(response.json())

    def _notification_columns(self):
        # notifications.community_id exists after the members-only prep SQL: named only while
        # members_only is on, so the code also runs before that SQL.
        return NOTIFICATION_COLUMNS + ",community_id" if self._members_only_value is True else NOTIFICATION_COLUMNS

    def list_notifications(self, recipient_id, limit=100):
        rows = self._get(NOTIFICATIONS, {
            "select": f"{self._notification_columns()},"
                      f"{ACCOUNTS}!notifications_actor_id_fkey(id,display_name,icon_id,avatar_path)",
            "recipient_id": f"eq.{recipient_id}",
            "order": "created_at.desc",
            "limit": str(limit),
        })
        rows = [_flatten(row, into="actor") for row in rows]
        for row in rows:
            if row.get("actor_id") is None:
                row["actor"] = None  # island notifications have nobody behind them
        return rows

    def insert_notifications(self, rows):
        if not rows:
            return []
        keys = ["recipient_id", "actor_id", "post_id", "type", "island_id", "event_id", "payload"]
        if self._members_only_value is True:
            keys.append("community_id")
            rows = [row for row in rows if row.get("community_id") or row["type"] not in UNSCOPED_NOTIFICATION_TYPES]
            if not rows:
                return []
        response = self._send(
            "POST", NOTIFICATIONS, label="通知の保存",
            headers={"Prefer": "return=representation"},
            params={"select": self._notification_columns()},
            json=[{key: row.get(key) for key in keys} for row in rows],
        )
        return response.json()

    def recent_notifications(self, kind, since, recipient_id=None, recipient_ids=None):
        params = {"select": self._notification_columns(), "type": f"eq.{kind}",
                  "created_at": f"gte.{_since(since)}", "order": "created_at.desc",
                  "limit": "1000"}
        if recipient_id is not None:
            params["recipient_id"] = f"eq.{recipient_id}"
        if recipient_ids is None:
            return self._get(NOTIFICATIONS, params, label="通知の読み込み")
        # Only these people's rows, a few dozen ids per request: a busy day elsewhere can
        # never push them past the 1000-row page and quietly lift a per-person limit.
        ids, rows = sorted(set(recipient_ids)), []
        for start in range(0, len(ids), 40):
            rows += self._get(NOTIFICATIONS, {**params, "recipient_id": f"in.({','.join(ids[start:start + 40])})"},
                              label="通知の読み込み")
        return rows

    def blocked_with(self, account_id):
        """Everybody `account_id` blocked or was blocked by (either way), as a set of ids."""
        rows = self._get(DM_BLOCKS, {"select": "blocker_id,blocked_id",
                                     "or": f"(blocker_id.eq.{account_id},blocked_id.eq.{account_id})"},
                         label="ブロックの読み込み")
        return ({row["blocked_id"] for row in rows if row["blocker_id"] == account_id}
                | {row["blocker_id"] for row in rows if row["blocked_id"] == account_id})

    # -- notification settings ---------------------------------------------

    def get_notification_settings(self, account_id):
        return self._get(NOTIFICATION_SETTINGS, {
            "select": "account_id,category,push,in_app,updated_at",
            "account_id": f"eq.{account_id}",
        }, label="通知設定の読み込み")

    def put_notification_settings(self, account_id, rows):
        if rows:
            self._send(
                "POST", NOTIFICATION_SETTINGS, label="通知設定の保存",
                headers={"Prefer": "return=minimal,resolution=merge-duplicates"},
                params={"on_conflict": "account_id,category"},
                json=[{"account_id": account_id, "category": row["category"],
                       "push": bool(row["push"]), "in_app": bool(row["in_app"]),
                       "updated_at": _now()} for row in rows],
            )
        return self.get_notification_settings(account_id)

    def notification_settings_for(self, account_ids):
        out = {}
        for ids in _batches(account_ids):
            for row in self._get(NOTIFICATION_SETTINGS, {
                "select": "account_id,category,push,in_app,updated_at",
                "account_id": f"in.({','.join(ids)})",
            }, label="通知設定の読み込み"):
                out.setdefault(row["account_id"], []).append(row)
        return out

    # -- web push (段6) ------------------------------------------------------
    #
    # push_config and push_presence are closed to everybody but this key. The
    # database pokes /api/push/dispatch after each insert into notifications;
    # the dispatcher then claims the rows itself, so a forged poke sends
    # nothing that was not already due.

    def get_push_config(self):
        rows = self._get(PUSH_CONFIG, {"select": PUSH_CONFIG_COLUMNS, "singleton": "eq.true"},
                         label="通知の鍵の読み込み")
        if not rows:
            return {key: None for key in PUSH_CONFIG_COLUMNS.split(",")}
        return rows[0]

    def save_push_keys(self, public, private):
        # Only fills an empty slot: the first pair written is the one everybody keeps.
        response = self._send(
            "PATCH", PUSH_CONFIG, label="通知の鍵の保存",
            headers={"Prefer": "return=representation"},
            params={"singleton": "eq.true", "vapid_private": "is.null",
                    "select": PUSH_CONFIG_COLUMNS},
            json={"vapid_public": public, "vapid_private": private, "updated_at": _now()},
        )
        rows = response.json()
        return rows[0] if rows else self.get_push_config()

    def claim_pending_pushes(self):
        # One UPDATE ... WHERE pushed_at IS NULL: two dispatchers never take the same row.
        response = self._send(
            "PATCH", NOTIFICATIONS, label="送る通知の取り出し",
            headers={"Prefer": "return=representation"},
            params={"pushed_at": "is.null", "select": self._notification_columns()},
            json={"pushed_at": _now()},
        )
        rows = response.json()
        rows.sort(key=lambda row: _stamp(row["created_at"]))
        return rows

    def release_pushes(self, ids):
        """Give claimed notifications back (pushed_at empty again): the next dispatch takes them."""
        for batch in _batches(list(ids)):
            self._send("PATCH", NOTIFICATIONS, label="通知の取り戻し",
                       params={"id": f"in.({','.join(batch)})"}, json={"pushed_at": None})

    def pushed_matches(self, since, recipient_ids):
        """[{id, recipient_id, pushed_at}] of 'match' rows taken by the dispatcher since `since`."""
        rows = []
        for batch in _batches(list(recipient_ids)):
            rows += self._get(NOTIFICATIONS, {
                "select": "id,recipient_id,pushed_at", "type": "eq.match",
                "pushed_at": f"gte.{_since(since)}", "recipient_id": f"in.({','.join(batch)})",
                "limit": "1000"}, label="通知の読み込み")
        return rows

    def push_subscriptions(self, account_ids):
        rows = []
        for ids in _batches(account_ids):
            rows.extend(self._get(PUSH_SUBSCRIPTIONS, {
                "select": PUSH_SUBSCRIPTION_COLUMNS, "account_id": f"in.({','.join(ids)})",
            }, label="通知の送り先の読み込み"))
        return rows

    def save_push_subscription(self, account_id, endpoint, p256dh, auth, user_agent=None):
        response = self._send(
            "POST", PUSH_SUBSCRIPTIONS, label="通知の送り先の保存",
            headers={"Prefer": "return=representation,resolution=merge-duplicates"},
            params={"on_conflict": "endpoint", "select": PUSH_SUBSCRIPTION_COLUMNS},
            json={"account_id": account_id, "endpoint": endpoint, "p256dh": p256dh,
                  "auth": auth, "user_agent": user_agent},
        )
        return response.json()[0]

    def delete_push_subscription(self, endpoint, account_id=None):
        params = {"endpoint": f"eq.{endpoint}"}
        if account_id is not None:
            params["account_id"] = f"eq.{account_id}"
        response = self._send(
            "DELETE", PUSH_SUBSCRIPTIONS, label="通知の送り先の削除",
            headers={"Prefer": "return=representation"}, params=params,
        )
        return bool(response.json())

    def mark_active(self, account_id, seconds):
        # The browser calls the mark_active() RPC itself; this is for the server.
        if seconds <= 0:
            self._send("DELETE", PUSH_PRESENCE, label="表示中の記録",
                       headers={"Prefer": "return=minimal"},
                       params={"account_id": f"eq.{account_id}"})
            return
        until = datetime.now(timezone.utc) + timedelta(seconds=min(seconds, PRESENCE_MAX_SECONDS))
        self._send("POST", PUSH_PRESENCE, label="表示中の記録",
                   headers={"Prefer": "return=minimal,resolution=merge-duplicates"},
                   params={"on_conflict": "account_id"},
                   json={"account_id": account_id, "active_until": until.isoformat()})

    def active_accounts(self, account_ids):
        found = set()
        for ids in _batches(account_ids):
            found.update(row["account_id"] for row in self._get(PUSH_PRESENCE, {
                "select": "account_id", "account_id": f"in.({','.join(ids)})",
                "active_until": f"gt.{_now()}",
            }, label="表示中の確認"))
        return found

    def recent_visitors(self, account_ids, since):
        found = set()
        for ids in _batches(account_ids):
            found.update(row["id"] for row in self._get(ACCOUNTS, {
                "select": "id", "id": f"in.({','.join(ids)})",
                "last_seen_at": f"gte.{_since(since)}",
            }, label="訪問の確認"))
        return found

    # -- people layer --------------------------------------------------------

    def profile_vectors(self):
        rows = self._rpc("profile_vectors", {}, label="プロフィールの読み込み")
        for row in rows:
            row["topics"] = list(row.get("topics") or [])
            for key in PROFILE_VECTOR_COLUMNS:
                row[key] = _parse_vector(row.get(key))
        return rows

    def post_centroids(self, community=None):
        self._require_scope(community)
        rows = self._rpc("account_post_centroids",
                         {} if community is None else {"p_community": community},
                         label="投稿の平均の読み込み")
        return {
            row["author_id"]: {"centroid": _parse_vector(row["centroid"]),
                               "post_count": int(row["post_count"])}
            for row in rows if row.get("centroid") is not None
        }

    def interaction_events(self, since=None):
        rows = self._rpc("interaction_events", {"since": _since(since)}, label="交流の読み込み")
        rows.sort(key=lambda event: _stamp(event["created_at"]))
        return rows

    def touch_last_seen(self, account_id):
        # touch_last_seen() reads auth.uid(), which is empty for the server's
        # key, so the server does the same two steps directly.
        rows = self._get(ACCOUNTS, {"select": "last_seen_at", "id": f"eq.{account_id}",
                                    "limit": "1"}, label="前回の訪問の読み込み")
        self._send("PATCH", ACCOUNTS, label="訪問の記録",
                   headers={"Prefer": "return=minimal"},
                   params={"id": f"eq.{account_id}"}, json={"last_seen_at": _now()})
        return rows[0].get("last_seen_at") if rows else None

    # -- islands -------------------------------------------------------------

    @property
    def supports_island_names(self):
        """False once the database turned out not to have the name columns."""
        return self._has_name_columns

    @staticmethod
    def _missing_name_columns(response):
        """True when a 400 says the islands_state name columns do not exist (yet)."""
        if response.status_code != 400:
            return False
        text = response.text or ""
        try:
            code = str((response.json() or {}).get("code", ""))
        except Exception:
            code = ""
        # Both: a CHECK violation (23514), a bad filter (PGRST100) or another column's
        # 42703 must not be taken for "the migration has not been run".
        return code in ("42703", "PGRST204") and any(name in text for name in ISLAND_NAME_COLUMNS)

    @staticmethod
    def _missing_intro_column(response):
        """True when a 400 says islands_state.intro does not exist (yet)."""
        if response.status_code != 400:
            return False
        text = response.text or ""
        try:
            code = str((response.json() or {}).get("code", ""))
        except Exception:
            code = ""
        return code in ("42703", "PGRST204") and ISLAND_INTRO_COLUMN in text

    def _remember_missing_intro_column(self):
        if self._has_intro_column:
            print("[store] islands_state has no intro column yet; island intros are not saved "
                  "until supabase/migrations/20261028000000_island_intro.sql is run", flush=True)
        self._has_intro_column = False
        self._intro_checked_at = time.monotonic()

    def _island_columns(self):
        columns = ISLAND_STATE_COLUMNS if self._has_name_columns else ISLAND_STATE_BASE_COLUMNS
        if self._has_intro_column:
            columns += "," + ISLAND_INTRO_COLUMN
        # community_id exists after supabase/migrations/20261027000000_members_only_prep.sql; it is
        # only named while members_only is on, so the code also runs before that SQL.
        return columns + ",community_id" if self._members_only_value is True else columns

    def island_states(self, active_only=True, communities=None):
        # An instance that decided "no columns" tries the full read again once the
        # check interval has passed (the SQL may have been run since), without a restart.
        if (not self._has_name_columns and self._names_checked_at is not None
                and time.monotonic() - self._names_checked_at >= NAME_COLUMNS_CHECK_SECONDS):
            self._has_name_columns = True
            self._names_checked_at = time.monotonic()
        if (not self._has_intro_column and self._intro_checked_at is not None
                and time.monotonic() - self._intro_checked_at >= NAME_COLUMNS_CHECK_SECONDS):
            self._has_intro_column = True
            self._intro_checked_at = time.monotonic()
        for _ in range(3):
            params = {"select": self._island_columns(), "order": "created_at.asc"}
            if active_only:
                params["active"] = "is.true"
            if communities is not None:
                if not communities:
                    return []
                params["community_id"] = f"in.({','.join(sorted(communities))})"
            response = self._send("GET", ISLANDS_STATE, label="島の読み込み", params=params,
                                  allow_statuses=(400,))
            if response.status_code < 300:
                return response.json()
            if self._has_intro_column and self._missing_intro_column(response):
                self._remember_missing_intro_column()
                continue
            if self._has_name_columns and self._missing_name_columns(response):
                self._remember_missing_name_columns()
                continue
            print(f"[store] 島の読み込み failed: HTTP {response.status_code}: {response.text[:200]}", flush=True)
            raise StoreError("島の読み込み")
        raise StoreError("島の読み込み")

    def _remember_missing_name_columns(self):
        if self._has_name_columns:
            print("[store] islands_state has no name_source column yet; AI island names are off "
                  "until supabase/migrations/20261012000000_ai_island_names_no_connection.sql is run",
                  flush=True)
        self._has_name_columns = False
        self._names_checked_at = time.monotonic()

    def island_names_ready(self):
        """True when islands_state can be read with the name columns (cached briefly).

        Used by /api/health: a database the 2026-10-12 migration has not reached
        must not be promoted. Raises StoreError when the database cannot be asked.
        """
        now = time.monotonic()
        if self._names_checked_at is not None and now - self._names_checked_at < NAME_COLUMNS_CHECK_SECONDS:
            return self._has_name_columns
        response = self._send("GET", ISLANDS_STATE, label="島の列の確認", allow_statuses=(400,),
                              params={"select": ",".join(ISLAND_NAME_COLUMNS), "limit": "1"})
        if response.status_code < 300:
            self._has_name_columns = True
            self._names_checked_at = now
        elif self._missing_name_columns(response):
            self._remember_missing_name_columns()
        else:
            raise StoreError("島の列の確認")
        return self._has_name_columns

    def save_island_states(self, rows):
        if not rows:
            return 0
        if (not self._has_intro_column and self._intro_checked_at is not None
                and time.monotonic() - self._intro_checked_at >= NAME_COLUMNS_CHECK_SECONDS):
            self._has_intro_column = True
            self._intro_checked_at = time.monotonic()
        for _ in range(3):
            keys = self._island_columns().split(",")
            stamp = _now()
            response = self._send(
                "POST", ISLANDS_STATE, label="島の保存", allow_statuses=(400,),
                headers={"Prefer": "return=minimal,resolution=merge-duplicates"},
                params={"on_conflict": "id"},
                json=[{**{key: row.get(key) for key in keys if key in row and key != "created_at"},
                       "updated_at": stamp} for row in rows],
            )
            if response.status_code < 300:
                return len(rows)
            if self._has_intro_column and self._missing_intro_column(response):
                self._remember_missing_intro_column()
                continue
            if self._has_name_columns and self._missing_name_columns(response):
                self._remember_missing_name_columns()
                continue
            print(f"[store] 島の保存 failed: HTTP {response.status_code}: {response.text[:200]}", flush=True)
            raise StoreError("島の保存")
        raise StoreError("島の保存")

    def add_island_events(self, rows):
        if rows:
            keys = ISLAND_EVENT_COLUMNS.split(",")
            if self._members_only_value is True:
                keys.append("community_id")
            self._send("POST", ISLAND_EVENTS, label="島の変化の保存",
                       headers={"Prefer": "return=minimal"},
                       json=[{key: row[key] for key in keys if key in row} for row in rows])
        return len(rows)

    def list_island_events(self, since=None, limit=50, island_ids=None, communities=None):
        columns = ISLAND_EVENT_COLUMNS + (",community_id" if communities is not None else "")
        params = {"select": columns, "created_at": f"gte.{_since(since)}",
                  "order": "created_at.desc", "limit": str(limit)}
        if communities is not None:
            if not communities:
                return []
            params["community_id"] = f"in.({','.join(sorted(communities))})"
        if island_ids is not None:
            if not island_ids:
                return []
            params["island_id"] = f"in.({','.join(island_ids)})"
        return self._get(ISLAND_EVENTS, params, label="島の変化の読み込み")

    def claim_island_run(self, min_seconds):
        return bool(self._rpc("claim_island_run", {"min_seconds": int(min_seconds)},
                              label="島の処理の確認"))

    def mark_notifications_read(self, recipient_id, ids=None):
        params = {"recipient_id": f"eq.{recipient_id}", "read_at": "is.null"}
        if ids is not None:
            params["id"] = f"in.({','.join(ids)})"
        response = self._send(
            "PATCH", NOTIFICATIONS, label="既読の保存",
            headers={"Prefer": "return=representation"},
            params=params, json={"read_at": _now()},
        )
        return len(response.json())

    def unread_count(self, recipient_id):
        response = self._send(
            "GET", NOTIFICATIONS, label="未読件数の取得",
            headers={"Prefer": "count=exact", "Range": "0-0"},
            params={"select": "id", "recipient_id": f"eq.{recipient_id}",
                    "read_at": "is.null"},
        )
        return int(response.headers.get("content-range", "*/0").split("/")[-1])

    def add_report(self, reporter_id, post_id, comment_id, reason):
        response = self._send(
            "POST", REPORTS, label="通報の送信",
            headers={"Prefer": "return=representation"},
            json={"reporter_id": reporter_id, "post_id": post_id,
                  "comment_id": comment_id, "reason": reason},
        )
        return response.json()[0]


def create_store():
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
    if url and key:
        return SupabaseStore(url, key)
    return MemoryStore()
