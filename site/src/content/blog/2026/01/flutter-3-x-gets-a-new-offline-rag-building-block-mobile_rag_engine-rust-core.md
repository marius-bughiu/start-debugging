---
title: "Flutter 3.x gets a new “offline RAG” building block: `mobile_rag_engine` (Rust core)"
description: "mobile_rag_engine brings on-device RAG to Flutter with a Rust core, ONNX embeddings, HNSW vector search, and SQLite storage. A practical look at the API, integration flow, and shipping constraints."
pubDate: 2026-01-10
tags:
  - "dart"
  - "flutter"
---
On-device RAG is showing up in Flutter land as something you can actually ship, not just demo. `mobile_rag_engine` was published on pub.dev just the other day and it’s opinionated in the right way: a Rust core for the heavy lifting, a Flutter API for integration, and prebuilt binaries so you do not set up Rust, Cargo, or the Android NDK just to try it.

If you’ve wanted semantic search inside an app without sending user data to a server, this is the shape you want to study.

## What it gives you (in practical terms)

The package positions itself as a fully local RAG engine:

-   Embeddings (via ONNX Runtime)
-   HNSW vector search for fast nearest-neighbor queries
-   SQLite-backed storage for documents and metadata
-   Tokenization via HuggingFace tokenizers (through Rust)

You still have to ship a model. The difference is that once you do, the retrieval loop is local and predictable.

## A tiny end-to-end flow (add docs, build index, search)

The README’s quick start is already close to what you want in a real app. Here’s an adapted version that makes the “model bytes” step explicit for Flutter 3.x:

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

That’s the core loop you need for “offline knowledge base” features: help center search, personal notes, enterprise docs synced to device, and any app where “send user text to a backend” is a non-starter.

## Shipping constraints you should think about up front

### Model size is product design

Even INT8 models can be large. Decide whether you ship the model in the app bundle, download it on first run, or use platform-specific asset delivery.

### Initialization cost and warm path

Embedding generation is the expensive step. Your UI should be honest about it: background indexing, progress, and caching. The retrieval step (HNSW search) is usually cheap by comparison.

If you want the canonical references:

-   pub.dev: [https://pub.dev/packages/mobile_rag_engine](https://pub.dev/packages/mobile_rag_engine)
-   GitHub: [https://github.com/dev07060/mobile_rag_engine](https://github.com/dev07060/mobile_rag_engine)
