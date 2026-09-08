---
title: "Como rodar dart fix no repositório inteiro para aplicar as migrações de breaking changes do Flutter"
description: "O dart fix aceita um único diretório de destino e esse diretório pode ser a raiz do repositório: o analisador abre um contexto por pubspec.yaml aninhado e migra todos os pacotes em uma passada. Aqui está a superfície completa de flags, as quatro coisas que silenciam as correções e fazem um repo sujo relatar Nothing to fix, por que o código de saída é inútil no CI, e um caso em que uma transformação do Flutter gera código que não compila."
pubDate: 2026-09-08
template: how-to
tags:
  - "flutter"
  - "dart"
  - "migration"
  - "tooling"
  - "how-to"
lang: "pt-br"
translationOf: "2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations"
translatedBy: "claude"
translationDate: 2026-09-08
---

`dart fix --apply` aceita um único diretório de destino, e esse diretório pode ser a raiz do seu repositório. O analisador abre um contexto de análise para cada `pubspec.yaml` aninhado abaixo dele, então um monorepo com uma dúzia de pacotes migra com um comando só, respeitando o `analysis_options.yaml` de cada pacote. O motivo de uma execução no repositório inteiro tantas vezes imprimir `Nothing to fix!` em uma base de código visivelmente cheia de avisos de depreciação não é que a ferramenta esteja quebrada: quatro coisas sem relação entre si suprimem as correções, e o `dart fix` sai com 0 em todos esses casos. Também não existe um comando `flutter fix`, apesar da página de documentação chamada Flutter fix. Tudo abaixo foi rodado no Flutter 3.44.8 com Dart 3.12.2; a superfície do comando e as entranhas citadas aqui não mudaram no branch main do SDK do Dart que alimenta a linha estável atual, Flutter 3.47.

## A superfície inteira do comando são quatro flags

Antes de desenhar um fluxo de trabalho para o repositório todo em torno dessa ferramenta, ajuda saber o quão pouco existe nela:

```console
$ dart fix --help
Apply automated fixes to Dart source code.

This tool looks for and fixes analysis issues that have associated automated fixes.

To use the tool, run either 'dart fix --dry-run' for a preview of the proposed changes for a project, or 'dart fix --apply' to apply the changes.

Usage: dart fix [arguments]
-h, --help                      Print this usage information.
-n, --dry-run                   Preview the proposed changes but make no changes.
    --apply                     Apply the proposed changes.
    --code=<code1,code2,...>    Apply fixes for one (or more) diagnostic codes.
```

É isso. Existem dois flags ocultos em `pkg/dartdev/lib/src/commands/fix.dart` (`--compare-to-golden`, para os testes do próprio SDK, e `--use-aot-snapshot`), e nenhum deles é útil para você. Não há `--exclude`, não há suporte a glob, não há argumento de múltiplos caminhos. Exatamente um destino posicional, um arquivo ou um diretório, com padrão no diretório atual. Se você não passar nem `--apply` nem `--dry-run`, ou passar os dois, o comando imprime o uso e retorna 0 sem fazer nada.

A outra coisa que vale checar cedo:

```console
$ flutter fix --dry-run
Could not find a command named "fix".
```

A página de documentação [Flutter fix](https://docs.flutter.dev/tools/flutter-fix) descreve um recurso, não um comando. Você roda `dart fix`, e desde que o `dart` no seu `PATH` seja o que vem junto com o SDK do Flutter (`$FLUTTER_ROOT/bin/dart`), ele resolve os dados de migração do framework automaticamente.

## Uma execução na raiz cobre todos os pacotes aninhados

Essa é a parte que a maioria dos times erra, geralmente escrevendo um laço com `find` antes de checar se ele é necessário. Pegue um pub workspace com três membros:

```yaml
# pubspec.yaml at the repo root, Dart 3.12.2
name: mono_root
environment:
  sdk: ^3.12.0
workspace:
  - packages/pkg_a
  - packages/pkg_b
  - apps/app
```

Um comando na raiz, um relatório cobrindo os três:

```console
$ dart fix --dry-run
Computing fixes in mono (dry run)...

6 proposed fixes in 3 files.

apps/app/lib/main.dart
  prefer_const_constructors - 1 fix
  prefer_final_locals - 1 fix

packages/pkg_a/lib/a.dart
  prefer_const_constructors - 1 fix
  prefer_final_locals - 1 fix

packages/pkg_b/lib/b.dart
  prefer_const_constructors - 1 fix
  prefer_final_locals - 1 fix
```

Isso não é um recurso de workspace. Dois pacotes irmãos sem nenhum `pubspec.yaml` na raiz recebem o mesmo tratamento, porque o analisador descobre as raízes de contexto percorrendo a árvore de diretórios em busca de arquivos `pubspec.yaml` e `analysis_options.yaml`. Cada pacote mantém sua própria configuração de lints durante essa execução única, então um pacote que adota `prefer_final_locals` recebe essas correções enquanto o vizinho não.

O `dart fix` também itera. `FixCommand.maxPasses` vale 4, e ele reexecuta todo o cálculo até que nenhuma edição nova seja produzida ou até bater nesse teto. Dá para ver o efeito em uma única instrução: `var b = Box(1);` vira `final b = const Box(1);`, o que exige que `prefer_final_locals` e `prefer_const_constructors` disparem em passadas separadas sobre a mesma linha.

## Por que um pacote relata "Nothing to fix!" estando cheio de APIs depreciadas

Quatro mecanismos distintos produzem a mesma saída e o mesmo código de saída. Elimine-os nesta ordem.

**O pacote não está resolvido.** O `dart fix` precisa de um `.dart_tool/package_config.json` para saber o que `package:lib_pkg/api.dart` significa, e sem ele não existe diagnóstico `deprecated_member_use` ao qual anexar uma correção. Mesmo repositório, mesmo arquivo, antes e depois de um `pub get`:

```console
$ dart fix --dry-run          # no pub get yet
Computing fixes in app (dry run)...
Nothing to fix!

$ dart pub get && dart fix --dry-run
Computing fixes in app (dry run)...

1 proposed fix in 1 file.

lib/main.dart
  deprecated_member_use - 1 fix
```

Num monorepo esse é o culpado de sempre: o CI resolveu o app mas não os seis pacotes folha, então a migração cobre silenciosamente uma fração da árvore.

**Os arquivos estão excluídos da análise.** Uma lista `exclude`, tipicamente adicionada anos atrás para manter código gerado fora do relatório de lints, também remove esses arquivos do conjunto de correções:

```yaml
# analysis_options.yaml
analyzer:
  exclude:
    - lib/main.dart
```

```console
$ dart fix --dry-run
Nothing to fix!
```

**O diagnóstico foi rebaixado para `ignore`.** Esse é o mais destrutivo, porque é a jogada padrão quando uma atualização do Flutter inunda o CI com avisos de depreciação:

```yaml
analyzer:
  errors:
    deprecated_member_use: ignore
```

Silenciar o aviso também desativa a migração automática correspondente. Se o seu repo tem essa linha, remova antes de rodar o `dart fix`, não depois.

**A linha carrega um comentário `// ignore:`.** Mesmo efeito, na granularidade de arquivo ou de linha. Um `// ignore_for_file: deprecated_member_use` no topo de um arquivo de widgets grande faz o `dart fix` pular o arquivo inteiro sem dizer nada.

Para correções vindas de lints há um quinto caso que é por design e não uma armadilha: uma correção só existe se o lint estiver habilitado. `--code` não sobrepõe isso.

```console
$ dart fix --dry-run --code=prefer_final_locals   # lint not in analysis_options.yaml
Nothing to fix!
```

Adicione a regra e o mesmo comando encontra a correção. Isso rende um padrão útil de uso único: habilite temporariamente um lint de limpeza, rode `dart fix --apply --code=<esse lint>` e então decida se mantém a regra ligada.

Nenhum desses cinco casos muda o status de saída. Toda execução acima retornou 0. A única invocação que retorna diferente de zero é um código de diagnóstico desconhecido:

```console
$ dart fix --apply --code=this_is_not_a_real_code
Computing fixes in app...
Unable to compute fixes: The diagnostic 'this_is_not_a_real_code' is not defined by the analyzer.
$ echo $?
3
```

O que vale saber, porque significa que um erro de digitação em um script de CI falha alto em vez de pular a migração.

## Rodando no repositório inteiro, em ordem

1. **Atualize o SDK e então remova os supressores.** Transformações de depreciação só existem para APIs que o analisador enxerga como depreciadas, então `flutter upgrade` vem primeiro. Depois procure `deprecated_member_use: ignore` em cada `analysis_options.yaml` e `ignore_for_file: deprecated_member_use` em `lib/`, e apague. Pule isso e os passos 3 e 4 vão relatar um repo limpo.

2. **Resolva cada pacote.** Dentro de um pub workspace, um único `dart pub get` em qualquer lugar resolve tudo (rodar em um pacote membro imprime `Resolving dependencies in /path/to/root` e escreve o `.dart_tool` da raiz). Fora de um workspace, cada pacote com resolução própria precisa do seu próprio `pub get`.

3. **Rode uma vez na raiz e leia o relatório.** `dart fix --dry-run` a partir da raiz do repositório, e confira se a lista de arquivos menciona todos os pacotes que você espera. Um pacote ausente do relatório é um pacote que falhou no passo 2 ou que está excluído da análise, não um pacote limpo.

4. **Recorra a um laço por pacote apenas se o passo 3 ficou aquém.** Para repos onde os pacotes não podem ser resolvidos de um lugar só, isso cobre tudo e é idempotente:

   ```bash
   #!/usr/bin/env bash
   # tool/dart_fix_repo.sh - Flutter 3.44.8, Dart 3.12.2
   set -euo pipefail

   find . -name pubspec.yaml \
     -not -path '*/.*' \
     -not -path '*/build/*' \
     -not -path '*/ephemeral/*' \
     -print | while read -r manifest; do
       pkg=$(dirname "$manifest")
       echo "==> $pkg"
       ( cd "$pkg" && dart pub get >/dev/null && dart fix --apply "$@" )
     done

   dart format .
   ```

   Os filtros `-not -path` importam: `build/` e os diretórios `ephemeral/` sob `windows/`, `linux/` e `macos/` contêm arquivos `pubspec.yaml` gerados que você não quer tocar. Se você já usa [Melos](https://melos.invertase.dev/), `melos exec -- "dart pub get && dart fix --apply"` faz a mesma coisa com os flags de filtragem que você já tem configurados.

5. **Formate, depois analise, depois rode os testes.** Nessa ordem, e não pule o último. Os detalhes vêm abaixo.

## Um diagnóstico por commit

Um diff de `dart fix --apply` com 400 arquivos é irrevisável. `--code` aceita uma lista separada por vírgulas, então divida a execução em commits que um humano consiga ler de verdade:

```bash
dart fix --apply --code=deprecated_member_use
git commit -am "chore: apply Flutter deprecation migrations via dart fix"

dart fix --apply --code=prefer_const_constructors,prefer_const_literals_to_create_immutables
git commit -am "chore: const cleanup via dart fix"
```

O relatório do dry run imprime os comandos exatos para os códigos que encontrou, o que torna esse planejamento barato.

## De onde vêm as migrações

Correções de depreciação são dados, não lógica de compilador. Um pacote as declara em `lib/fix_data.yaml`, e o analisador as recolhe de qualquer dependência resolvida. No Flutter 3.44.8 o framework traz 30 arquivos desses em `packages/flutter/lib/fix_data/`, contendo 381 transformações, mais 8 em `flutter_test`, 2 em `flutter_driver` e 1 em `integration_test`. Os tipos de mudança, por frequência em `package:flutter`: 418 `removeParameter`, 228 `addParameter`, 204 `fragment`, 158 `rename`, 90 `renameParameter`, 16 `import`, 12 `addTypeParameter`, 11 `replacedBy`, 1 `changeParameterType`.

O mesmo mecanismo está disponível para os seus pacotes internos, o que é a coisa de maior alavancagem neste artigo se você mantém um design system compartilhado. Deprecie o membro antigo e então descreva a reescrita:

```dart
// lib_pkg/lib/api.dart
class Report {
  @Deprecated('Use render() instead. Removed in lib_pkg 3.0.0.')
  String toHtml() => render();
  String render() => '<html/>';
}
```

```yaml
# lib_pkg/lib/fix_data.yaml - Dart 3.12.2
version: 1
transforms:
  - title: "Rename to 'render'"
    date: 2026-09-01
    element:
      uris: ['api.dart']
      method: 'toHtml'
      inClass: 'Report'
    changes:
      - kind: 'rename'
        newName: 'render'
```

Todo consumidor que rodar `dart fix --apply` depois de subir a dependência recebe `r.toHtml()` reescrito para `r.render()`. A lista `uris` precisa conter o caminho da biblioteca pública que os consumidores importam, não o arquivo em `src/` onde a classe é declarada. Esse único detalhe é o motivo mais comum de um `fix_data.yaml` escrito à mão não fazer nada.

## dart fix não é um compilador, e vai te entregar código que não builda

É por isso que o passo 5 acima termina em analisar e testar, e não em commitar. Um widget mínimo usando duas APIs depreciadas do Flutter:

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'package:flutter/material.dart';

class Card1 extends StatelessWidget {
  const Card1({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Colors.black.withOpacity(0.5),
      child: ListView(
        cacheExtent: 250.0,
        children: const [Text('hi')],
      ),
    );
  }
}
```

`dart fix --apply` relata `deprecated_member_use - 2 fixes` e reescreve as duas. A transformação do `withOpacity` está correta. A do `cacheExtent` não:

```dart
color: Colors.black.withValues(alpha: 0.5),
child: ListView(
  scrollCacheExtent: ScrollCacheExtent.pixels(250.0), children: const [Text('hi')],
),
```

```console
$ flutter analyze
error - Undefined name 'ScrollCacheExtent'. Try correcting the name to one that is defined,
        or defining the name - lib/main.dart:11:28 - undefined_identifier
```

`ScrollCacheExtent` é declarado em `packages/flutter/lib/src/rendering/viewport.dart` e exportado apenas de `package:flutter/rendering.dart`. Nem `material.dart` nem `widgets.dart` reexportam, e a transformação em `fix_widgets.yaml` usa `addParameter` sem uma mudança `import` acompanhando. A reescrita está semanticamente certa e o arquivo não compila mais. Adicionar `import 'package:flutter/rendering.dart';` resolve, e o `flutter analyze` fica verde.

Esse modo de falha se generaliza. O `dart fix` edita faixas de tokens descritas em YAML; ele não faz checagem de tipos do resultado, e não faz ideia se o símbolo que acabou de escrever está no escopo. Mudanças de comportamento são piores que erros de compilação aqui, porque nada as pega, que é o mesmo motivo pelo qual a [separação dos pacotes Material e Cupertino](/pt-br/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/) e a [reescrita de Radio para RadioGroup](/pt-br/2026/08/how-to-replace-flutter-deprecated-radio-groupvalue-and-onchanged-with-radiogroup/) precisam de uma rodada de testes depois da passada automática, e não só de um analyze.

Um consolo: um arquivo com erro de sintaxe não envenena a execução. O `dart fix` continua calculando e aplicando correções em todos os outros arquivos do mesmo pacote.

## Sempre siga com dart format

A ferramenta aplica edições, ela não reflui o resultado. Repare onde o `children` foi parar acima. `dart format .` restaura:

```dart
child: ListView(
  scrollCacheExtent: ScrollCacheExtent.pixels(250.0),
  children: const [Text('hi')],
),
```

Coloque o passo de formatação no mesmo commit da correção, senão o editor da próxima pessoa faz isso e o blame fica pior.

## Colocando uma trava no CI

Como o código de saída é sempre 0, uma checagem de CI precisa olhar a árvore de trabalho em vez disso. Aplique as correções e deixe o git decidir:

```yaml
# .github/workflows/analyze.yml
- run: dart pub get
- run: dart fix --apply
- run: git diff --exit-code
```

Verificado localmente: com uma correção pendente commitada no branch, `git diff --exit-code` retorna 1 e o job falha; sem nada a corrigir, retorna 0. Combine com uma matriz se você [builda contra mais de uma versão do Flutter](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/), já que as transformações disponíveis diferem por SDK e uma correção pendente no 3.47 pode não existir no 3.44.

O fluxo que realmente se sustenta ao longo de uma base de código de vários anos é sem graça: atualize o SDK, apague os supressores, resolva tudo, rode o dry run na raiz, aplique um código de diagnóstico por vez, formate, analise, teste, commite. As 392 transformações do framework vão fazer a maior parte da digitação. A parte que elas não fazem é aquela em que você lê o diff.

## Relacionados

- [Migre as importações de Material e Cupertino do Flutter para os pacotes material_ui e cupertino_ui](/pt-br/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/)
- [Migre um app web Flutter de dart:html para package:web e dart:js_interop](/pt-br/2026/09/migrate-a-flutter-web-app-from-dart-html-to-package-web/)
- [Como substituir groupValue e onChanged obsoletos do Radio no Flutter por RadioGroup](/pt-br/2026/08/how-to-replace-flutter-deprecated-radio-groupvalue-and-onchanged-with-radiogroup/)
- [Migre um app Flutter 2 para o Flutter 3.x: o checklist de null safety](/pt-br/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/)
- [Como mirar várias versões do Flutter a partir de um único pipeline de CI](/pt-br/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)

## Fontes

- [dart fix](https://dart.dev/tools/dart-fix), documentação da ferramenta Dart
- [Flutter fix](https://docs.flutter.dev/tools/flutter-fix), documentação da ferramenta Flutter
- [Breaking changes and migration guides](https://docs.flutter.dev/release/breaking-changes), documentação de releases do Flutter
- [`pkg/dartdev/lib/src/commands/fix.dart`](https://github.com/dart-lang/sdk/blob/main/pkg/dartdev/lib/src/commands/fix.dart), SDK do Dart
- [`pkg/dartdev/doc/dart-fix.md`](https://github.com/dart-lang/sdk/blob/main/pkg/dartdev/doc/dart-fix.md), SDK do Dart
- [Data driven fixes](https://dart.dev/go/data-driven-fixes), especificação do Dart para `fix_data.yaml`
- [Pub workspaces](https://dart.dev/tools/pub/workspaces), documentação de gerenciamento de pacotes do Dart
- [Customizing static analysis](https://dart.dev/tools/analysis), documentação do analisador do Dart
