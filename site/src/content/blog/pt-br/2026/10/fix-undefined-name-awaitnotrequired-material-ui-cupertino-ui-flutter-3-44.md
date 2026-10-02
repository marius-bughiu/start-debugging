---
title: "Corrigindo: Undefined name 'awaitNotRequired' em material_ui ou cupertino_ui no Flutter 3.44"
description: "material_ui 1.3.0 e cupertino_ui 1.1.0 usam uma anotação que o Flutter 3.44 não exporta. Ambas foram retiradas, mas o lockfile as mantém. Faça downgrade e depois upgrade para chegar em 1.2.0 e 1.0.2."
pubDate: 2026-10-02
template: error-page
tags:
  - "errors"
  - "flutter"
  - "flutter-3-44"
  - "dart"
  - "pub"
lang: "pt-br"
translationOf: "2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44"
translatedBy: "claude"
translationDate: 2026-10-02
---

O seu `pubspec.lock` fixa `material_ui` 1.3.0 e/ou `cupertino_ui` 1.1.0, duas versões que usam `@awaitNotRequired`, que `package:flutter/foundation.dart` só exporta a partir do Flutter 3.47.0. Ambas as versões agora estão retiradas (retracted) no pub.dev, mas o pub mantém uma versão retirada que você já tenha travado, e no Flutter 3.44 nem mesmo `flutter pub upgrade` sai dela. Execute `flutter pub downgrade material_ui cupertino_ui` seguido de `flutter pub upgrade` (você termina em `material_ui` 1.2.0 e `cupertino_ui` 1.0.2), ou atualize o Flutter para 3.47. Tudo abaixo foi medido no Flutter 3.44.8 (Dart 3.12.2) e no Flutter 3.47.6 (Dart 3.13.5) em 2026-10-02.

## O erro em contexto

O analisador fica em silêncio, `flutter pub get` funciona, e então a primeira compilação real falha dentro do cache do pub. Esta é a saída de `flutter build web` no 3.44.8; todos os outros alvos executam o mesmo frontend do Dart sobre os mesmos fontes, então `flutter run` falha nas mesmas linhas:

```text
Target dart2js failed: ProcessException: Process exited abnormally with exit code 1:
/Users/marius/.pub-cache/hosted/pub.dev/material_ui-1.3.0/lib/src/bottom_sheet.dart:1304:2:
Error: Undefined name 'awaitNotRequired'.
@awaitNotRequired
 ^^^^^^^^^^^^^^^^
/Users/marius/.pub-cache/hosted/pub.dev/material_ui-1.3.0/lib/src/carousel.dart:1982:4:
Error: Not a constant expression.
  @awaitNotRequired
   ^^^^^^^^^^^^^^^^
/Users/marius/.pub-cache/hosted/pub.dev/material_ui-1.3.0/lib/src/dialog.dart:1672:2:
Error: Undefined name 'awaitNotRequired'.
@awaitNotRequired
 ^^^^^^^^^^^^^^^^
...
/Users/marius/.pub-cache/hosted/pub.dev/cupertino_ui-1.1.0/lib/src/route.dart:1347:2:
Error: Undefined name 'awaitNotRequired'.
@awaitNotRequired
 ^^^^^^^^^^^^^^^^
```

`material_ui` 1.3.0 produz oito desses erros (`showModalBottomSheet`, `CarouselController.animateToItem`, `showDatePicker`, `showDateRangePicker`, `showDialog`, `showAdaptiveDialog`, `showMenu`, `showTimePicker`) e `cupertino_ui` 1.1.0 acrescenta mais dois (`showCupertinoModalPopup`, `showCupertinoDialog`). A variante `Not a constant expression` é o mesmo bug: a anotação em um método de instância é reportada de outra forma pelo frontend. Note que `flutter analyze` no seu projeto não reporta nada, porque o analisador não exibe erros dentro de dependências. Só uma etapa de compilação exibe.

Você não precisa depender de `material_ui` diretamente para cair nisso. `shimmer` 4.0.0, por exemplo, depende de `material_ui: ^1.0.1`, então executar `flutter pub add shimmer` no Flutter 3.44 entre 2026-09-15 e a retirada trouxe a 1.3.0 de forma transitiva. Foi exatamente assim que o autor do relato em [flutter/flutter#192839](https://github.com/flutter/flutter/issues/192839) esbarrou nisso.

## Por que o Flutter 3.44 não enxerga uma anotação que existe no próprio pacote meta

`awaitNotRequired` não é novo. Ele existe em `package:meta` desde a 1.17.0, e o Flutter 3.44.8 fixa `meta` 1.18.0, que já o contém. A constante está ali no seu cache do pub. O que o 3.44 não tem é a reexportação.

`material_ui` e `cupertino_ui` nunca importam `package:meta`. Os arquivos de biblioteca deles importam `package:flutter/foundation.dart` e dependem do que ele reexporta de `meta`. No Flutter 3.44, essa lista é fechada:

```dart
// packages/flutter/lib/foundation.dart, Flutter 3.44.8
export 'package:meta/meta.dart'
    show
        factory,
        immutable,
        internal,
        // ignore: experimental_member_use
        mustBeConst,
        mustCallSuper,
        nonVirtual,
        optionalTypeArgs,
        protected,
        required,
        visibleForOverriding,
        visibleForTesting;
```

[flutter/flutter#181513](https://github.com/flutter/flutter/pull/181513) ("Add @awaitNotRequired annotation to flutter sdk") adicionou `awaitNotRequired` a essa lista `show` em 2026-04-25. Ele ficou de fora da branch 3.44 e foi lançado no Flutter 3.47.0 em 2026-08-12. Em qualquer versão 3.44.x (3.44.0 até 3.44.9), o identificador simplesmente não está no escopo para código que importa apenas `foundation.dart`.

Os pacotes, por sua vez, são desenvolvidos contra o canal main do Flutter. [flutter/packages#12622](https://github.com/flutter/packages/pull/12622) e [#12817](https://github.com/flutter/packages/pull/12817) adicionaram as anotações, e `material_ui` 1.3.0 e `cupertino_ui` 1.1.0 foram publicados em 2026-09-15 com as anotações, mas com o mesmo `environment` de antes:

```yaml
# material_ui 1.3.0 pubspec.yaml
environment:
  sdk: ^3.12.0
  flutter: ">=3.44.0"
```

O pub confia nessa restrição, então no Flutter 3.44 ele escolheu a 1.3.0 como a versão compatível mais recente. A correção upstream foi dupla: `material_ui` 1.4.0 e `cupertino_ui` 1.1.1 (ambas de 2026-09-21/22) elevaram o piso para `flutter: ">=3.47.0"` e `sdk: ^3.13.0`, e a 1.3.0 e a 1.1.0 foram retiradas. A issue foi fechada em 2026-09-21.

## Reprodução mínima

Versões retiradas ainda podem ser forçadas com um pin em `dependency_overrides`, que é a forma mais fácil de reproduzir a falha de compilação de propósito:

```yaml
# pubspec.yaml, Flutter 3.44.8 / Dart 3.12.2
name: repro
publish_to: 'none'
environment:
  sdk: ^3.12.0
dependencies:
  flutter:
    sdk: flutter
  material_ui: ^1.0.0
dependency_overrides:
  material_ui: 1.3.0
  cupertino_ui: 1.1.0
```

```dart
// lib/main.dart, Flutter 3.44.8, material_ui 1.3.0
import 'package:material_ui/material_ui.dart';

void main() => runApp(
  const MaterialApp(home: Scaffold(body: Center(child: Text('hi')))),
);
```

`flutter pub get` funciona, `flutter analyze` não reporta erros, e `flutter build web` falha com a saída acima. Sem o override, `flutter pub add material_ui:1.3.0` agora se recusa de imediato com `Because repro depends on material_ui 1.3.0 which doesn't match any versions, version solving failed.`, já que o solver oculta versões retiradas, a menos que estejam fixadas ou já travadas.

## Por que a retirada não corrigiu o seu projeto

Se você executou `pub get` enquanto a 1.3.0 estava no ar, o seu `pubspec.lock` diz `version: "1.3.0"`, e uma retirada não mexe em lockfiles. A [documentação do pub](https://dart.dev/tools/pub/publishing#retract) é explícita de que uma versão retirada já travada continua funcionando. `flutter pub outdated` é a forma mais rápida de confirmar que você está nesse estado:

```text
Package Name              Current             Upgradable          Resolvable          Latest

direct dependencies:
material_ui               *1.3.0 (retracted)  *1.3.0 (retracted)  *1.3.0 (retracted)  1.5.0

transitive dependencies:
cupertino_ui              *1.1.0 (retracted)  *1.1.0 (retracted)  *1.1.0 (retracted)  1.1.1
...
material_ui
    Version 1.3.0 is retracted. See https://dart.dev/go/package-retraction
cupertino_ui
    Version 1.1.0 is retracted. See https://dart.dev/go/package-retraction
```

Olhe as colunas Upgradable e Resolvable: o próprio pub diz que não vai tirar você dali. A mesma documentação do pub recomenda `dart pub upgrade <package>` para sair de uma versão retirada, e no Flutter 3.44 isso não faz nada:

```text
$ flutter pub upgrade material_ui cupertino_ui
  cupertino_ui 1.1.0 (retracted, 1.1.1 available)
  material_ui 1.3.0 (retracted, 1.5.0 available)
No dependencies changed.
```

O motivo está no solver. Em `lib/src/solver/version_solver.dart`, `_getAllowedRetracted` retorna `_lockFile.packages[package]?.version` independentemente de o pacote ter sido destravado para upgrade. Assim, durante o `upgrade`, a versão retirada travada continua sendo uma candidata válida. Toda versão mais nova (1.4.0, 1.5.0, 1.1.1) exige o Flutter 3.47, então a versão mais alta que o solver pode escolher no 3.44 é a retirada que você já tem. O conselho da documentação só funciona quando existe uma versão *compatível* mais nova, e no 3.44 não existe nenhuma.

## Correção 1: ficar no Flutter 3.44 e voltar para material_ui 1.2.0

Você quer que o lockfile pare de mencionar a 1.3.0 e a 1.1.0. A forma mais limpa é fazer downgrade e depois upgrade, para que a versão retirada saia do lock antes de o upgrade rodar:

```bash
# Flutter 3.44.8: escape the retracted versions
flutter pub downgrade material_ui cupertino_ui
flutter pub upgrade
```

O primeiro comando move os dois pacotes para as versões mais baixas que as suas restrições permitem (`material_ui` 1.0.0 e `cupertino_ui` 0.0.2 com `^1.0.0`), o que também limpa as entradas retiradas do `pubspec.lock`. O segundo sobe de volta para as versões não retiradas mais novas que o 3.44 aceita:

```text
> cupertino_ui 1.0.2 (was 0.0.2) (1.1.1 available)
> material_ui 1.2.0 (was 1.0.0) (1.5.0 available)
```

Depois disso, `flutter build web` no 3.44.8 funciona. Apagar à mão as entradas `material_ui` e `cupertino_ui` do `pubspec.lock` e executar `flutter pub get` dá o mesmo resultado (1.2.0 e 1.0.2), e apagar o lockfile inteiro também, embora isso reavalie todo o resto do seu grafo. Não pule o `cupertino_ui`: ele costuma ser uma dependência transitiva, e nomear apenas `material_ui` deixa a 1.1.0 travada e ainda quebrada.

Faça commit do novo `pubspec.lock`. Se o seu CI executa `flutter pub get --enforce-lockfile`, ele instala exatamente o que o lockfile commitado diz, então o build continua falhando lá até que o novo lockfile chegue.

## Correção 2: migrar para o Flutter 3.47, que é o que os pacotes esperam agora

`material_ui` 1.4.0 e posteriores exigem o Flutter 3.47, e novas correções chegam somente lá. Se você pode atualizar, essa é a resposta de longo prazo:

```bash
# Flutter 3.47.6 / Dart 3.13.5
flutter upgrade
flutter pub upgrade
```

No 3.47.6 o upgrade funciona como a documentação do pub descreve, porque agora existem versões compatíveis mais novas:

```text
> cupertino_ui 1.1.1 (was 1.1.0)
> material_ui 1.5.0 (was 1.3.0)
```

A rigor, você nem precisa do upgrade dos pacotes: a 1.3.0 retirada compila normalmente no Flutter 3.47.6, porque `foundation.dart` agora reexporta a anotação. Mesmo assim recomendo executar `flutter pub upgrade` para que o lockfile deixe de apontar para uma versão retirada, o que `flutter pub outdated` continuaria sinalizando.


Migrar para o 3.47 é uma mudança maior que a atualização dos pacotes. Ele traz o Dart 3.13 (que, entre outras coisas, [rejeita `final` em parâmetros comuns](/pt-br/2026/09/fix-dart-3-13-cant-have-modifier-final-here-on-parameters/)) e torna o Impeller o renderizador padrão no desktop, então trate isso como um upgrade planejado, e não como um hotfix.

## Correção 3: manter uma restrição no pubspec.yaml para que isso não se repita no 3.44

Se você vai ficar no 3.44 por um tempo, limite os pacotes explicitamente. Isso documenta a decisão e impede que o `pub upgrade` de um colega se desvie caso outra versão seja publicada com um `environment` errado:

```yaml
# pubspec.yaml, Flutter 3.44.x
dependencies:
  material_ui: ">=1.0.0 <1.3.0"
  cupertino_ui: ">=1.0.0 <1.1.0"
```

Adicione `cupertino_ui` mesmo que você não o importe. Quando limitei apenas `material_ui` e executei `flutter pub get` contra o lockfile quebrado, o pub moveu `material_ui` para a 1.2.0, mas deixou o `cupertino_ui` transitivo na 1.1.0 retirada, porque nada o forçava a mudar. Com os dois limites no lugar, o mesmo `flutter pub get` os moveu para 1.2.0 e 1.0.2.

## Coisas que parecem correções, mas não são

- **Atualizar `meta`.** `meta` 1.18.0 já declara `awaitNotRequired`, e o framework do Flutter 3.44 fixa `meta` exatamente em 1.18.0 no próprio `pubspec.yaml`, então você nem conseguiria atualizá-lo. O problema é a lista `show` em `foundation.dart`, não a versão de `meta`.
- **Declarar o seu próprio `awaitNotRequired`.** A resolução de nomes acontece dentro das bibliotecas do `material_ui`. Uma constante de nível superior no seu app não está no escopo delas.
- **`flutter clean` ou apagar o cache do pub.** A versão ruim é selecionada pelo seu lockfile, não por saída de build antiga, então ela é baixada de novo no próximo `pub get`.
- **Fixar `material_ui: 1.3.0` em `dependencies`.** Uma versão retirada não pode ser selecionada dessa forma. Só `dependency_overrides` pode forçá-la, e isso apenas reproduz o bug.

Se você encontrar `Undefined name` para outro identificador do Flutter depois de migrar para os pacotes independentes, a causa geralmente é o mesmo padrão em outra direção: código compilado contra um framework mais novo que o instalado. `flutter --version` e o bloco `environment` do pacote citado no caminho do erro mostram rapidamente qual lado está à frente.

## Relacionados

- O contexto sobre por que Material e Cupertino saíram do SDK está em [Flutter 3.44 dividindo Material e Cupertino em pacotes](/pt-br/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- Para a migração completa de imports, incluindo `dart fix --code=migrate_design_widgets` e as pontes de compatibilidade, veja [migrando para os pacotes material_ui e cupertino_ui](/pt-br/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/).
- Outra incompatibilidade de tipos entre os dois mundos do Material é abordada em [o erro de TextTheme do google_fonts com material_ui](/pt-br/2026/09/fix-textheme-cant-be-assigned-to-textheme-google-fonts-material-ui/).
- Quando o pub se recusa a resolver em vez de resolver para algo quebrado, comece por [corrigindo "version solving failed" no pubspec.yaml](/pt-br/2026/05/fix-version-solving-failed-in-pubspec-yaml/).
- Antes de migrar para o 3.47, leia sobre [o Impeller se tornando o renderizador padrão do desktop no Flutter 3.47](/pt-br/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/).

## Fontes

- [flutter/flutter#192839: material_ui 1.3.0 & cupertino_ui 1.1.0 on Flutter 3.44 Error: Undefined name 'awaitNotRequired'](https://github.com/flutter/flutter/issues/192839)
- [flutter/flutter#181513: Add @awaitNotRequired annotation to flutter sdk](https://github.com/flutter/flutter/pull/181513)
- [flutter/packages#12622: Add awaitNotRequired annotation to material_ui](https://github.com/flutter/packages/pull/12622) e o revert não mesclado [#12942](https://github.com/flutter/packages/pull/12942)
- [changelog do material_ui](https://pub.dev/packages/material_ui/changelog) e [changelog do cupertino_ui](https://pub.dev/packages/cupertino_ui/changelog)
- [Retract a package version](https://dart.dev/tools/pub/publishing#retract), documentação do Dart
- [`version_solver.dart` em dart-lang/pub](https://github.com/dart-lang/pub/blob/master/lib/src/solver/version_solver.dart)
- [Documentação da API de `awaitNotRequired` em package:meta](https://pub.dev/documentation/meta/latest/meta/awaitNotRequired-constant.html)
