---
title: "Migre transições de página personalizadas após a reorganização dos page transition builders do Flutter (Flutter 3.44 a 3.47)"
description: "O Flutter moveu PageTransitionsBuilder e dois builders embutidos para a camada widgets e CupertinoPageTransitionsBuilder para fora do Material. O que realmente quebra (um import, com um erro enganoso 'Not a constant expression'), o que o dart fix faz e erra em projetos com material_ui, e como reescrever builders e rotas personalizados para que não dependam mais do Material."
pubDate: 2026-10-08
updatedDate: 2026-10-08
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "navigation"
  - "cupertino"
lang: "pt-br"
translationOf: "2026/10/migrate-custom-page-transitions-after-the-flutter-page-transition-builders-reorganization"
translatedBy: "claude"
translationDate: 2026-10-08
---

Para a maioria dos apps, esta é uma migração de cinco minutos com exatamente uma mudança que quebra o código-fonte: desde o Flutter 3.44, `CupertinoPageTransitionsBuilder` fica na biblioteca Cupertino, então qualquer arquivo que importe apenas `package:flutter/material.dart` (ou `package:material_ui/material_ui.dart`) e coloque esse builder em um `PageTransitionsTheme` deixa de compilar. Adicione o import do Cupertino e pronto. O restante da reorganização, que moveu a classe base `PageTransitionsBuilder` além de `FadeUpwardsPageTransitionsBuilder` e `OpenUpwardsPageTransitionsBuilder` para `package:flutter/widgets.dart` no Flutter 3.38 e 3.41, não quebra nada, mas é a parte que vale a pena aproveitar: seus builders personalizados agora podem abandonar por completo a dependência do Material, o que os mantém funcionando quando você migrar para os pacotes de design independentes. Tudo abaixo foi compilado e testado no Flutter 3.44.8 com Dart 3.12.2, e verificado contra a versão estável atual, Flutter 3.47.6, com [`material_ui`](https://pub.dev/packages/material_ui) 1.6.0 e [`cupertino_ui`](https://pub.dev/packages/cupertino_ui) 1.1.2.

## Por que os builders foram movidos

`PageTransitionsBuilder` nasceu como uma classe do Material porque `PageTransitionsTheme` e `MaterialPageRoute` eram seus únicos consumidores. Isso não fazia sentido para um app Cupertino, nem para uma equipe com seu próprio design system construído sobre `WidgetsApp`: para reutilizar um objeto de transição, era preciso importar o Material. A [issue #172929](https://github.com/flutter/flutter/issues/172929) do Flutter ("Move platform specific page transitions outside of Material and Cupertino") acompanhou o trabalho de desfazer esse acoplamento, como parte do esforço maior de distribuir Material e Cupertino como pacotes separados.

Os resultados concretos:

- **Builders personalizados não precisam mais do Material.** Uma subclasse de `PageTransitionsBuilder` pode importar apenas `package:flutter/widgets.dart` e ser usada por um `PageRoute` escrito à mão, um `WidgetsApp`, um `CupertinoApp` ou um `PageTransitionsTheme`.
- **Apps Cupertino recebem o builder do iOS sem puxar o Material.** `CupertinoPageTransitionsBuilder` agora fica ao lado de `CupertinoPageRoute` em `cupertino/route.dart`.
- **Os builders sobrevivem à migração para o `material_ui`.** Como a classe base fica na camada widgets, que não sai do SDK, um builder escrito contra `widgets.dart` é o mesmo tipo tanto para o `PageTransitionsTheme` do SDK quanto para o do `material_ui`.

## O que quebra

| Área | Mudança | Chegou ao stable | Gravidade |
| ---- | ------- | ---------------- | --------- |
| `PageTransitionsBuilder` | Movido do Material para `widgets.dart` ([PR #174321](https://github.com/flutter/flutter/pull/174321)) | 3.38 | nenhuma, o Material reexporta widgets |
| `FadeUpwardsPageTransitionsBuilder` | Movido para `widgets.dart` ([PR #175560](https://github.com/flutter/flutter/pull/175560)) | 3.41 | nenhuma |
| `OpenUpwardsPageTransitionsBuilder` | Movido para `widgets.dart` ([PR #177080](https://github.com/flutter/flutter/pull/177080)) | 3.41 | nenhuma |
| `CupertinoPageTransitionsBuilder` | Movido do Material para `cupertino.dart` ([PR #179776](https://github.com/flutter/flutter/pull/179776)) | 3.44 | alta para arquivos só com Material, um import resolve |
| `ZoomPageTransitionsBuilder`, `FadeForwardsPageTransitionsBuilder`, `PredictiveBackPageTransitionsBuilder`, `PageTransitionsTheme` | Sem alteração, continuam no Material | n/a | nenhuma |

As três primeiras linhas são invisíveis para um app Material porque `material.dart` faz `export 'package:flutter/widgets.dart'`. Um arquivo que escreve `extends PageTransitionsBuilder` com apenas um import do Material resolve a classe por esse reexport, exatamente como antes. A [página oficial de breaking changes](https://docs.flutter.dev/release/breaking-changes/decouple-page-transition-builders) lista `FadeUpwardsPageTransitionsBuilder` e `OpenUpwardsPageTransitionsBuilder` sob "Material" pelo mesmo motivo: a partir de um import do Material, é de lá que eles parecem vir.

## Checklist prévio

- Saiba em qual Flutter você está: `flutter --version`. A quebra exige a versão 3.44 ou posterior. A 3.47.x é a estável atual.
- Encontre todas as referências antes de mexer em qualquer coisa:

  ```bash
  # Any Flutter version
  grep -rn "PageTransitionsBuilder\|PageTransitionsTheme" lib test packages
  ```

- Anote se o projeto usa as bibliotecas do SDK (`package:flutter/material.dart`) ou os pacotes independentes (`package:material_ui/material_ui.dart`). A correção segue a mesma ideia, mas a linha de import é diferente, e o `dart fix` erra em um dos casos (veja o passo 3).
- Verifique também suas dependências por path e por git. Um pacote que referencia `CupertinoPageTransitionsBuilder` com apenas um import do Material quebra seu build da mesma forma, e você não consegue corrigir isso a partir do seu app.

## Passos da migração

1. **Atualize e reproduza a falha.** Mude para o SDK de destino e execute o analisador, que dá uma mensagem muito mais clara que o compilador:

   ```bash
   # Flutter 3.44.8 or later
   flutter upgrade
   flutter analyze
   ```

   Pegue este `ThemeData` de um app típico, que compilava normalmente na 3.41:

   ```dart
   // Flutter 3.44.8, Dart 3.12.2 -- fails to compile
   import 'package:flutter/material.dart';

   final ThemeData theme = ThemeData(
     pageTransitionsTheme: const PageTransitionsTheme(
       builders: <TargetPlatform, PageTransitionsBuilder>{
         TargetPlatform.android: PredictiveBackPageTransitionsBuilder(),
         TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
         TargetPlatform.macOS: CupertinoPageTransitionsBuilder(),
       },
     ),
   );
   ```

   O `flutter analyze` informa a causa real, `undefined_method`: "The method 'CupertinoPageTransitionsBuilder' isn't defined", além do ruído de `invalid_constant` e `non_constant_map_value` para cada entrada. Verifique: você vê um `undefined_method` por uso de `CupertinoPageTransitionsBuilder` e nenhum outro erro novo.

2. **Adicione o import do Cupertino a cada arquivo afetado.** Nas bibliotecas do SDK:

   ```dart
   // Flutter 3.44+, SDK libraries
   import 'package:flutter/cupertino.dart';
   import 'package:flutter/material.dart';
   ```

   Nos pacotes independentes:

   ```dart
   // Flutter 3.47.6, material_ui 1.6.0, cupertino_ui 1.1.2
   import 'package:cupertino_ui/cupertino_ui.dart';
   import 'package:material_ui/material_ui.dart';
   ```

   O `material_ui` já depende do `cupertino_ui`, mas importar uma dependência transitiva dispara o lint `depend_on_referenced_packages`, então adicione-o explicitamente com `flutter pub add cupertino_ui`. Verifique: o `flutter analyze` não reporta nada para esses arquivos.

3. **Ou deixe o `dart fix` fazer isso e depois confira o resultado.** Ambas as bibliotecas trazem uma correção orientada a dados para essa mudança (a entrada `replacedBy` em `fix_material.yaml`):

   ```bash
   # Flutter 3.44+
   dart fix --dry-run
   dart fix --apply
   ```

   Em um projeto com as bibliotecas do SDK, isso insere `import 'package:flutter/cupertino.dart';` e nada mais, o que está correto. Em um projeto com `material_ui` 1.6.0, os dados da correção ainda apontam para `package:flutter/cupertino.dart`, a cópia congelada do SDK, e não para o `cupertino_ui`. Seu código compila, porque o builder do SDK estende a mesma classe base da camada widgets, mas você acabou de reintroduzir um import de biblioteca de design do SDK em um projeto que já tinha migrado para fora dela. Substitua essa linha pelo import do `cupertino_ui` manualmente. Verifique: `grep -rn "package:flutter/cupertino.dart" lib` não retorna nada em um projeto migrado.

4. **Redirecione os builders personalizados para a camada widgets.** Um builder que apenas compõe `SlideTransition`, `FadeTransition`, `ScaleTransition` e curvas não tem mais motivo para importar o Material:

   ```dart
   // Flutter 3.44+, Dart 3.12 -- no Material import needed
   import 'package:flutter/widgets.dart';

   class FadeSlidePageTransitionsBuilder extends PageTransitionsBuilder {
     const FadeSlidePageTransitionsBuilder();

     @override
     Duration get transitionDuration => const Duration(milliseconds: 250);

     @override
     Widget buildTransitions<T>(
       PageRoute<T> route,
       BuildContext context,
       Animation<double> animation,
       Animation<double> secondaryAnimation,
       Widget child,
     ) {
       final Animation<Offset> position = animation.drive(
         Tween<Offset>(begin: const Offset(0.0, 0.08), end: Offset.zero)
             .chain(CurveTween(curve: Curves.easeOutCubic)),
       );
       return FadeTransition(
         opacity: animation,
         child: SlideTransition(position: position, child: child),
       );
     }
   }
   ```

   A mesma classe continua se encaixando em um tema Material sem alterações, porque `PageTransitionsTheme.builders` é tipado exatamente contra essa classe base. Verifique: o único import do Flutter no arquivo é `widgets.dart` e o `flutter analyze` não reporta nada.

5. **Substitua o boilerplate de `PageRouteBuilder` por uma rota que delega a um builder.** Este é o padrão para o qual a reorganização foi projetada: uma classe de rota, qualquer transição, sem Material:

   ```dart
   // Flutter 3.44+, Dart 3.12
   import 'package:flutter/widgets.dart';

   class BuilderPageRoute<T> extends PageRoute<T> {
     BuilderPageRoute({
       required this.builder,
       this.transitionsBuilder = const FadeSlidePageTransitionsBuilder(),
       super.settings,
     });

     final WidgetBuilder builder;
     final PageTransitionsBuilder transitionsBuilder;

     @override
     Duration get transitionDuration => transitionsBuilder.transitionDuration;

     @override
     Duration get reverseTransitionDuration =>
         transitionsBuilder.reverseTransitionDuration;

     @override
     DelegatedTransitionBuilder? get delegatedTransition =>
         transitionsBuilder.delegatedTransition;

     @override
     Color? get barrierColor => null;

     @override
     String? get barrierLabel => null;

     @override
     bool get maintainState => true;

     @override
     Widget buildPage(
       BuildContext context,
       Animation<double> animation,
       Animation<double> secondaryAnimation,
     ) => builder(context);

     @override
     Widget buildTransitions(
       BuildContext context,
       Animation<double> animation,
       Animation<double> secondaryAnimation,
       Widget child,
     ) => transitionsBuilder.buildTransitions<T>(
       this,
       context,
       animation,
       secondaryAnimation,
       child,
     );
   }
   ```

   Encaminhar `transitionDuration`, `reverseTransitionDuration` e `delegatedTransition` é importante. O [exemplo oficial](https://api.flutter.dev/flutter/widgets/PageTransitionsBuilder-class.html) fixa 300 ms no código, o que ignora silenciosamente a duração que o builder declara, e sem `delegatedTransition` um `CupertinoPageTransitionsBuilder` passado para essa rota anima a página que entra, mas deixa a página anterior congelada em vez de deslizá-la para a esquerda. Verifique com um teste de widget (próxima seção).

6. **Conecte a rota ao widget de app que você usa.** Para um design system baseado em `WidgetsApp`, passe-a como `pageRouteBuilder`:

   ```dart
   // Flutter 3.44+
   WidgetsApp(
     color: const Color(0xFF0B57D0),
     pageRouteBuilder: <T>(RouteSettings settings, WidgetBuilder builder) =>
         BuilderPageRoute<T>(builder: builder, settings: settings),
     home: const HomeScreen(),
   );
   ```

   Em um app Material, continue usando `PageTransitionsTheme` para o padrão e faça push de `BuilderPageRoute` apenas onde uma tela precisar de uma transição diferente. Verifique: navegar para uma tela empilhada mostra a nova animação, e o `flutter analyze` não reporta nada.

## Verificação

Não confie nos seus olhos para uma animação de 250 ms. Avance a rota até a metade e faça uma asserção sobre o widget de transição:

```dart
// Flutter 3.44.8, flutter_test
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:my_app/transitions.dart';

void main() {
  testWidgets('BuilderPageRoute uses the builder duration', (tester) async {
    final navigator = GlobalKey<NavigatorState>();
    await tester.pumpWidget(WidgetsApp(
      navigatorKey: navigator,
      color: const Color(0xFF000000),
      pageRouteBuilder: <T>(RouteSettings s, WidgetBuilder b) =>
          BuilderPageRoute<T>(builder: b, settings: s),
      home: const Text('home', textDirection: TextDirection.ltr),
    ));

    navigator.currentState!.push(BuilderPageRoute<void>(
      builder: (_) => const Text('second', textDirection: TextDirection.ltr),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 125));

    final fade = tester.widget<FadeTransition>(find
        .ancestor(of: find.text('second'), matching: find.byType(FadeTransition))
        .first);
    expect(fade.opacity.value, 0.5);

    await tester.pumpAndSettle();
    expect(find.text('second'), findsOneWidget);
  });
}
```

No Flutter 3.44.8 este teste passa com opacidade exatamente `0.5` em 125 ms, o que prova que a rota assumiu a duração de 250 ms do builder. Se alguém fixar 300 ms no código de novo, o valor cai para cerca de `0.42` e o teste falha. Além disso:

- O `flutter analyze` não reporta diagnósticos `undefined_method` nem `undefined_hidden_name`.
- O `flutter test` passa, incluindo testes golden que capturam frames no meio da transição, se você tiver algum.
- Em um simulador de iOS, deslize para voltar a partir da borda esquerda em uma tela que usa `CupertinoPageTransitionsBuilder` e confirme que a página anterior se move junto com o gesto.

## Plano de rollback

As mudanças de código são aditivas: um import extra e algumas classes que não precisam mais do Material. Todas compilam também na 3.41, exceto que na 3.41 `CupertinoPageTransitionsBuilder` é resolvido pelo import do Material, então o import adicionado de `cupertino.dart` é apenas redundante. Fazer rollback do SDK com `flutter downgrade` ou uma versão fixada no CI não exige reverter nada disso. A única coisa que não pode voltar para antes da 3.38 é um builder que importa apenas `widgets.dart`, já que a classe base ainda não existia lá.

## Armadilhas

**O erro do compilador aponta para o problema errado.** Dentro de um mapa `const`, que é como quase todo `PageTransitionsTheme` é escrito, o front end não diz que o nome é indefinido. `flutter build` e `flutter test` imprimem apenas:

```text
lib/main.dart:14:33: Error: Not a constant expression.
            TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
                                ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
```

As pessoas removem o `const`, o que o transforma em "The method 'CupertinoPageTransitionsBuilder' isn't defined for the type 'App'", e aí saem procurando um método. Execute o `flutter analyze` primeiro; ele mostra o diagnóstico `undefined_method` junto com o ruído de constantes.

**Um mapa `builders` parcial não é mesclado com os padrões.** Passar `builders:` substitui o mapa padrão inteiro, e as plataformas ausentes recorrem, em runtime, a `CupertinoPageTransitionsBuilder` apenas no iOS e a `ZoomPageTransitionsBuilder` em todos os outros lugares, macOS incluído. Se você listar apenas Android e iOS, o macOS recebe a transição de zoom. Já que você está neste arquivo de qualquer forma, liste todas as plataformas que você publica.

**Misturar os imports Cupertino do SDK e do pacote no mesmo arquivo.** Em um projeto com `material_ui`, um arquivo que importa tanto `package:flutter/cupertino.dart` (deixado pelo `dart fix`) quanto `package:cupertino_ui/cupertino_ui.dart` recebe erros `ambiguous_import` para todo nome do Cupertino. Mantenha exatamente um.

**Cláusulas `hide` obsoletas.** Algumas bases de código escreveram `import 'package:flutter/material.dart' hide CupertinoPageTransitionsBuilder;` para evitar um conflito com uma classe local de mesmo nome. Na 3.44+, esse nome não existe mais no namespace do Material, e o analisador sinaliza `undefined_hidden_name`. Apague a cláusula.

**Builders de terceiros continuam funcionando.** `SharedAxisPageTransitionsBuilder`, do pacote [`animations`](https://pub.dev/packages/animations), e classes semelhantes estendem a classe base por meio de seu próprio import do Material, que reexporta o tipo da camada widgets, então continuam se encaixando no seu tema. Só quebram os pacotes que eles mesmos referenciam `CupertinoPageTransitionsBuilder` com um import apenas do Material, e esses precisam de uma nova versão do pacote, não de uma mudança no seu app.

**Estender um builder do Material ainda exige o Material.** `ZoomPageTransitionsBuilder`, `FadeForwardsPageTransitionsBuilder` e os builders de predictive back permaneceram no Material. Se o seu builder personalizado estende um deles para ajustar uma duração, ele mantém seu import do Material (ou do `material_ui`).

## Leitura relacionada

- A mudança de imports aqui é uma fatia da movimentação maior tratada em [migrando os imports de Material e Cupertino do Flutter para os pacotes material_ui e cupertino_ui](/pt-br/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/).
- Para a versão que iniciou o desacoplamento, veja [Flutter 3.44 dividindo Material e Cupertino em pacotes](/pt-br/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- Outro erro de compilação do 3.44 com a mesma causa raiz: [corrigindo "Undefined name 'awaitNotRequired'" com material_ui e cupertino_ui](/pt-br/2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44/).
- Se a sua transição personalizada na verdade é um elemento compartilhado, [uma animação Hero entre duas telas](/pt-br/2026/07/how-to-add-a-hero-animation-between-two-screens-in-flutter/) pode ser a ferramenta melhor.
- Roteadores que constroem suas próprias páginas, como o `CustomTransitionPage` do go_router, são comparados em [go_router vs auto_route vs Navigator 2.0](/pt-br/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/).

## Fontes

- [Page transition builders reorganization](https://docs.flutter.dev/release/breaking-changes/decouple-page-transition-builders), breaking changes do Flutter.
- [Referência da API `PageTransitionsBuilder`](https://api.flutter.dev/flutter/widgets/PageTransitionsBuilder-class.html).
- [flutter/flutter#172929](https://github.com/flutter/flutter/issues/172929), a issue de acompanhamento.
- PRs [#174321](https://github.com/flutter/flutter/pull/174321), [#175560](https://github.com/flutter/flutter/pull/175560), [#177080](https://github.com/flutter/flutter/pull/177080) e [#179776](https://github.com/flutter/flutter/pull/179776).
- [Correções orientadas a dados](https://dart.dev/tools/fix) na documentação do Dart.
