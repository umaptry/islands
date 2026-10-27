"""Japanese stop words tuned for free-text self-introductions.

Ported from pokeDB's GENERAL_STOP_WORDS with the Pokedex-specific entries
removed (ポケモン, 進化, 生息, 習性, 大昔, 見張る, ...) and self-introduction
filler added. The purpose is unchanged: strip words that appear everywhere and
therefore carry no signal about who a person is.

Deliberately kept from pokeDB: 好き / 嫌い / 得意 / 苦手. In a profile corpus
these are near-universal, so they would pull unrelated people together.
"""

GENERAL_STOP_WORDS = {
    # --- generic nouns (from pokeDB, domain-neutral half) ---
    "自分", "相手", "場合", "存在", "確認", "記録", "時間", "瞬間",
    "以内", "以上", "以下", "全体", "部分", "周囲", "近く", "遠く", "世界", "一番",
    "発見", "場所", "仲間", "性格", "普段", "特徴", "様子", "状態", "理由", "原因",
    "方法", "変化", "効果", "安心", "大変", "自由", "危険", "注意", "関係",
    "種類", "情報", "調査", "研究", "現在", "当時", "以前", "最初", "最後", "中心",
    "能力", "行動", "生活", "誕生", "最高", "特殊", "普通", "可能", "必要",
    "姿", "体", "気持ち", "詳細", "説明", "地域",

    # --- generic verbs / adjectives (from pokeDB) ---
    "見る", "見える", "出す", "なる", "持つ", "使う", "大きい", "小さい",
    "強い", "弱い", "高い", "低い", "深い", "浅い", "重い", "軽い",
    "いる", "ある", "する", "れる", "られる", "やる", "いう", "くる", "いく",
    "動く", "歩く", "立つ", "居る", "有る", "為る", "成る", "出来る",
    "言う", "呼ぶ", "作る", "取る", "付く", "入る", "出る",
    "分かる", "知る", "思う", "考える", "できる",
    "好き", "嫌い", "得意", "不得意", "苦手",

    # --- function words / demonstratives (from pokeDB) ---
    "キロ", "メートル", "時速", "毎日", "いつも", "すべて", "前", "後", "上", "下",
    "中", "外", "間", "内", "もの", "こと", "よう", "ため", "ところ", "とき", "たち",
    "これ", "それ", "その", "この", "あの", "どの", "また", "そして", "という",

    # --- self-introduction filler (new for this project) ---
    "自己", "紹介", "自己紹介", "趣味", "特技", "最近", "今度", "今後", "将来", "昔",
    "今", "現", "当", "新しい", "古い", "若い",
    "学生", "社会人", "会社", "仕事", "休日", "週末", "平日", "年", "月", "日",
    "結構", "ちょっと", "いろいろ", "色々", "たまに", "よく", "ずっと", "そろそろ",
    "やつ", "感じ", "興味", "関心", "経験", "予定", "目標", "夢",
    "挑戦", "頑張る", "始める", "続ける", "やってみる", "はまる", "ハマる",
    "楽しい", "面白い", "嬉しい", "難しい", "簡単", "大切", "大事",
    "みたい", "ほう", "方", "人", "自身", "うち", "そのうち",

    # --- narrative glue -------------------------------------------------
    # Words that describe HOW someone talks about an interest rather than WHAT
    # the interest is. A smoke-test build named its islands 教える貰う /
    # 機嫌良い / 費やす数える - every label came from the sentence frame and
    # none from the subject matter. These are the frames.
    "教える", "貰う", "もらう", "変わる", "離れる", "遣る", "費やす", "数える",
    "増やす", "減らす", "語る", "止まる", "伸ばす", "広がる", "入り口", "入口",
    "悩み", "種", "機嫌", "大体", "夢中", "のめり込む", "気付く", "気づく",
    "過ごす", "心地よい", "旨い", "緩い", "ゆるい", "手", "世界", "話",
    "終わる", "済む", "残る", "戻る", "向く", "変える", "覚える", "習う",
    "数年", "両方", "二つ", "一つ", "次", "気", "口",
    "無い", "良い", "心地良い", "仕舞う", "付け", "多い", "少ない",
    # Surfaced by a real build: three islands were named 流す/汗, 自家製/作り and
    # 日々/目指す while their actual content was サウナ, コーヒー and 習慣.
    "日々", "目指す", "成長", "流す", "楽しむ", "作り", "現在形", "以来", "頃", "ころ",
}

# The two sets below are read only by maps built with preprocessing "-v2" (2026-10-28):
# core.features.use_preprocessing. A map keeps the stop words it was built with, so
# older maps place posts exactly as before.
#
# Words that say HOW or WHEN somebody does a thing rather than WHAT it is: looking for
# somebody (探しています / 撮ってくれる人), an invitation (一緒に / 初心者歓迎 / 会を開きます),
# when (学生時代 / 毎朝 / 今年 / 身につけたい) and how it felt (悩んでいます / 楽しみ). They
# are shared with posts on every other topic in the same stance and pulled such posts
# together. Picked from the 15,579 seed texts: words spread evenly over all eight regions
# and over-represented in one kind of variant (scripts/seed_variants.jsonl). Measured on
# the v6 layout, these against the "-v1" stop words: of 32 test posts (8 topics x やった /
# やってる / やりたい / 探してる, scripts/probe_stances.jsonl) a post's three nearest in
# another topic but the same stance went 20 -> 4 of 96, 「町内のお祭りで料理を作ってくれる人を
# 探しています」 landed 74 from the other cooking posts instead of 434, and an invitation
# variant's ten nearest held another region's invitation 15.9% -> 4.2% of the time. The
# map did not lose its topics for it: the labelled probes' nearest on the same topic went
# 0.87 -> 0.93 (on the map 0.71 -> 0.74), the placement gate 0.91 -> 0.95 at k=15.
# Normalised forms (Sudachi's), as they are looked up.
STANCE_STOP_WORDS = frozenset({
    # looking for somebody, asking
    "探す", "呉れる", "下さる", "欲しい", "頼む", "願う", "御願い", "求める", "手伝う",
    "見付ける", "御勧め",
    # an invitation
    "募集", "募集中", "歓迎", "初心者", "経験者", "参加", "参加者", "一緒", "集まる", "集まり",
    "開く", "開催", "会", "共有", "交換", "持ち寄る", "持ち寄り", "持参", "語り合う", "教え合う",
    "見せ合う", "相談", "話す", "日時", "後日", "お知らせ", "OK", "交流会", "体験会",
    # when, and how far along
    "学生時代", "時代", "時期", "懐かしい", "思い出す", "思い出", "去年", "今年", "来年", "今月",
    "来月", "毎年", "毎月", "毎週", "毎朝", "毎晩", "毎回", "今日", "いま", "最中", "半年", "一度",
    "何度", "久し振り", "再開", "日課", "習慣", "準備", "進める", "向ける", "身", "つける", "付ける",
    "憧れる", "極める", "上達", "磨く", "試す",
    # how it felt
    "悩む", "迷う", "困る", "不安", "驚く", "感動", "楽しみ", "怖い", "心配", "凄い", "本当",
    "結局", "実感", "びっくり", "忘れる", "感じる",
})

# Entries of GENERAL_STOP_WORDS that never matched: Sudachi hands over its normalised
# form (くる -> 来る, ハマる -> 嵌まる, ため -> 為) and that is what is looked up.
NORMALISED_STOP_WORDS = frozenset({
    "行く", "来る", "為", "時", "所", "嵌まる", "物", "此の", "此れ", "全て", "其の", "其れ",
    "偶に", "一寸", "又", "奴", "良く", "遠い",
})

# Fine inside a document vector, but not worth SHOWING a reader - as an island
# heading or as a shared keyword. Changing this set never moves a coordinate.
LABEL_ONLY_STOP_WORDS = {
    "物", "人", "人間", "時", "為", "系", "的", "用", "中",
    "一緒", "一人", "感", "心", "身体", "問題",
}


# Fragments and filler that survive tokenisation and would otherwise be offered
# as a "shared word". Same idea as LABEL_ONLY_STOP_WORDS, and equally safe to
# edit: neither set touches the vectors.
DISPLAY_STOP_WORDS = LABEL_ONLY_STOP_WORDS | {
    "なし", "そのまま", "一度", "旧", "会", "朝", "夜", "毎朝", "毎晩",
    "自宅", "部分", "以外", "程度", "本当", "自体",
    # Counters and time-filler. These started showing up as island headings
    # once names were built from live posts: 「何個 / 湯飲み」 says nothing
    # about the place that 「湯飲み」 alone does not.
    "何個", "何本", "何度", "一日", "休み", "時間",
    # Calendar words. A post that says "来年こそ税理士試験に" got named
    # 「来年 / 税理士島」 - 来年 is when, not what, and the island is about the
    # 税理士 half. Same argument as the counters above.
    "来年", "今年", "去年", "毎年", "今度", "最近", "将来", "今後", "当時", "学生時代",
    # 「来週 / 海馬島」 reached production the same way 来年 once did.
    "来週", "今週", "先週", "来月", "今月", "先月", "今日", "明日", "昨日", "週末", "今回", "前回",
}
