---
title: "Como acelerar um Dart analysis server lento no VS Code em um monorepo Flutter grande"
description: "Um monorepo com dezenas de arquivos pubspec.yaml faz o Dart analysis server criar um contexto de análise por pacote, e é para lá que vão a memória e o startup de um minuto. Converta para um pub workspace, exclua o código gerado no analysis_options.yaml, remova os plugins legados do analyzer e use a página Insights para comprovar. Medido no Dart 3.12.2: 2,3x menos memória de pico e metade do tempo de análise a frio."
pubDate: 2026-09-27
template: "how-to"
tags:
  - "dart"
  - "flutter"
  - "vs-code"
  - "performance"
  - "monorepo"
  - "how-to"
lang: "pt-br"
translationOf: "2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo"
translatedBy: "claude"
translationDate: 2026-09-27
---

**Resposta curta:** em um monorepo Flutter, o Dart analysis server fica lento principalmente porque cria um contexto de análise separado para cada pacote que tem seu próprio `pubspec.yaml` e `.dart_tool/package_config.json`, e cada contexto carrega sua própria cópia do SDK, do Flutter e de todas as dependências compartilhadas. Transforme o repo em um [pub workspace](https://dart.dev/tools/pub/workspaces) (Dart 3.6+) para que todos os pacotes sejam resolvidos em um único contexto compartilhado, exclua o código gerado com `analyzer: exclude:` no `analysis_options.yaml` da raiz, remova plugins legados do analyzer como o `custom_lint` e abra a raiz do workspace no VS Code. Em um repo sintético com 40 pacotes e 3.240 arquivos, isso reduziu a memória de pico de cerca de 1,2 GB para 0,5 GB e a análise a frio de 17-22 s para 11-12 s, antes mesmo de mexer no código gerado.

Tudo o que segue foi medido com Dart 3.12.2 (Flutter 3.44.8) em um Mac com Apple Silicon. A versão estável atual é o Dart 3.13.3, que acompanha a linha Flutter 3.47; as chaves de configuração e o comportamento descritos aqui não mudaram nela, e o 3.13.2 ainda deprecia o sistema legado de plugins que a seção 4 manda você abandonar.

## Por que um repo vira quarenta analisadores

O analysis server (o processo por trás do `dart language-server`, que a extensão Dart-Code inicia, e por trás do `dart analyze`) organiza o trabalho em contextos de análise. Um contexto é um conjunto de arquivos que compartilham uma única resolução de pacotes e um único conjunto de opções de análise. Cada contexto mantém seu próprio modelo de elementos resolvido de tudo o que consegue enxergar, o que, para um pacote Flutter, significa o SDK do Dart, o pacote `flutter` inteiro e todas as dependências transitivas.

Quando você abre a raiz de um monorepo que contém `apps/customer`, `apps/driver` e 38 pacotes em `packages/`, cada um com seu próprio `pubspec.lock` e `.dart_tool/package_config.json`, o servidor não tem escolha: esses pacotes podem resolver `collection` ou `riverpod` para versões diferentes, então ele cria 40 contextos e resolve `package:flutter` 40 vezes. O time do Dart diz exatamente isso na página de workspaces: abrir a raiz sem workspaces "cria contextos de análise separados para cada pacote, aumentando o uso de memória". A issue de acompanhamento de longa data para a correção, [dart-lang/sdk#53874](https://github.com/dart-lang/sdk/issues/53874), coloca a redução do número de contextos no centro do trabalho de desempenho do servidor.

Os sintomas no VS Code são conhecidos: "Analyzing..." girando por um minuto depois de abrir a pasta, autocompletar que leva segundos, sugestões de auto-import que ficam atrás da digitação e, em máquinas com 16 GB, o servidor sendo encerrado e reiniciado.

## Meça antes de mudar qualquer coisa

Adivinhar sai caro aqui, então obtenha dois números primeiro.

No VS Code, execute **Dart: Open Analyzer Diagnostics / Insights** na paleta de comandos. Isso abre a página web de diagnóstico do servidor. A página Contexts lista cada contexto de análise com sua localização, a raiz do workspace e a contagem de arquivos "added" (os seus) e "implicit" (os arquivos do SDK e das dependências que aquele contexto precisou carregar). Se você vê um contexto por pacote, cada um com milhares de arquivos implícitos, encontrou o problema. A página "Memory and CPU usage" mostra o que o processo está segurando, e a página "Legacy Plugins" lista os isolates de plugins. **Dart: Capture Analysis Server Timings** registra quais requisições estão lentas, se a reclamação é o autocompletar e não o startup.

Para um número reproduzível que você possa rodar no CI ou antes e depois de uma mudança, use a linha de comando. O `dart analyze` roda o mesmo analysis server, e duas flags ocultas (visíveis com `dart analyze -h -v`) o tornam útil como benchmark:

```bash
# Dart 3.12.2. --cache points at an empty dir so every run is cold.
rm -rf /tmp/dart-cache
/usr/bin/time -l dart analyze --cache=/tmp/dart-cache .
# "maximum resident set size" in the time output is peak memory (macOS, bytes).
# On Linux use: /usr/bin/time -v dart analyze --cache=/tmp/dart-cache .

# Server-reported heap, printed only with JSON output:
dart analyze --cache=/tmp/dart-cache --memory --format=json . | jq .memory
```

A flag `--cache` importa. Sem ela, a execução reutiliza `~/.dartServer`, e execuções a quente escondem a maior parte da diferença que você está tentando medir.

## O repo que eu medi

Para obter números que não estejam presos à base de código de uma empresa, gerei um monorepo com 40 pacotes Dart puros, cada um com 80 arquivos de biblioteca, um arquivo barrel e dependências por path nos dois pacotes anteriores, de modo que o grafo de dependências é uma cadeia como em um app real em camadas (`core` -> `data` -> `features`). São 3.240 arquivos. Pacotes Flutter se comportam da mesma forma para esse propósito; eles só tornam cada contexto extra mais caro, porque o `package:flutter` é grande.

Duas variantes: `separate`, em que cada pacote rodou seu próprio `dart pub get`, e `workspace`, o mesmo código convertido para um pub workspace. Três execuções a frio de cada:

| Variante | Package configs | `dart analyze` a frio | RSS de pico |
| --- | --- | --- | --- |
| separate | 40 | 16,5 s / 20,7 s / 22,4 s | 1.225 / 1.291 / 1.067 MB |
| workspace | 1 | 11,1 s / 11,6 s / 11,7 s | 499 / 495 / 490 MB |

Mesmos diagnósticos, mesmo código, menos da metade da memória. Na IDE a diferença é maior do que em uma execução única pela CLI, porque o servidor vive durante toda a sua sessão e todos os contextos permanecem residentes.

## Passo a passo: deixe o analyzer rápido de novo

1. Atualize o SDK para além das regressões conhecidas.
2. Converta o repo para um pub workspace.
3. Exclua código gerado e de terceiros no `analysis_options.yaml`.
4. Remova os plugins legados do analyzer.
5. Abra a raiz do workspace no VS Code e reduza o que a IDE enxerga.

### 1. Atualize para além das regressões conhecidas

O Dart 3.11.0 saiu com um problema de desempenho em workspaces com muitos arquivos e muitos diretórios, corrigido no 3.11.1 ([dart-lang/sdk#62456](https://github.com/dart-lang/sdk/issues/62456)). Há também um relato em aberto, [dart-lang/sdk#62704](https://github.com/dart-lang/sdk/issues/62704), de um workspace com 18 pacotes que passou de cerca de 10 s para mais de 6 minutos depois de migrar para o 3.11.0. Se você está exatamente no 3.11.0, atualize primeiro e meça de novo. O Dart 3.12 também melhorou o startup com um cache melhor dos arquivos de opções de análise, o que ajuda mais quando cada pacote tem seu próprio `analysis_options.yaml` que faz `include:` de um compartilhado.

### 2. Converta para um pub workspace

Um workspace exige que cada membro declare `resolution: workspace` e um limite inferior de SDK de pelo menos 3.6. O `pubspec.yaml` da raiz lista os membros:

```yaml
# pubspec.yaml at the repo root. Dart 3.6+ (measured on 3.12.2).
name: _
publish_to: none
environment:
  sdk: ^3.12.0
workspace:
  - apps/customer
  - apps/driver
  - packages/core
  - packages/data
  - packages/design_system
```

```yaml
# packages/data/pubspec.yaml
name: data
publish_to: none
environment:
  sdk: ^3.12.0
  flutter: ">=3.44.0"
resolution: workspace
dependencies:
  flutter:
    sdk: flutter
  core:
    path: ../core
```

Depois, limpe os artefatos de resolução por pacote e resolva uma única vez a partir da raiz:

```bash
# Remove stale per-package lockfiles and package configs, then resolve the workspace.
find . -name pubspec.lock -not -path './pubspec.lock' -delete
find . -path '*/.dart_tool/package_config.json' -not -path './.dart_tool/*' -delete
flutter pub get   # or: dart pub get
```

Depois disso existe um único `pubspec.lock` e um único `.dart_tool/package_config.json`, ambos na raiz. Reinicie o analysis server (**Dart: Restart Analysis Server**) e confira a página Contexts de novo: você deve ver um único contexto para o workspace.

A contrapartida é que o workspace tem uma única resolução de versões. Se `apps/driver` fixa o `intl` em uma major e `apps/customer` precisa de outra, o `pub get` falha até você alinhá-las. Essa falha é o trabalho da migração; a maioria dos repos descobre dois ou três conflitos desse tipo. Se você usa Melos, a versão 7.0.0 migrou para pub workspaces e substituiu o `melos.yaml` por uma seção `melos:` no `pubspec.yaml` da raiz, então atualizar o Melos e converter para um workspace são o mesmo trabalho.

### 3. Exclua código gerado e de terceiros

Código Dart gerado costuma ser tão grande quanto o código que você escreveu. A saída de `freezed`, `json_serializable`, `mockito`, `drift` e `intl` fica ao lado dos seus fontes como `*.g.dart`, `*.freezed.dart` e `*.mocks.dart`, e o servidor resolve e aplica lint em cada linha. (Se a própria geração de código está falhando, veja [a incompatibilidade de versões entre source_gen e analyzer que quebra o build_runner](/pt-br/2026/08/fix-the-method-getinvocation-isnt-defined-for-the-type-dartobjectimpl/); se você está escolhendo entre modelos gerados e os nativos, [Dart records vs classes freezed](/pt-br/2026/05/dart-records-vs-freezed-classes/) é a comparação relevante.)

```yaml
# analysis_options.yaml at the workspace root. Dart 3.12.2.
include: package:flutter_lints/flutter.yaml

analyzer:
  exclude:
    - "**/*.g.dart"
    - "**/*.freezed.dart"
    - "**/*.mocks.dart"
    - "**/build/**"
    - "third_party/**"
```

Adicionei 10 arquivos no estilo de código gerado (cerca de 1.000 linhas) a cada um dos 40 pacotes e medi de novo na variante workspace:

| Workspace + código gerado | `dart analyze` a frio | RSS de pico |
| --- | --- | --- |
| arquivos gerados analisados | 19,4 s / 14,7 s | 1.148 / 1.185 MB |
| `**/*.g.dart` excluído | 6,9 s / 6,9 s | 523 / 523 MB |

Quatro detalhes sobre o `exclude` que a documentação não explicita, todos verificados no 3.12.2:

- **Os globs são relativos ao arquivo de opções.** A [documentação de análise](https://dart.dev/tools/analysis) diz isso explicitamente. `**/*.g.dart` funciona de qualquer lugar; `lib/**` no arquivo da raiz significa o `lib` da raiz, não o de cada pacote.
- **Em um workspace, o exclude do arquivo da raiz cobre membros que têm seu próprio `analysis_options.yaml`.** No meu teste, cada pacote manteve seu próprio arquivo de opções, e um `exclude` só na raiz ainda removeu os arquivos gerados deles da análise. Sem workspace isso não acontece: cada pacote é sua própria raiz de contexto, o arquivo da raiz é ignorado para eles, e você precisa do exclude em cada pacote, ou de uma linha `include: ../../analysis_options.yaml` no arquivo de cada pacote, que leva o exclude junto.
- **Excluir um arquivo não impede que ele seja resolvido quando algo o importa.** Excluí uma biblioteca que outros arquivos importam e coloquei um warning nela. O warning sumiu, e os arquivos que a importam continuaram passando na checagem de tipos. Então a exclusão economiza o trabalho de lint e de diagnósticos, e economiza tudo para arquivos que ninguém importa (mocks, fixtures de teste, saída obsoleta), mas um `*.g.dart` que é `part` de um modelo que você usa ainda será lido.
- **`build/` não é ignorado por padrão.** Pastas cujo nome começa com ponto (`.dart_tool`, `.git`) são ignoradas, mas um diretório `build/` ou `ios/Pods/` que por acaso contenha arquivos `.dart` é analisado. Apps `example/` aninhados com seu próprio `pubspec.yaml` que não são membros do workspace também viram contextos extras. Adicione-os ao workspace ou exclua-os.

### 4. Remova os plugins legados do analyzer

Plugins legados do analyzer, do tipo `analyzer: plugins:` que o `custom_lint` e ferramentas mais antigas usam, rodam em isolates separados ligados aos contextos de análise. A documentação do Dart avisa que habilitar um deles "aumenta a quantidade de memória que o analyzer usa" e recomenda evitá-los totalmente se você tem menos de 16 GB de RAM ou um monorepo com 10 ou mais arquivos `pubspec.yaml` ou `analysis_options.yaml`. O Dart 3.13.2 depreciou formalmente o sistema legado.

Verifique se eles existem:

```bash
grep -rn --include=analysis_options.yaml -A3 'plugins:' .
```

Se os lints importam, migre para o [novo sistema de plugins](https://dart.dev/tools/analyzer-plugins) adicionado no Dart 3.10, configurado com uma chave `plugins:` de nível superior e suportado tanto pela IDE quanto pelo `dart analyze`. O Dart 3.11 passou a reutilizar um snapshot AOT do entrypoint do plugin, o que, segundo o changelog, economiza algo na ordem de 10 segundos no início de cada sessão da IDE. Se os lints não importam o bastante para serem portados, apague o plugin e meça a diferença; normalmente é a maior queda individual depois da conversão para workspace.

### 5. Abra a pasta certa e reduza o que a IDE enxerga

Com um workspace, abra a raiz do repo no VS Code em vez da pasta de um único app, para que uma única sessão do servidor cubra todos os membros e a navegação entre pacotes, o rename e o find-references funcionem no repo inteiro.

Duas configurações do Dart-Code valem a pena conhecer, e uma vale a pena evitar:

```jsonc
// .vscode/settings.json (Dart-Code extension)
{
  // Folders the IDE analysis server ignores entirely, including for project detection.
  "dart.analysisExcludedFolders": [
    "tools/legacy_scripts",
    "third_party"
  ],
  // Keep SDK and dependency symbols out of Ctrl+T if workspace symbol search is slow.
  "dart.includeDependenciesInWorkspaceSymbols": false
}
```

`dart.analysisExcludedFolders` afeta apenas o editor, então prefira `analyzer: exclude:` para tudo o que também deve ser ignorado pelo `dart analyze` no CI. Use a configuração do VS Code quando uma pasta deve continuar sendo analisada no CI, mas não localmente, como um app arquivado grande que ninguém do seu time edita.

Evite `dart.onlyAnalyzeProjectsWithOpenFiles`. Ela está depreciada, e a própria descrição avisa que ela "pode tornar o desempenho significativamente pior ao navegar por um projeto", porque o servidor fica desmontando e reconstruindo contextos à medida que você troca de arquivo.

## Quando ainda está lento

Se a página Contexts mostra um único contexto e o código gerado está excluído, o custo restante é código de verdade. Algumas coisas para verificar:

- **Exports barrel circulares ou muito amplos.** Um arquivo barrel que reexporta um pacote inteiro faz cada importador depender de cada arquivo dele, então uma edição invalida muito mais do que precisa. Importe por caminhos `src/` dentro de um pacote e mantenha os barrels para a API pública.
- **Um megapacote.** Dividir um pacote `app` de 3.000 arquivos em features não reduz o trabalho total, mas permite que o servidor pule a reanálise de bibliotecas não afetadas depois de uma edição.
- **Um restart do servidor depois de grandes operações de git.** Trocar para branches que mexem em centenas de arquivos enfileira muito trabalho. **Dart: Restart Analysis Server** é, em alguns casos, mais rápido do que esperar a invalidação incremental.
- **Instrumentação para um bug report.** Defina `dart.analyzerInstrumentationLogFile` com um caminho, reproduza o problema e anexe o arquivo a uma issue em [dart-lang/sdk](https://github.com/dart-lang/sdk/issues). As regressões acima foram encontradas assim.

Esses são os mesmos contextos que o `dart fix` percorre, e é por isso que [rodar o dart fix no repo inteiro](/pt-br/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/) também fica mais rápido depois da conversão para workspace. E se você roda um agente de IA contra o repo por meio do [servidor MCP do Dart e do Flutter](/pt-br/2026/05/dart-flutter-mcp-server-claude-code-cursor/), ele também está conversando com um analysis server, então um layout de contextos mais enxuto ajuda ali tanto quanto no seu editor.

## Fontes

- [Pub workspaces (suporte a monorepo)](https://dart.dev/tools/pub/workspaces), dart.dev
- [Customizing static analysis](https://dart.dev/tools/analysis), dart.dev
- [Analyzer plugins](https://dart.dev/tools/analyzer-plugins), dart.dev
- [Dart SDK CHANGELOG](https://github.com/dart-lang/sdk/blob/main/CHANGELOG.md), entradas para 3.10.0, 3.11.0, 3.11.1, 3.12.0 e 3.13.2
- [Referência de configurações do Dart-Code](https://dartcode.org/docs/settings/)
- [dart-lang/sdk#53874: reduzir o número de contextos de análise](https://github.com/dart-lang/sdk/issues/53874)
- [Changelog do Melos, 7.0.0](https://pub.dev/packages/melos/changelog)
