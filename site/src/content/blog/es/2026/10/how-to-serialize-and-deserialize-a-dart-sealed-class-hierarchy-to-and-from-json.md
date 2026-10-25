---
title: "Cómo serializar y deserializar una jerarquía de clases sealed de Dart a y desde JSON"
description: "Pon un campo discriminador en el JSON, haz un switch sobre él en un factory de la base sealed y haz un switch sobre el subtipo para escribirlo de vuelta. Tres versiones funcionales en Dart 3.13.7: coincidencia de patrones escrita a mano, json_serializable 6.15.2 y Freezed 4.0.3 con unionKey y fallbackUnion, además de las trampas que esconde cada una."
pubDate: 2026-10-25
template: how-to
tags:
  - "dart"
  - "flutter"
  - "json"
  - "freezed"
  - "json-serializable"
  - "sealed-classes"
lang: "es"
translationOf: "2026/10/how-to-serialize-and-deserialize-a-dart-sealed-class-hierarchy-to-and-from-json"
translatedBy: "claude"
translationDate: 2026-10-25
---

**Respuesta corta:** JSON no sabe de qué subclase de Dart proviene un objeto, así que tienes que escribir esa información en el payload tú mismo, normalmente como un campo discriminador como `"type": "circle"`. Deserializa con un `factory Shape.fromJson` en la base sealed que haga un switch sobre ese campo y delegue en la subclase correcta, y serializa con un `toJson` que haga un switch sobre `this` (de forma exhaustiva, gracias a `sealed`) y vuelva a añadir el discriminador. Puedes escribirlo a mano con los patrones de mapa de Dart 3, dejar que json_serializable genere el cuerpo de cada subclase mientras tú escribes el despacho, o dejar que Freezed lo genere todo con `@Freezed(unionKey: 'type')`. Todo lo que sigue se compiló y se ejecutó en Dart 3.13.7 (el SDK de Flutter 3.47.8) con json_serializable 6.15.2, json_annotation 4.12.0, Freezed 4.0.3, freezed_annotation 3.1.0 y build_runner 2.17.1.

## Por qué una jerarquía sealed no hace el viaje de ida y vuelta por sí sola

Una `sealed class Shape` con las subclases `Circle` y `Rect` te da comprobación exhaustiva de `switch` dentro de Dart, pero `jsonDecode` solo te entrega `Map<String, dynamic>`, `List<dynamic>`, `String`, `num`, `bool` y `null`. Nada en `{"radius": 2}` dice "esto era un `Circle`". Así que el trabajo se divide en dos direcciones que necesitan herramientas distintas:

- **De Dart a JSON** es fácil porque tienes un objeto real. Un `switch (this)` sobre un tipo sealed lo comprueba el compilador, así que si más adelante añades un `Triangle`, cada `toJson` que lo olvide se convierte en un error de compilación.
- **De JSON a Dart** es la dirección difícil. Estás haciendo un switch sobre un *string* que viene del cable, y ningún compilador puede comprobar que cada posible string corresponde a una subclase. Necesitas una política para discriminadores desconocidos o ausentes.

El discriminador no tiene por qué llamarse `type`. Freezed usa `runtimeType` por defecto, muchas APIs usan `kind` o `@type`, y algunas APIs no tienen discriminador alguno y tienes que inferir el subtipo según qué claves están presentes. Los tres enfoques de abajo cubren esos casos.

## La jerarquía mínima y el formato de transmisión

Esta es la forma que se usa en todos los ejemplos:

```json
[
  { "type": "circle", "radius": 2 },
  { "type": "rect", "width": 3, "height": 4.5 }
]
```

Fíjate en `"radius": 2`. `jsonDecode` lo convierte en un `int`, no en un `double`, lo cual importa en cuanto tu campo está declarado como `double`.

## Opción 1: escrito a mano con patrones de mapa de Dart 3

Sin paquetes, sin generación de código. Los patrones de mapa comprueban que la clave exista *y* que el valor tenga el tipo correcto en un solo paso:

```dart
// Dart 3.13.7, no packages
sealed class Shape {
  const Shape();

  factory Shape.fromJson(Map<String, dynamic> json) => switch (json) {
        {'type': 'circle', 'radius': num radius} => Circle(radius.toDouble()),
        {'type': 'rect', 'width': num w, 'height': num h} =>
          Rect(w.toDouble(), h.toDouble()),
        {'type': String type} =>
          throw FormatException('Unknown or malformed Shape "$type"', json),
        _ => throw FormatException('Missing "type" discriminator', json),
      };

  Map<String, dynamic> toJson() => switch (this) {
        Circle(:final radius) => {'type': 'circle', 'radius': radius},
        Rect(:final width, :final height) =>
          {'type': 'rect', 'width': width, 'height': height},
      };
}

final class Circle extends Shape {
  const Circle(this.radius);
  final double radius;
}

final class Rect extends Shape {
  const Rect(this.width, this.height);
  final double width;
  final double height;
}
```

Ejecutándolo contra el payload anterior:

```text
[Circle, Rect]
[{"type":"circle","radius":2.0},{"type":"rect","width":3.0,"height":4.5}]
manual unknown THREW FormatException: Unknown or malformed Shape "hexagon"
manual missing type THREW FormatException: Missing "type" discriminator
manual circle missing radius THREW FormatException: Unknown or malformed Shape "circle"
manual radius as string THREW FormatException: Unknown or malformed Shape "circle"
```

Tres detalles hacen que esta versión sea mejor que el típico fragmento `json['radius'] as double`:

1. **`num` y luego `.toDouble()`.** Hacer coincidir `'radius': double r` fallaría con `2` porque el valor decodificado es un `int`. Hacer coincidir `num` acepta ambos.
2. **Los payloads incorrectos fallan con tu mensaje, no con un `TypeError`.** Un círculo sin radio, o con `"radius": "2"`, no coincide con el primer caso, cae al caso `{'type': String type}` y lanza una `FormatException` que lleva el mapa problemático.
3. **`toJson` lo comprueba el compilador.** Si añades `final class Triangle extends Shape` y lo olvidas, el analizador te detiene:

```text
error - The type 'Shape' isn't exhaustively matched by the switch cases since it doesn't match the pattern 'Triangle()'. Try adding a wildcard pattern or cases that match 'Triangle()'. - non_exhaustive_switch_expression
```

`fromJson` no recibe esa comprobación, porque hace el switch sobre el contenido del mapa. Mantén los dos switches uno junto al otro en la clase base para que quien revise el código vea ambos cuando se añada una subclase.

### Cuando la API no tiene discriminador

Si no controlas el payload y se ve como `{"radius": 2}` o `{"width": 3, "height": 4.5}`, los mismos patrones de mapa despachan según la *presencia* de claves:

```dart
// Dart 3.13.7: dispatch on key presence, no "type" field on the wire
factory Shape.fromJson(Map<String, dynamic> json) => switch (json) {
      {'radius': num r} => Circle(r.toDouble()),
      {'width': num w, 'height': num h} => Rect(w.toDouble(), h.toDouble()),
      _ => throw FormatException('Not a Shape', json),
    };
```

El orden importa aquí: los patrones de mapa ignoran las claves adicionales, así que pon primero el caso más específico. Un `RoundedRect` con `width`, `height` y `cornerRadius` debe coincidir antes que `Rect`, o cada rectángulo redondeado se convierte en uno simple.

La versión escrita a mano es la opción correcta para de tres a cinco subclases con un puñado de campos cada una. Más allá de eso, el código repetitivo por campo es donde viven los bugs, y la generación de código se paga sola.

## Opción 2: json_serializable para las subclases, tu propio despacho en la base

json_serializable no entiende las jerarquías sealed. La solicitud de funcionalidad, [google/json_serializable.dart#1342 "Support dart3 sealed class"](https://github.com/google/json_serializable.dart/issues/1342), está abierta desde agosto de 2023 y sigue abierta a fecha de 6.15.2. Lo que sí hace bien es generar el código campo por campo para cada clase concreta, así que el patrón es: anota las subclases, escribe a mano los dos switches en la base.

```dart
// Dart 3.13.7, json_serializable 6.15.2, json_annotation 4.12.0
import 'package:json_annotation/json_annotation.dart';

part 'shape.g.dart';

sealed class Shape {
  const Shape();

  factory Shape.fromJson(Map<String, dynamic> json) => switch (json['type']) {
        'circle' => Circle.fromJson(json),
        'rect' => Rect.fromJson(json),
        final type => throw CheckedFromJsonException(
            json, 'type', 'Shape', 'Unknown Shape type "$type"'),
      };

  Map<String, dynamic> toJson();
}

@JsonSerializable()
final class Circle extends Shape {
  const Circle(this.radius);
  final double radius;

  factory Circle.fromJson(Map<String, dynamic> json) => _$CircleFromJson(json);

  @override
  Map<String, dynamic> toJson() => {'type': 'circle', ..._$CircleToJson(this)};
}

@JsonSerializable()
final class Rect extends Shape {
  const Rect(this.width, this.height);
  final double width;
  final double height;

  factory Rect.fromJson(Map<String, dynamic> json) => _$RectFromJson(json);

  @override
  Map<String, dynamic> toJson() => {'type': 'rect', ..._$RectToJson(this)};
}
```

Ejecuta `dart run build_runner build`. El `_$CircleToJson` generado solo contiene `radius`; no sabe nada del discriminador, por eso cada override lo expande dentro de un mapa que empieza con `'type'`. Lanzar `CheckedFromJsonException` para los tipos desconocidos mantiene la forma del error idéntica a la que lanza el código generado en otras partes, de modo que un solo manejador `on CheckedFromJsonException` cubre ambos.

Como `Shape` ahora tiene un factory `fromJson` y un método `toJson`, json_serializable la trata como cualquier otro tipo serializable cuando aparece como campo. Una clase contenedora simplemente funciona para decodificar:

```dart
// Dart 3.13.7, json_serializable 6.15.2
@JsonSerializable(explicitToJson: true)
class Drawing {
  Drawing(this.name, this.shapes);
  final String name;
  final List<Shape> shapes;

  factory Drawing.fromJson(Map<String, dynamic> json) => _$DrawingFromJson(json);
  Map<String, dynamic> toJson() => _$DrawingToJson(this);
}
```

El decodificador generado llama a `Shape.fromJson(e as Map<String, dynamic>)` para cada elemento, así que se reutiliza el despacho que escribiste. Mantén `explicitToJson: true`; el motivo está en las trampas de más abajo.

La única debilidad: cuando a un payload le falta un campo, el código generado no te dice cuál. `Shape.fromJson({'type': 'circle'})` lanza `type 'Null' is not a subtype of type 'num' in type cast`. Añade `@JsonSerializable(checked: true)` a las subclases si quieres una `CheckedFromJsonException` que nombre la clave.

## Opción 3: Freezed genera toda la unión

Freezed modela una jerarquía sealed como una clase con varios constructores factory, y cuando json_serializable también es una dependencia de desarrollo, genera el despacho, el discriminador y el código de cada caso:

```dart
// Dart 3.13.7, freezed 4.0.3, freezed_annotation 3.1.0, json_serializable 6.15.2
import 'package:freezed_annotation/freezed_annotation.dart';

part 'shape.freezed.dart';
part 'shape.g.dart';

@Freezed(unionKey: 'type', unionValueCase: FreezedUnionCase.snake)
sealed class Shape with _$Shape {
  const factory Shape.circle({required double radius}) = Circle;
  const factory Shape.rect({required double width, required double height}) =
      Rect;
  const factory Shape.roundedRect({
    required double width,
    required double height,
    required double cornerRadius,
  }) = RoundedRect;

  factory Shape.fromJson(Map<String, dynamic> json) => _$ShapeFromJson(json);
}
```

Las dependencias de desarrollo son `build_runner`, `freezed` y `json_serializable`; las dependencias normales son `freezed_annotation` y `json_annotation`. Freezed 4.0.3 requiere Dart 3.13, así que en Flutter 3.44 (Dart 3.12) te quedas en Freezed 3.2.x, donde las mismas anotaciones funcionan.

Lo que hace el código generado:

```text
[{"radius":2.0,"type":"circle"},{"width":3.0,"height":4.5,"type":"rect"},{"width":1.0,"height":2.0,"cornerRadius":0.5,"type":"rounded_rect"}]
fz unknown THREW CheckedFromJsonException: Could not create `Shape`. There is a problem with "type". Invalid union type "hexagon"!
fz missing type THREW CheckedFromJsonException: Could not create `Shape`. There is a problem with "type". Invalid union type "null"!
```

- `unionKey: 'type'` renombra el discriminador. Sin él, Freezed escribe y lee `runtimeType`, así que una unión `@freezed` simple produce `{"n": 1, "runtimeType": "a"}`. Eso casi nunca es lo que espera un backend.
- `unionValueCase` controla cómo los nombres de constructor se convierten en valores: `roundedRect` pasa a ser `rounded_rect` con `FreezedUnionCase.snake`, `rounded-rect` con `kebab`, `RoundedRect` con `pascal`, y sigue siendo `roundedRect` con el valor por defecto `none`.
- `@FreezedUnionValue('rounded-rect')` en un constructor sobrescribe el valor solo para ese caso, que es como se ajusta un formato de transmisión que no sigue una única regla de capitalización.
- Las clases generadas son subtipos reales, así que un `switch (shape) { Circle(:final radius) => ..., Rect() => ..., RoundedRect() => ... }` exhaustivo funciona exactamente igual que en la opción 1.

Si quieres los ajustes en todas partes en lugar de por clase, ponlos en `build.yaml`:

```yaml
# build.yaml, freezed 4.0.3
targets:
  $default:
    builders:
      freezed:
        options:
          union_key: type
          union_value_case: snake
```

### Tipos desconocidos: `fallbackUnion`

Los clientes sobreviven a los despliegues del servidor. Cuando el backend añade un nuevo tipo de evento, una app que lanza una excepción ante discriminadores desconocidos se cae con una lista que de otro modo habría podido mostrar. El `fallbackUnion` de Freezed dirige cada valor no reconocido a un solo constructor:

```dart
// Dart 3.13.7, freezed 4.0.3
@Freezed(unionKey: 'type', fallbackUnion: 'unknown')
sealed class Event with _$Event {
  const factory Event.click({required int x, required int y}) = ClickEvent;
  const factory Event.unknown() = UnknownEvent;

  factory Event.fromJson(Map<String, dynamic> json) => _$EventFromJson(json);
}
```

Decodificar `{"type": "scroll", "dy": 120}` da `Event.unknown()`, y su `toJson()` devuelve `{type: scroll}`: Freezed conserva el discriminador original en el campo oculto `$type`, pero el payload (`dy`) se pierde. Una clave `type` ausente también termina en el fallback. Si necesitas reenviar o registrar eventos desconocidos fielmente, dale al constructor de fallback un campo `Map<String, dynamic>` y rellénalo con un `fromJson` personalizado, o usa la versión escrita a mano, donde el caso `_` puede conservar el mapa completo.

## Trampas que muerden en todos los enfoques

1. **El `toJson` anidado devuelve objetos, no mapas, a menos que lo pidas.** Sin `explicitToJson: true`, json_serializable escribe `'shapes': instance.shapes`. El resultado de `Drawing.toJson()` es `{name: d, shapes: [Instance of 'Circle', Instance of 'Rect']}`. `jsonEncode` oculta el problema porque llama a `toJson()` sobre cualquier cosa que no pueda codificar, así que el string parece correcto. Cualquier cosa que consuma el *mapa* (Firestore, `shared_preferences` mediante un mapa, mensajes de `Isolate`, una prueba que compare mapas) recibe objetos de Dart. Freezed tiene el mismo valor por defecto; la solución ahí es anotar el constructor factory:

   ```dart
   // Dart 3.13.7, freezed 4.0.3
   @freezed
   abstract class FzDrawing with _$FzDrawing {
     @JsonSerializable(explicitToJson: true)
     const factory FzDrawing({required String name, required List<Shape> shapes}) =
         _FzDrawing;

     factory FzDrawing.fromJson(Map<String, dynamic> json) =>
         _$FzDrawingFromJson(json);
   }
   ```

   Tras ese cambio, `toJson()` produjo `{name: d, shapes: [{radius: 2.0, type: circle}, ...]}` y el viaje de decodificar, codificar y decodificar de nuevo dio objetos iguales.

2. **`int` frente a `double`.** El código generado ya hace `(json['radius'] as num).toDouble()`. El código escrito a mano que hace el cast `as double` lanza una excepción con `2`, y el `jsonEncode` de Dart vuelve a escribir `2.0`, así que una comparación byte a byte con el payload original falla incluso cuando el valor hizo el viaje de ida y vuelta correctamente. Compara objetos decodificados, no strings.

3. **El discriminador no debe colisionar con un campo.** Si un caso ya tiene un campo llamado `type`, Freezed no se queja. Con `unionKey: 'type'` y `const factory Note.email({required String type, required String to})`, `toJson()` devolvió `{type: urgent, to: a}`: el campo reemplazó silenciosamente al discriminador, así que decodificar esa salida lanza `Invalid union type "urgent"!`. En la otra dirección, `Note.fromJson({'type': 'email', 'to': 'a'})` mete el discriminador en el campo (`Note.email(type: email, ...)`). Elige un `unionKey` que ningún campo use, como `kind`. Las versiones escrita a mano y con json_serializable tienen la misma trampa si el `toJson` de una subclase contiene una clave `type`, porque el spread sobrescribe el literal.

4. **Renombrar un constructor es un cambio del formato de transmisión.** Con Freezed, el valor del discriminador se deriva del nombre del constructor. Renombrar `Shape.rect` a `Shape.rectangle` cambia silenciosamente lo que envías y rompe todos los documentos almacenados y los clientes más antiguos. Fija los valores con `@FreezedUnionValue('rect')` en todo lo que se persista o se comparta con otro servicio.

5. **Las opciones de `build_runner` han cambiado.** En build_runner 2.17.1, `dart run build_runner build --delete-conflicting-outputs` imprime `These options have been removed and were ignored: --delete-conflicting-outputs` y aun así compila. Los README antiguos y los scripts de CI todavía lo pasan; la advertencia es inofensiva, pero quítalo para que no oculte una real.

6. **Los genéricos necesitan `genericArgumentFactories`.** Una `sealed class Result<T>` con los casos `Ok<T>` y `Err<T>` necesita `@JsonSerializable(genericArgumentFactories: true)` (o `@Freezed(genericArgumentFactories: true)`), y entonces `fromJson` recibe un parámetro adicional `T Function(Object?) fromJsonT`. Planifica esa firma antes de extender `Result.fromJson` por todo el código.

## Cuál elegir

- **Escrito a mano** para jerarquías pequeñas y estables, o cuando el payload no tiene discriminador y debes inferir el tipo a partir de sus claves. Cero dependencias, los mejores mensajes de error, pero cada campo es código que mantienes.
- **json_serializable en las subclases** cuando ya lo usas para DTOs simples y quieres mantener las subclases como clases normales con sus propios métodos. Escribes unas diez líneas de despacho por jerarquía.
- **Freezed** cuando también quieres `copyWith`, igualdad por valor y `toString`, o la jerarquía es grande. Establece `unionKey` de forma explícita, fija los valores con `@FreezedUnionValue` para datos persistidos y decide desde el principio si los tipos desconocidos lanzan una excepción o van a `fallbackUnion`. La [comparación de records frente a Freezed](/es/2026/05/dart-records-vs-freezed-classes/) explica cuándo merece la pena tener la generación de código de Freezed.

### Sigue leyendo

- [Fix FormatException: Unexpected character when parsing JSON in Dart](/es/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/) para el paso previo a que `fromJson` siquiera se ejecute.
- [Fix "type 'Null' is not a subtype of type" in Dart](/es/2026/07/fix-type-null-is-not-a-subtype-of-type-in-dart/), el error que produce un campo ausente en el código `fromJson` generado.
- [How to handle network errors gracefully in a Flutter app](/es/2026/06/how-to-handle-network-errors-gracefully-in-a-flutter-app/), incluido dónde debe aflorar en la interfaz un fallo de decodificación.
- El equivalente en C#, [serializar una jerarquía polimórfica con JsonDerivedType en System.Text.Json](/es/2026/07/how-to-serialize-a-polymorphic-type-hierarchy-with-jsonderivedtype-in-system-text-json/), resuelve el mismo problema del discriminador con atributos.

### Fuentes

- [Dart language: patterns, map patterns](https://dart.dev/language/pattern-types#map) y [class modifiers: sealed](https://dart.dev/language/class-modifiers#sealed)
- [Freezed README: fromJSON for classes with multiple constructors](https://pub.dev/packages/freezed#fromjson---classes-with-multiple-constructors) y el [Freezed changelog](https://pub.dev/packages/freezed/changelog)
- [json_serializable on pub.dev](https://pub.dev/packages/json_serializable) e [issue #1342, sealed class support](https://github.com/google/json_serializable.dart/issues/1342)
- [build_runner changelog](https://pub.dev/packages/build_runner/changelog)
