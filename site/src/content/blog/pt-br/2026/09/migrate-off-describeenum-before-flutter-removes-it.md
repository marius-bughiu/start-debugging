---
title: "Migre do describeEnum no Flutter antes que ele seja removido"
description: "O describeEnum está obsoleto desde o Flutter 3.16 e o PR de remoção já foi aprovado. Como substituir cada chamada por Enum.name (Flutter 3.47.4, Dart 3.13), lidar com classes que imitam enums e com diagnósticos, encontrar as chamadas escondidas em dependências como o flutter_svg 1.x e como fica o erro de build depois que ele sumir."
pubDate: 2026-09-18
updatedDate: 2026-09-18
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "enums"
lang: "pt-br"
translationOf: "2026/09/migrate-off-describeenum-before-flutter-removes-it"
translatedBy: "claude"
translationDate: 2026-09-18
---

Para quase todo codebase isso é um buscar e substituir de 30 minutos: `describeEnum(x)` vira `x.name`, `describeEnum` passado como tear-off vira `(e) => e.name`, e os loops de "string de volta para enum" que vinham junto viram `MyEnum.values.byName(s)`. O `dart fix` não faz isso por você, e os únicos pontos de chamada que exigem atenção são os que passam algo que não é um `Enum` de verdade do Dart. O que realmente consome tempo é o seu grafo de dependências: um pacote antigo como o `flutter_svg` 1.1.6 ainda chama `describeEnum`, e no dia em que a função for removida seu app para de compilar em um arquivo que não é seu. Tudo abaixo foi verificado no Flutter 3.47.4 (Dart 3.13.3), o stable atual, e em um build local do Flutter com a remoção pendente aplicada.

## Em que pé a remoção realmente está

A linha do tempo é confusa o suficiente para valer a pena fixá-la antes de mexer no código, porque hoje a documentação oficial e o SDK discordam.

- O `describeEnum` foi marcado como obsoleto em [flutter/flutter#125016](https://github.com/flutter/flutter/pull/125016), que entrou na 3.14.0-2.0.pre e foi lançado no stable 3.16. A mensagem de obsolescência diz "Use the `name` getter on enums instead. This feature was deprecated after v3.14.0-2.0.pre."
- A remoção é o [flutter/flutter#190076](https://github.com/flutter/flutter/pull/190076), aberto em 2026-07-27. Ele apaga a função de `packages/flutter/lib/src/foundation/diagnostics.dart` junto com seus testes. Tem três aprovações, mas, em 2026-09-18, continua aberto: a verificação "Google testing" falha porque o monorepo interno do Google precisa primeiro atualizar o `flutter_svg` para além da 2.0.0.
- O guia de breaking change da remoção ([flutter/website#13682](https://github.com/flutter/website/pull/13682)) foi mesclado em 2026-08-18, e o índice de breaking changes já lista "Removal of `describeEnum`" em **Released in Flutter 3.47**. Isso está à frente da realidade. Conferi o `diagnostics.dart` na tag `3.47.4`, na tag beta `3.48.0-0.5.pre` e no `master`: o `describeEnum` continua definido nos três.

Então nada quebra no canal stable hoje. O que você recebe é uma dica `deprecated_member_use` de nível `info` que a maioria das equipes vem ignorando desde 2023. No momento em que o #190076 for mesclado, o `master` quebra na hora e o próximo beta depois disso quebra para todo mundo no beta. Migrar agora custa o mesmo que migrar depois, só que depois acontece no meio de um upgrade que você queria fazer por outro motivo.

## O que quebra

| Área | Mudança | Severidade |
| ---- | ------ | -------- |
| `describeEnum(value)` no seu código | Erro de compilação: a função não existe mais | alta, mas trivial de corrigir |
| `describeEnum` em uma dependência | Erro de compilação no arquivo do pacote, o app não compila | alta, exige upgrade do pacote |
| `describeEnum` em classes que não são `Enum` | Não há getter `.name` para onde migrar | média, exige um helper local |
| `describeEnum` usado como tear-off (`.map(describeEnum)`) | O mesmo erro de compilação | baixa |
| `StringProperty(name, describeEnum(v))` em `debugFillProperties` | Funciona se reescrito para `.name`, mas `EnumProperty` é o substituto melhor | baixa |
| Suporte do `dart fix` | Nenhum. O guia do Flutter diz isso explicitamente, e `dart fix --dry-run` reporta "Nothing to fix!" | informativo |

## Checklist antes de começar

- Flutter 3.16 ou mais recente. Todo stable desde então traz a obsolescência, então o analyzer consegue encontrar os pontos de chamada para você. O código na 3.47.4 é a referência aqui.
- Dart 2.15 ou mais recente para o getter `name` e para `values.byName`. Os dois vieram com os helpers de enum do `dart:core` no Dart 2.15.0 (o guia do Flutter diz 2.14, mas o changelog do Dart os lista na 2.15.0). Qualquer projeto Flutter 3.x já atende a isso.
- Uma linha de base limpa no `flutter analyze`, para que as dicas de obsolescência não fiquem enterradas sob avisos não relacionados.
- A saída do `flutter pub outdated` do seu app, porque o passo de dependências abaixo pode forçar um salto de versão major.

## Como fica a falha depois da remoção

Para obter o texto real do erro em vez de adivinhar, apliquei o diff do #190076 em um checkout descartável do Flutter 3.47.4 e rodei um projeto de teste contra ele. O analyzer reporta:

```text
error • The function 'describeEnum' isn't defined. Try importing the library that defines 'describeEnum', correcting the name to the name of an existing function, or defining a function named 'describeEnum' • lib/legacy.dart:27:20 • undefined_function
```

`flutter run`, `flutter test` e `flutter build` passam pelo compilador front-end, que imprime:

```text
lib/legacy.dart:27:20: Error: Method not found: 'describeEnum'.
String simple() => describeEnum(ThemeChoice.dark);
                   ^^^^^^^^^^^^
```

E um projeto que depende de `flutter_svg: 1.1.6` falha antes de qualquer código seu rodar, com o erro apontando para dentro do pub cache:

```text
/Users/marius/.pub-cache/hosted/pub.dev/flutter_svg-1.1.6/lib/src/picture_provider.dart:196:33: Error: The method 'describeEnum' isn't defined for the type 'PictureConfiguration'.
      result.write('platform: ${describeEnum(platform!)}');
                                ^^^^^^^^^^^^
```

Se você chegou a este post por causa dessa última mensagem, pule direto para o passo 5.

## Passos da migração

1. **Liste todos os pontos de chamada com o analyzer.**
   Rode `flutter analyze` e filtre pela obsolescência. Na 3.47.4 cada ocorrência é uma linha `info` terminando em `deprecated_member_use`:

   ```bash
   # Flutter 3.47.4
   flutter analyze --no-fatal-infos | grep "'describeEnum' is deprecated"
   ```

   Um simples `grep -rn "describeEnum" lib test` pega os mesmos pontos, mais menções em comentários de documentação e em qualquer arquivo que o seu `analysis_options.yaml` exclua. Verifique: você tem uma lista de arquivos e números de linha, e sabe quais estão em arquivos gerados (regenere esses, não os edite à mão).

2. **Substitua as chamadas em enums reais por `.name`.**
   Para qualquer valor cujo tipo estático seja um `enum`, a reescrita é mecânica. Isso cobre enums simples, enhanced enums, enums anuláveis e tear-offs:

   ```dart
   // Flutter 3.47.4, Dart 3.13
   enum ThemeChoice { light, dark }

   // Before
   String simple() => describeEnum(ThemeChoice.dark);
   String? nullable(ThemeChoice? c) => c == null ? null : describeEnum(c);
   List<String> tearOff() => ThemeChoice.values.map(describeEnum).toList();

   // After
   String simple() => ThemeChoice.dark.name;
   String? nullable(ThemeChoice? c) => c?.name;
   List<String> tearOff() => ThemeChoice.values.map((e) => e.name).toList();
   ```

   O comportamento é idêntico: desde o Flutter 3.0, o `describeEnum` começa com `if (enumEntry is Enum) return enumEntry.name;`, então para enums reais ele já era só um wrapper em volta de `.name`. Isso inclui enhanced enums que sobrescrevem `toString()`. Um enum cujo `toString()` retorna `Level(H)` ainda dava `high` com `describeEnum`, e dá `high` com `.name`. Verifique: o `flutter analyze` não mostra mais dicas para esses arquivos.

3. **Substitua a busca reversa por `values.byName`.**
   A maior parte do código com `describeEnum` fica ao lado de um parser feito à mão que percorre `values` comparando strings. Substitua as duas metades juntas:

   ```dart
   // Flutter 3.47.4, Dart 3.13
   // Before
   Map<String, Object?> toJson(ThemeChoice c) => {'theme': describeEnum(c)};
   ThemeChoice fromJson(Map<String, Object?> json) =>
       ThemeChoice.values.firstWhere((e) => describeEnum(e) == json['theme']);

   // After
   Map<String, Object?> toJson(ThemeChoice c) => {'theme': c.name};
   ThemeChoice fromJson(Map<String, Object?> json) =>
       ThemeChoice.values.byName(json['theme']! as String);
   ```

   As strings serializadas não mudam, então JSON armazenado, shared preferences e eventos de analytics continuam funcionando. O modo de falha muda: para um valor desconhecido, o loop antigo lançava `StateError: Bad state: No element`, enquanto `byName` lança `ArgumentError: Invalid argument (name): No enum value with that name: "blue"`. Se você captura `StateError` em volta desse parse, atualize o `catch`. Verifique: um teste que faz o round trip de cada valor em `ThemeChoice.values` por `toJson`/`fromJson`, mais um teste com uma string desconhecida.

4. **Dê às classes que imitam enums um helper local.**
   O `describeEnum` aceitava `Object`, e para qualquer coisa que não fosse um `Enum` ele pegava o `toString()` e retornava tudo depois do primeiro ponto. Isso era pensado para as classes "tipo enum" de antes do Dart 2.17, como esta, que ainda existem em codebases antigos e em alguns pacotes:

   ```dart
   // Flutter 3.47.4, Dart 3.13
   class Channel {
     const Channel._(this._value);
     final String _value;
     static const Channel stable = Channel._('stable');
     static const Channel beta = Channel._('beta');
     @override
     String toString() => 'Channel.$_value';
   }
   ```

   `Channel.beta.name` não compila, porque não existe `name`. Você tem duas opções. A melhor é converter `Channel` em um `enum` de verdade, o que geralmente é possível agora que enhanced enums suportam campos e construtores. Quando isso não é possível (a classe vem de um pacote, ou tem instâncias não const), copie o ramo de fallback para o seu próprio código:

   ```dart
   // Flutter 3.47.4, Dart 3.13
   /// Local copy of the only describeEnum behaviour `.name` cannot replace.
   String enumLikeName(Object value) {
     final String description = value.toString();
     final int indexOfDot = description.indexOf('.');
     assert(
       indexOfDot != -1 && indexOfDot < description.length - 1,
       'The provided object "$value" is not an enum.',
     );
     return description.substring(indexOfDot + 1);
   }

   String fromObject(Object value) =>
       value is Enum ? value.name : enumLikeName(value);
   ```

   A verificação `value is Enum` importa para pontos de chamada tipados como `Object` ou `dynamic`, que é exatamente onde as pessoas passavam ao `describeEnum` uma mistura de enums e classes tipo enum. Note que o `assert` só roda em builds de debug. Em release, `describeEnum(42)` nunca lançava exceção: `indexOf` retornava -1, `substring(0)` retornava `"42"`, e seu código seguia em frente. O helper mantém esse comportamento de propósito, para que nada mude em produção. Verifique: testes em modo debug para cada tipo que imita enum retornam as mesmas strings de antes.

5. **Corrija as chamadas nas suas dependências.**
   O seu próprio código é a parte fácil. Um pacote que chama `describeEnum` quebra o seu build no dia em que a função desaparecer, e você não consegue corrigi-lo com um buscar e substituir. Fazer grep no pub cache gera muito ruído porque ele guarda todas as versões que você já baixou, então escaneie só as versões de pacote que o seu app realmente resolve, usando `.dart_tool/package_config.json`:

   ```dart
   // Dart 3.13: list every describeEnum call in the packages your app resolves.
   // Save as tool/find_describe_enum.dart, run: dart run tool/find_describe_enum.dart
   import 'dart:convert';
   import 'dart:io';

   void main() {
     final config = File('.dart_tool/package_config.json');
     final json = jsonDecode(config.readAsStringSync()) as Map<String, dynamic>;
     final call = RegExp(r'\bdescribeEnum\s*[(),;]');
     for (final pkg in (json['packages'] as List).cast<Map<String, dynamic>>()) {
       if (pkg['name'] == 'flutter') continue; // defines it
       var rootUri = pkg['rootUri'] as String;
       if (!rootUri.endsWith('/')) rootUri += '/';
       final root = config.parent.uri.resolve(rootUri);
       final lib = Directory.fromUri(root.resolve(pkg['packageUri'] as String));
       if (!lib.existsSync()) continue;
       for (final f in lib.listSync(recursive: true).whereType<File>()) {
         if (!f.path.endsWith('.dart')) continue;
         final lines = f.readAsLinesSync();
         for (var i = 0; i < lines.length; i++) {
           if (call.hasMatch(lines[i]) && !lines[i].trimLeft().startsWith('//')) {
             print('${pkg['name']}: ${f.path}:${i + 1}');
           }
         }
       }
     }
   }
   ```

   A correção da barra final não é enfeite. O `package_config.json` guarda pacotes hospedados como `file:///.../flutter_svg-1.1.6` sem barra final, e resolver `lib/` contra isso aponta silenciosamente para a pasta pai. A primeira versão deste script tinha esse bug e reportou zero ocorrências para o `flutter_svg` 1.1.6. A versão corrigida imprime:

   ```text
   flutter_svg: /Users/marius/.pub-cache/hosted/pub.dev/flutter_svg-1.1.6/lib/src/picture_provider.dart:196
   ```

   Para cada pacote reportado, veja se uma versão mais nova removeu a chamada. Para o `flutter_svg` a resposta é qualquer 2.x: fiz grep na 2.0.0 e na 2.2.1 e nenhuma referencia `describeEnum` (a versão mais recente é a 2.3.0). O salto de 1.x para 2.x é uma migração por si só, porque a 2.0 passou a usar `vector_graphics` e mudou as APIs de carregamento, mas é o mesmo salto que o código interno do Google precisa dar antes que o #190076 possa entrar. Se um pacote estiver abandonado, faça um fork, aplique o passo 2 no fork e aponte uma entrada `dependency_overrides` para ele. Verifique: o script não imprime nenhuma linha para pacotes de terceiros.

6. **Reescreva os diagnósticos para usar `EnumProperty`.**
   Um uso comum dentro de widgets e render objects era o `debugFillProperties`. Uma reescrita mecânica para `.name` compila, mas a propriedade tipada é melhor:

   ```dart
   // Flutter 3.47.4, Dart 3.13
   // Before
   properties.add(StringProperty('choice', describeEnum(choice)));

   // After
   properties.add(EnumProperty<ThemeChoice>('choice', choice));
   ```

   A saída é um pouco diferente. `StringProperty` coloca o valor entre aspas, então o DevTools e o `toStringDeep()` mostravam `choice: "dark"`, enquanto `EnumProperty` imprime `choice: dark`. Se você tem golden tests sobre `toStringDeep()` ou `debugDescribeChildren`, atualize-os. Desde o Flutter 3.16, `EnumProperty<T>` exige `T extends Enum?`, então para uma classe tipo enum use `DiagnosticsProperty<Channel>`. Verifique: os testes de diagnóstico passam depois de regenerar as strings esperadas.

7. **Impeça que a obsolescência volte.**
   `deprecated_member_use` é `info` por padrão, e é por isso que essas chamadas sobreviveram a três anos de obsolescência. Promova-o no `analysis_options.yaml`:

   ```yaml
   # Flutter 3.47.4
   include: package:flutter_lints/flutter.yaml

   analyzer:
     exclude:
       - build/**
       - android/**
     errors:
       deprecated_member_use: error
   ```

   Mescle `errors:` no bloco `analyzer:` que você já tem. Quando acrescentei uma segunda chave `analyzer:` de nível superior, o analyzer não reclamou e continuou reportando `info`, então a promoção parecia aplicada e não estava. Com o bloco mesclado, `flutter analyze --no-fatal-infos` reporta `error` e sai com código 1. Saiba que isso promove todas as obsolescências, não só o `describeEnum`. Se for demais para um único PR, mantenha em `warning` e faça a CI falhar com `--fatal-warnings`. Verifique: adicione uma chamada a `describeEnum` em um arquivo descartável e confirme que a CI falha.

## Verificação

Rodei as versões antes e depois de cada padrão acima lado a lado em um único `flutter test` no Flutter 3.47.4:

| Padrão | Resultado com `describeEnum` | Resultado migrado |
| ------- | --------------------- | --------------- |
| Enum simples | `dark` | `dark` |
| Enhanced enum com override de `toString()` | `high` | `high` |
| Classe tipo enum | `beta` | `beta` |
| Anulável, valor `null` | `null` | `null` |
| Tear-off sobre `values` | `[light, dark]` | `[light, dark]` |
| Valor de enum tipado como `Object` | `light` | `light` |
| Round trip de JSON | `ThemeChoice.dark` | `ThemeChoice.dark` |
| Valor JSON desconhecido | `StateError` | `ArgumentError` |
| `debugFillProperties` | `choice: "dark"` | `choice: dark` |

Depois da migração, o checklist é curto: o `flutter analyze` fica limpo com `deprecated_member_use: error`, o escaneamento de dependências não imprime nada para pacotes de terceiros e a suíte de testes passa. Para ter certeza extra, faça checkout de um branch do Flutter com o #190076 aplicado e rode `flutter test`. Foi assim que as mensagens de erro acima foram capturadas.

## Plano de rollback

Não há nada para reverter no seu próprio código: `.name` e `values.byName` funcionam em todas as versões do Flutter desde a 3.0, então o código migrado roda no SDK que você tem hoje e em todos os SDKs depois da remoção. O único passo que pode doer é um upgrade major de pacote no passo 5. Faça-o em um commit separado, para poder reverter a mudança no `pubspec.yaml` e no `pubspec.lock` isoladamente, mantendo a limpeza do `describeEnum`.

## Armadilhas

- **O `dart fix` não vai ajudar.** Ao contrário da maioria das obsolescências do Flutter, o `describeEnum` não tem uma correção orientada a dados em `packages/flutter/lib/fix_data`, e o guia de remoção afirma que a migração não é suportada pelo `dart fix`. Se você roda um `dart fix` no repositório inteiro para outras migrações, esta continua manual.
- **Não substitua `describeEnum(e)` por `e.toString().split('.').last`.** É a resposta mais comum no Stack Overflow, e está errada para enhanced enums que sobrescrevem `toString()`: `Level.high.toString().split('.').last` retorna `Level(H)`.
- **Código gerado.** Se uma ocorrência do passo 1 está em um arquivo `.g.dart` ou `.freezed.dart`, corrija o gerador (atualize-o ou mude o seu template) e regenere. Editar a saída à mão só dura até a próxima execução do `build_runner`.
- **A documentação diz 3.47, o SDK não.** Se um revisor apontar para o índice de breaking changes e perguntar por que a 3.47.4 ainda compila, é porque o guia foi mesclado antes da mudança no código. Acompanhe o #190076 para saber a data real. O próprio campo "Landed in version" do guia ainda diz TBD.

## Relacionados

- Se você tem uma pilha de obsolescências do Flutter para resolver de uma vez, [rodar o `dart fix` em um repositório inteiro](/pt-br/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/) cuida de tudo que tem uma correção orientada a dados.
- Outra obsolescência que exige reescrita manual: [substituir `groupValue` e `onChanged` obsoletos do `Radio` por `RadioGroup`](/pt-br/2026/08/how-to-replace-flutter-deprecated-radio-groupvalue-and-onchanged-with-radiogroup/).
- A migração maior de grafo de dependências que vem para todo app Flutter: [migrar para os pacotes independentes `material_ui` e `cupertino_ui`](/pt-br/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/).
- Se o parse do seu enum fica dentro da decodificação de JSON, [corrigir `FormatException: Unexpected character` no Dart](/pt-br/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/) cobre a outra metade desse caminho de código.

## Fontes

- [flutter/flutter#190076: Remove deprecated `describeEnum` from framework](https://github.com/flutter/flutter/pull/190076)
- [flutter/flutter#125016: Deprecate `describeEnum`](https://github.com/flutter/flutter/pull/125016)
- [Breaking change do Flutter: Remove describeEnum](https://docs.flutter.dev/release/breaking-changes/remove-describeEnum)
- [Breaking change do Flutter: guia de migração para describeEnum e EnumProperty](https://docs.flutter.dev/release/breaking-changes/describe-enum)
- [Referência da API de `describeEnum`](https://api.flutter.dev/flutter/foundation/describeEnum.html)
- [Referência da API de `EnumProperty`](https://api.flutter.dev/flutter/foundation/EnumProperty-class.html)
- [Linguagem Dart: tipos enumerados](https://dart.dev/language/enums)
- [Changelog do SDK do Dart, 2.15.0](https://github.com/dart-lang/sdk/blob/main/CHANGELOG.md)
- [flutter_svg no pub.dev](https://pub.dev/packages/flutter_svg)
