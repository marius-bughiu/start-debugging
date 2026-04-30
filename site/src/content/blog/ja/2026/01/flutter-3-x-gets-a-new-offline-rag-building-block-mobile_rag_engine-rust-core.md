---
title: "Flutter 3.x に新しい「オフライン RAG」のビルディングブロック: `mobile_rag_engine` (Rust コア)"
description: "mobile_rag_engine は Rust コア、ONNX 埋め込み、HNSW ベクトル検索、SQLite ストレージを備え、オンデバイス RAG を Flutter にもたらします。API、統合フロー、出荷上の制約を実用的に見ていきます。"
pubDate: 2026-01-10
tags:
  - "dart"
  - "flutter"
lang: "ja"
translationOf: "2026/01/flutter-3-x-gets-a-new-offline-rag-building-block-mobile_rag_engine-rust-core"
translatedBy: "claude"
translationDate: 2026-04-30
---
オンデバイス RAG が Flutter 界隈で、デモだけでなく実際に出荷できる形として登場しつつあります。`mobile_rag_engine` は数日前に pub.dev で公開され、適切な意味で意見を持っています。重い処理は Rust コアが担当し、統合は Flutter API、そして試すだけのために Rust や Cargo、Android NDK をセットアップしないで済むよう、ビルド済みバイナリも用意されています。

ユーザーデータをサーバーに送らずにアプリ内でセマンティック検索を実現したかったなら、これは研究すべき形です。

## 何を提供してくれるか (実用的な観点で)

このパッケージは完全にローカルな RAG エンジンとして自身を位置付けています。

-   埋め込み (ONNX Runtime 経由)
-   高速な近傍探索のための HNSW ベクトル検索
-   ドキュメントとメタデータのための SQLite ベースのストレージ
-   HuggingFace のトークナイザによるトークン化 (Rust 経由)

モデルの出荷は依然として必要です。違いは、出荷さえしてしまえば検索ループはローカルで予測可能だという点です。

## 最小限のエンドツーエンドフロー (ドキュメント追加、インデックス構築、検索)

README のクイックスタートは、すでに実アプリで欲しい形に近いです。Flutter 3.x 向けに「モデルのバイト列」のステップを明示化した適合版を示します。

```dart
import 'dart:typed_data';
import 'package:flutter/services.dart';
import 'package:mobile_rag_engine/mobile_rag_engine.dart';

Future<Uint8List> loadModelBytes(String assetPath) async {
  final data = await rootBundle.load(assetPath);
  return data.buffer.asUint8List();
}

Future<void> main() async {
  const dbPath = 'rag.sqlite';

  await RustLib.init(
    externalLibrary: ExternalLibrary.process(iKnowHowToUseIt: true),
  );

  await initTokenizer(tokenizerPath: 'assets/tokenizer.json');

  final modelBytes = await loadModelBytes('assets/model.onnx');
  await EmbeddingService.init(modelBytes);

  final docEmbedding = await EmbeddingService.embed('Flutter is a UI toolkit.');
  await addDocument(
    dbPath: dbPath,
    content: 'Flutter is a UI toolkit.',
    embedding: docEmbedding,
  );

  await rebuildHnswIndex(dbPath: dbPath);

  final queryEmbedding = await EmbeddingService.embed('What is Flutter?');
  final results = await searchSimilar(
    dbPath: dbPath,
    queryEmbedding: queryEmbedding,
    topK: 5,
  );

  print(results.first);
}
```

これが「オフライン知識ベース」機能に必要な中心ループです。ヘルプセンター検索、個人メモ、端末に同期される企業ドキュメント、そして「ユーザーテキストをバックエンドに送る」が成立しないあらゆるアプリに使えます。

## あらかじめ考えておくべき出荷上の制約

### モデルサイズはプロダクトデザイン

INT8 モデルでもサイズが大きくなり得ます。モデルをアプリバンドルに同梱するか、初回起動時にダウンロードするか、プラットフォーム固有のアセット配信を使うかを決めてください。

### 初期化コストとウォームパス

埋め込み生成が高価なステップです。UI はそれに対して正直であるべきです。バックグラウンド索引付け、進捗表示、キャッシュです。検索ステップ (HNSW 検索) は比較的安価なのが普通です。

正準的な参照先が欲しい場合。

-   pub.dev: [https://pub.dev/packages/mobile_rag_engine](https://pub.dev/packages/mobile_rag_engine)
-   GitHub: [https://github.com/dev07060/mobile_rag_engine](https://github.com/dev07060/mobile_rag_engine)
