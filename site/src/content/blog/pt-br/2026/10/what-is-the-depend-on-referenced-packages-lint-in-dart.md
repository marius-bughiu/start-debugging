---
title: "O que é o lint depend_on_referenced_packages no Dart e por que ele dispara em imports transitivos?"
description: "O depend_on_referenced_packages dispara quando um arquivo importa ou exporta um pacote que não está listado no seu próprio pubspec.yaml, mesmo que ele seja resolvido por outra dependência. Veja exatamente o que a regra verifica no Dart 3.12.2 e no Flutter 3.44.8, por que imports transitivos são um bug real e como corrigir cada variante."
pubDate: 2026-10-24
tags:
  - "dart"
  - "flutter"
  - "lints"
  - "pub"
  - "pubspec"
lang: "pt-br"
translationOf: "2026/10/what-is-the-depend-on-referenced-packages-lint-in-dart"
translatedBy: "claude"
translationDate: 2026-10-24
---

**Resposta curta:** `depend_on_referenced_packages` reporta qualquer `import` ou `export` de `package:foo/...` em que `foo` não está listado no `pubspec.yaml` do próprio pacote que importa. Ele não se importa que `foo` seja resolvido normalmente porque uma das suas dependências o traz junto: um pacote transitivo é algo que você está pegando emprestado, com uma versão que você não controla e uma presença que você não pode garantir. Corrija declarando o pacote você mesmo (`dart pub add foo` ou `flutter pub add foo`), em `dependencies` se o import estiver em `lib/`, `bin/`, `hook/build.dart` ou `hook/link.dart`, e em `dev_dependencies` somente se estiver em qualquer outro lugar, como `test/` ou `tool/`. Tudo abaixo foi medido no Dart 3.12.2 e no Flutter 3.44.8 com `lints` 6.1.0 e `flutter_lints` 6.0.0.

A regra existe desde o Dart 2.14 e faz parte do conjunto **core** do [`package:lints`](https://pub.dev/packages/lints), o que significa que `lints/recommended.yaml` e `flutter_lints` a ativam. A maioria das pessoas esbarra nela na primeira vez que digita `import 'package:collection/collection.dart';` em um app Flutter novo e recebe um sublinhado azul em uma linha que compila e roda perfeitamente.

## Por que um import que funciona ainda é sinalizado

Quando você roda `flutter pub get`, o pub resolve o grafo de dependências inteiro e escreve todos os pacotes dele em `.dart_tool/package_config.json`. O compilador e o analisador resolvem URIs `package:` por meio desse arquivo, e ele contém também as suas dependências transitivas. É por isso que `package:http_parser` é resolvido em um projeto que depende apenas de `http`: `http` depende de `http_parser`, então ele está no package config.

O import funciona hoje por acaso. Três coisas podem quebrá-lo depois, e nenhuma delas aparece no seu diff:

1. **O intermediário o remove.** Se o `http` 2.0 deixar de depender de `http_parser`, o seu próximo `pub upgrade` o remove do grafo e o seu build falha com `Target of URI doesn't exist`. Nada no seu `pubspec.yaml` mudou.
2. **Você nunca escolheu a versão.** Seu código é escrito contra qualquer versão de `http_parser` que a restrição do `http` tenha permitido. Uma mudança de versão major no pacote transitivo que o `http` tolera é uma breaking change para você, sem nenhuma restrição sua para impedi-la.
3. **Seus consumidores não o recebem.** Se você publica um pacote, os usuários resolvem o próprio grafo. Dev dependencies nunca são transitivas, então tudo o que o seu código em `lib/` importa de uma dev dependency simplesmente não existe para eles.

O lint transforma essas três falhas latentes em um único diagnóstico info visível no ponto do import. A [página oficial da regra](https://dart.dev/tools/linter-rules/depend_on_referenced_packages) a resume como "Depend on referenced packages", e o raciocínio é que uma dependência explícita é a única forma de garantir que o pacote esteja lá e, ao mesmo tempo, impor a sua própria restrição de versão sobre ele.

## O que a regra realmente verifica

A implementação é curta e vale a leitura: [`pkg/linter/lib/src/rules/pub/depend_on_referenced_packages.dart`](https://github.com/dart-lang/sdk/blob/main/pkg/linter/lib/src/rules/pub/depend_on_referenced_packages.dart) no SDK do Dart. Para cada biblioteca, ela monta uma lista de nomes de pacote permitidos:

- o próprio `name` do pacote (então auto-imports `package:my_app/...` sempre passam),
- toda chave em `dependencies`,
- toda chave em `dev_dependencies`, **mas somente se o arquivo não estiver em um local público**.

Um arquivo conta como público quando está dentro de `lib/` ou `bin/`, ou é exatamente `hook/build.dart` ou `hook/link.dart` (os hooks de build de native assets, adicionados após [dart-lang/sdk#54334](https://github.com/dart-lang/sdk/issues/54334)). Depois ela visita cada diretiva `import` e `export`, pega o primeiro segmento de caminho após `package:` e o reporta se o nome não estiver na lista permitida.

Algumas consequências saem diretamente desse código:

- `dependency_overrides` não é consultado. Um pacote que aparece apenas ali continua sendo "não uma dependência".
- Diretivas `export` são verificadas exatamente como imports.
- Apenas a URI principal de uma diretiva é verificada, não as URIs dentro de cláusulas condicionais `if (dart.library.io) ...`.
- A única isenção fixa no código é `flutter_gen`, o antigo pacote sintético de localização (veja [dart-lang/linter#3308](https://github.com/dart-lang/linter/issues/3308)).
- Não há herança de pacote raiz nem de workspace. Cada pacote é verificado contra o seu próprio pubspec.

## Um repro que dispara todas as variantes

Aqui está um pequeno pacote Dart puro que depende apenas de `http` e mantém `meta` como dev dependency:

```yaml
# pubspec.yaml -- Dart 3.12.2
name: repro
version: 1.0.0

environment:
  sdk: ^3.12.0

dependencies:
  http: ^1.6.0

dev_dependencies:
  lints: ^6.1.0
  meta: ^1.18.0

dependency_overrides:
  path: ^1.9.1
```

```yaml
# analysis_options.yaml
include: package:lints/recommended.yaml
```

```dart
// lib/repro.dart -- Dart 3.12.2
import 'package:http/http.dart' as http;          // declared: OK
import 'package:http_parser/http_parser.dart';   // transitive via http: LINT
import 'package:meta/meta.dart';                 // dev_dependency in lib/: LINT
import 'package:repro/src/helpers.dart';         // self package: OK
export 'package:async/async.dart' show Result;   // transitive export: LINT

@immutable
class Probe {
  const Probe();

  Future<MediaType> contentType(Uri uri) async {
    final response = await http.head(uri);
    return MediaType.parse(response.headers['content-type'] ?? 'text/plain');
  }
}

final helper = helperValue;
```

Adicione o mesmo `import 'package:meta/meta.dart';` a `bin/repro.dart`, `hook/build.dart`, `tool/gen.dart` e `test/repro_test.dart`, importe `package:http_parser` também no teste, e importe `package:path` (apenas override) em `lib/src/over.dart`. O `dart analyze` reporta:

```text
info - bin/repro.dart:1:8 - The imported package 'meta' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - hook/build.dart:1:8 - The imported package 'meta' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - lib/repro.dart:2:8 - The imported package 'http_parser' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - lib/repro.dart:3:8 - The imported package 'meta' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - lib/repro.dart:5:8 - The imported package 'async' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - lib/src/over.dart:1:8 - The imported package 'path' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - test/repro_test.dart:2:8 - The imported package 'http_parser' isn't a dependency of the importing package. ... - depend_on_referenced_packages
```

Observe o que está faltando: `tool/gen.dart` e o import de `meta` em `test/` estão limpos, porque dev dependencies são permitidas fora de locais públicos. Observe também que a mensagem é a mesma quer o pacote esteja ausente, quer esteja apenas na seção errada. "Isn't a dependency" pode significar "ele é uma dev dependency, e este arquivo é público".

## A versão Flutter da mesma coisa

Em um app Flutter, os pacotes transitivos que você tem mais chance de importar por acidente são os dos quais o próprio SDK depende: `collection`, `meta`, `vector_math`, `characters`, `material_color_utilities`. Eles estão sempre no grafo porque o `flutter` precisa deles. Um app novo criado com `flutter create --empty` com este arquivo:

```dart
// lib/probe.dart -- Flutter 3.44.8
import 'package:collection/collection.dart';
import 'package:meta/meta.dart';
import 'package:vector_math/vector_math_64.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
```

recebe quatro infos de `depend_on_referenced_packages`. `flutter_localizations` também recebe um erro grave `uri_does_not_exist`, porque é um pacote de SDK separado que não está no grafo até você pedi-lo. O lint é o mais amigável dos dois diagnósticos, mas o problema de fundo é idêntico.

## Como corrigir, caso a caso

1. **Pacote transitivo importado de `lib/`.** Declare-o como dependência normal. Deixe o pub escolher a restrição em vez de chutar:

   ```bash
   # Flutter 3.44.8
   flutter pub add collection meta vector_math
   ```

   ```yaml
   dependencies:
     collection: ^1.19.1
     flutter:
       sdk: flutter
     meta: ^1.18.0
     vector_math: ^2.2.0
   ```

2. **Pacote de SDK como `flutter_localizations`.** Eles precisam da forma `sdk: flutter`, que o `pub add` aceita como um descritor JSON:

   ```bash
   flutter pub add 'flutter_localizations:{"sdk":"flutter"}'
   ```

3. **Dev dependency importada de `lib/`, `bin/` ou de um build hook.** Mova-a para `dependencies` (`dart pub add meta` a move para você) ou mova o código que importa para fora do diretório público. Para pacotes só de anotações como `meta`, movê-lo para `dependencies` é a decisão certa: um pacote publicado com `@immutable` em `lib/` não compila para os consumidores caso contrário.

4. **Pacote que existe apenas em `dependency_overrides`.** Um override muda a versão de algo que já está no grafo; ele não declara uma dependência. Adicione também uma entrada normal e mantenha o override se ainda precisar dele.

5. **Pacote exportado pela sua biblioteca.** Mesma correção de um import. Se você reexporta o `Result` de `package:async`, a sua API pública agora depende da versão de `async`, que é exatamente o motivo pelo qual você quer a sua própria restrição sobre ele.

Não existe `dart fix` para esta regra; no repro, `dart fix --dry-run` reporta "Nothing to fix!". A correção rápida da IDE adiciona o pacote ao `pubspec.yaml`, e `pub add` faz o mesmo pelo terminal.

## Pegadinhas e casos extremos

### O SDK do Flutter fixa a sua restrição

Pacotes como `meta` e `collection` são fixados em versões exatas por `flutter` e `flutter_test`. Se você escrever uma restrição acima da versão fixada, a resolução falha:

```text
Note: meta is pinned to version 1.18.0 by flutter_test from the flutter SDK.

Because every version of flutter_test from sdk depends on meta 1.18.0 and fapp depends on meta ^1.19.0, flutter_test from sdk is forbidden.
So, because fapp depends on flutter_test from sdk, version solving failed.
```

É por isso que `flutter pub add` é melhor do que digitar a restrição à mão: ele escolhe a versão que satisfaz a fixação. Se você já bateu nesse erro, o passo a passo em [como corrigir "version solving failed" no pubspec.yaml](/pt-br/2026/05/fix-version-solving-failed-in-pubspec-yaml/) mostra como ler a saída do solver. Espere que o seu `pubspec.lock` oscile quando você trocar de versão do Flutter mais tarde, já que as fixações acompanham o SDK; [este artigo sobre o pubspec.lock](/pt-br/2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions/) explica o motivo.

### Workspaces do pub não herdam dependências

Com um workspace do pub do Dart 3.6+, todos os membros compartilham uma resolução e um `package_config.json`, então um membro pode importar qualquer coisa de que outro membro dependa. O lint não permite isso. Um `pubspec.yaml` raiz com `http` em `dependencies` e um membro `pkgs/app` com `resolution: workspace` e sem dependências ainda produz:

```text
info - pkgs/app/lib/app.dart:1:8 - The imported package 'http' isn't a dependency of the importing package. ... - depend_on_referenced_packages
```

Esse é o comportamento que você quer em um monorepo. A resolução compartilhada facilita o empréstimo acidental entre pacotes, e o lint é o que impede um pacote de depender silenciosamente da lista de dependências de um vizinho. Se o analysis server estiver lento em um workspace grande, esse é outro problema, veja [como acelerar o analysis server do Dart em um monorepo Flutter grande](/pt-br/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/).

### Imports condicionais passam despercebidos

A regra verifica apenas a URI primária de uma diretiva. Isto passa pelo lint mesmo que `path` não esteja declarado:

```dart
// lib/src/cond.dart -- Dart 3.12.2
import 'package:repro/src/helpers.dart'
    if (dart.library.io) 'package:path/path.dart';
```

O `dart pub publish --dry-run` também não sinalizou isso no Dart 3.12.2. Trate imports condicionais por plataforma como algo a verificar manualmente no code review.

### O `dart pub publish` aplica a mesma regra como erro

Para pacotes publicados, o próprio validador do pub executa uma versão mais rígida desta verificação. No repro, `dart pub publish --dry-run` transformou os achados de lib, bin e hook em erros graves:

```text
* line 3, column 1 of lib/repro.dart: meta is in the `dev_dependencies` section of `pubspec.yaml`. Packages used in lib/ must be declared in the `dependencies` section.
* line 2, column 1 of lib/repro.dart: This package does not have http_parser in the `dependencies` section of `pubspec.yaml`.
```

O achado em `test/` volta apenas como aviso. Então ignorar o lint em um pacote que você publica só empurra a falha para o dia do release.

### `flutter_gen` é isento, mas está de saída

A isenção de `flutter_gen` existe porque `flutter gen-l10n` costumava gerar um pacote sintético que não podia aparecer em nenhum pubspec. O Flutter descontinuou esse pacote sintético (veja o [aviso de breaking change](https://docs.flutter.dev/release/breaking-changes/flutter-generate-i10n-source)); as localizações geradas agora ficam na sua própria árvore de código-fonte e são importadas pelo nome do seu próprio pacote, o que o lint já permite.

### Não o silencie "só para um dev package"

Um pedido comum é incluir na lista de exceções um pacote de anotações usado só em desenvolvimento no `analysis_options.yaml`. [dart-lang/sdk#60026](https://github.com/dart-lang/sdk/issues/60026) pediu exatamente isso e foi fechado sem o recurso. A resposta do mantenedor foi que um pacote importado de `lib/` é uma dependência real, e comentários `// ignore:` estão disponíveis se você insistir. Se realmente precisar, restrinja a supressão à linha em vez de ao projeto:

```dart
// ignore: depend_on_referenced_packages
import 'package:meta/meta.dart';
```

Desligar a regra globalmente (`depend_on_referenced_packages: false` em `linter: rules:`) também desliga o único alerta antecipado que você tem antes de o pub ou o build de um consumidor falhar. A configuração de lints em geral fica mais fácil de entender quando você sabe exatamente onde cada regra olha; a [comparação entre unawaited_futures e discarded_futures](/pt-br/2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart/) é um bom exemplo de duas regras cujos escopos são mais estreitos do que seus nomes sugerem.

## Leia a seguir

- [Fix: Version solving failed in pubspec.yaml](/pt-br/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [Fix: pubspec.lock shows as modified after flutter upgrade or switching Flutter versions](/pt-br/2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions/)
- [unawaited_futures vs discarded_futures in Dart](/pt-br/2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart/)
- [How to run dart fix across a whole repo to apply Flutter breaking-change migrations](/pt-br/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/)
- [How to speed up a slow Dart analysis server in VS Code for a large Flutter monorepo](/pt-br/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/)

## Fontes

- [depend_on_referenced_packages rule page](https://dart.dev/tools/linter-rules/depend_on_referenced_packages) e [diagnostic page](https://dart.dev/tools/diagnostics/depend_on_referenced_packages)
- [Rule implementation in dart-lang/sdk](https://github.com/dart-lang/sdk/blob/main/pkg/linter/lib/src/rules/pub/depend_on_referenced_packages.dart) e [its tests](https://github.com/dart-lang/sdk/blob/main/pkg/linter/test/rules/depend_on_referenced_packages_test.dart)
- [package:lints core rule set](https://pub.dev/packages/lints)
- [dart-lang/sdk#60026: exempting dev dependencies](https://github.com/dart-lang/sdk/issues/60026)
- [dart-lang/linter#3308: flutter_gen exemption](https://github.com/dart-lang/linter/issues/3308)
- [SDK version pinning](https://dart.dev/go/sdk-version-pinning)
- [Flutter breaking change: flutter generate l10n source](https://docs.flutter.dev/release/breaking-changes/flutter-generate-i10n-source)
