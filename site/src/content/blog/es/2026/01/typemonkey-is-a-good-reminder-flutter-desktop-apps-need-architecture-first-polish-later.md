---
title: "TypeMonkey es un buen recordatorio: las apps de escritorio en Flutter necesitan arquitectura primero, pulido después"
description: "TypeMonkey, una app de escritorio para mecanografiar en Flutter, muestra por qué los proyectos de escritorio necesitan arquitectura limpia desde el primer día: estados sealed, fronteras por interfaz y lógica testeable."
pubDate: 2026-01-18
tags:
  - "dart"
  - "flutter"
lang: "es"
translationOf: "2026/01/typemonkey-is-a-good-reminder-flutter-desktop-apps-need-architecture-first-polish-later"
translatedBy: "claude"
translationDate: 2026-04-29
---
Hoy apareció en r/FlutterDev un pequeño proyecto Flutter de escritorio: **TypeMonkey**, una app tipo MonkeyType para mecanografiar que se posiciona explícitamente como "temprana, pero estructurada".

Fuente: el post original y el repositorio: [hilo en r/FlutterDev](https://www.reddit.com/r/FlutterDev/comments/1qgc72p/typemonkey_yet_another_typing_app_available_on/) y [BaldGhost-git/typemonkey](https://github.com/BaldGhost-git/typemonkey).

## Escritorio es donde "solo lanza la UI" deja de funcionar

En mobile a veces puedes salir adelante con un único objeto de estado y una pila de widgets. En escritorio (Flutter **3.x** + Dart **3.x**) aparecen rápido presiones distintas:

-   **Flujos centrados en el teclado**: atajos, gestión del foco, manejo predecible de teclas.
-   **Sensibilidad a la latencia**: tu UI no puede dar tirones al actualizar stats, cargar historial o calcular WPM.
-   **Crecimiento de funcionalidades**: perfiles, modos de práctica, listas de palabras, temas, persistencia offline.

Por eso me gustan los proyectos que empiezan con estructura. La arquitectura limpia no es una religión, es una forma de que tu segunda y tercera funcionalidad duelan menos que la primera.

## Modela el ciclo de escritura como estados explícitos

Dart 3 te da clases `sealed`. Para el estado de la app, esa es una forma práctica de evitar la "sopa de nulos" y los booleanos sueltos.

Aquí tienes una forma mínima de estado para una sesión de escritura que se mantiene testeable y amigable con la UI:

```dart
sealed class TypingState {
  const TypingState();
}

final class Idle extends TypingState {
  const Idle();
}

final class Running extends TypingState {
  final DateTime startedAt;
  final int typedChars;
  final int errorChars;

  const Running({
    required this.startedAt,
    required this.typedChars,
    required this.errorChars,
  });
}

final class Finished extends TypingState {
  final Duration duration;
  final double wpm;

  const Finished({required this.duration, required this.wpm});
}
```

En Flutter 3.x puedes colgar esto de la solución de estado que prefieras (`ValueNotifier` simple, Provider, Riverpod, BLoC). La clave es que tu UI renderiza un estado, no un montón de condicionales repartidos por los widgets.

## Mantén la "lista de palabras" y los "stats" detrás de una interfaz

Las apps de escritorio suelen sumar persistencia más tarde. Si empiezas con una frontera como:

-   `WordSource` (en memoria ahora, basada en archivos después)
-   `SessionRepository` (no-op ahora, SQLite después)

puedes mantener la lógica de escritura determinista y testeable por unidad mientras igual lanzas UI pronto.

Si estás construyendo una app de escritorio en Flutter 3.x y quieres un repo real al que mirar para estructurarte, este vale la pena seguirlo. Aunque nunca lo clones, la idea central es simple: en escritorio, la arquitectura no es exagerada, es como sigues avanzando.
