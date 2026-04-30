---
title: "Flutter 3.x ganha um novo bloco de construção de \"RAG offline\": `mobile_rag_engine` (núcleo em Rust)"
description: "mobile_rag_engine traz RAG no dispositivo para Flutter com um núcleo em Rust, embeddings ONNX, busca vetorial HNSW e armazenamento SQLite. Um olhar prático sobre a API, o fluxo de integração e as restrições de distribuição."
pubDate: 2026-01-10
tags:
  - "dart"
  - "flutter"
lang: "pt-br"
translationOf: "2026/01/flutter-3-x-gets-a-new-offline-rag-building-block-mobile_rag_engine-rust-core"
translatedBy: "claude"
translationDate: 2026-04-30
---
RAG no dispositivo está aparecendo no mundo Flutter como algo que dá para realmente enviar, não só demonstrar. O `mobile_rag_engine` foi publicado no pub.dev há poucos dias e é opinativo do jeito certo: um núcleo em Rust para o trabalho pesado, uma API Flutter para integração e binários pré-compilados para que você não precise configurar Rust, Cargo ou o Android NDK só para experimentar.

Se você queria busca semântica dentro de um app sem enviar dados do usuário para um servidor, este é o formato que vale a pena estudar.

## O que ele oferece (em termos práticos)

O pacote se posiciona como um motor RAG totalmente local:

-   Embeddings (via ONNX Runtime)
-   Busca vetorial HNSW para consultas rápidas de vizinho mais próximo
-   Armazenamento baseado em SQLite para documentos e metadados
-   Tokenização via tokenizers do HuggingFace (através de Rust)

Você ainda precisa enviar um modelo. A diferença é que, uma vez feito isso, o loop de recuperação é local e previsível.

## Um fluxo minúsculo de ponta a ponta (adicionar docs, construir índice, buscar)

O quick start do README já está próximo do que você vai querer em um app real. Aqui está uma versão adaptada que torna o passo de "bytes do modelo" explícito para Flutter 3.x:

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

Esse é o loop central de que você precisa para recursos de "base de conhecimento offline": busca em central de ajuda, notas pessoais, documentos corporativos sincronizados no dispositivo e qualquer app em que "mandar texto do usuário para um backend" não rola.

## Restrições de distribuição para pensar com antecedência

### O tamanho do modelo é design de produto

Mesmo modelos INT8 podem ser grandes. Decida se você envia o modelo no bundle do app, baixa na primeira execução ou usa entrega de assets específica da plataforma.

### Custo de inicialização e caminho quente

A geração de embeddings é o passo caro. Sua UI deve ser honesta sobre isso: indexação em segundo plano, progresso e cache. O passo de recuperação (busca HNSW) costuma ser barato em comparação.

Se quiser as referências canônicas:

-   pub.dev: [https://pub.dev/packages/mobile_rag_engine](https://pub.dev/packages/mobile_rag_engine)
-   GitHub: [https://github.com/dev07060/mobile_rag_engine](https://github.com/dev07060/mobile_rag_engine)
