---
title: "Flutter 3.44: Lee el radio de las esquinas físicas de la pantalla desde MediaQuery"
description: "Flutter 3.44 expone las esquinas redondeadas del dispositivo a través de MediaQuery.displayCornerRadiiOf. Deja de adivinar un radio mágico y recorta tu UI a la curva exacta del hardware en Android API 31+."
pubDate: 2026-07-07
tags:
  - "flutter"
  - "dart"
lang: "es"
translationOf: "2026/07/flutter-3-44-read-the-screen-corner-radius-from-mediaquery"
translatedBy: "claude"
translationDate: 2026-07-07
---

Los teléfonos dejaron de tener pantallas cuadradas hace años, pero Flutter nunca te decía qué tan redondas eran las esquinas en realidad. Si querías que una tarjeta o una hoja a pantalla completa se ajustara a la curva física de la pantalla, codificabas a mano un `BorderRadius.circular(24)` que calibrabas a ojo contra un dispositivo y esperabas que se viera bien en el resto. Flutter 3.44, la versión estable actual, por fin lee ese valor directamente del hardware y te lo entrega a través de `MediaQuery`.

## El valor que el sistema operativo ya conocía

Android expone los radios por esquina a través de su API `RoundedCorner` desde el nivel de API 31, pero el framework nunca los mostraba. El [PR #179219](https://github.com/flutter/flutter/pull/179219) canaliza esos radios desde las métricas de ventana del motor hasta `MediaQueryData`. Los lees igual que lees el padding o los view insets:

```dart
final BorderRadius? corners = MediaQuery.displayCornerRadiiOf(context);
```

El tipo de retorno es un `BorderRadius` anulable. Cada esquina es un `Radius` en píxeles lógicos, así que se compone directamente con los widgets que ya usas. En Android por debajo de la API 31, en iOS y en cualquier otra plataforma, el valor es `null`, así que una comprobación de null es tu ruta alternativa, no una idea de último momento.

## Recortar según la curva del hardware

El uso obvio es una superficie a pantalla completa cuyo redondeo coincida con el cristal. Antes inventabas un número. Ahora se lo preguntas a la pantalla:

```dart
@override
Widget build(BuildContext context) {
  final BorderRadius radius =
      MediaQuery.displayCornerRadiiOf(context) ?? BorderRadius.circular(16);

  return ClipRRect(
    borderRadius: radius,
    child: ColoredBox(
      color: Theme.of(context).colorScheme.surface,
      child: content,
    ),
  );
}
```

Como `displayCornerRadii` es un `BorderRadius` real, sus cuatro esquinas pueden diferir. Eso importa en dispositivos donde la curva inferior es más cerrada que la superior, o donde una bisagra plegable le da a un borde un perfil distinto. También puedes obtener una sola esquina cuando solo necesitas una:

```dart
final Radius topLeft =
    (MediaQuery.displayCornerRadiiOf(context) ?? BorderRadius.zero).topLeft;
```

## Píxeles físicos cuando los necesitas

`MediaQuery` te da píxeles lógicos, que es lo que quiere el código de layout. Si trabajas a nivel de píxel puro, por ejemplo dentro de un `RenderObject` personalizado o un shader, los mismos datos están en la vista: `FlutterView.displayCornerRadii` devuelve los valores en píxeles físicos. Elige el que coincida con el espacio de coordenadas en el que dibujas y evitarás una multiplicación por `devicePixelRatio` que es fácil de invertir.

## Dónde realmente vale la pena

La mayoría de las apps no necesitan una coincidencia de esquinas perfecta al píxel, y `SafeArea` sigue resolviendo el caso común de mantener el contenido fuera del notch. Esto es para las superficies que se leen como parte del dispositivo mismo: hojas inferiores que se deslizan hasta el borde del cristal, reproductores multimedia inmersivos, layouts de kiosco y las nuevas transiciones de retroceso predictivo, que Flutter 3.44 ya conecta a `displayCornerRadii` para que la pantalla saliente se encoja en un rectángulo correctamente redondeado.

La característica es pequeña, pero cierra una brecha que obligaba a cada traspaso de diseñador a desarrollador a terminar en un número adivinado. Trata `null` como "asume cuadrado, recurre a tu propia constante" y el resto es solo leer un valor que el sistema operativo tenía guardado todo el tiempo. Consulta la [documentación de MediaQueryData.displayCornerRadii](https://api.flutter.dev/flutter/widgets/MediaQueryData/displayCornerRadii.html) para el contrato completo.
