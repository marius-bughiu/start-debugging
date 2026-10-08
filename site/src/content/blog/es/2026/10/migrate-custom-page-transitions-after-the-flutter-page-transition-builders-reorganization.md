---
title: "Migra transiciones de página personalizadas tras la reorganización de los builders de transición de página de Flutter (Flutter 3.44 a 3.47)"
description: "Flutter movió PageTransitionsBuilder y dos builders integrados a la capa widgets, y CupertinoPageTransitionsBuilder fuera de Material. Qué se rompe realmente (un import, con un engañoso error 'Not a constant expression'), qué hace dart fix y en qué se equivoca en proyectos con material_ui, y cómo reescribir builders y rutas personalizados para que ya no dependan de Material."
pubDate: 2026-10-08
updatedDate: 2026-10-08
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "navigation"
  - "cupertino"
lang: "es"
translationOf: "2026/10/migrate-custom-page-transitions-after-the-flutter-page-transition-builders-reorganization"
translatedBy: "claude"
translationDate: 2026-10-08
---

Para la mayoría de las aplicaciones esta es una migración de cinco minutos con exactamente un cambio que rompe el código fuente: desde Flutter 3.44, `CupertinoPageTransitionsBuilder` vive en la biblioteca Cupertino, así que cualquier archivo que importe solo `package:flutter/material.dart` (o `package:material_ui/material_ui.dart`) y use ese builder dentro de un `PageTransitionsTheme` deja de compilar. Agrega el import de Cupertino y listo. El resto de la reorganización, que movió la clase base `PageTransitionsBuilder` junto con `FadeUpwardsPageTransitionsBuilder` y `OpenUpwardsPageTransitionsBuilder` a `package:flutter/widgets.dart` en Flutter 3.38 y 3.41, no rompe nada, pero es la parte en la que vale la pena actuar: tus builders personalizados ahora pueden prescindir por completo de Material, que es lo que los mantiene funcionando cuando pasas a los paquetes de diseño independientes. Todo lo que sigue se compiló y probó con Flutter 3.44.8 y Dart 3.12.2, y se verificó contra la versión estable actual, Flutter 3.47.6, con [`material_ui`](https://pub.dev/packages/material_ui) 1.6.0 y [`cupertino_ui`](https://pub.dev/packages/cupertino_ui) 1.1.2.

## Por qué se movieron los builders

`PageTransitionsBuilder` nació como una clase de Material porque `PageTransitionsTheme` y `MaterialPageRoute` eran sus únicos consumidores. Eso no tenía sentido para una aplicación Cupertino, ni para un equipo con su propio sistema de diseño construido sobre `WidgetsApp`: para reutilizar un objeto de transición había que importar Material. El [issue #172929](https://github.com/flutter/flutter/issues/172929) de Flutter ("Move platform specific page transitions outside of Material and Cupertino") dio seguimiento a desenredar esto, como parte del esfuerzo mayor de distribuir Material y Cupertino como paquetes separados.

Los resultados concretos:

- **Los builders personalizados ya no necesitan Material.** Una subclase de `PageTransitionsBuilder` puede importar solo `package:flutter/widgets.dart` y usarse desde un `PageRoute` escrito a mano, un `WidgetsApp`, un `CupertinoApp` o `PageTransitionsTheme`.
- **Las aplicaciones Cupertino obtienen el builder de iOS sin traer Material.** `CupertinoPageTransitionsBuilder` ahora está junto a `CupertinoPageRoute` en `cupertino/route.dart`.
- **Los builders sobreviven a la migración a `material_ui`.** Como la clase base vive en la capa widgets, que no sale del SDK, un builder escrito contra `widgets.dart` es el mismo tipo tanto para el `PageTransitionsTheme` del SDK como para el de `material_ui`.

## Qué se rompe

| Área | Cambio | Llegó a stable | Gravedad |
| ---- | ------ | -------------- | -------- |
| `PageTransitionsBuilder` | Movido de Material a `widgets.dart` ([PR #174321](https://github.com/flutter/flutter/pull/174321)) | 3.38 | ninguna, Material reexporta widgets |
| `FadeUpwardsPageTransitionsBuilder` | Movido a `widgets.dart` ([PR #175560](https://github.com/flutter/flutter/pull/175560)) | 3.41 | ninguna |
| `OpenUpwardsPageTransitionsBuilder` | Movido a `widgets.dart` ([PR #177080](https://github.com/flutter/flutter/pull/177080)) | 3.41 | ninguna |
| `CupertinoPageTransitionsBuilder` | Movido de Material a `cupertino.dart` ([PR #179776](https://github.com/flutter/flutter/pull/179776)) | 3.44 | alta para archivos solo con Material, un import lo arregla |
| `ZoomPageTransitionsBuilder`, `FadeForwardsPageTransitionsBuilder`, `PredictiveBackPageTransitionsBuilder`, `PageTransitionsTheme` | Sin cambios, siguen en Material | n/a | ninguna |

Las tres primeras filas son invisibles para una aplicación Material porque `material.dart` hace `export 'package:flutter/widgets.dart'`. Un archivo que escribe `extends PageTransitionsBuilder` con solo un import de Material resuelve la clase a través de ese reexport, exactamente igual que antes. La [página oficial de cambios incompatibles](https://docs.flutter.dev/release/breaking-changes/decouple-page-transition-builders) lista `FadeUpwardsPageTransitionsBuilder` y `OpenUpwardsPageTransitionsBuilder` bajo "Material" por la misma razón: desde un import de Material, ahí es donde parecen venir.

## Lista de verificación previa

- Confirma en qué versión de Flutter estás: `flutter --version`. La ruptura requiere 3.44 o posterior. 3.47.x es la versión estable actual.
- Encuentra todas las referencias antes de tocar nada:

  ```bash
  # Any Flutter version
  grep -rn "PageTransitionsBuilder\|PageTransitionsTheme" lib test packages
  ```

- Anota si el proyecto usa las bibliotecas del SDK (`package:flutter/material.dart`) o los paquetes independientes (`package:material_ui/material_ui.dart`). La solución es la misma idea, pero la línea de import cambia, y `dart fix` se equivoca con una de ellas (consulta el paso 3).
- Revisa también tus dependencias por ruta y por git. Un paquete que referencie `CupertinoPageTransitionsBuilder` con solo un import de Material rompe tu compilación de la misma forma, y no puedes arreglarlo desde tu aplicación.

## Pasos de migración

1. **Actualiza y reproduce el fallo.** Pasa al SDK objetivo y ejecuta el analizador, que da un mensaje mucho más claro que el compilador:

   ```bash
   # Flutter 3.44.8 or later
   flutter upgrade
   flutter analyze
   ```

   Toma este `ThemeData` de una aplicación típica, que compilaba bien en 3.41:

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

   `flutter analyze` informa la causa real, `undefined_method`: "The method 'CupertinoPageTransitionsBuilder' isn't defined", además del ruido de `invalid_constant` y `non_constant_map_value` por cada entrada. Verifica: ves un `undefined_method` por cada uso de `CupertinoPageTransitionsBuilder` y ningún otro error nuevo.

2. **Agrega el import de Cupertino a cada archivo afectado.** Con las bibliotecas del SDK:

   ```dart
   // Flutter 3.44+, SDK libraries
   import 'package:flutter/cupertino.dart';
   import 'package:flutter/material.dart';
   ```

   Con los paquetes independientes:

   ```dart
   // Flutter 3.47.6, material_ui 1.6.0, cupertino_ui 1.1.2
   import 'package:cupertino_ui/cupertino_ui.dart';
   import 'package:material_ui/material_ui.dart';
   ```

   `material_ui` ya depende de `cupertino_ui`, pero importar una dependencia transitiva activa el lint `depend_on_referenced_packages`, así que agrégala explícitamente con `flutter pub add cupertino_ui`. Verifica: `flutter analyze` queda limpio para esos archivos.

3. **O deja que `dart fix` lo haga y luego revisa el resultado.** Ambas bibliotecas incluyen una corrección basada en datos para este movimiento (la entrada `replacedBy` en `fix_material.yaml`):

   ```bash
   # Flutter 3.44+
   dart fix --dry-run
   dart fix --apply
   ```

   En un proyecto con las bibliotecas del SDK esto inserta `import 'package:flutter/cupertino.dart';` y nada más, lo cual es correcto. En un proyecto con `material_ui` 1.6.0, los datos de la corrección siguen apuntando a `package:flutter/cupertino.dart`, la copia congelada del SDK, y no a `cupertino_ui`. Tu código compila, porque el builder del SDK extiende la misma clase base de la capa widgets, pero acabas de reintroducir un import de una biblioteca de diseño del SDK en un proyecto del que ya habías migrado. Reemplaza esa línea por el import de `cupertino_ui` a mano. Verifica: `grep -rn "package:flutter/cupertino.dart" lib` no devuelve nada en un proyecto migrado.

4. **Reorienta los builders personalizados a la capa widgets.** Un builder que solo compone `SlideTransition`, `FadeTransition`, `ScaleTransition` y curvas ya no tiene motivo para importar Material:

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

   La misma clase sigue encajando sin cambios en un tema de Material, porque `PageTransitionsTheme.builders` está tipado contra esta misma clase base. Verifica: el único import de Flutter del archivo es `widgets.dart` y `flutter analyze` queda limpio.

5. **Reemplaza el código repetitivo de `PageRouteBuilder` por una ruta que delegue en un builder.** Este es el patrón para el que se diseñó la reorganización: una sola clase de ruta, cualquier transición, sin Material:

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

   Reenviar `transitionDuration`, `reverseTransitionDuration` y `delegatedTransition` es importante. El [ejemplo oficial](https://api.flutter.dev/flutter/widgets/PageTransitionsBuilder-class.html) fija 300 ms de forma rígida, lo que ignora en silencio la duración que declara el builder, y sin `delegatedTransition` un `CupertinoPageTransitionsBuilder` pasado a esta ruta anima la página entrante pero deja congelada la página anterior en lugar de deslizarla hacia la izquierda. Verifica con una prueba de widgets (siguiente sección).

6. **Conecta la ruta al widget de aplicación que uses.** Para un sistema de diseño basado en `WidgetsApp`, pásala como `pageRouteBuilder`:

   ```dart
   // Flutter 3.44+
   WidgetsApp(
     color: const Color(0xFF0B57D0),
     pageRouteBuilder: <T>(RouteSettings settings, WidgetBuilder builder) =>
         BuilderPageRoute<T>(builder: builder, settings: settings),
     home: const HomeScreen(),
   );
   ```

   En una aplicación Material, sigue usando `PageTransitionsTheme` para el valor predeterminado y empuja `BuilderPageRoute` solo donde una pantalla necesite una transición distinta. Verifica: al navegar a una pantalla empujada se ve la nueva animación, y `flutter analyze` queda limpio.

## Verificación

No confíes en tus ojos con una animación de 250 ms. Avanza la ruta hasta la mitad y comprueba el widget de transición:

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

En Flutter 3.44.8 esto pasa con una opacidad exactamente de `0.5` a los 125 ms, lo que demuestra que la ruta tomó la duración de 250 ms del builder. Si alguien vuelve a fijar 300 ms de forma rígida, el valor baja a aproximadamente `0.42` y la prueba falla. Además:

- `flutter analyze` no informa diagnósticos `undefined_method` ni `undefined_hidden_name`.
- `flutter test` pasa, incluidas las pruebas golden que capturan fotogramas a mitad de la transición, si tienes alguna.
- En un simulador de iOS, desliza hacia atrás desde el borde izquierdo en una pantalla que use `CupertinoPageTransitionsBuilder` y confirma que la página anterior se mueve con el gesto.

## Plan de reversión

Los cambios de código son aditivos: un import adicional y algunas clases que ya no necesitan Material. Todos compilan también en 3.41, salvo que en 3.41 `CupertinoPageTransitionsBuilder` se resuelve a través del import de Material, así que el import de `cupertino.dart` agregado simplemente es redundante. Volver atrás el SDK con `flutter downgrade` o con una versión fijada en CI no requiere revertir nada de esto. Lo único que no puede retroceder por debajo de 3.38 es un builder que importe solo `widgets.dart`, ya que la clase base todavía no existía.

## Problemas frecuentes

**El error del compilador apunta al problema equivocado.** Dentro de un mapa `const`, que es como se escribe casi todo `PageTransitionsTheme`, el front end no dice que el nombre no está definido. `flutter build` y `flutter test` imprimen solo:

```text
lib/main.dart:14:33: Error: Not a constant expression.
            TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
                                ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
```

La gente borra `const`, lo que lo convierte en "The method 'CupertinoPageTransitionsBuilder' isn't defined for the type 'App'", y luego se pone a buscar un método. Ejecuta primero `flutter analyze`; muestra el diagnóstico `undefined_method` junto con el ruido de constantes.

**Un mapa `builders` parcial no se combina con los valores predeterminados.** Pasar `builders:` reemplaza todo el mapa predeterminado, y las plataformas que falten recurren en tiempo de ejecución a `CupertinoPageTransitionsBuilder` solo en iOS y a `ZoomPageTransitionsBuilder` en todas las demás, macOS incluido. Si solo listas Android e iOS, macOS obtiene la transición de zoom. Ya que estás en este archivo, lista todas las plataformas que distribuyes.

**Mezclar los imports de Cupertino del SDK y del paquete en un mismo archivo.** En un proyecto con `material_ui`, un archivo que importa tanto `package:flutter/cupertino.dart` (dejado por `dart fix`) como `package:cupertino_ui/cupertino_ui.dart` obtiene errores `ambiguous_import` por cada nombre de Cupertino. Conserva exactamente uno.

**Cláusulas `hide` obsoletas.** Algunas bases de código escribían `import 'package:flutter/material.dart' hide CupertinoPageTransitionsBuilder;` para evitar un choque con una clase local del mismo nombre. En 3.44+ ese nombre ya no existe en el espacio de nombres de Material, y el analizador marca `undefined_hidden_name`. Elimina la cláusula.

**Los builders de terceros siguen funcionando.** `SharedAxisPageTransitionsBuilder` de [`animations`](https://pub.dev/packages/animations) y clases similares extienden la clase base a través de su propio import de Material, que reexporta el tipo de la capa widgets, así que siguen encajando en tu tema. Solo se rompen los paquetes que ellos mismos referencian `CupertinoPageTransitionsBuilder` con un import solo de Material, y esos necesitan una nueva versión del paquete, no un cambio en tu aplicación.

**Heredar de un builder de Material sigue necesitando Material.** `ZoomPageTransitionsBuilder`, `FadeForwardsPageTransitionsBuilder` y los builders de gesto atrás predictivo se quedaron en Material. Si tu builder personalizado extiende uno de ellos para ajustar una duración, conserva su import de Material (o de `material_ui`).

## Relacionado

- El cambio de imports aquí es una parte del movimiento más amplio que cubre [migrar los imports de Material y Cupertino de Flutter a los paquetes material_ui y cupertino_ui](/es/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/).
- Para la versión que inició el desacoplamiento, consulta [Flutter 3.44 separando Material y Cupertino en paquetes](/es/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- Otro error de compilación de 3.44 con la misma causa raíz: [cómo corregir "Undefined name 'awaitNotRequired'" con material_ui y cupertino_ui](/es/2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44/).
- Si tu transición personalizada en realidad es un elemento compartido, [una animación Hero entre dos pantallas](/es/2026/07/how-to-add-a-hero-animation-between-two-screens-in-flutter/) puede ser la mejor herramienta.
- Los enrutadores que construyen sus propias páginas, como `CustomTransitionPage` de go_router, se comparan en [go_router vs auto_route vs Navigator 2.0](/es/2026/07/go-router-vs-auto-route-vs-navigator-2-0-in-flutter/).

## Fuentes

- [Page transition builders reorganization](https://docs.flutter.dev/release/breaking-changes/decouple-page-transition-builders), cambios incompatibles de Flutter.
- [Referencia de la API de `PageTransitionsBuilder`](https://api.flutter.dev/flutter/widgets/PageTransitionsBuilder-class.html).
- [flutter/flutter#172929](https://github.com/flutter/flutter/issues/172929), el issue de seguimiento.
- Los PR [#174321](https://github.com/flutter/flutter/pull/174321), [#175560](https://github.com/flutter/flutter/pull/175560), [#177080](https://github.com/flutter/flutter/pull/177080) y [#179776](https://github.com/flutter/flutter/pull/179776).
- [Correcciones basadas en datos](https://dart.dev/tools/fix) en la documentación de Dart.
