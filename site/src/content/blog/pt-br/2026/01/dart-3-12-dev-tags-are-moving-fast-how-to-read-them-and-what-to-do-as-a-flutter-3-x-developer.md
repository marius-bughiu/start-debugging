---
title: "As tags dev do Dart 3.12 estão saindo rápido: como lê-las (e o que fazer) como dev de Flutter 3.x"
description: "As tags dev do Dart 3.12 estão chegando rápido. Aqui está como ler a string de versão, fixar um SDK dev no CI e triar falhas para que sua migração do Flutter 3.x seja um PR pequeno em vez de um incêndio."
pubDate: 2026-01-10
tags:
  - "dart"
  - "flutter"
lang: "pt-br"
translationOf: "2026/01/dart-3-12-dev-tags-are-moving-fast-how-to-read-them-and-what-to-do-as-a-flutter-3-x-developer"
translatedBy: "claude"
translationDate: 2026-04-30
---
O feed de releases do SDK do Dart andou incomumente ativo nas últimas 48 horas, com várias tags **Dart 3.12 dev** chegando em sequência (por exemplo `3.12.0-12.0.dev`). Mesmo que você publique Flutter 3.x estável, essas tags importam porque são um sinal antecipado de mudanças vindouras na linguagem, no analisador e na VM.

Fonte: [Dart SDK `3.12.0-12.0.dev`](https://github.com/dart-lang/sdk/releases/tag/3.12.0-12.0.dev)

## Uma tag dev não é um "release", mas é uma prévia de compatibilidade

Se você está no Flutter estável, não deve atualizar seu toolchain para um SDK dev sem critério. Mas você pode usar tags dev de forma estratégica:

-   **Pegar quebras do analisador cedo**: lints e erros do analisador aparecem antes de virarem o seu problema.
-   **Validar tooling de build**: geradores de código, build runners e scripts de CI costumam falhar primeiro.
-   **Avaliar custo de migração**: se um pacote do qual você depende é frágil, você descobre agora, não no dia do release.

Pense nas tags dev como um canal de prévia de compatibilidade.

## Lendo a string de versão sem adivinhar

O formato `3.12.0-12.0.dev` parece estranho até você tratá-lo como: "3.12.0 pré-release, build dev número 12". Você não precisa inferir features a partir do número em si. Você o usa para fixar um toolchain conhecido durante o teste.

Na prática:

-   **Escolha uma tag dev** para um branch de investigação de vida curta.
-   **Fixe-a explicitamente** para que você possa reproduzir resultados.
-   **Rode uma carga realista**: `flutter test`, um build de release e pelo menos uma execução de build\_runner se você usar codegen.

## Fixando um SDK específico do Dart no CI (sem quebrar o dia de todo mundo)

Aqui vai um exemplo mínimo de GitHub Actions que configura um SDK fixado e roda as verificações usuais. Isso é intencionalmente separado do seu build principal, então você pode tratar falhas como "sinal", não como "parar o mundo".

```yaml
name: dart-dev-signal
on:
  schedule:
    - cron: "0 6 * * *" # daily
  workflow_dispatch:

jobs:
  analyze:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # Pin a specific dev tag so failures are reproducible.
      # Follow Dart SDK release assets/docs for the right install method for your runner.
      - name: Install Dart SDK dev
        run: |
          echo "Pin Dart 3.12.0-12.0.dev here"
          dart --version

      - name: Analyze + test
        run: |
          dart pub get
          dart analyze
          dart test
```

O comportamento importante não é o snippet do instalador, é a política: **esse job é um canário**.

## O que fazer com as falhas

Quando o canal dev quebra seu build, você quer que a falha responda a uma única pergunta: "isso é nosso código ou nossas dependências?"

Checklist rápido de triagem:

-   **Se erros do analisador mudaram**: cheque novos lints ou tipagem mais estrita no seu código.
-   **Se build\_runner falha**: fixe e atualize os geradores primeiro, depois rode de novo.
-   **Se uma dependência falha**: abra uma issue upstream com a tag dev exata, não "última dev".

O retorno é chato mas real: quando o Flutter eventualmente adotar o toolchain mais novo do Dart, sua migração vai ser um PR pequeno em vez de um incêndio.

Recurso: [Dart SDK releases](https://github.com/dart-lang/sdk/releases)
