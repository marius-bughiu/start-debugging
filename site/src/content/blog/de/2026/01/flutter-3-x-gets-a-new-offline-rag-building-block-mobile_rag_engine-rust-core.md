---
title: "Flutter 3.x bekommt einen neuen \"Offline-RAG\"-Baustein: `mobile_rag_engine` (Rust-Kern)"
description: "mobile_rag_engine bringt RAG direkt aufs Gerät in Flutter mit einem Rust-Kern, ONNX-Embeddings, HNSW-Vektorsuche und SQLite-Speicher. Ein praktischer Blick auf die API, den Integrationsablauf und die Auslieferungseinschränkungen."
pubDate: 2026-01-10
tags:
  - "dart"
  - "flutter"
lang: "de"
translationOf: "2026/01/flutter-3-x-gets-a-new-offline-rag-building-block-mobile_rag_engine-rust-core"
translatedBy: "claude"
translationDate: 2026-04-30
---
RAG direkt auf dem Gerät taucht im Flutter-Land als etwas auf, das man tatsächlich ausliefern und nicht nur demonstrieren kann. `mobile_rag_engine` wurde vor wenigen Tagen auf pub.dev veröffentlicht und hat in der richtigen Weise klare Meinungen: ein Rust-Kern für die schwere Arbeit, eine Flutter-API für die Integration und vorab gebaute Binaries, sodass Sie weder Rust, Cargo noch das Android NDK einrichten müssen, nur um es auszuprobieren.

Falls Sie semantische Suche innerhalb einer App haben wollten, ohne Benutzerdaten an einen Server zu senden, ist das die Form, die Sie sich anschauen sollten.

## Was es Ihnen liefert (in praktischen Begriffen)

Das Paket positioniert sich als vollständig lokale RAG-Engine:

-   Embeddings (via ONNX Runtime)
-   HNSW-Vektorsuche für schnelle Nearest-Neighbor-Anfragen
-   SQLite-gestützter Speicher für Dokumente und Metadaten
-   Tokenisierung über HuggingFace-Tokenizer (durch Rust)

Sie müssen weiterhin ein Modell ausliefern. Der Unterschied: Sobald Sie das tun, ist die Retrieval-Schleife lokal und vorhersagbar.

## Ein winziger End-to-End-Fluss (Dokumente hinzufügen, Index bauen, suchen)

Der Quick-Start des README ist bereits nahe an dem, was Sie in einer echten App haben wollen. Hier ist eine angepasste Version, die den Schritt "Modell-Bytes" für Flutter 3.x explizit macht:

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

Das ist die Kernschleife, die Sie für "Offline-Wissensbasis"-Funktionen brauchen: Hilfecenter-Suche, persönliche Notizen, auf das Gerät synchronisierte Unternehmensdokumente und jede App, in der "Benutzertext an ein Backend senden" ein Ausschlusskriterium ist.

## Auslieferungseinschränkungen, über die Sie früh nachdenken sollten

### Modellgröße ist Produktdesign

Selbst INT8-Modelle können groß sein. Entscheiden Sie, ob Sie das Modell im App-Bundle ausliefern, beim ersten Start herunterladen oder plattformspezifische Asset-Auslieferung verwenden.

### Initialisierungskosten und Warm-Path

Die Erzeugung von Embeddings ist der teure Schritt. Ihre UI sollte das ehrlich darstellen: Hintergrundindexierung, Fortschritt und Caching. Der Retrieval-Schritt (HNSW-Suche) ist im Vergleich meist günstig.

Falls Sie die kanonischen Referenzen wollen:

-   pub.dev: [https://pub.dev/packages/mobile_rag_engine](https://pub.dev/packages/mobile_rag_engine)
-   GitHub: [https://github.com/dev07060/mobile_rag_engine](https://github.com/dev07060/mobile_rag_engine)
