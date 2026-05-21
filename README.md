# MoodleFuck

Chrome 拡張で Moodle の穴埋め/選択問題のヒント生成を支援するツールです。  
現在は複数API（OpenRouter / Gemini / OpenAI / CAPI）に対応しています。

## 現在の動作（2026-05 時点）

### 1. モデル選択とフォールバック

- デフォルトの優先順は `OpenRouter -> Gemini`。
- OpenRouter ではまず `openai/gpt-oss-120b:free` を優先して使用。
- 無料モデルが失敗した場合は Gemini 側へフォールバック。
- 無料モデルの試行回数は最大 3 回に制限（待ち時間短縮のため）。
- 実際に使われた `Provider` / `Model` はヒントパネルに表示。

### 2. OpenRouter の制限考慮

- `GET https://openrouter.ai/api/v1/key` を参照してキー情報を取得。
- レート制限は OpenRouter 公式 Limits に準拠して扱う。
- `:free` モデル利用時は、無料枠エラー（例: `free-models-per-min`, `free-models-per-day`, `402`）を検知して次の候補へ進む。

参考: https://openrouter.ai/docs/api/reference/limits

### 3. 資料優先モード（Material Mode）

- PDF / テキスト資料を popup から投入可能。
- 問題文に関連する断片を抽出し、回答生成時に優先参照。
- 資料モード有効時は精度寄りのプロンプトに切替。

### 4. UI/UX

- ヒントパネルに `Retry` ボタンあり（その問題だけ再実行）。
- ステータスウィジェット表示/非表示切替あり。
- API プロバイダは複数選択・優先順位入れ替え可能。

## 対応プロバイダ

- OpenRouter（APIキー必要）
- Gemini（APIキー必要）
- OpenAI（APIキー必要）
- CAPI `https://capi.voids.top/v2`（キー不要設定だが、状況により 401/404 の可能性あり）

## ファイル構成

```text
moodle-fuck/
├─ manifest.json
├─ background.js
├─ content.js
├─ popup.html
├─ popup.js
├─ icon.png
└─ data/
```

## セットアップ

1. `chrome://extensions/` を開く
2. デベロッパーモードを ON
3. 「パッケージ化されていない拡張機能を読み込む」でこのフォルダを選択
4. 拡張 popup を開き、使うプロバイダと API キーを設定

## 注意

- 本ツールは学習補助用途を想定しています。利用規約や授業ルールに従って利用してください。
- 外部APIへの送信が発生するため、機微情報の取り扱いには注意してください。
