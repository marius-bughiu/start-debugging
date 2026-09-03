---
title: "Migre as importações de Material e Cupertino do Flutter para os pacotes material_ui e cupertino_ui"
description: "A migração completa de package:flutter/material.dart e package:flutter/cupertino.dart para material_ui 1.1.1 e cupertino_ui 1.0.2: o que dart fix --code=migrate_design_widgets reescreve, por que widgets de terceiros passam a lançar erros de busca de ancestral, o que MaterialUiCompatibilityBridge realmente resolve e como a dependência de flutter_localizations muda."
pubDate: 2026-09-03
updatedDate: 2026-09-03
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "material-design"
  - "cupertino"
lang: "pt-br"
translationOf: "2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages"
translatedBy: "claude"
translationDate: 2026-09-03
---

Para um app cuja única superfície Material é o próprio código, esta é uma migração de um comando e uma tarde: `flutter pub add material_ui`, depois `dart fix --apply --code=migrate_design_widgets`, e então rode os testes. As APIs dos widgets são uma cópia idêntica do que havia no SDK, então nada renderiza diferente e nenhum golden deveria se mover. O que custa tempo de verdade é o grafo de dependências. Cada pacote que ainda importa `package:flutter/material.dart` arrasta para o seu programa uma segunda cópia, incompatível em nível de tipos, de `Theme`, `Material` e `MaterialLocalizations`, e os widgets dele vão falhar na busca de ancestral dentro da sua árvore migrada até você envolver o app em `MaterialUiCompatibilityBridge`. Este guia tem como alvo o canal stable atual, Flutter 3.47.2 com Dart 3.13.2, mais [`material_ui`](https://pub.dev/packages/material_ui) 1.1.1 e [`cupertino_ui`](https://pub.dev/packages/cupertino_ui) 1.0.2.

O relógio importa aqui. As bibliotecas dentro do SDK já estão congeladas, e a depreciação formal está agendada para a versão stable de novembro de 2026.

## Por que isso não é uma limpeza opcional

- **As cópias dentro do SDK não recebem correções.** O Flutter fechou os diretórios de Material e Cupertino em `flutter/flutter` para qualquer contribuição em 2026-04-07. Desde então, toda correção de bug caiu em `flutter/packages`. O `material_ui` 1.1.1 já traz correções que a cópia do SDK nunca vai receber, incluindo a condição de corrida do `SearchAnchor` em que um conjunto de sugestões assíncronas desatualizado substituía um mais novo, e os rótulos do indicador de valor do `Slider` sendo cortados em vez de reticenciados na borda da tela.
- **As atualizações de design param de esperar o trem do SDK.** Material e Cupertino costumavam ser publicados na cadência trimestral do Flutter, então um ajuste de token ou um novo argumento de `MenuAnchor` esperava o corte stable seguinte. Fixar `material_ui: ^1.1.1` desacopla isso: 1.1.0 e 1.1.1 saíram ambas entre a stable 3.47 e hoje.
- **Você finalmente pode descartar um design system que nunca usou.** Depois que as cópias do SDK forem removidas, um app só de Cupertino para de carregar o theming, a tipografia e os metadados de ícones do Material pelo tree-shaking, e vice-versa.
- **As localizações se mudam junto com os widgets.** As strings traduzidas e os delegates de Material e Cupertino agora vivem dentro dos pacotes, e é por isso que `flutter_localizations` deixa de ser algo que você declara.
- **Se você publica um pacote, você é um bloqueio.** Um único pacote folha não migrado impõe a ponte de compatibilidade a todos abaixo dele.

## O que quebra

| Área | Mudança | Severidade |
| ---- | ------- | ---------- |
| Importações | `package:flutter/material.dart` passa a ser `package:material_ui/material_ui.dart`; `package:flutter/cupertino.dart` passa a ser `package:cupertino_ui/cupertino_ui.dart` | alta, totalmente automatizável |
| Identidade de tipos | O `Material` do SDK e o `Material` do `material_ui` são tipos diferentes em runtime, então buscas de ancestral não cruzam a fronteira | alta, exige a ponte |
| Delegates de localização | `GlobalMaterialLocalizations` e `GlobalCupertinoLocalizations` vêm dos pacotes, não de `flutter_localizations` | média |
| `pubspec.yaml` | Duas novas dependências diretas; `flutter_localizations` não é mais uma dependência direta necessária | média |
| Código gerado | Tudo que emite `package:flutter/material.dart` em um arquivo `.g.dart` ou `.freezed.dart` precisa ser regerado após a passada no código-fonte | média |
| Pacotes publicados | Migrar seu próprio pacote é uma mudança incompatível para quem o consome, então exige um incremento de versão maior | média |
| APIs dos widgets | Nenhuma. Construtores, parâmetros e renderização seguem iguais | nenhuma |

Essa última linha é toda a razão de esta migração ser viável. O `material_ui` 1.0.0 é uma cópia da biblioteca embutida como ela estava no congelamento de abril de 2026, não um redesenho.

## Checklist de pré-voo

- Flutter 3.44 ou mais novo. O `material_ui` elevou seu piso para Flutter 3.44 / Dart 3.12 quando o código saiu de `flutter/flutter`, e 3.47.2 é a stable atual. Confira com `flutter --version`.
- Um `flutter analyze` limpo antes de começar. Você quer que a execução pós-migração seja comparável.
- Um branch. `dart fix --apply` reescreve todo arquivo correspondente em uma única passada e não existe flag de desfazer.
- Um inventário das dependências que renderizam widgets Material ou Cupertino. `flutter pub deps --style=compact` mais `flutter pub outdated` te dão a lista; qualquer coisa publicada por último antes de agosto de 2026 não migrou.
- Se você tem testes golden, rode-os primeiro e comite a linha de base. Eles não deveriam mudar, e essa é justamente a afirmação.

## Passos da migração

1. **Adicione os pacotes antes de mexer em uma única importação.** A regra do `dart fix` reescreve strings de importação; ela não edita `pubspec.yaml`. Faça na ordem errada e você fica com um arquivo cheio de importações não resolvidas.

   ```sh
   # Flutter 3.47.2, Dart 3.13.2
   flutter pub add material_ui
   flutter pub add cupertino_ui
   ```

   Isso resolve hoje para `material_ui: ^1.1.1` e `cupertino_ui: ^1.0.2`. Se o seu app é só Material, você ainda recebe `cupertino_ui` transitivamente, porque o `material_ui` depende de `cupertino_ui: ^1.0.0` desde a versão 1.0.1, mas declare-o explicitamente se você o importa diretamente. Verifique com `flutter pub deps --style=compact | grep -E 'material_ui|cupertino_ui'` e confirme que os dois resolvem.

2. **Reescreva as importações com a correção que já vem nos pacotes.** Ambos registram a mesma correção do analisador, então um comando cobre Material e Cupertino de uma vez.

   ```sh
   dart fix --dry-run --code=migrate_design_widgets   # review first
   dart fix --apply  --code=migrate_design_widgets
   ```

   O resultado é um diff de uma linha por arquivo:

   ```dart
   // Before: Flutter 3.43 and earlier
   import 'package:flutter/material.dart';

   // After: material_ui 1.1.1
   import 'package:material_ui/material_ui.dart';
   ```

   Nada abaixo da linha de importação muda. `MaterialApp`, `Scaffold`, `ThemeData`, `Colors`, `showDialog` e todos os outros nomes são exportados com o mesmo identificador. Verifique com `grep -rn "package:flutter/material.dart\|package:flutter/cupertino.dart" lib test` retornando nada, e depois `flutter analyze`.

3. **Aponte os delegates de localização para os pacotes.** Os delegates e as strings traduzidas se mudaram para `material_ui` e `cupertino_ui`, e os pacotes expõem um getter agregado que evita listar três delegates na mão.

   ```dart
   // Before: flutter_localizations, Flutter 3.43
   import 'package:flutter_localizations/flutter_localizations.dart';

   localizationsDelegates: const <LocalizationsDelegate<Object>>[
     GlobalMaterialLocalizations.delegate,
     GlobalCupertinoLocalizations.delegate,
     GlobalWidgetsLocalizations.delegate,
   ],
   ```

   ```dart
   // After: material_ui 1.1.1
   import 'package:material_ui/material_ui.dart';

   localizationsDelegates: GlobalMaterialLocalizations.delegates,
   ```

   `GlobalMaterialLocalizations.delegates` já inclui os delegates de Cupertino e de Widgets. Se você também usa `gen-l10n`, seu `AppLocalizations.delegate` gerado não é afetado e entra nessa lista como antes. Agora você pode remover `flutter_localizations` das suas próprias `dependencies`, embora ele permaneça no `pubspec.lock`: o `cupertino_ui` 1.0.2 ainda depende dele, junto de `collection: ^1.19.1` e `intl: ^0.20.2`. Verifique iniciando com um locale diferente de inglês e checando uma string embutida, por exemplo pressione e segure um `TextField` e confirme que a opção de colar está traduzida.

4. **Faça a ponte para as dependências que não migraram.** Este é o passo que as pessoas pulam e depois depuram por uma hora. Envolva no nível do app com `MaterialApp.builder`:

   ```dart
   // material_ui 1.1.1
   MaterialApp(
     theme: ThemeData(useMaterial3: true),
     builder: (BuildContext context, Widget? child) {
       return MaterialUiCompatibilityBridge(child: child!);
     },
     home: const HomeScreen(),
   )
   ```

   O lado Cupertino é simétrico:

   ```dart
   // cupertino_ui 1.0.2
   CupertinoApp(
     builder: (BuildContext context, Widget? child) {
       return CupertinoUiCompatibilityBridge(child: child!);
     },
     home: const HomeScreen(),
   )
   ```

   Você também pode envolver uma subárvore mais estreita se apenas uma tela embute widgets legados, o que mantém os inherited widgets extras fora do resto da árvore. Verifique navegando por todas as telas que hospedam um widget de terceiros. A ponte é um andaime temporário: apague-a quando `flutter pub outdated` não mostrar mais nada usando as importações antigas.

5. **Regenere tudo que um gerador de código escreveu.** O `dart fix` vê o seu código-fonte, não os templates que o produziram. Rode o gerador de novo depois do passo 2 para que os arquivos emitidos parem de importar a biblioteca do SDK:

   ```sh
   dart run build_runner build --delete-conflicting-outputs
   ```

   Depois confira os restos que o `dart fix` não alcança: arquivos barrel com `export` que reexportam Material para quem consome, importações condicionais que escolhem uma implementação de Material por plataforma, e qualquer template de gerador seu com o caminho de importação escrito à mão como string. Verifique com o mesmo `grep` do passo 2, ampliado para o repositório inteiro em vez de apenas `lib` e `test`.

6. **Se você publica um pacote, incremente a versão maior.** Trocar um pacote publicado para `material_ui` muda o que quem consome precisa ter no próprio `pubspec.yaml`. Publicar isso como versão menor quebra apps em silêncio: a árvore de widgets deles acaba misturando origens sem nenhum erro de compilação para apontar. Suba para a próxima versão maior, registre no changelog a restrição de `material_ui` necessária, e mantenha a versão maior anterior em um branch de manutenção se você dá suporte a versões antigas do Flutter. Verifique com `dart pub publish --dry-run`.

## Verificação

- `flutter analyze` reporta a mesma contagem da sua linha de base pré-migração, sem `uri_does_not_exist` e sem `deprecated_member_use` em linha de importação.
- `grep -rn "package:flutter/material.dart\|package:flutter/cupertino.dart" .` não acha nada fora de `.dart_tool` e `pubspec.lock`.
- `flutter test` passa, testes golden incluídos e inalterados. Um golden que se move significa que duas cópias da biblioteca estão renderizando na mesma árvore, não que o Material mudou.
- O app roda em um dispositivo e toda tela que embute um widget de terceiros renderiza com o seu tema, não com os padrões.
- Um locale diferente de inglês continua exibindo strings embutidas traduzidas depois do passo 3.
- `flutter build apk --release --analyze-size` (ou o equivalente de iOS) como linha de base de tamanho para depois, quando as cópias do SDK forem removidas e o tree-shaking puder de fato descartar o design system que você não usa.

## Plano de rollback

Totalmente reversível hoje. As mudanças são um diff de `pubspec.yaml`, uma linha de importação por arquivo, uma lista de delegates e um widget de ponte opcional, então um `git revert` do commit de migração te devolve às bibliotecas do SDK sem nenhum dado ou artefato de build para desfazer. Duas ressalvas: não existe `dart fix` reverso, então um rollback manual significa editar cada importação de volta na mão, e é por isso que o passo zero é um branch. E depois da stable de novembro de 2026, reverter te estaciona em APIs formalmente depreciadas que serão removidas, então trate o rollback como uma forma de desbloquear um release, não como uma decisão.

## Detalhes que pegam

**"Could not find an ancestor of type MaterialLocalizations" em código que você não escreveu.** É o problema de identidade de tipos aparecendo em runtime. Um widget compilado contra a biblioteca do SDK chama `MaterialLocalizations.of(context)`, que percorre a árvore procurando o inherited widget do *seu* tipo `MaterialLocalizations`. Seu `MaterialApp` do `material_ui` inseriu um tipo diferente com o mesmo nome, a busca não acha, e o assert dispara. `Theme.of(context)` falha da mesma forma, com "Could not find an ancestor of type Theme". A ponte do passo 4 existe exatamente para inserir os inherited widgets legados ao lado dos novos, de modo que as duas buscas resolvam. Ela não é remendo para um `Scaffold` ausente: se o erro vem do seu próprio código migrado, você tem o problema comum descrito em [no Material widget found no Flutter](/pt-br/2026/08/fix-no-material-widget-found-in-flutter/), e a ponte não vai ajudar.

**Importação não resolvida logo depois de rodar a correção.** Você rodou `dart fix` antes de `flutter pub add`. Adicione o pacote e rode `dart fix --apply --code=migrate_design_widgets` de novo; a regra é idempotente.

**Não deixe as duas importações no mesmo arquivo.** `package:flutter/material.dart` e `package:material_ui/material_ui.dart` exportam os mesmos identificadores, então qualquer arquivo com as duas recebe erros de importação ambígua em `Material`, `Theme`, `Colors` e companhia. Prefixar uma delas compila, mas te dá dois design systems em um arquivo, o que é pior que o erro. Escolha um por arquivo.

**A data do congelamento e a da depreciação não são a mesma.** O [anúncio do congelamento de código](https://flutter.dev/blog/flutters-material-and-cupertino-code-freeze) dizia que as bibliotecas do SDK seriam depreciadas na versão stable *seguinte* à 3.44. Isso escorregou: a 3.47 saiu em 2026-08-12 sem a depreciação, e [as notas da versão 3.47](https://flutter.dev/blog/whats-new-in-flutter-3-47) agora colocam a depreciação formal na stable de novembro. Congeladas desde abril, depreciadas em novembro, removidas depois. Planeje contra novembro, não contra aquilo sobre o que o seu analisador está calado hoje.

**Manifestos de assets podem mudar mesmo que os widgets não.** O `material_ui` 1.1.0 expôs o asset do shader `ink_sparkle` pelo próprio `pubspec.yaml` e descartou o shader `stretch_effect`. Se você faz asserções sobre o manifesto de assets ou remove assets não usados em um passo de build, esse é um diff real para revisar.

**Migre importações e versões do Flutter em commits separados.** Se você pular versões do SDK na mesma passada, qualquer regressão visual terá duas causas candidatas. Faça a atualização do SDK primeiro, confirme que o app está limpo, e só então migre as importações.

## Relacionado

- O anúncio ao qual esta migração dá sequência, incluindo o padrão SwiftPM que chegou na mesma versão, está em [Flutter 3.44 tira Material e Cupertino do SDK](/pt-br/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- Estruturalmente esta é a mesma forma de passada ampla e mecânica de [migrar um app web Flutter de dart:html para package:web](/pt-br/2026/09/migrate-a-flutter-web-app-from-dart-html-to-package-web/), inclusive na parte em que o `dart fix` cuida dos 95 % fáceis e o grafo de dependências cuida de você.
- Para uma depreciação que o `dart fix` explicitamente não consegue automatizar, compare com [substituir Radio.groupValue e onChanged por RadioGroup](/pt-br/2026/08/how-to-replace-flutter-deprecated-radio-groupvalue-and-onchanged-with-radiogroup/).
- Se você também vai para a stable atual neste ciclo, leia [o que o Flutter 3.47 mudou na renderização em desktop](/pt-br/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/) antes de atribuir uma regressão visual à troca de pacotes.
- Falhas de busca de ancestral são uma família, não um caso isolado. [ScaffoldMessenger.of(context) does not contain a Scaffold](/pt-br/2026/07/fix-scaffoldmessenger-of-context-does-not-contain-a-scaffold-in-flutter/) é o mesmo método de depuração aplicado a outro inherited widget.

## Fontes

- [material_ui no pub.dev](https://pub.dev/packages/material_ui), versão 1.1.1, e seu [changelog](https://pub.dev/packages/material_ui/changelog)
- [cupertino_ui no pub.dev](https://pub.dev/packages/cupertino_ui), versão 1.0.2
- [Flutter's Material and Cupertino code freeze](https://flutter.dev/blog/flutters-material-and-cupertino-code-freeze), o blog do Flutter
- [What's new in Flutter 3.44](https://flutter.dev/blog/whats-new-in-flutter-3-44), o blog do Flutter
- [What's new in Flutter 3.47](https://flutter.dev/blog/whats-new-in-flutter-3-47), o blog do Flutter
- [Issue de acompanhamento do desacoplamento do design system](https://github.com/flutter/flutter/issues/172932), flutter/flutter
- [Notas da versão Flutter 3.47.0](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0), docs.flutter.dev
