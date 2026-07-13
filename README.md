# MoodleFuck

Chrome 拡張で Moodle の穴埋め/選択問題のヒント生成を支援するツールです。  
現在は複数API（OpenRouter / Gemini / OpenAI / CAPI）に対応しています。

## 現在の動作（2026-05 時点）

### 1. モデル選択とフォールバック

- デフォルトの優先順は `OpenRouter -> Gemini`。
- OpenRouter では Gemini 系モデルを最初から使用（`google/gemini-2.5-flash-lite` -> `google/gemini-2.5-flash` -> `google/gemini-2.0-flash-001` -> `google/gemini-2.0-flash-lite-001`）。
- Free API Mode が ON の場合は、OpenRouter の `:free` モデルを先に試してから Gemini 系モデルへフォールバック。
- Detailed Mode / 資料優先モードでは `google/gemini-2.5-pro` -> `google/gemini-2.5-flash` -> `google/gemini-2.5-flash-lite` の順で使用。
- OpenRouter が失敗した場合は、設定されていれば Gemini API 側へフォールバック。
- Provider の優先順位は popup の並び順を尊重。Gemini API が quota / 残高なし系で失敗した場合は、Gemini の残りモデルを飛ばして次の provider へ進む。
- 複数問検出時もAI API呼び出しは最大2本までに抑え、詰まったリクエストは15秒で切る。
- 実際に使われた `Provider` / `Model` はヒントパネルに表示。

### 2. OpenRouter の制限考慮

- 現在のデフォルトは OpenRouter の有料/通常 Gemini モデルなので、無料枠チェックは通常スキップ。
- レート制限は OpenRouter 公式 Limits に準拠して扱う。
- `:free` モデル利用時のみ、無料枠エラー（例: `free-models-per-min`, `free-models-per-day`, `402`）を検知して次の候補へ進む。

参考: https://openrouter.ai/docs/api/reference/limits

### 3. 資料優先モード（Material Mode）

- PDF / テキスト資料を popup から投入可能。
- 問題文に関連する断片を抽出し、回答生成時に優先参照。
- 資料モード有効時は精度寄りのプロンプトに切替。

### 4. 画像付き問題への対応

- 問題文（`.qtext` / `.formulation`）内の `<img>` を検出し、base64 化して AI に添付。
- 画像がある問題では vision 非対応モデル（`gpt-oss` / `qwen3-coder` / `deepseek` 系）を自動でスキップし、Gemini など vision 対応モデルへ。
- 1 問あたり最大 4 枚、6MB まで。32px 未満のアイコン類は除外。
- 画像の取得結果はキャッシュされ、同じ画像を何度も取得しない（失敗時は次回スキャンで再試行）。
- 標準モードでは Gemini 2.5 Flash の thinking を無効化して空応答を防止（詳細モード・画像付き問題では thinking を許可）。

### 5. UI/UX

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
