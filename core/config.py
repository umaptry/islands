"""Single source of truth for every knob that shapes the map.

These values are copied verbatim from the pokeDB pipeline (see
`C:/Users/zk-ht/pokeDB/build_umap_coords.py`), where they were selected by
ablation. The only domain-specific change in this project is the stop-word
list in `stopwords.py`: the geometry parameters stay identical.
"""

import os
from datetime import date

GEMINI_MODEL_NAME = "gemini-embedding-2"
GEMINI_DIMENSIONS = 384
# The task prefix Gemini embeds for ("task: <this> | query: <text>"). Clustering
# since map v5 (2026-10-16): on 838 topic-labelled posts, a post's nearest
# neighbour shared its topic 83% of the time, against 62% for "sentence
# similarity" (and 60% for OpenAI text-embedding-3-large); announcements 60% ->
# 88%, "want to try" 51% -> 79%. More dimensions did not help (384 = 3072).
# Part of the embedding spec: a map built with one task refuses the other.
GEMINI_TASK = "clustering"

MODEL_VERSION = "kotoba-map-v2"
LAYOUT_VERSION = "seed-placed-isotropic-v3"

# One free-text self-introduction per person is the ONLY input signal.
FEATURE_CONFIG = {
    "dense_weight": 0.65,
    "sparse_weight": 0.35,
    "char_weight": 0.25,
    "dense_raw_weight": 0.35,
    "dense_concept_weight": 0.65,
    "word_min_df": 1,
    "word_max_features": 8000,
    "char_min_df": 1,
    "char_max_features": 6000,
    "svd_components": 64,
}

DENSE_WEIGHT = FEATURE_CONFIG["dense_weight"]
SPARSE_WEIGHT = FEATURE_CONFIG["sparse_weight"]
CHAR_WEIGHT = FEATURE_CONFIG["char_weight"]
DENSE_RAW_WEIGHT = FEATURE_CONFIG["dense_raw_weight"]
DENSE_CONCEPT_WEIGHT = FEATURE_CONFIG["dense_concept_weight"]

# How a map built from 2026-10-15 on reads a stored vector, for its encoder and
# for 似てる度 alike: the dense block centred on the seed mean, recombined with
# the word block at 0.80 / 0.20 (core.similarity.map_view). Measured with Gemini
# on the 100 labelled probes with the built map, a post's nearest map neighbour
# shared its family of topics 38% -> 82% of the time (with the 10k seed corpus),
# and posts with none among their four nearest went 36% -> 10%. At 0.35 the word block let common words
# (勉強, 毎日) outvote the meaning; 0-25% measured alike, above 30% fell away.
#
# Kept OUT of FEATURE_CONFIG on purpose: that dict describes the STORED vector
# and every artifact's manifest must equal it, so older artifacts stay loadable.
# A build writes these weights into its own seed_map.json (cosine_centroid), and
# from then on the artifact, not these constants, decides how it is read.
VIEW_DENSE_WEIGHT = 0.80
VIEW_SPARSE_WEIGHT = 0.20

# How a map built from 2026-10-15 on places a new text: at the main group among
# its k nearest seeds in meaning (core.placement.place_by_seeds). temperature
# weights the k by similarity, bandwidth (world units) is how close two seeds'
# spots must be to count as one group. Written into the artifact, which decides.
# Softer since v4 (2026-10-16; was k 15, temperature 0.02, bandwidth 25): more
# seeds and a flatter weighting keep a post with its topic rather than with
# posts worded like it. On the Gemini map: held-out seeds 0.94 -> 0.96 of the
# ceiling (1.5%: 0.94 -> 1.00), the 478 evaluation posts' nearest neighbour on
# their own topic 44% -> 50%, build probes lost 14% -> 11%.
SEED_PLACEMENT = {"method": "seed_mode", "k": 60, "temperature": 0.05, "bandwidth": 40.0}
SEED_VARIANTS_FILE = "seed_variants.jsonl"   # in scripts/, see core.placement

# Reference layout parameters for the one-off teacher UMAP run. min_dist went
# 0.05 -> 0.0 on 2026-10-15: with posts placed by their seeds, the tighter teacher
# left more sea between topics - on 478 labelled posts at reach x0.7, 18-29
# islands with 106-150 posts on the biggest (0.05: 22-30 and 130-213), the
# placement no less accurate (3 random seeds each).
# repulsion_strength 2 and spread 0.5 since v6 (2026-10-16): searched over ~60
# settings on the clustering vectors (2 random seeds each, the best 7 on 3 more
# and with posts placed as serving places them). Placed the serving way, the
# 838 labelled posts' islands were one family 61% -> 73% of the time and the
# biggest island 29% -> 19% of them (3 seeds); laid out with the seeds, 71% ->
# 81% (5 seeds, worst 77%). Seeds' 15 nearest kept on the map: 0.36 -> 0.35.
LAYOUT_CONFIG = {
    "n_neighbors": 15,
    "min_dist": 0.0,
    "spread": 0.5,
    "repulsion_strength": 2.0,
    "n_epochs": 1000,
    "negative_sample_rate": 10,
    "metric": "cosine",
    "init": "pca",
    "random_state": 42,
}

# Candidate island counts. The upper bound is set by how many island colours a
# reader can actually tell apart, not by anything in the data.
CLUSTER_CANDIDATES = (6, 7, 8, 9, 10)

# Size bounds are PROPORTIONAL, not absolute. pokeDB hard-coded min 15 / max 125
# for a 500-document corpus; carried over unchanged to 1000 documents, max=125
# is below N/k for every k <= 8, so no k could ever pass and the build would
# abort. These bounds are only a sanity floor anyway - the real selection is the
# score in select_cluster_model. They exist for one reason: an island holding a
# third of the corpus gets labelled with whatever is generic across a third of
# the corpus, which tells a reader nothing.
CLUSTER_MIN_RATIO = 0.02
CLUSTER_MIN_ABSOLUTE = 12
CLUSTER_MAX_RATIO = 0.35


def cluster_size_bounds(total):
    """(min, max) members per island for a corpus of `total` documents."""
    return (
        max(CLUSTER_MIN_ABSOLUTE, int(total * CLUSTER_MIN_RATIO)),
        max(CLUSTER_MIN_ABSOLUTE * 2, int(total * CLUSTER_MAX_RATIO)),
    )

# Island assignment for a new person: inverse-distance-weighted vote over the
# nearest seed points.
CLUSTER_VOTE_K = 15

MAP_MIN = 0.0
MAP_MAX = 1000.0
MAP_PADDING = 0.02
# Only literal overlaps are separated; semantic distances are never rewritten.
OVERLAP_EPSILON = 0.5

# Post rules.
#
# 60 and no floor (Q36, 2026-10-07): a post is a quick line, not an essay. The
# old floor of 30 kept the embedding's sparse block from being mostly empty; a
# very short post now leans on OVERLAP_EPSILON to stay off its neighbours.
#
# There is no MAX_USERS any more. It existed because anybody with the URL could
# fill the map and the only brake was a number; accounts are the brake now.
MIN_TEXT_LENGTH = 1
# 2026-10-31: 新しい投稿は画面で15字から（BAR で「アプリ開発」のような短すぎる投稿が地図の置き場所とつながりを
# 悪くした）。サーバーの下限は MIN_TEXT_LENGTH のまま：昔の短い投稿の編集やテスト・デモのデータを壊さないため、
# 画面だけの決まりにしてある。/api/config の limits.compose_min で画面に渡す。
COMPOSE_MIN_LENGTH = 15
MAX_TEXT_LENGTH = 60
# 2026-11-01: 24 字（フルネームのお願い。supabase の display_name の制約と /api/config の limits.name_max もこの値）。
MAX_NAME_LENGTH = 24
MAX_COMMENT_LENGTH = 500
MAX_AFFILIATION_LENGTH = 32
MAX_BIO_LENGTH = 300
MAX_LINK_LENGTH = 200

# One colour per island, so this list also caps CLUSTER_CANDIDATES.
# Hue separation matters most on avatar rings and island labels; the terrain
# dots are drawn at 0.12 alpha where hue barely reads, so ten is workable.
ISLAND_COLORS = [
    "#db2777", "#7c3aed", "#0284c7", "#059669", "#b45309",
    "#e11d48", "#4f46e5", "#15803d", "#0f766e", "#9333ea",
]
assert max(CLUSTER_CANDIDATES) <= len(ISLAND_COLORS), "島の数が色数を超えています"


# ---------------------------------------------------------------------------
# islands' post model.
#
# Everything below arrives from C:/Users/zk-ht/Downloads/islands, where posts
# carry a mood and a handful of tags and those turn into terrain. The geometry
# above is untouched by it: a tag never moves anybody, and the slider never
# does either. Only the TEXT decides where a post lands. What islands adds is
# what happens to the ground once it is there.
# ---------------------------------------------------------------------------

# Checkboxes, not radio buttons: islands moved away from a single "tense"
# choice in 2026-07-27 because people wanted to say two of these at once.
TAGS = (
    "気軽に話しかけて",
    "助けてほしい",
    "仲間募集中",
    "参加者募集中",
)

# エンジョイ (0) - ガチ (100).
MOTIVATION_MIN = 0
MOTIVATION_MAX = 100
MOTIVATION_DEFAULT = 50

# energy = motivation + interactions * ENERGY_PER_INTERACTION.
#
# islands counted likes + comments. There are three reaction kinds here, so all
# of them count: telling someone "手伝えるかも" is at least as much of a signal
# as a like, and making it worth nothing would have made the map read wrong.
ENERGY_PER_INTERACTION = 5

# radius = (ENERGY_RADIUS_BASE + energy * ENERGY_RADIUS_SCALE) * ENERGY_RADIUS_TRIM
# Verbatim from islands' MapApp.tsx: (30 + energy * 0.45) * (2 / 3). It reads
# oddly because it is two edits deep - a base radius, then a trim applied to the
# whole thing after the islands turned out too fat. Kept in that shape so the
# port can be checked against the original by eye.
ENERGY_RADIUS_BASE = 30.0
ENERGY_RADIUS_SCALE = 0.45
ENERGY_RADIUS_TRIM = 2.0 / 3.0
# Islands are the posts whose ground overlaps. Past ISLAND_REACH_FULL_POSTS the
# reach shrinks as (full / posts) ** ISLAND_REACH_POWER - as if the map grew with
# its people - so islands keep apart instead of chaining into one continent.
# Fitted on the labelled eval posts placed by seeds (2026-10-16): about 20
# islands with the biggest holding a quarter to a third of the posts needed
# x1.0 at ~120 posts, x0.9 at ~240 and x0.7 at ~480 (x1.0 there: one island of
# all 478). Never below the floor, or a very busy map would be dust.
ISLAND_REACH_FULL_POSTS = 180
ISLAND_REACH_POWER = 0.36
ISLAND_REACH_FLOOR = 0.4

# Where the ground changes. Summed energy at a point in the field, not one
# post's energy: two posts side by side make forest out of what either alone
# would leave as savanna, which is the entire point of the additive field.
BIOME_THRESHOLDS = {
    "shallow": 0.05,
    "desert": 30.0,
    "savanna": 50.0,
    "plains": 90.0,
    "forest": 300.0,
    "mountain": 700.0,
}

# Drawn on the client; defined here so the server and the browser cannot drift.
# 2026-10-31 (the user, prototype E): the colours of the 3D prototype C, measured
# off its pictures - a deeper sea, and land in warmer, more natural greens.
BIOME_COLORS = {
    "sea": "#1D88C7",
    "shallow": "#3EA7D0",
    "desert": "#E3C98B",
    "savanna": "#9CBB5E",
    "plains": "#74AD4E",
    "forest": "#5C9F48",
    "mountain": "#4D8A40",
}

# Settlement glyph by interaction count. islands' table, unchanged.
PLOT_TIERS = (
    (30, "🏰"),
    (10, "🏠"),
    (5, "🛖"),
    (0, "🪵"),
)

# A landmass with this many posts is a continent rather than an island. Only
# affects the word printed after the name.
CONTINENT_MIN_POSTS = 50

# Regions inside one landmass (Q29: 麺類島 holding a ラーメン地方 and an うどん地方).
# A landmass this big is split by the frozen k-means region its posts sit in, and
# each group with enough posts gets its own name. Both numbers are provisional.
REGION_MIN_POSTS = 8
REGION_MIN_GROUP = 3

# Must match the literal 20.0 in supabase/schema.sql (energy_cell_apply and
# map_cells). A generated column and an index depend on it there, and neither
# can call out to Python, so it is written twice on purpose and asserted in
# tests/test_energy.py.
ENERGY_CELL_SIZE = 20.0

# How many posts the client pulls for one viewport. Above this the terrain is
# built from the most energetic ones plus the coarse energy_cells layer.
MAP_POST_LIMIT = 800

# How many neighbours the orbit view asks for.
ORBIT_NEIGHBOR_COUNT = 24


# ---------------------------------------------------------------------------
# People layer (islands redesign, stage 1). Every number below is PROVISIONAL
# (仮): chosen in the 2026-10-06 design, not measured on real use. They live
# here so they can be tuned without touching the code that uses them.
# ---------------------------------------------------------------------------

# Profile fields. Topics are short words; the other three are one sentence.
PROFILE_TOPIC_MAX = 8
PROFILE_TOPIC_LENGTH = 12
PROFILE_TEXT_LENGTH = 60
PROFILE_TEXT_FIELDS = ("goal", "seeking", "offering")

# How alike two people are. Topics and goal matter most (the user's request).
# A part one of the two people left empty is dropped and the rest renormalised,
# so an empty profile neither helps nor hurts. "seeking_offering" takes the
# better of A.seeking vs B.offering and B.seeking vs A.offering.
AFFINITY_WEIGHTS = {
    "topics": 0.35,
    "goal": 0.30,
    "seeking_offering": 0.20,
    "posts": 0.15,
}
# Profile vectors are compared in the same centred space as posts: the seed
# corpus's dense mean is subtracted first (core/similarity.similarity_view).
# Raw e5 cosine on short profile texts sits in a band too narrow to read -
# measured 10/06 on 16 made-up texts: related pairs 0.89-0.95, unrelated
# 0.87-0.92. Centred: related 0.26-0.64 (mean 0.50), unrelated 0.17-0.51
# (mean 0.33), median of all pairs 0.25. The centred cosine is rescaled
# linearly to 0..1 between these anchors (clipped).
# 仮: 16 made-up texts is not real profiles; re-measure once people fill them in.
# Gemini is NOT measured (未確認) and uses the same numbers until it is.
PROFILE_COSINE_ANCHORS = {
    "onnx": (0.25, 0.65),
    "gemini": (0.25, 0.65),
}
SIMILAR_PEOPLE_COUNT = 5
# Reasons shown with a suggested person (core/introductions.py). A part counts
# as a reason from this score up (0..1, the same scale as AFFINITY parts).
# 仮: chosen by eye on made-up profiles, not measured.
INTRO_PART_THRESHOLD = 0.5
INTRO_REASON_COUNT = 3
# A person's card lists this many of the people they have a line with.
PERSON_CARD_CONNECTIONS = 5
# The away digest names this many people behind each change.
DIGEST_CONTRIBUTORS = 2
# A new profile this close to somebody tells them ("similar" notification).
SIMILAR_NOTIFY_THRESHOLD = 0.75
SIMILAR_NOTIFY_PER_DAY = 3

# Connections: one line per pair of people, no direction.
CONNECTION_POINTS = {"join": 1, "comment": 2, "reply": 3}
CONNECTION_HALF_LIFE_DAYS = 14.0
# Strength tiers 1..3 by decayed points: below the first bound is tier 1.
CONNECTION_TIER_BOUNDS = (3.0, 8.0)
# A line whose last interaction is older than this is drawn thin and faint. It
# is removed only when the interactions themselves are undone.
CONNECTION_FAINT_DAYS = 30
# "Ongoing": interaction on at least this many distinct days within the window.
CONNECTION_ONGOING_DAYS = 2
CONNECTION_ONGOING_WINDOW_DAYS = 14
# "Aさん と Bさん　この1週間で8回": the count a tap on a vehicle shows.
CONNECTION_WEEK_DAYS = 7
# Interactions before the launch of public lines are not shown as lines: people
# did them before they were told it would be visible.
CONNECTIONS_SINCE = "2026-10-06T00:00:00+00:00"
CONNECTION_CACHE_SECONDS = 30

# Island growth. score = people*W + sqrt-per-person posts*W + interactions*W.
GROWTH_WEIGHTS = {"people": 1.0, "posts": 0.6, "interactions": 0.8}
# One actor counts once per post per day, and at most this many times per
# island per day, so a burst of taps cannot build a city.
GROWTH_DAILY_CAP = 5
GROWTH_RECENT_DAYS = 14
# The shown score may fall by at most this share per update.
GROWTH_MAX_SHRINK = 0.20
# 小屋・村・港町・町・都市. Lower bound of each tier.
GROWTH_TIERS = ("小屋", "村", "港町", "町", "都市")
GROWTH_TIER_BOUNDS = (0.0, 8.0, 20.0, 45.0, 90.0)
# A tier is lost only when the score falls this far below its lower bound.
GROWTH_TIER_HYSTERESIS = 0.20

# Island tracking.
ISLAND_MATCH_OVERLAP = 0.5        # share of the smaller island's posts
ISLAND_RUN_MIN_SECONDS = 600      # run on map open, at most every 10 minutes
ISLAND_QUIET_DAYS = 14
AWAY_DIGEST_COUNT = 5
# Landmarks by tier index: born with 1, 港町 2, 都市 3.
LANDMARK_COUNT_BY_TIER = (1, 1, 2, 2, 3)
LANDMARK_SWAP_DAYS = 3
LANDMARK_CANDIDATES = (
    "灯台", "風車", "時計塔", "図書館", "工房", "温室",
    "天文台", "市場", "港の桟橋", "鍛冶場", "学び舎", "茶屋",
    "劇場", "庭園", "畑", "釣り小屋", "画廊", "音楽堂",
    "研究所", "パン屋", "診療所", "見張り台", "運動場", "広場",
)

# Notifications.
# 2026-10-12: 「新しいつながり」(connection) と「おすすめ」(similar) の分類は
# 画面から外した。古い画面が送ってきても 400 にしないよう、名前だけ残して無視する。
NOTIFICATION_CATEGORIES = ("reply", "reaction", "island")
LEGACY_NOTIFICATION_CATEGORIES = ("connection", "similar")
NOTIFICATION_CATEGORY_OF = {
    "like": "reaction", "help": "reaction", "join": "reaction",
    "comment": "reply", "reply": "reply",
    "connection": "connection", "similar": "similar", "island": "island",
    # Q34: a post nobody has answered yet, shown to people nearby. Since the
    # similar switch went away it follows the island category (in the app
    # only, never pushed; see NEVER_PUSHED and core/notifications.allows).
    "quiet_post": "island",
    # 2026-10-26: 「話してみたい」と DM. They use the existing switches (the settings
    # screen does not change): the talk lines are reactions, a new message is a reply.
    "talk_wish": "reaction", "talk_match": "reaction", "dm": "reply",
    # 2026-10-29: 「つながり」: somebody just posted something that connects to your post. A reaction
    # (the settings screen only gets a longer note), one row each, never folded.
    "match": "reaction",
    # 2026-11-01: 承認制。分類の名前は種類名そのもの（設定の画面に出る分類ではないので、
    # NOTIFICATION_CATEGORIES には足さない）。設定に関係なく常にオン：ALWAYS_ON_NOTIFICATION_TYPES。
    "join_request": "join_request", "join_approved": "join_approved",
    # 2026-11-01 第2回a：会（イベント申し込み）。主催者へ「遅れます」「キャンセルしました」、
    # 申し込み中のメンバーへ「会が中止になりました」（アプリの中の通知）。
    "event_late": "event_late", "event_cancel": "event_cancel", "event_cancelled": "event_cancelled",
}
# Types that are ALWAYS shown and pushed, whatever the settings say: a person waiting to be let in,
# and "you are in" (notices.allows / interrupts). 2026-11-01 第2回a：会の遅れる連絡・キャンセル・中止も常にオン。
ALWAYS_ON_NOTIFICATION_TYPES = frozenset({
    "join_request", "join_approved", "event_late", "event_cancel", "event_cancelled"})
# Only these are folded into one line ("A ほか2人") when they follow each other. The
# talk lines are shown one by one: a talk_wish has no actor and no post.
CHAINED_NOTIFICATION_TYPES = frozenset({"like", "help", "join"})
# Types that stay inside the app whatever the settings say.
NEVER_PUSHED = frozenset({"quiet_post"})
REACTION_GROUP_MINUTES = 10
ISLAND_NOTIFY_PER_DAY = 1
# 'resident' island notifications (somebody new moved onto your island): per recipient and island per day.
RESIDENT_NOTIFY_PER_DAY = 3
# ... and per recipient per day over all islands: a big community's first-post wave stays a few pushes.
RESIDENT_NOTIFY_PER_PERSON_DAY = 5
# Island residents shown on an island (newest poster first).
ISLAND_RESIDENTS_SHOWN = 5
ISLAND_INTRO_MAX_LENGTH = 30       # AI one-line intro; the column allows 60

# 島の名前を AI（Gemini）で付ける。島の追跡処理（10分に1回まで）の中だけで呼ぶ。
# 鍵なし・失敗・時間切れのときは、島の投稿の上位語から作る従来の名前のまま。
# 既定はオフ。本番は CI のデプロイが ISLAND_NAMING_ENABLED=1 を付ける（2026-10-28〜）。
ISLAND_NAMING_ENABLED = os.environ.get("ISLAND_NAMING_ENABLED", "0") == "1"
ISLAND_NAMING_MODEL = os.environ.get("ISLAND_NAMING_MODEL", "gemini-3.5-flash-lite")
ISLAND_NAMING_TIMEOUT = 5.0        # 1回の呼び出しの秒数。越えたら従来の名前
ISLAND_NAMING_MAX_PER_RUN = 10     # 1回の追跡で呼ぶ回数の上限（費用と時間の上限。聞き直しも数える。AI 名のない島を先に）
ISLAND_NAMING_SAMPLE_POSTS = 30    # プロンプトに入れる投稿の数
ISLAND_NAMING_KEEP_OVERLAP = 0.7   # 顔ぶれ（投稿ID）の重なりがこれ以上なら前の名前を使い回す
# 同じ島を（成功も失敗も）呼び直す最短の間隔。24時間だと、BAR の夜に島の中身が入れ替わっても
# 名前が翌日まで古いままになるので 30分にした（2026-10-28）。呼ぶのは1回の追跡で MAX_PER_RUN まで。
ISLAND_NAMING_RETRY_HOURS = 0.5

# 投稿画面の ① で「次へ」を押したとき、本文に話題がいくつ入っているかを AI（Gemini）に聞く（2026-10-31）。
# 鍵（GEMINI_API_KEY）が無いか TOPIC_CHECK_ENABLED=0 なら AI を呼ばず、画面はそのまま ② へ進む。
TOPIC_CHECK_ENABLED = os.environ.get("TOPIC_CHECK_ENABLED", "1") == "1"
TOPIC_CHECK_TIMEOUT = 3.0          # サーバー側の時間切れ（秒）。ブラウザ側は4秒で諦める
TOPIC_CHECK_MAX_TOPICS = 4         # 画面に並べる話題の数の上限
TOPIC_CHECK_TOPIC_MAX_LENGTH = 12  # 話題の名前の長さの上限
TOPIC_CHECK_RATE_MAX = 10          # 1人あたりの回数（check_rate_limit の窓＝5分のあいだ）
ISLAND_NAMING_NOTIFY_OVERLAP = 0.4  # AI名→AI名の改名を通知するのは、投稿の重なりがこれ未満のときだけ
# すべての島（1人・1件でも）を AI で名付ける（2026-10-28 ユーザー決定）。一覧から選ぶ方式は、
# 小さな島で票が同点になりやすく、地図 v7 で投稿の中身と関係ない「料理」が付いたため。
ISLAND_NAME_PENDING_LABEL = "名前を考え中"  # AI 名が付くまで、ジャンル名の代わりに出す
ISLAND_NAME_PENDING_MAX_SECONDS = 1800   # この時間たっても AI 名が付かない島は、ジャンル名に戻す（AI が失敗し続けたとき）
ISLAND_RUN_PENDING_SECONDS = 60          # AI 名待ちの島があるときの追跡の間隔（通常は ISLAND_RUN_MIN_SECONDS）
ISLAND_NAMING_MIN_AUTHORS = 1      # AI で名前を付けるのは、書き手がこれ以上
ISLAND_NAMING_MIN_POSTS = 1        # かつ投稿がこれ以上の島（それ未満は一覧から選ぶ方式）
ISLAND_NAME_MAX_LENGTH = 8         # 「島」「大陸」を付ける前の最大字数
# Activity genres an island can be called when no AI name exists (the default).
# The live name is the genre closest in meaning to the island's words, instead of
# its most frequent noun. Each is short, without 島/大陸 (the map adds those), and
# at most ISLAND_NAME_MAX_LENGTH characters. Order breaks ties, so keep it stable.
ISLAND_GENRES = (
    "スポーツ", "アウトドア", "釣り", "旅", "ものづくり", "手芸", "料理", "農業",
    "園芸", "ボランティア", "子育て", "教育", "学び", "読書", "語学", "音楽",
    "アート", "写真", "映像", "映画", "ゲーム", "IT", "プログラミング", "AI",
    "起業", "ビジネス", "地域づくり", "防災", "環境", "健康", "医療", "福祉",
    "ペット", "ファッション", "美容", "グルメ", "建築", "科学", "歴史", "文章",
    "ダンス", "演劇",
)
# 追加の禁止語は環境変数 ISLAND_NAME_BLOCKLIST（カンマ区切り）。組み込みの語は core/island_namer.py。

# Q34 quiet posts (all provisional). A post with no like/help/join/comment
# between these ages is shown, in the app only, to a few people who stand
# near it and still come by. Nobody is told the post went unanswered.
# Off since 2026-10-28 (replaced by the 'resident' notice). QUIET_POST_ENABLED=1 turns it back on.
QUIET_POST_ENABLED = os.environ.get("QUIET_POST_ENABLED", "0") == "1"
QUIET_POST_MIN_HOURS = 24
QUIET_POST_MAX_DAYS = 7
QUIET_POST_NEAR_ISLANDS = 2       # besides the post's own island
QUIET_POST_PER_POST = 3
QUIET_POST_VISIT_DAYS = 14
QUIET_POST_CANDIDATES = 20        # nearest people checked for a recent visit
QUIET_POST_PER_DAY = 1            # per person told

# Web push (段6).
PUSH_FRESH_MINUTES = 10           # older rows are marked sent but not pushed
PUSH_TTL_SECONDS = 24 * 3600
PRESENCE_PING_SECONDS = 30        # the page says "on screen" this often
PRESENCE_HOLD_SECONDS = 75        # ...and each ping lasts this long


# ---------------------------------------------------------------------------
# 段5: things that make the first and the next post easier to write.
# ---------------------------------------------------------------------------

# Q37: post whenever you like, plus one gentle prompt a week. The week turns
# over on Monday 00:00 Japan time, and the list is walked in order by ISO week
# number so everybody sees the same prompt. 仮: written by Claude Code on
# 2026-10-07, to be replaced by the founder's own list.
WEEKLY_PROMPTS = (
    "最近はじめたこと",
    "今週うれしかったこと",
    "人にすすめたいお気に入り",
    "いま少し困っていること",
    "だれかと一緒にやってみたいこと",
    "週末の過ごし方",
    "最近おどろいたこと",
    "前から気になっている場所",
)
PROMPT_UTC_OFFSET_HOURS = 9

# Q40: the first post is made by choosing one of these. It is placed to show
# where it would stand and is never saved, so the map does not fill up with
# the same sentence. Three, on different topics on purpose so the tryout lands
# on different islands: 昔がんばってたこと, 最近やってること and an event (参加者募集中).
# Under them, the first post offers the extra prompts below. 仮: by Claude Code,
# 2026-10-20; cut from eight to three on 2026-10-21.
EXAMPLE_POSTS = (
    "学生のころ吹奏楽部でトランペットを吹いていました。また吹きたいな",
    "最近ボードゲームにはまっています。おすすめがあれば教えてください",
    "今度の日曜に公園で朝ランをします。ゆっくりペースで5人ほど募集中です",
)

# Extra writing prompts next to the weekly one. All of them are always offered (since 2026-10-29 a
# prompt is no longer hidden once used; the browser still hides all of them when post_extras is off);
# the weekly prompt is not one of these and keeps coming back every week.
# 2026-10-29 (chosen by the founder): 最近はまってること became 最近やってること (the key `now` and the
# saved posts do not change).
# `example` is what the body's placeholder says while the prompt is chosen
# ("例：…"), on topics none of EXAMPLE_POSTS uses. 2026-10-20; examples 2026-10-21.
# Rewritten 2026-10-27 (chosen by the founder): what the person does in concrete words (they place the
# post near the people who write alike), a touch of themselves, and an ending another person can answer
# (教えてください / 一緒に…). About 45 characters, well under the 60, and in です・ます throughout.
# Different kinds of topic, so copying one does not pile everybody onto one island.
# 2026-10-28 (chosen by the founder): 困ってること, for asking for a hand. A prompt's `tag` is ticked at
# step ③ when the prompt is chosen (and unticked when it is unchosen, unless the person has touched the
# tag since): 困ってること comes with 助けてほしい, so the card says so and 手伝えるかも is the obvious answer.
EXTRA_PROMPTS = (
    {"key": "past", "text": "昔がんばってたこと",
     "example": "学生時代はずっとバスケ部でした。運動不足なので、またゆるくボールを触れる仲間がほしいです。"},
    {"key": "now", "text": "最近やってること",
     "example": "仕事帰りにレイトショーを観ています。洋画が多めです。おすすめがあれば教えてください。"},
    {"key": "future", "text": "今度やってみたいこと",
     "example": "陶芸教室で、自分用のお皿を作ってみたいです。一人だと行きづらいので、一緒に体験しませんか。"},
    {"key": "help", "text": "困ってること", "tag": "助けてほしい",
     "example": "家庭菜園のミニトマトが、毎年うまく育ちません。くわしい方がいたら、育て方のコツを教えてください。"},
)
# The prompts offered on the first post (chips over the box). Each key is one of
# EXTRA_PROMPTS' keys, and a chosen chip is recorded as the post's `prompt` like that prompt.
# A chip puts nothing in the box: the prompt's example sentence shows as the placeholder.
POST_STARTERS = (
    {"key": "past", "text": "昔がんばってたこと"},
    {"key": "now", "text": "最近やってること"},
    {"key": "future", "text": "今度やってみたいこと"},
    {"key": "help", "text": "困ってること"},
)
# What a post's `prompt` may be: the weekly one or an extra one.
POST_PROMPT_KEYS = ("weekly",) + tuple(item["key"] for item in EXTRA_PROMPTS)
assert all(item.get("tag") in (None,) + TAGS for item in EXTRA_PROMPTS), "お題のタグが TAGS にありません"

# 「参加者募集中」 posts may carry a sign-up deadline (a Japan-time date, open until
# the end of that day) and a first-come capacity.
RECRUIT_TAG = "参加者募集中"

# 「もっと話してみたい」（仮名）: the button's name lives here and nowhere else. The screen
# reads it from /api/config (talk.label), and the push texts are built from it.
# NO romance words (the legal check depends on it).
# The notice reads 「誰かが、あなたと{label}と言っています」, so the name must end like a verb
# in the 〜たい / 〜したい form (話してみたい, 挨拶したい ...). A noun or 「気になる」 breaks the sentence.
# After renaming: run the node tests (PUSH_TEXT vs screen texts) and retake the screenshots.
TALK_LABEL = "もっと話してみたい"
# A press stays until it is withdrawn or matched. Only the anonymous talk_wish notice is
# limited: once per this many days from the same person to the same person.
TALK_NOTICE_DAYS = 14
# How many people one person can newly press per day (JST). The SQL in
# supabase/migrations/20261028020000_talk_daily_limit.sql writes the same number as a literal 20.
TALK_DAILY_PRESS_LIMIT = 20
DM_BODY_MAX = 1000
DM_ROOM_EXCERPT = 30
# The words press_talk raises (PostgREST {"message"}; local mode 4xx {"detail"}).
# A person who is not in a shared meeting and a blocked person get the SAME words.
TALK_ERROR_LOGIN = "ログインしてください。"
TALK_ERROR_SELF = "自分には押せません。"
TALK_ERROR_NOT_PEER = "この相手には押せません。"
TALK_ERROR_DAILY_LIMIT = (
    f"今日はここまでです。「{TALK_LABEL}」を押せるのは1日{TALK_DAILY_PRESS_LIMIT}人までで、"
    "明日（0時すぎ）からまた押せます。"
)
DM_ERROR_SEND = "このDMには送信できません。"
# 2026-10-31 (supabase/migrations/20261031000000_dm_reactions.sql): the reactions to a DM message,
# kept as keys (the screen turns them into emoji). Not being in the room and being blocked get the SAME words.
DM_REACTION_KINDS = ("heart", "thumbs", "laugh", "wow", "sad", "pray")
DM_ERROR_REACT = "このメッセージには反応できません。"
DM_ERROR_REACT_KIND = "その反応は使えません。"

# Communities and invite links (2026-10-26, supabase/migrations/20261026010000_communities_and_invites.sql).
# The words the database functions raise (PostgREST {"message"}; local mode 4xx {"detail"}).
INVITE_ERROR_REQUIRED = "islands は招待制です。コミュニティの招待リンクから登録してください。"
INVITE_ERROR_UNKNOWN = "招待リンクが見つかりません。管理者に新しいリンクをもらってください。"
INVITE_ERROR_REVOKED = "招待リンクは止められています。管理者に新しいリンクをもらってください。"
INVITE_ERROR_EXPIRED = "招待リンクの期限が切れています。管理者に新しいリンクをもらってください。"
INVITE_ERROR_ADMIN_ONLY = "このコミュニティの招待リンクは、管理者だけが作れます。"
INVITE_ERROR_ADMIN_ONLY_LIST = "このコミュニティの招待リンクは、管理者だけが見られます。"
INVITE_ERROR_ADMIN_ONLY_REVOKE = "この招待リンクは、管理者だけが止められます。"
INVITE_ERROR_MINUTES = "有効な時間は1分から30日の間で指定してください。"
COMMUNITY_ERROR_POST = "このコミュニティに投稿できません。"
# 承認制 (2026-11-01, A の設計 2-1)。ブラウザが直接呼ぶ DB 関数の日本語。pgTAP と pytest が同じ文を見る。
APPROVAL_ERROR_INVITE_ADMIN_ONLY = "この招待リンクの設定は、管理者だけが変えられます。"
APPROVAL_ERROR_INVITE_UNKNOWN = "招待リンクが見つかりません。"
APPROVAL_ERROR_LIST_ADMIN_ONLY = "参加の申し込みは、管理者だけが見られます。"
APPROVAL_ERROR_DECIDE_ADMIN_ONLY = "参加の申し込みは、管理者だけが決められます。"
APPROVAL_ERROR_POST_NOT_IN_COMMUNITY = "この投稿はこのコミュニティのものではありません。"
# 承認待ちの人を管理者が見る・決める。承認待ちが取り消し済みでも同じ文で扱う（'already'）。
JOIN_REQUEST_NOTIFY_HOURS = 24      # 同じ人・同じ会について管理者に知らせるのは 24 時間に 1 回まで
# 申し込み画面が claim_invite に送る「同意した規約の版」（施行日と同じ。E の 19）。
CONSENT_VERSION = "2026-11-16"
# 新しい規約・ポリシーの施行日（日本時間 0:00）。「外す」のボタンはこの日から（features.member_removal）。
MEMBER_REMOVAL_FROM = date(2026, 11, 16)
# フルネームの確認が必須になる日（同じ施行日。時計はサーバーが持つ）。
FULLNAME_REQUIRED_FROM = date(2026, 11, 16)
# 年代（accounts.age_band）。画面の選択肢と並びが同じ。
AGE_BANDS = (
    ("10s", "10代"), ("20s", "20代"), ("30s", "30代"),
    ("40s", "40代"), ("50s", "50代"), ("60s", "60代"),
)
JOB_TITLE_MAX = 32
# 名前を確かめるときに足りないもの（PUT /api/account/me の name_confirmed）。
NAME_CONFIRM_ERROR = "フルネームと所属を入力してください。"
# accounts_read を閉じたあと、見えない人の名前の代わりに出す言葉。
HIDDEN_PERSON_NAME = "（このコミュニティの外の人）"
# ほかのコミュニティにも出す (2026-10-29, supabase/migrations/20261029000000_share_group.sql).
SHARE_ERROR_OFF = "ほかのコミュニティに出す機能は、まだ使えません。"
SHARE_ERROR_NONE = "出すコミュニティを選んでください。"
SHARE_ERROR_FAILED = "ほかのコミュニティに出せませんでした。もう一度お試しください。"
SHARE_ERROR_SYNC = "ほかのコミュニティに出している同じ投稿を直せませんでした。もう一度お試しください。"
SHARE_ERROR_LONG = "60文字を超える投稿は、ほかのコミュニティに出せません。本文を60文字以内に直してから出してください。"
SHARE_COMMUNITIES_MAX = 20
# rename_community (supabase/migrations/20261026020000_rename_community.sql): 1..COMMUNITY_NAME_MAX characters after trimming.
COMMUNITY_ERROR_RENAME_ADMIN_ONLY = "このコミュニティの名前は、管理者だけが変えられます。"
COMMUNITY_ERROR_NAME = "コミュニティの名前は1〜40文字で入力してください。"
COMMUNITY_NAME_MAX = 40
# create_invite: minutes is 1..INVITE_MINUTES_MAX; until_end_of_day ends at 23:59 Japan time
# (and moves to the next day when less than INVITE_END_OF_DAY_MIN_MINUTES would be left).
INVITE_MINUTES_MAX = 43200
INVITE_END_OF_DAY_MIN_MINUTES = 10
INVITE_CODE_LENGTH = 24
# Local mode only: the community and the fixed invite code made at start-up (for tests and
# for trying the screens by hand). The code is long enough to look like a real one.
LOCAL_DEMO_COMMUNITY_NAME = "デモ"
LOCAL_DEMO_COMMUNITY_SLUG = "demo"
LOCAL_DEMO_INVITE_CODE = "demo-invite-code-local-0001"
# How long the server trusts what it read from app_settings (invite_only).
INVITE_ONLY_CACHE_SECONDS = 60
# Members-only posts (app_settings.members_only): a post of a community is read by that community's
# members only. The server reads the switch at most this often, and a change reaches every
# instance within it.
MEMBERS_ONLY_CACHE_SECONDS = 15
# ONE sentence for "no such post", "a post of another community" and "you are not a member":
# the three must never be told apart (no existence leak).
MEMBERS_ONLY_NOT_FOUND = "見つかりませんでした。"
MEMBERS_ONLY_UNAVAILABLE = "現在、確認できません。しばらくしてからお試しください。"
MEMBERS_ONLY_COMMUNITY_REQUIRED = "コミュニティを指定してください。"
RECRUIT_CAPACITY_MIN = 1
RECRUIT_CAPACITY_MAX = 999
RECRUIT_DEADLINE_MAX_DAYS = 365  # at most a year from today
# How far (map units) the nearest saved post may be for the tryout to count as
# standing on that post's island. 仮: about one landmass radius at 50 energy.
PREVIEW_ISLAND_RADIUS = 40.0
PREVIEW_NEIGHBORS = 3


# ---------------------------------------------------------------------------
# Match cards (2026-10-29): after a post, up to MATCH_LIMIT people whose post connects to it
# (GET /api/matches). Cosines are the 448-dim centred ones, never the 似てる度 percent. PROVISIONAL:
# measured on 32 short sentences (10/27: at 0.40 the complementary pairs let 1 wrong pair of about
# 270 through) and on 21 real posts (10/28: 0 wrong at 0.40). Real posts are longer and messier,
# so these lean towards showing fewer lines.
# ---------------------------------------------------------------------------
MATCH_LIMIT = 3
# need/have, want/have and the like: the two posts complete each other, so the bar is lower.
MATCH_COSINE_COMPLEMENT = 0.40
# want/want, have/have, need/want and "close in words only": the same side of the table,
# which also scores high across topics (need x need did even at 0.365 on average), so higher.
MATCH_COSINE_SAME = 0.45
# How many nearest posts are looked at before the filters.
MATCH_CANDIDATES = 15

# ---------------------------------------------------------------------------
# Match notices (2026-10-29): a new post P (author A) that connects to an older post Q (author B)
# tells B ('match' notification, at most MATCH_LIMIT per new post). No per-day limit (the founder's
# decision): only "one row per P and B". The push goes out at once, one per row, like any other
# notification (the founder's decision, 10/29 evening: a 5-minute bundle needed a timer that is lost
# while Cloud Run sleeps, so a push could be late or never come).
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# 会（イベント申し込み）2026-11-01 第2回a。設計は設計_イベント申し込み/D_関数の取り決め.md。
# DB 関数（supabase/migrations/20261106000000_events.sql）と同じ数字・同じ文。
# ---------------------------------------------------------------------------
EVENT_TITLE_MAX = 40
EVENT_PLACE_MAX = 60
EVENT_QUESTIONS_MAX = 3                     # 11/1 決定：now・past・future の最大3問
EVENT_QUESTION_PROMPTS = ("now", "past", "future")
EVENT_QUESTION_LABEL_MAX = 40
EVENT_QUESTION_HINT_MAX = 60
EVENT_ANSWERS_MIN = 2                       # メンバーでない人が申し込むとき答える最少数
EVENT_ANSWER_MAX = 60
REFERRAL_MAX = 40
# きっかけの選択肢（仮。画面イメージで確かめる。自由入力も40字まで受ける）
REFERRAL_CHOICES = ("友だちに聞いた", "SNSで見た", "主催者に誘われた", "その他")
LATE_CHOICES = (10, 30, 60)
CHECKIN_OPENS_BEFORE_HOURS = 3
CHECKIN_CLOSES_AFTER_HOURS = 2
EVENT_CLEANUP_DAYS = 7                      # 会の終了からこの日数で、受付していない申し込みと予約を消す
EVENT_REMIND_WEEK_DAYS = 7                  # week_before = 開始の7日前の同じ時刻
EVENT_REMIND_DAY_HOURS = 3                  # day_of = 開始の3時間前
OUTBOUND_MAX_ATTEMPTS = 5
OUTBOUND_STALE_HOURS = 24                   # 予定からこれ以上たった予約は取り出さない
OUTBOUND_LEASE_SECONDS = 300
OUTBOUND_BATCH = 50
OUTBOUND_KINDS = ("applied", "week_before", "day_of", "after", "declined", "event_cancelled", "event_changed")
LINE_WEBHOOK_KEEP_DAYS = 30                 # E の 4
LINE_API_BASE = "https://api.line.me"
LINE_DATA_API_BASE = "https://api-data.line.me"
LINE_TIMEOUT_SECONDS = 10.0
LINE_WEBHOOK_MAX_BYTES = 1_000_000
LINE_TEXT_LIMIT = 160                       # buttons テンプレートの本文の上限
BREAKDOWN_MIN_COUNT = 3                     # 内訳は2人以下を「ほか」に（E の 8）
BREAKDOWN_OTHER = "ほか"
PUBLIC_EVENT_CACHE_SECONDS = 60
WALKIN_REJECT_MAX = 3
# probe（近い人が来るか見てみる）
PROBE_INTERESTS_MAX = 2
PROBE_INTEREST_LENGTH = 30
PROBE_PER_DEVICE_PER_DAY = 5                # 同じ cookie・同じ IP から1つの会につき1日
PROBE_PER_EVENT_PER_DAY = 300               # 会全体で1日
PROBE_COSINE = 0.40                         # 仮：興味の文と回答の中心化コサインがこれ以上なら「近い」
PROBE_COOKIE = "islands_probe"
PROBE_FEW_MAX = 2                           # 1〜2人は「少し」、3人以上は数字（E の 8）
EVENT_STATUSES = ("applied", "attended", "cancelled", "declined", "waiting")
EVENT_LIVE_STATUSES = ("applied", "waiting", "attended")
# 開催の条件・会のあとの入り方（2026-11-11 第2回b。設計 G）
EVENT_MIN_PARTICIPANTS = (2, 1000)          # 最小開催人数の範囲（上は定員まで）
EVENT_JOIN_POLICIES = ("auto", "ask", "none")   # 受付で自動加入／本人に確認／加入させない
EVENT_JOIN_POLICY_DEFAULT = "ask"           # 新しい会の初期値（SQL より前の会は auto）
EVENT_PARTICIPANTS_CACHE_SECONDS = 60
# 参加者リストの「近い人」（回答どうしの中心化コサイン。仮：会で試して直す）
EVENT_NEAR_HIGH = 0.55
EVENT_NEAR_MID = 0.45
EVENT_NEAR_LOW = 0.30                       # これより下は near なし
EVENT_NEAR_TOP = 3
EVENT_B_OFF_ERROR = "会の新しい機能は、まだ使えません。"

# エラーコード（hint）→ HTTP の番号と日本語の文。D の 1-2。DB 関数・MemoryStore・API が同じ文を使う。
EVENT_ERROR_TEXT = {
    "not_logged_in": "ログインしてください。",
    "event_not_found": "この会は見つかりません。",
    "event_cancelled": "この会は中止になりました。",
    "event_banned": "このコミュニティの会には申し込めません。",
    "event_members_only": "この会は、コミュニティのメンバーだけが申し込めます。",
    "event_not_host": "この会の主催者だけが行えます。",
    "event_attended": "受付のあとは、取り消せません。",
    "event_not_applied": "この会に申し込んでいません。",
    "checkin_closed": "受付の時間ではありません。",
    "checkin_cancelled_reg": "申し込みを取り消しているため、受付できません。主催者に声をかけてください。",
    "walkin_limit": "受付待ちのやり直しは3回までです。主催者に声をかけてください。",
    "not_waiting": "この人は受付待ちではありません。",
    "capacity_below_joins": "先着人数は、いまの申し込みの人数より少なくできません。",
    "answers_required": "質問は2つ以上答えてください。",
    "name_required": "フルネームと所属を入力してください。",
    "public_admin_only": "公開の会は、コミュニティの管理者だけが作れます。",
    "probe_limit": "今日はここまでです。",
    "recruit_closed": "申し込みの期限が過ぎています。",
    "recruit_full": "先着人数に達しています。",
    "event_use_apply": "会への参加は、申し込みから行ってください。",
    "event_invalid": "会の内容を確かめてください。",
    "terms_required": "新しい利用規約とプライバシーポリシーに同意してください。",
    # 第2回b（設計 G）
    "event_not_held": "人数が集まらなかったため、この会は中止になりました。",
    "cancel_closed": "キャンセルの期限を過ぎました。期限後のキャンセルは主催者に連絡してください。",
    "event_decided": "開催の判定が出たあとは、最小開催人数と判定日を変えられません。",
    "join_not_allowed": "この会からは、コミュニティに参加できません。",
    "event_not_attended": "受付が済んだ人だけが使えます。",
    "participants_forbidden": "この会は見つかりません。",
}
EVENT_STATUS_OF = {
    "not_logged_in": 401, "event_not_found": 404, "event_cancelled": 409, "event_banned": 403,
    "event_members_only": 403, "event_not_host": 403, "event_attended": 409, "event_not_applied": 409,
    "checkin_closed": 409, "checkin_cancelled_reg": 409, "walkin_limit": 429, "not_waiting": 409,
    "capacity_below_joins": 422, "answers_required": 422, "name_required": 422,
    "public_admin_only": 403, "probe_limit": 429, "recruit_closed": 409, "recruit_full": 409,
    "event_use_apply": 403, "event_invalid": 422, "terms_required": 422,
    "event_not_held": 409, "cancel_closed": 409, "event_decided": 409, "join_not_allowed": 409,
    "event_not_attended": 403, "participants_forbidden": 404,
}
EVENT_SHARE_ERROR = "会の投稿は、ほかのコミュニティに出せません。"
EVENT_CAPACITY_ERROR = EVENT_ERROR_TEXT["capacity_below_joins"]

# ---------------------------------------------------------------------------
# 利用規約・プライバシーポリシーの改定 (2026-11-16 施行)
# 施行の前は今の文 (web/terms.html・privacy.html)、施行のあとは新しい文 (*-next.html) を /terms・/privacy
# が返す。お知らせの帯 (/api/config の notice) は START から END まで。日付はどれも日本時間。
# ---------------------------------------------------------------------------
POLICY_REVISION_ID = "policy-20261116"
POLICY_REVISION_EFFECTIVE = "2026-11-16T00:00:00+09:00"
POLICY_NOTICE_START = "2026-11-02T00:00:00+09:00"
POLICY_NOTICE_END = "2026-11-30T23:59:59+09:00"
POLICY_NOTICE_BEFORE = ("11月16日から利用規約とプライバシーポリシーが変わります"
                        "（フルネームでの登録・承認つきの招待・会の申し込みなど）")
POLICY_NOTICE_AFTER = "11月16日から新しい利用規約とプライバシーポリシーになりました"

# 地図B案（1コミュニティ＝1つの大きな島。外形は固定、島は16の「地方」に分かれ、
# 今の「重なりの島」は地方の中の小さなまとまり「開拓村」になる）。既定はオン。
# 環境変数 MAP_B_ENABLED=0 で止められる（止めると今までと完全に同じ動き。止めても ?map=b の試し見は使える）。
MAP_B_ENABLED = os.environ.get("MAP_B_ENABLED", "1") == "1"
# 投稿のない所の森の描き方："mass"（ひとかたまり、既定）か "grove"（木立）。
MAP_B_FOREST = os.environ.get("MAP_B_FOREST", "mass")
# 地方16の中心点と名前：(番号, 中心x, 中心y, 名前)。座標は本番 v7 のお手本を地図上で
# k-means 16 に分けた中心。名前は「短い言葉＋地名」（ユーザーの決定 2026-11-04。地図には水を
# 描かないので湖・渓谷は使わない）。右のコメントはもとの話題。変えるのはこの表だけ。
MAP_B_REGIONS = (
    (0, 732.0, 192.4, "草花の岬"),   # 生きもの・園芸
    (1, 289.6, 868.4, "音楽高原"),   # 音楽
    (2, 489.1, 514.0, "まちの平原"),   # 地域活動
    (3, 215.8, 278.3, "ものづくり谷"),   # 工作・DIY
    (4, 700.7, 734.5, "からだの丘"),   # 運動・健康
    (5, 858.3, 361.3, "食の森"),   # 料理・お酒
    (6, 318.4, 590.6, "物語の小道"),   # 本・映画・語学
    (7, 457.2, 684.8, "家族の里"),   # 子育て・介護
    (8, 356.1, 329.6, "創作の台地"),   # 絵・創作
    (9, 850.7, 554.4, "アウトドアの森"),   # アウトドア
    (10, 561.5, 889.2, "スポーツの浜"),   # スポーツ
    (11, 580.9, 325.4, "写真の高台"),   # 写真・美術
    (12, 400.0, 146.3, "暮らしの野原"),   # 手芸・暮らし
    (13, 695.1, 483.1, "旅の街道"),   # 旅行
    (14, 175.0, 471.6, "しごとの峠"),   # IT・仕事
    (15, 159.6, 712.2, "あそびの入り江"),   # ゲーム
)
