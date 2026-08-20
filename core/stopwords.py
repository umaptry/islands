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
}
