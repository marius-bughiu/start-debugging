---
title: "Flutter 3.38.6 e o bump do `engine.version`: builds reproduzíveis ficam mais fáceis (se você fixar)"
description: "Flutter 3.38.6 subiu engine.version, e isso importa para builds reproduzíveis. Aprenda a fixar o SDK no CI, evitar drift do engine e diagnosticar 'o que mudou' quando builds quebram sem mudanças de código."
pubDate: 2026-01-08
tags:
  - "flutter"
lang: "pt-br"
translationOf: "2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it"
translatedBy: "claude"
translationDate: 2026-04-30
---
Flutter 3.38.6 chegou com uma entrada de release "engine.version bump", e essa pequena frase importa mais do que parece. Se suas builds de CI alguma vez derivaram porque uma máquina pegou um artefato de engine ligeiramente diferente, fixar a versão é a diferença entre "funciona" e "conseguimos reproduzir esse build na próxima semana".

Entrada do release: [https://github.com/flutter/flutter/releases/tag/3.38.6](https://github.com/flutter/flutter/releases/tag/3.38.6)

## `engine.version` é o pin escondido por trás do SDK

Quando você roda `flutter --version`, não está só escolhendo uma versão do framework. Está implicitamente selecionando uma revisão específica do engine, e essa revisão controla:

-   **Comportamento do Skia e da renderização**
-   **Mudanças do embedder de plataforma**
-   **Comportamento de ferramentas que dependem de artefatos do engine**

Uma atualização ao `engine.version` é o Flutter dizendo: "essa tag de SDK mapeia para essa revisão de engine". Em outras palavras, é um sinal de reprodutibilidade, não só uma tarefa do processo de release.

## Fixe o Flutter 3.38.6 no CI do jeito chato

O jeito chato é o melhor jeito: use um gerenciador de versões e commite a versão que você quer.

Se você usa FVM, fixe o Flutter explicitamente e faça o CI falhar se houver drift:

```bash
# One-time on your machine
fvm install 3.38.6
fvm use 3.38.6 --force

# In CI (example: verify the version)
fvm flutter --version
```

Se você não usa FVM, a ideia importante é a mesma: não deixe "o que estiver instalado no runner" decidir seu engine. Instale o Flutter 3.38.6 como parte do pipeline, cacheie e imprima `flutter --version` nos logs para conseguir diagnosticar drift.

## O checklist "por que meu build mudou"

Quando um build de Flutter muda sem mudanças de código, eu verifico nesta ordem:

-   **Tag do SDK do Flutter**: ainda estamos no 3.38.6?
-   **Revisão do engine**: `flutter --version -v` mostra o mesmo commit do engine?
-   **Versão do Dart**: drift do SDK pode mudar comportamento do analyzer e do runtime.
-   **Ambiente de build**: versões de Xcode/Android Gradle Plugin podem criar diferenças.

A razão pela qual gosto de chamar atenção para `engine.version` é que torna a segunda bala acionável. Uma vez que você trata o SDK do Flutter como uma entrada imutável, o resto do pipeline fica mais fácil de raciocinar.

Se você mantém múltiplos apps, deixe o pin visível. Um snippet de `README` ou um check de CI que verifique Flutter 3.38.6 é barato, e economiza horas na primeira vez que alguém perguntar: "o que mudou?".
