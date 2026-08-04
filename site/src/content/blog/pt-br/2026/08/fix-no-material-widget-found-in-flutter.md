---
title: "Correção: No Material widget found no Flutter"
description: "Envolva a subárvore em Material(type: MaterialType.transparency) ou coloque a tela dentro de um Scaffold. O MaterialApp sozinho não fornece um ancestral Material, por isso TextField e InkWell falham."
pubDate: 2026-08-04
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "material"
lang: "pt-br"
translationOf: "2026/08/fix-no-material-widget-found-in-flutter"
translatedBy: "claude"
translationDate: 2026-08-04
---

`No Material widget found` significa que o widget que você acabou de construir (`TextField`, `InkWell`, `ListTile`, `Chip`, `Switch`, `Slider` e companhia) subiu pela árvore procurando um ancestral `Material` e não encontrou nenhum. A correção mais rápida e segura é envolver a subárvore em `Material(type: MaterialType.transparency, child: ...)`, que não muda nada visualmente. A correção estrutural é colocar a tela dentro de um `Scaffold`. Note que o `MaterialApp` sozinho **não** fornece um `Material`. Verificado no Flutter 3.44 stable, Dart 3.x.

## O erro em contexto

A asserção é lançada a partir do método `build` do widget que falhou, então a primeira linha nomeia o widget que não conseguiu encontrar seu ancestral:

```
======== Exception caught by widgets library ===================================
The following assertion was thrown building TextField(dirty, state: _TextFieldState#3f2a1):
No Material widget found.

TextField widgets require a Material widget ancestor within the closest LookupBoundary.
In Material Design, most widgets are conceptually "printed" on a sheet of
material. In Flutter's material library, that material is represented by the
Material widget. It is the Material widget that renders ink splashes, for
instance. Because of this, many material library widgets require that there be
a Material widget in the tree above them.

To introduce a Material widget, you can either directly include one, or use a
widget that contains Material itself, such as a Card, Dialog, Drawer, or
Scaffold.

The specific widget that could not find a Material ancestor was:
  TextField
The ancestors of this widget were:
  Center
  Semantics
  ...
```

Existe uma segunda redação que você pode encontrar, e ela é um problema genuinamente diferente:

```
No Material widget found within the closest LookupBoundary.
There is an ancestor Material widget, but it is hidden by a LookupBoundary.
```

Essa significa que existe sim um `Material` acima de você, mas um `LookupBoundary` está bloqueando a busca de propósito. Ela tem sua própria seção mais adiante.

## Quais widgets realmente exigem um ancestral Material

Isso importa porque a lista é mais curta do que "tudo que está em `package:flutter/material.dart`". Buscar `assert(debugCheckHasMaterial(context))` em `packages/flutter/lib/src/material/` no branch stable do Flutter 3.44 dá o conjunto real:

- `InkWell`, `InkResponse` (via `InkResponse.debugCheckContext`) e `Ink`
- `TextField`
- `ListTile`
- `Chip`, `InputChip`, `ActionChip`, `ChoiceChip`, `FilterChip`
- `Checkbox`, `Radio`, `Switch`, `Slider`
- `DropdownButton`
- `DataTable`
- `TabBar`
- `Stepper`
- `ExpandIcon`

Igualmente útil é o que *não* está na lista. `ElevatedButton`, `FilledButton`, `OutlinedButton`, `TextButton`, `FloatingActionButton`, `Card` e `Tooltip` não fazem a asserção, porque cada um deles constrói o próprio `Material` internamente e depois coloca a superfície de tinta abaixo do próprio filho. É por isso que uma tela cheia de botões funciona perfeitamente fora de um `Scaffold` até você adicionar um único `TextField` e tudo explodir.

`IconButton` é um caso especial que vale conhecer. Sua asserção fica apenas no caminho de código do Material 2: o `build` retorna antecipadamente por `_SelectableIconButton` quando `theme.useMaterial3` é true, e o `assert(debugCheckHasMaterial(context))` vem depois desse return. Como `useMaterial3` tem valor padrão `true` desde o Flutter 3.16, um `IconButton` comum não precisa mais de um ancestral `Material`. Volte seu tema para `useMaterial3: false` e ele volta a falhar.

## Por que o MaterialApp não basta

Esta é a parte que pega quase todo mundo, e não é óbvia pelo nome. O `MaterialApp` fornece um `Theme`, `MaterialLocalizations`, um `Navigator`, um `ScaffoldMessenger` e um `WidgetsApp`. Ele não insere um `Material` em lugar nenhum. Não existe nenhuma construção `Material(` em `packages/flutter/lib/src/material/app.dart`.

O `Material` vem do `Scaffold`. O `build` do seu state envolve todo o layout em um:

```dart
// Flutter 3.44, packages/flutter/lib/src/material/scaffold.dart
child: ScrollNotificationObserver(
  child: Material(
    color: widget.backgroundColor ?? themeData.scaffoldBackgroundColor,
    child: Builder(...),
  ),
),
```

O mesmo vale para `Card`, `Dialog`, `Drawer` e a folha construída por `showModalBottomSheet`: cada um constrói um `Material` ao redor do seu filho. Essa é exatamente a lista que a dica do erro apresenta, e é essa lista porque são esses os widgets que de fato fazem isso.

## A reprodução mínima

Doze linhas, e falha no primeiro frame:

```dart
// Flutter 3.44, Dart 3.x
import 'package:flutter/material.dart';

void main() => runApp(const MyApp());

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      home: Center(child: TextField()), // throws: No Material widget found.
    );
  }
}
```

Troque `TextField` por `ElevatedButton` e ele renderiza. Troque por `ListTile` e falha de novo. O ingrediente que falha nunca é o `MaterialApp`, é a ausência de um `Scaffold` (ou de qualquer outro portador de `Material`) entre o app e o widget.

## Correção 1: coloque a tela dentro de um Scaffold

Se o widget que falha faz parte de uma tela, essa é a correção certa, não um paliativo. Você ganha o `Material`, mais a cor de fundo, o espaço para a barra de aplicativo, o tratamento de safe area e os deslocamentos do teclado sobre os quais o widget foi implicitamente projetado para se apoiar:

```dart
// Flutter 3.44, Dart 3.x
class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: Scaffold(
        appBar: AppBar(title: const Text('Sign in')),
        body: const Padding(
          padding: EdgeInsets.all(16),
          child: TextField(
            decoration: InputDecoration(labelText: 'Email'),
          ),
        ),
      ),
    );
  }
}
```

Recorra a uma das outras correções apenas quando um `Scaffold` genuinamente não fizer sentido: uma entrada de overlay, um teste de widget, um fragmento renderizado fora da árvore de rotas normal.

## Correção 2: Material com MaterialType.transparency

Quando você precisa da superfície de tinta mas não do visual, essa é a correção que não custa nada:

```dart
// Flutter 3.44, Dart 3.x
Material(
  type: MaterialType.transparency,
  child: InkWell(
    onTap: _handleTap,
    child: const Padding(
      padding: EdgeInsets.all(12),
      child: Text('Tap me'),
    ),
  ),
)
```

O tipo importa mais do que parece. Duas coisas mudam de acordo com ele, ambas visíveis no método build do `Material`:

```dart
// Flutter 3.44, packages/flutter/lib/src/material/material.dart
final Color? backgroundColor = widget.color ?? switch (widget.type) {
  MaterialType.canvas => theme.canvasColor,
  MaterialType.card => theme.cardColor,
  MaterialType.button || MaterialType.circle || MaterialType.transparency => null,
};
// ...
child: _InkFeatures(
  absorbHitTest: widget.type != MaterialType.transparency,
  color: backgroundColor,
  ...
),
```

Um `Material(child: ...)` puro usa por padrão `MaterialType.canvas`, que pinta um retângulo opaco de `theme.canvasColor` por cima do que estava atrás e define `absorbHitTest: true`, engolindo os eventos de ponteiro que antes passavam para os widgets de baixo. `MaterialType.transparency` não pinta nada e não absorve nada. Se você está corrigindo um layout existente, comece sempre com `transparency` para não trocar uma falha por um gesto silenciosamente quebrado ou uma caixa branca sobre o seu gradiente.

Uma coisa da qual `transparency` não te livra: o `Material` sempre envolve o filho em um `AnimatedDefaultTextStyle` usando `widget.textStyle ?? Theme.of(context).textTheme.bodyMedium`. Se um `Text` sem estilo dentro da subárvore recém-envolvida mudar de repente de tamanho ou cor, é por isso. Passe um `textStyle` explícito, ou defina o estilo nos próprios widgets `Text`.

## Correção 3: use um widget contêiner que já carregue um Material

Às vezes a resposta certa não é nem `Scaffold` nem um `Material` puro, porque o contêiner já era o que você queria:

```dart
// Flutter 3.44, Dart 3.x
Card(
  child: ListTile(                    // ListTile asserts; Card supplies the Material
    leading: const Icon(Icons.person),
    title: const Text('Marius'),
    onTap: _openProfile,
  ),
)
```

`showDialog`, `showModalBottomSheet` e `Drawer` dão um `Material` de graça, então `ListTile` e `TextField` funcionam dentro deles sem um `Scaffold`. O modo de falha a vigiar é o `showGeneralDialog`, cujo `pageBuilder` devolve seu widget cru, sem nenhum invólucro `Material`. Envolva você mesmo, ou use `Dialog`.

Entradas de `Overlay` têm o mesmo formato de problema. O builder de um `OverlayEntry` é montado como filho do `Overlay`, não do `Scaffold` da sua tela, então ele não herda o `Material` do `Scaffold`, não importa quão fundo na árvore viva o código que o inseriu.

## Correção 4: quem usa WidgetsApp precisa de MaterialApp

Se a raiz do seu app é `WidgetsApp` ou `CupertinoApp` e você usa widgets do Material mesmo assim, você recebe este erro mais o irmão dele, `No MaterialLocalizations found`. Isso foi fechado como uso inválido em [flutter/flutter#103843](https://github.com/flutter/flutter/issues/103843), e os mantenedores estão certos: ou migre para `MaterialApp`, ou adicione você mesmo os escopos `Material` e `Localizations`. `MaterialApp` é a resposta mais barata para quase todo mundo.

## A variante do LookupBoundary

A redação `within the closest LookupBoundary` significa que a busca foi interceptada. O `debugCheckHasMaterial` usa `LookupBoundary.findAncestorWidgetOfExactType<Material>(context)`, não a busca simples de elementos, e um `LookupBoundary` a interrompe na hora mesmo quando existe um `Material` perfeitamente válido acima.

No código do framework, o único lugar que insere um é o `view.dart`:

```dart
// Flutter 3.44, packages/flutter/lib/src/widgets/view.dart (ViewAnchor.build)
return _MultiChildComponentWidget(
  views: <Widget>[if (view != null) LookupBoundary(child: view!)],
  child: child,
);
```

Então se você está renderizando em uma segunda `FlutterView` através do `ViewAnchor` (um tooltip na sua própria view de plataforma, uma janela secundária de desktop), a barreira é intencional: o conteúdo daquela view é uma árvore de renderização separada e não deve depender silenciosamente de ancestrais da view hospedeira. A correção é dar à nova view o seu próprio `Material` (ou o seu próprio `Scaffold`) em vez de tentar atravessar a barreira. Essa é uma das arestas mais afiadas quando você [habilita suporte a múltiplas janelas em um app desktop Flutter](/pt-br/2026/08/how-to-enable-multi-window-support-in-a-flutter-desktop-app/).

Se foi você quem inseriu um `LookupBoundary` para isolar uma subárvore, vale a mesma regra: tudo de que a subárvore precisa tem que viver dentro dela.

## Pegadinhas e falsos parecidos

**Em debug lança, em release não.** O `debugCheckHasMaterial` está envolvido em `assert(() { ... }())`, então é totalmente removido das builds de release e a função simplesmente retorna `true`. Um `TextField` sem `Material` renderiza em `--release` e falha em debug, que é exatamente a confusão por trás da issue 103843. Não trate o "funciona em release" como prova de que a árvore está correta. No momento em que um efeito de tinta realmente disparar, o `Material.of(context)` roda, e esse lança em release também: "Material.of() was called with a context that does not contain a Material widget."

**O splash é invisível mas não há erro.** Bug diferente, mesma vizinhança. Splashes de tinta são pintados sobre o próprio `Material`, *abaixo* de tudo que é desenhado por cima, então um `InkWell` envolvido em um `Container(color: ...)` pinta o splash atrás do preenchimento opaco do container. Troque `Container(color: x)` por `Ink(color: x)` (ou defina a cor no `Material`), porque o `Ink` pinta sua decoração no `Material` pai para que o splash fique por cima. Relacionado: [Cannot provide both a color and a decoration em um Container do Flutter](/pt-br/2026/07/fix-cannot-provide-both-a-color-and-a-decoration-in-a-flutter-container/).

**Testes de widget falham onde o app funciona.** `tester.pumpWidget(const TextField())` lança pelo mesmo motivo que o `runApp`. Testes de widget precisam dos ancestrais explícitos: `MaterialApp(home: Scaffold(body: TextField()))`, ou no mínimo `Material(child: Directionality(textDirection: TextDirection.ltr, child: ...))`. A falta de `Directionality` e a falta de `MediaQuery` produzem o mesmo formato de erro, vindos de `debugCheckHasDirectionality` e `MediaQuery.of`.

**Não envolva o app inteiro em um único Material.** Funciona, e é uma armadilha. Um único `Material` no nível do app faz todos os splashes de tinta do aplicativo renderizarem em uma superfície só, anula as cores de fundo por tela e aplica um único estilo de texto `bodyMedium` padrão em todo lugar. Adicione o `Material` no menor escopo que corrija o erro.

**Aninhar Material muda em qual superfície os splashes caem.** O `Material.of` resolve o ancestral *mais próximo*, então um `Material` interno com um `borderRadius` ou um `shape` recorta os splashes naquele formato. Normalmente é isso que você quer para um card personalizado, e ocasionalmente é a razão de um splash parecer quadrado quando você esperava arredondado.

**`No MaterialLocalizations found` é outro ancestral faltando.** Mesmo mecanismo de busca para cima, escopo diferente, emitido por `debugCheckHasMaterialLocalizations`. Adicionar um `Material` não resolve; adicionar um `MaterialApp` ou um delegate de `Localizations` resolve.

## Relacionados

- [Correção: ScaffoldMessenger.of() was called with a context that does not contain a Scaffold](/pt-br/2026/07/fix-scaffoldmessenger-of-context-does-not-contain-a-scaffold-in-flutter/): a mesma falha de busca de ancestral, uma camada acima, mais o truque do `Builder` para obter um contexto abaixo do widget de que você precisa.
- [Correção: Looking up a deactivated widget's ancestor is unsafe no Flutter](/pt-br/2026/06/fix-looking-up-a-deactivated-widgets-ancestor-is-unsafe-in-flutter/): quando o ancestral existe mas a busca acontece no momento errado do ciclo de vida.
- [Correção: Incorrect use of ParentDataWidget. Expanded widgets must be placed inside Flex widgets](/pt-br/2026/07/fix-incorrect-use-of-parentdatawidget-expanded-must-be-inside-flex-in-flutter/): outra asserção estrutural de "lugar errado na árvore de widgets" que o Flutter detecta durante o build.
- [Como habilitar suporte a múltiplas janelas em um app desktop Flutter](/pt-br/2026/08/how-to-enable-multi-window-support-in-a-flutter-desktop-app/): onde o `LookupBoundary` começa a bloquear buscas de ancestrais em apps reais.
- [Como definir a cor de destaque em um app Flutter com o ColorScheme do Material 3](/pt-br/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/): o `canvasColor` e o `scaffoldBackgroundColor` que um `Material` assume quando você não passa nenhum.

## Fontes

- [debugCheckHasMaterial, referência da API do Flutter](https://api.flutter.dev/flutter/material/debugCheckHasMaterial.html): a asserção em si, incluindo o ramo do `LookupBoundary` e o texto exato da dica.
- [Classe Material, referência da API do Flutter](https://api.flutter.dev/flutter/material/Material-class.html): os valores de `MaterialType`, o recorte, a elevação e como os efeitos de tinta são anexados.
- [Classe Ink, referência da API do Flutter](https://api.flutter.dev/flutter/material/Ink-class.html): por que os splashes ficam escondidos por uma decoração opaca desenhada sobre o `Material`, e como o `Ink` evita isso.
- [flutter/flutter#103843: Error "No Material widget found.", but not in release build](https://github.com/flutter/flutter/issues/103843): a asserção exclusiva de debug confirmada pelos mantenedores, fechada como uso inválido do `WidgetsApp`.
- [flutter/flutter `packages/flutter/lib/src/material/debug.dart` (stable)](https://github.com/flutter/flutter/blob/stable/packages/flutter/lib/src/material/debug.dart): o código-fonte de `debugCheckHasMaterial` e `debugCheckHasMaterialLocalizations`.
