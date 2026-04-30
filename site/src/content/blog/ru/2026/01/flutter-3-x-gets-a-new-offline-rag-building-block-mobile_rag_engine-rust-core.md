---
title: "Flutter 3.x получает новый строительный блок \"оффлайн-RAG\": `mobile_rag_engine` (ядро на Rust)"
description: "mobile_rag_engine приносит RAG прямо на устройство во Flutter с ядром на Rust, эмбеддингами через ONNX, векторным поиском HNSW и хранилищем на SQLite. Практический взгляд на API, поток интеграции и ограничения поставки."
pubDate: 2026-01-10
tags:
  - "dart"
  - "flutter"
lang: "ru"
translationOf: "2026/01/flutter-3-x-gets-a-new-offline-rag-building-block-mobile_rag_engine-rust-core"
translatedBy: "claude"
translationDate: 2026-04-30
---
RAG на устройстве появляется во Flutter-краях как нечто, что можно действительно отгружать, а не только демонстрировать. `mobile_rag_engine` был опубликован на pub.dev буквально на днях, и он принципиален в правильном смысле: ядро на Rust для тяжёлой работы, Flutter-API для интеграции и предсобранные бинарники, чтобы вам не пришлось настраивать Rust, Cargo или Android NDK только ради того, чтобы попробовать.

Если вы хотели семантический поиск внутри приложения без отправки пользовательских данных на сервер, это та форма, которую стоит изучить.

## Что он даёт (в практическом смысле)

Пакет позиционируется как полностью локальный RAG-движок:

-   Эмбеддинги (через ONNX Runtime)
-   Векторный поиск HNSW для быстрых запросов ближайшего соседа
-   Хранилище на SQLite для документов и метаданных
-   Токенизация через токенизаторы HuggingFace (через Rust)

Вам всё ещё нужно поставлять модель. Разница в том, что как только вы это сделали, цикл извлечения локален и предсказуем.

## Крошечный сквозной поток (добавить документы, построить индекс, искать)

Quick start из README уже близок к тому, что вы захотите в реальном приложении. Вот адаптированная версия, делающая шаг "байты модели" явным для Flutter 3.x:

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

Это базовый цикл, нужный для функций "оффлайн-базы знаний": поиск в центре помощи, личные заметки, корпоративные документы, синхронизированные на устройство, и любое приложение, где "отправить пользовательский текст на бэкенд" неприемлемо.

## Ограничения поставки, о которых стоит подумать заранее

### Размер модели -- это дизайн продукта

Даже INT8-модели могут быть большими. Решите, поставлять ли модель в бандле приложения, скачивать при первом запуске или использовать платформенно-специфичную доставку ассетов.

### Стоимость инициализации и горячий путь

Генерация эмбеддингов -- дорогой шаг. Ваш UI должен быть честен на этот счёт: фоновое индексирование, прогресс и кеш. Шаг извлечения (HNSW-поиск), по сравнению, обычно дешёв.

Если хотите канонические ссылки:

-   pub.dev: [https://pub.dev/packages/mobile_rag_engine](https://pub.dev/packages/mobile_rag_engine)
-   GitHub: [https://github.com/dev07060/mobile_rag_engine](https://github.com/dev07060/mobile_rag_engine)
