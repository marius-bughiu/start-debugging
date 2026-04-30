---
title: "Flutter 3.x obtiene un nuevo bloque de construcción de \"RAG offline\": `mobile_rag_engine` (núcleo en Rust)"
description: "mobile_rag_engine lleva RAG en el dispositivo a Flutter con un núcleo en Rust, embeddings ONNX, búsqueda vectorial HNSW y almacenamiento SQLite. Un vistazo práctico a la API, el flujo de integración y las restricciones de distribución."
pubDate: 2026-01-10
tags:
  - "dart"
  - "flutter"
lang: "es"
translationOf: "2026/01/flutter-3-x-gets-a-new-offline-rag-building-block-mobile_rag_engine-rust-core"
translatedBy: "claude"
translationDate: 2026-04-30
---
RAG en el dispositivo está apareciendo en el mundo Flutter como algo que realmente puedes enviar, no solo mostrar en demo. `mobile_rag_engine` se publicó en pub.dev hace pocos días y es opinionado en el sentido correcto: un núcleo en Rust para el trabajo pesado, una API de Flutter para la integración y binarios precompilados para que no tengas que configurar Rust, Cargo ni el Android NDK solo para probarlo.

Si has querido búsqueda semántica dentro de una app sin enviar datos del usuario a un servidor, esta es la forma que conviene estudiar.

## Qué te da (en términos prácticos)

El paquete se posiciona como un motor RAG totalmente local:

-   Embeddings (vía ONNX Runtime)
-   Búsqueda vectorial HNSW para consultas rápidas de vecino más cercano
-   Almacenamiento respaldado por SQLite para documentos y metadatos
-   Tokenización vía tokenizers de HuggingFace (a través de Rust)

Aún tienes que enviar un modelo. La diferencia es que una vez que lo haces, el bucle de recuperación es local y predecible.

## Un flujo minúsculo de extremo a extremo (agregar docs, construir índice, buscar)

El quick start del README ya está cerca de lo que querrás en una app real. Aquí hay una versión adaptada que hace explícito el paso de "bytes del modelo" para Flutter 3.x:

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

Ese es el bucle central que necesitas para funcionalidades de "base de conocimientos offline": búsqueda en centros de ayuda, notas personales, documentos empresariales sincronizados al dispositivo y cualquier app donde "enviar texto del usuario a un backend" no es viable.

## Restricciones de distribución en las que debes pensar de antemano

### El tamaño del modelo es diseño de producto

Incluso los modelos INT8 pueden ser grandes. Decide si envías el modelo en el bundle de la app, lo descargas en la primera ejecución o usas la entrega de assets específica de la plataforma.

### Costo de inicialización y ruta caliente

La generación de embeddings es el paso costoso. Tu UI debería ser honesta al respecto: indexación en segundo plano, progreso y caché. El paso de recuperación (búsqueda HNSW) suele ser barato en comparación.

Si quieres las referencias canónicas:

-   pub.dev: [https://pub.dev/packages/mobile_rag_engine](https://pub.dev/packages/mobile_rag_engine)
-   GitHub: [https://github.com/dev07060/mobile_rag_engine](https://github.com/dev07060/mobile_rag_engine)
