# 電子公文書 PDF変換システム

XML/XSLファイルをブラウザでプレビュー・PDF変換するシンプルなWebアプリケーション

## 🌐 公開URL

https://ksktkhs.github.io/e-govXLSTtoPDF/

## ✨ 機能

- **ドラッグ&ドロップ対応**: ファイル・フォルダ・ZIPを直接ドロップ
- **ZIP自動展開**: ブラウザ内でZIPファイルを自動展開
- **自動ペアリング**: ファイル名でXMLとXSLを自動マッチング
- **リアルタイムプレビュー**: クリックするだけで即座にプレビュー
- **PDF保存**: ブラウザの印刷機能で簡単PDF化
- **2分割UI**: リサイズ可能なパネルレイアウト

## 🚀 使い方

1. ファイル・フォルダ・ZIPをドラッグ&ドロップ
2. 左側の一覧からファイルをクリック
3. 右側にプレビューが表示されます
4. 「PDFとして保存」ボタンで印刷ダイアログを開く
5. 「PDFに保存」を選択して保存

## 📁 ファイル構成

```
.
├── index.html    # メインHTML（GitHubPages用）
├── viewer.js     # アプリケーションロジック
├── favicon.ico   # ファビコン
├── icons/        # アイコン画像
└── README.md     # このファイル
```

## 🛠️ 技術スタック

- **Vanilla JavaScript**: フレームワーク不要のシンプル実装
- **DecompressionStream API**: ブラウザネイティブのZIP展開
- **XSLT Processor**: XML/XSL変換
- **Print CSS**: 印刷最適化

## 📝 特徴

- フレームワーク不要（依存関係なし）
- ブラウザだけで動作
- オフライン対応可能
- 軽量（約50KB）
- レスポンシブデザイン

## 📄 ライセンス

MIT License

## 👤 作成者

Created by AI Assistant
