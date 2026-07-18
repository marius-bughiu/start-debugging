---
title: "Solución: type 'Null' is not a subtype of type 'X' en Dart"
description: "Este error de ejecución significa que un null llegó a una conversión que esperaba un tipo no anulable, casi siempre desde JSON. Haz el campo anulable, o proporciona un valor por defecto antes de la conversión."
pubDate: 2026-07-18
template: error-page
tags:
  - "errors"
  - "dart"
  - "flutter"
lang: "es"
translationOf: "2026/07/fix-type-null-is-not-a-subtype-of-type-in-dart"
translatedBy: "claude"
translationDate: 2026-07-18
---

`type 'Null' is not a subtype of type 'X'` es un error de tipo en tiempo de ejecución: un `null` llegó a un punto de tu código donde una conversión o una asignación insistía en un tipo no anulable. La fuente abrumadoramente común es el análisis de JSON, donde una clave falta o llega como `null` y tú la conviertes directamente a `String`, `int` o un tipo de modelo. La solución es impedir que la conversión vea un `null` crudo: o declaras el tipo de destino como anulable (`String?`) y manejas el null, o proporcionas un valor por defecto con `?? fallback` antes de que la conversión ocurra. Esto está verificado contra Dart 3.12 (Flutter 3.44); el comportamiento ha sido el mismo en cada versión con null safety sólido desde Dart 2.12.

## El error en contexto

El mensaje nombra el tipo concreto que se suponía que el valor debía ser. Desde una decodificación de JSON normalmente se ve así:

```
Unhandled Exception: type 'Null' is not a subtype of type 'String' in type cast
#0      _$UserFromJson (package:myapp/models/user.dart:12:34)
#1      new User.fromJson (package:myapp/models/user.dart:8:7)
#2      fetchUser (package:myapp/api/client.dart:41:24)
<asynchronous suspension>
```

Dos palabras en ese mensaje hacen todo el trabajo. La primera, `'Null'`, es el tipo que el valor realmente tenía en tiempo de ejecución: era `null`. La segunda, tras "subtype of type", es lo que el código exigía: `'String'`, `'int'`, `'List<dynamic>'`, `'Map<String, dynamic>'` o una de tus propias clases de modelo. El `in type cast` final te dice que el fallo ocurrió en una conversión `as` explícita o implícita, que es la huella reveladora de decodificar JSON `dynamic` sin tipar hacia campos tipados.

También verás la variante sin `in type cast`, por ejemplo `type 'Null' is not a subtype of type 'String'`, cuando el valor fluye hacia un parámetro o campo no anulable en lugar de una expresión `as`. La misma causa raíz, las mismas soluciones.

## Por qué sucede

Bajo null safety sólido, `Null` es su propio tipo y no es un subtipo de ningún tipo no anulable. Ese es todo el sentido del null safety: `String` genuinamente no puede contener `null`, así que el runtime se niega a dejar que un `null` se haga pasar por uno. Cuando escribes `json['name'] as String` y `json['name']` es `null`, estás pidiendo al runtime que trate `Null` como `String`, y lanza el error.

La razón por la que esto aparece en tiempo de ejecución en lugar de en tiempo de compilación es que JSON es `dynamic`. `jsonDecode` devuelve `dynamic`, y cada búsqueda en un `Map<String, dynamic>` también es `dynamic`. El compilador no puede ver qué hay realmente en el mapa, así que confía en tu conversión `as String` y difiere la comprobación al tiempo de ejecución. Si el valor real es `null`, la comprobación falla en el momento en que esa línea se ejecuta. Por eso el error es tan común en las fábricas `fromJson` y en el código generado por `json_serializable`: esos son exactamente los lugares donde los valores `dynamic` se fuerzan a formas tipadas.

Hay tres situaciones que lo producen, en orden aproximado de frecuencia:

- La clave JSON falta por completo, así que `json['key']` devuelve `null`, y tú conviertes ese `null` a un tipo no anulable.
- La clave está presente pero su valor es JSON `null`, por ejemplo una columna anulable serializada desde un backend.
- El valor está presente pero tiene la forma equivocada, por ejemplo un número que llega como `int` cuando conviertes a `String`, o un objeto donde esperabas una lista. Esto lanza un mensaje de subtipo diferente pero es la misma categoría de error.

## Reproducción mínima

El fragmento más pequeño que reproduce el caso canónico:

```dart
// Dart 3.12, Flutter 3.44
import 'dart:convert';

class User {
  final String name;
  final int age;
  User({required this.name, required this.age});

  factory User.fromJson(Map<String, dynamic> json) => User(
        name: json['name'] as String, // throws if 'name' is null or missing
        age: json['age'] as int,
      );
}

void main() {
  // 'name' is absent from the payload
  final payload = jsonDecode('{"age": 30}') as Map<String, dynamic>;
  final user = User.fromJson(payload); // type 'Null' is not a subtype of type 'String'
  print(user.name);
}
```

`json['name']` se evalúa como `null` porque la clave no está en el mapa. La conversión `as String` entonces intenta ver `null` como un `String` y lanza el error. Ten en cuenta que la excepción se lanza dentro de `User.fromJson`, no en el `print`, razón por la cual la traza de pila apunta a tu archivo de modelo y no al widget que finalmente mostró los datos.

## Solución, en detalle

Recorre estas en orden. Las dos primeras cubren casi cada caso real; el resto maneja las formas que las soluciones simples no cubren.

### 1. Haz el campo anulable si los datos realmente pueden faltar

Si el backend puede omitir o anular legítimamente el valor, modélalo con honestidad. Declara el campo de Dart como anulable y deja que la conversión apunte a un tipo anulable, del cual `null` es subtipo:

```dart
// Dart 3.12, Flutter 3.44
class User {
  final String? name; // was String
  final int age;
  User({this.name, required this.age});

  factory User.fromJson(Map<String, dynamic> json) => User(
        name: json['name'] as String?, // as String?, not as String
        age: json['age'] as int,
      );
}
```

`json['name'] as String?` tiene éxito tanto si el valor es un `String` como si es `null`, porque `Null` es un subtipo de `String?`. El compromiso es que cada consumidor de `name` ahora tiene que manejar el null, que es exactamente la corrección que el sistema de tipos te está pidiendo que reconozcas. Esta es la solución correcta cuando el campo es genuinamente opcional.

### 2. Proporciona un valor por defecto con ?? antes de que el valor llegue a un campo no anulable

Si el campo debe permanecer no anulable pero puedes elegir un valor por defecto sensato, elimina el null antes de que la conversión se complete:

```dart
// Dart 3.12, Flutter 3.44
factory User.fromJson(Map<String, dynamic> json) => User(
      name: json['name'] as String? ?? 'Unknown', // cast to nullable, then default
      age: json['age'] as int? ?? 0,
    );
```

El orden importa. Convierte primero al tipo anulable (`as String?`), luego aplica `??`. Si escribes `json['name'] ?? 'Unknown' as String`, la precedencia lo convierte en `json['name'] ?? ('Unknown' as String)`, que no protege el lado izquierdo y aún lanza el error cuando el valor es un tipo no nulo equivocado. Convertir a anulable y aplicar la fusión de nulos es el idioma que se lee limpiamente y se comporta correctamente.

### 3. Nunca conviertas el valor de un mapa `dynamic` directamente a un tipo no anulable

El hábito que causa este error es `json['x'] as ConcreteType`. Haz de la forma segura tu opción por defecto: convierte al tipo anulable, luego decide qué significa un null. Para objetos y listas anidados, se aplica la misma regla un nivel más profundo:

```dart
// Dart 3.12, Flutter 3.44
// A list that may be absent -> default to empty, never null-cast the elements
final tags = (json['tags'] as List<dynamic>?)
        ?.map((e) => e as String)
        .toList() ??
    <String>[];

// A nested object that may be absent -> guard before recursing
final address = json['address'] == null
    ? null
    : Address.fromJson(json['address'] as Map<String, dynamic>);
```

Convertir el contenedor externo a `List<dynamic>?` o comprobar `== null` antes de recurrir impide que el `null` llegue jamás a un elemento o a una conversión anidada. Aquí es donde el código `fromJson` escrito a mano más a menudo se equivoca: el campo de nivel superior está protegido pero los elementos de la lista o el mapa anidado no lo están.

### 4. Si usas json_serializable, marca el campo como anulable o dale un valor por defecto

El código `fromJson` generado convierte exactamente igual que lo harías a mano, así que un campo no anulable con `@JsonKey` produce el mismo error en tiempo de ejecución cuando faltan los datos. Corrígelo en la declaración del modelo y regenera:

```dart
// Dart 3.12, Flutter 3.44, json_serializable 6.x
@JsonSerializable()
class User {
  final String? name;                       // nullable -> generator emits `as String?`
  @JsonKey(defaultValue: 0) final int age;  // default -> used when the key is null/absent
  User({this.name, required this.age});

  factory User.fromJson(Map<String, dynamic> json) => _$UserFromJson(json);
}
```

Un campo anulable hace que el generador emita `as String?`. Un `@JsonKey(defaultValue: ...)` hace que sustituya el valor por defecto cuando la clave falta o es null. Ejecuta `dart run build_runner build --delete-conflicting-outputs` tras cambiar las anotaciones, de lo contrario la vieja conversión generada es lo que se ejecuta.

### 5. Corrige el desajuste de forma cuando el valor no es realmente null

Si el error nombra un tipo como `'String'` pero el payload claramente tiene un valor, el valor tiene la forma equivocada. Un backend que envía `"age": "30"` (cadena) cuando conviertes `as int`, o `"30"` donde esperas un número, desencadena la misma familia de error. Coacciona explícitamente en lugar de convertir:

```dart
// Dart 3.12, Flutter 3.44
// Backend sends age as a string sometimes, an int other times
final age = json['age'] is int
    ? json['age'] as int
    : int.parse(json['age'].toString());
```

Este no es el caso de `Null`, pero lleva a la gente a esta página porque la forma del mensaje es idéntica. Cuando el tipo en el mensaje no es `'Null'` en el lado izquierdo, mira lo que el servidor realmente envió, no tu manejo de nulos.

## Trampas y variantes

- **La traza de pila apunta al modelo, no a la interfaz.** Como la conversión se ejecuta dentro de `fromJson`, el marco superior es tu archivo de modelo. Los desarrolladores a menudo empiezan a depurar el widget que mostró el campo en blanco; la solución real está uno o dos marcos más abajo, en la conversión. Lee el primer marco no perteneciente al framework en la traza.

- **`as String?` no es lo mismo que `as String`.** El único `?` es toda la solución en la mayoría de los casos. `as String?` permite `null`; `as String` lo prohíbe. Si copias una conversión de un campo no anulable a uno anulable, recuerda añadir el `?`, o has movido el error, no lo has solucionado.

- **Las conversiones de `Map<String, dynamic>` fallan de la misma manera.** `jsonDecode` devuelve `dynamic`. Si el payload completo es `null` (un cuerpo de respuesta 204 vacío, por ejemplo) entonces `jsonDecode(body) as Map<String, dynamic>` lanza `type 'Null' is not a subtype of type 'Map<String, dynamic>'` antes de que siquiera llegues a un campo. Protege la decodificación: `body.isEmpty ? null : jsonDecode(body)`. Esto se solapa con la entrada malformada que se maneja en [FormatException: Unexpected character al analizar JSON en Dart](/es/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/).

- **El operador bang mueve el fallo, no lo soluciona.** Escribir `json['name']!` convierte un error de subtipo `Null` en `Null check operator used on a null value`. Es el mismo null subyacente, lanzado por un mecanismo diferente. Consulta [Null check operator used on a null value en Flutter](/es/2026/06/fix-null-check-operator-used-on-a-null-value-in-flutter/) para saber por qué `!` debe reservarse para valores que puedes probar que no son nulos, no usarse para silenciar un compilador con el que no estás de acuerdo.

- **Los campos `late` convierten el mismo null en un error diferente.** Si diriges un valor posiblemente nulo hacia un campo `late` no anulable y lo lees antes de la asignación, obtienes `LateInitializationError` en su lugar. La cura es la misma: modela la ausencia con honestidad en lugar de prometer un valor que no tienes. Consulta [LateInitializationError: Field has not been initialized en Flutter](/es/2026/06/fix-lateinitializationerror-field-has-not-been-initialized-in-flutter/).

- **Los argumentos de tipo genérico ocultan la conversión.** `List<String>.from(json['tags'])` y `(json['tags'] as List).cast<String>()` ambos lanzan este error de forma perezosa, cuando un elemento es `null`, y la traza puede apuntar a `.cast` en lugar de a tu código. Prefiere un `.map((e) => e as String?)` explícito para que el fallo sea visible y tuyo para manejar.

- **Este es un error en tiempo de ejecución, así que las pruebas lo detectan y el analizador no.** El analizador no puede ver dentro de un mapa JSON `dynamic`, así que `dart analyze` se mantiene en verde mientras la conversión es insegura. Una sola prueba unitaria de `fromJson` con un payload que omite el campo saca a la luz el error antes de que lo haga un usuario. Si estás migrando una base de código más antigua, la [lista de comprobación de migración a null safety de Flutter](/es/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/) recorre dónde tienden a esconderse estas conversiones.

El modelo mental para llevarse: este error es null safety negándose a dejar que un `null` finja ser algo que no es. El valor entró como `null`, y alguna conversión o asignación aguas abajo prometió que no lo sería. La solución nunca es forzar la conversión con más fuerza; es decidir, en la frontera donde los datos `dynamic` entran en tu mundo tipado, si ese campo puede estar ausente. Si puede, hazlo anulable y maneja el null. Si no puede, dale un valor por defecto antes de que la conversión se complete. Haz eso en cada búsqueda `json[...]` y este error deja de aparecer.

## Relacionado

- [Solución: FormatException: Unexpected character al analizar JSON en Dart](/es/2026/05/fix-formatexception-unexpected-character-when-parsing-json-in-dart/) para el error hermano cuando el payload ni siquiera es JSON válido.
- [Solución: Null check operator used on a null value en Flutter](/es/2026/06/fix-null-check-operator-used-on-a-null-value-in-flutter/) para lo que sucede cuando recurres a `!` para silenciar esta conversión en su lugar.
- [Solución: LateInitializationError: Field has not been initialized en Flutter](/es/2026/06/fix-lateinitializationerror-field-has-not-been-initialized-in-flutter/) para la variante `late` de prometer un valor que no tienes.
- [Migra una app de Flutter 2 a Flutter 3.x: lista de comprobación de null safety](/es/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/) para encontrar estas conversiones inseguras en toda una base de código.

## Fuentes

- Dart, [Understanding null safety](https://dart.dev/null-safety/understanding-null-safety) (por qué `Null` ya no es un subtipo de todo tipo, y por qué las conversiones implícitas desde `dynamic` se convirtieron en conversiones explícitas que fallan en tiempo de ejecución).
- Dart, [Sound null safety](https://dart.dev/null-safety) (las garantías que hacen que un `String` no anulable rechace `null` en tiempo de ejecución).
- GitHub, [dart-lang/sdk issue #53700](https://github.com/dart-lang/sdk/issues/53700) ("type 'Null' is not a subtype of type 'String'" reportado contra código real de decodificación de JSON, con la causa raíz de la clave faltante).
