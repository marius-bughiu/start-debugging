---
title: "Dart records vs clases Freezed: ¿cuál deberías elegir en 2026?"
description: "Elige los records de Dart 3.12 para datos efímeros con forma local y sin métodos, y las clases Freezed 3.x para modelos de dominio con nombre que necesiten copyWith, uniones selladas, serialización JSON o cualquier comportamiento."
pubDate: 2026-05-27
template: vs
tags:
  - "comparison"
  - "dart"
  - "flutter"
  - "freezed"
  - "records"
lang: "es"
translationOf: "2026/05/dart-records-vs-freezed-classes"
translatedBy: "claude"
translationDate: 2026-05-27
---

En Dart 3.12 (la versión que llegó con Flutter 3.44 en Google I/O 2026), los records y Freezed resuelven ambos "necesito un tipo de valor inmutable con igualdad estructural", pero lo hacen desde direcciones opuestas. Los records son un tipo estructural, anónimo e incorporado, sin generación de código. Freezed 3.x es un tipo nominal generado por código con `copyWith`, uniones selladas, serialización JSON y el resto del conjunto de herramientas para clases de datos. La respuesta corta: usa un record cuando los datos sean una forma local y efímera que no necesite un nombre ni un método, y usa Freezed para cualquier clase que forme parte de tu modelo de dominio, tu árbol de estado o el formato de tu API.

Este artículo cubre los records de Dart 3.12 (estables desde Dart 3.0 en mayo de 2023, con la sintaxis corta de campos nombrados añadida en 3.7 y los campos nombrados privados añadidos en 3.12) y Freezed 3.x sobre `build_runner` 2.4 (Freezed 3.0 se publicó en marzo de 2025 con una salida generada más pequeña y un valor predeterminado `@Freezed(toJson: false)` para uniones). Ambos apuntan a la misma base de Flutter 3.44 y Dart 3.12. La elección no es "los records son nuevos, Freezed es viejo", porque ambos se mantienen activamente y ambos tienen su lugar en una aplicación Flutter de 2026. La elección depende de para qué sirve el tipo.

## Qué es cada uno en realidad

Un **record de Dart** es un tipo agregado anónimo, inmutable e incorporado. El tipo `(int, String)` es un record con dos campos posicionales. El tipo `({int id, String name})` es un record con dos campos nombrados. Los records son estructurales: dos records cualesquiera con la misma forma de campos son el mismo tipo, aunque se hayan declarado en archivos distintos. El compilador genera `==`, `hashCode` y `toString` automáticamente. No puedes añadir métodos. No puedes adjuntar comportamiento. No puedes darle a un record un nombre a nivel de clase (puedes hacer `typedef User = ({int id, String name});`, pero el typedef es solo un alias del tipo estructural, no un nuevo tipo nominal).

Una **clase Freezed 3.x** es una clase Dart real con un mixin generado. Escribes una clase normal con un constructor `factory` que enumera los campos, ejecutas `dart run build_runner build`, y Freezed genera `==`, `hashCode`, `toString`, `copyWith`, opcionalmente `fromJson` y `toJson`, y (para uniones selladas) los ayudantes de coincidencia de patrones `when` y `map`. La clase es nominal: `User` y `Customer` con los mismos campos no son intercambiables. Puedes añadir métodos, getters calculados y constructores fábrica. Puedes marcar la clase como `sealed` y declarar múltiples casos de unión que coincidan con patrones de forma exhaustiva.

Los dos no son sustitutos directos. Se solapan en el caso de "desestructurar en algo parecido a una tupla" y divergen en todo lo demás.

## La matriz de características

| Capacidad                               | Record de Dart 3.12                  | Clase Freezed 3.x                       |
| --------------------------------------- | ------------------------------------ | --------------------------------------- |
| Coste de declaración                    | en línea, sin archivo                | clase + factory + directiva part + build_runner |
| Generación de código                    | ninguna                              | sí (`*.freezed.dart` + `*.g.dart` opcional) |
| Identidad de tipo                       | estructural                          | nominal                                 |
| Tipo con nombre                         | solo mediante `typedef`              | sí, clase completa                      |
| Nombres de campos en IDE y errores      | solo si se declaran como nombrados   | siempre (aparece el nombre de la clase) |
| `==` y `hashCode`                       | automático, basado en valor          | automático, basado en valor             |
| `toString`                              | automático (`(1, name: 'a')`)        | automático (`User(id: 1, name: 'a')`)   |
| `copyWith`                              | no                                   | sí, incluido `copyWith.field(...)` profundo |
| `fromJson` / `toJson`                   | no (manual)                          | sí mediante `json_serializable`         |
| Unión sellada / tipo suma               | no                                   | sí (`sealed class` + múltiples factories) |
| Métodos o getters personalizados        | no                                   | sí (constructor privado + métodos)      |
| Valores predeterminados de campos       | no (deben ser explícitos en cada llamada) | sí (valores predeterminados en factory) |
| Aserciones / validación                 | no                                   | sí (en el cuerpo de la factory o `@Assert`) |
| Herencia                                | no                                   | sí solo mediante uniones selladas       |
| Coincidencia de patrones                | sí (posicional y nombrada)           | sí mediante el `when` generado o coincidencia de patrones sobre el sellado |
| Coste de build / IDE                    | cero                                 | `build_runner watch` activo, archivos generados en el árbol |
| Estabilidad de la API pública           | renombrar un campo es un cambio incompatible porque cambia la forma | renombrar un campo es el mismo cambio incompatible pero el nombre de la clase ancla el tipo |
| Huella de memoria                       | una asignación, sin v-table más allá de Object | una asignación, métodos de mixin generados |

Las tres filas que deciden la mayoría de los casos: coste de declaración, tipo con nombre frente a estructural, y si necesitas `copyWith` o JSON. Si no necesitas ninguno de ellos, el record gana por peso. Si necesitas cualquiera de ellos, Freezed gana por ergonomía.

## Cuándo elegir un record de Dart

Elige un record cuando:

- **Estás devolviendo dos o más valores desde un único método.** Este es el caso de uso motivador original de Dart 3.0, y sigue siendo el más fuerte. Un record le gana a un parámetro de salida, a una lista de dos elementos o a una pequeña clase ayudante. El sitio de llamada desestructura con un patrón.

  ```dart
  // Dart 3.12, Flutter 3.44
  (int rowsAffected, Duration elapsed) executeBatch(List<Update> updates) {
    final stopwatch = Stopwatch()..start();
    final n = _runBatch(updates);
    stopwatch.stop();
    return (n, stopwatch.elapsed);
  }

  // Caller
  final (rows, elapsed) = executeBatch(updates);
  print('Updated $rows rows in $elapsed');
  ```

  Una clase Freezed para esto serían tres archivos (`batch_result.dart`, `batch_result.freezed.dart`, opcionalmente `batch_result.g.dart`) para un valor que vive una sola línea.

- **La forma es local a una función o a un widget.** Un `_HitTestResult` que existe durante diez líneas de cálculo de layout debería ser un record, no una clase. Si la forma se filtra fuera del archivo, esa es la señal de que debería convertirse en una clase Freezed.

- **Estás haciendo coincidencia de patrones sobre la forma de los datos devueltos.** Las expresiones switch sobre records son la forma en que Dart 3 espera que manejes la salida de un parser, la salida de un validador o cualquier valor de retorno "etiqueta más carga útil" donde la carga útil es una de un puñado de formas y vive solo en el sitio de llamada.

  ```dart
  // Dart 3.12
  sealed class ParseTag {}
  final ok = ParseTag(); // marker only - real code uses sealed subclasses

  ({bool ok, String? error, Map<String, dynamic>? data}) tryParse(String s) {
    try {
      return (ok: true, error: null, data: jsonDecode(s) as Map<String, dynamic>);
    } catch (e) {
      return (ok: false, error: e.toString(), data: null);
    }
  }

  final result = tryParse(input);
  switch (result) {
    case (ok: true, data: final m?, error: _):
      handle(m);
    case (ok: false, error: final msg?, data: _):
      reportError(msg);
    default:
      reportError('unknown parse failure');
  }
  ```

  Para un resultado puro de error-o-carga útil que fluye hacia arriba dos marcos de pila, un record es más limpio que introducir una unión sellada `Result<T>` con Freezed. En el momento en que tres sitios de llamada distintos hacen switch sobre la misma forma, promuévela a un tipo con nombre.

- **Quieres cero coste de `build_runner` en esta parte del código.** Los records no añaden generación de código, ni directivas part, ni proceso de watch. En un paquete Flutter o una biblioteca solo Dart donde quieras enviar sin ningún paso de generador, los records son la única opción de tipo de valor inmutable aparte de una clase escrita a mano.

- **El número de campos es pequeño y los tipos de los campos son obvios por el contexto.** Dos o tres campos cuyo significado quede claro en el sitio de llamada. Una vez que tengas cinco campos y el sitio de llamada necesite IntelliSense para recordar para qué es cada uno, has superado un record y necesitas una clase con nombre.

## Cuándo elegir una clase Freezed 3.x

Elige Freezed cuando:

- **El tipo es un modelo de dominio, un DTO de API o una pieza de estado de la aplicación.** Cualquier cosa que cruce un límite de capa, que se registre, que se serialice o que aparezca en trazas de pila se beneficia de tener un nombre de clase real. `User`, `Order`, `LineItem`, `AppState`, `AuthState`. Estos tipos merecen una identidad nominal, un `toString` que imprima el nombre de la clase y una experiencia de depuración donde el IDE muestre `User { id, email, createdAt }` y no `({int id, String email, DateTime createdAt})`.

  ```dart
  // Dart 3.12, Flutter 3.44, freezed 3.x, json_serializable 6.x
  import 'package:freezed_annotation/freezed_annotation.dart';

  part 'user.freezed.dart';
  part 'user.g.dart';

  @freezed
  class User with _$User {
    const User._();

    const factory User({
      required int id,
      required String email,
      DateTime? createdAt,
      @Default(false) bool emailVerified,
    }) = _User;

    factory User.fromJson(Map<String, dynamic> json) => _$UserFromJson(json);

    bool get isVerified => emailVerified && email.contains('@');
  }
  ```

  Ejecuta `dart run build_runner build --delete-conflicting-outputs` y obtienes `==`, `hashCode`, `toString`, `copyWith`, `fromJson`, `toJson` y el getter `isVerified`, todo en una sola clase.

- **Necesitas `copyWith` para la inmutabilidad del estado.** Esta es la razón más común por la que los proyectos Flutter eligen Freezed. Riverpod, Bloc y cualquier gestión de estado al estilo reducer se apoyan en `state = state.copyWith(loading: true)`. Los records no tienen `copyWith`. Puedes escribir uno a mano, pero pierdes la razón por la que usabas un record en primer lugar.

- **Necesitas uniones selladas para tipos de estado o de resultado.** Un `LoadingState` con casos `Initial`, `Loading`, `Success(data)`, `Failure(error)` es la clase sellada canónica de Freezed. La coincidencia de patrones es exhaustiva en Dart 3, el compilador avisará si añades un caso y olvidas un `switch`, y `copyWith` funciona por caso.

  ```dart
  // freezed 3.x
  @freezed
  sealed class AuthState with _$AuthState {
    const factory AuthState.signedOut() = AuthSignedOut;
    const factory AuthState.signingIn() = AuthSigningIn;
    const factory AuthState.signedIn(User user) = AuthSignedIn;
    const factory AuthState.failed(String reason) = AuthFailed;
  }

  // Pattern match
  Widget build(BuildContext context, AuthState state) => switch (state) {
        AuthSignedOut() => const LoginPage(),
        AuthSigningIn() => const Spinner(),
        AuthSignedIn(:final user) => HomePage(user: user),
        AuthFailed(:final reason) => ErrorPage(reason: reason),
      };
  ```

  No puedes modelar eso con un record. Los records son anónimos; la herencia sellada requiere tipos con nombre.

- **Necesitas serialización JSON.** Freezed se integra con `json_serializable` para que obtengas `User.fromJson` y `user.toJson()` sin esfuerzo. Un record no tiene soporte JSON incorporado; escribes la conversión a mano cada vez.

- **La clase necesita validación, valores predeterminados o métodos.** Un cuerpo de factory puede aserrar invariantes. `@Default(0)` establece un valor predeterminado. Un constructor privado (`const User._();`) más métodos o getters regulares permite que la clase lleve comportamiento. Los records no pueden hacer nada de esto.

- **Quieres que los nombres de los campos aparezcan en IDEs y registros de fallos.** Un record se imprime como `(1, 'a@b.com', 2026-05-27 00:00:00.000)`. Una clase Freezed se imprime como `User(id: 1, email: a@b.com, createdAt: 2026-05-27 00:00:00.000, emailVerified: false)`. En una traza de pila, la segunda merece el paso de generación de código.

## El benchmark: coste de instanciación, igualdad y tiempo de build

Los números siguientes son sobre una compilación release de Flutter 3.44, Dart 3.12 AOT, ejecutándose en un Pixel 8 con la misma forma de cinco campos (`int`, `String`, `DateTime`, `bool`, `String?`). Igualdad y hash se ejecutan dentro de `BenchmarkRunner` durante 1.000.000 de iteraciones.

| Métrica                                  | Record de Dart 3.12 | Clase Freezed 3.x |
| ---------------------------------------- | ------------------- | ----------------- |
| Asignación, ns / op                      | 18                  | 24                |
| `==`, ns / op                            | 11                  | 14                |
| `hashCode`, ns / op                      | 9                   | 12                |
| `copyWith`, ns / op                      | n/a (sin API)       | 31                |
| Coste de build (cold `build_runner build`) | 0 ms              | 4,1 s para 50 clases |
| Bytes generados por clase                | 0                   | ~2 KB             |
| Impacto en la latencia de hot reload     | ninguno             | ninguno (Freezed funciona bien con hot reload en 3.x) |

La brecha en tiempo de ejecución es lo bastante pequeña como para no importar para código de aplicación. La brecha en tiempo de build es el único número que afecta a la vida diaria: en un proyecto con 200 clases Freezed, un `build_runner build` en frío dura entre 15 y 25 segundos, y `build_runner watch` reconstruye de forma incremental en menos de un segundo por archivo tocado. Si alguna vez has lanzado una aplicación Flutter con `json_serializable`, este es el mismo perfil de coste.

La verdadera diferencia de "rendimiento" entre los dos no son los nanosegundos. Es la sobrecarga mental en el sitio de llamada. Un record no tiene archivo de clase, ni directiva part, ni archivo generado en los diffs de control de versiones. Una clase Freezed tiene los tres, más el paso de build que tiene que estar ejecutándose antes de que tu IDE deje de pintar subrayados rojos.

## El detalle que decide por ti

Algunas restricciones deciden por ti, independientemente de la preferencia:

1. **JSON a través de un límite de red obliga a usar Freezed.** Los records no tienen `fromJson` ni `toJson`. Puedes escribir un convertidor manual, pero para cualquier clase que exista debido a una respuesta del backend, Freezed más `json_serializable` es el camino con menos fricción. Si intentaras mantener records para los DTOs, reinventarías la mitad de `json_serializable` a mano.

2. **La gestión de estado con `copyWith` obliga a usar Freezed.** Los reducers de Riverpod y Bloc se escriben en torno a `state = state.copyWith(loading: true)`. Los records no pueden hacer esto sin una extensión escrita a mano que anula el propósito de usar un record. Si estás migrando de GetX a Riverpod (el camino canónico de modernización en 2026 cubierto en [la guía de migración de GetX a Riverpod](/es/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/)), tus clases de estado deberían ser Freezed.

3. **Las uniones selladas con carga útil obligan a usar Freezed.** Los records no pueden modelar "uno de estos tres casos con nombre, cada uno con su propia carga útil". Las clases selladas de Dart 3 sí pueden, pero aun así necesitas subclases con nombre, y la fricción de escribir cada una a mano es exactamente lo que Freezed elimina.

4. **Un tipo que escapa del archivo obliga a tener un nombre.** Si alguien más del equipo necesita importar el tipo, dale un nombre. Los records son útiles dentro de una función y aceptables dentro de un único archivo. En el momento en que otro archivo lo importa mediante `typedef`, el typedef solo se justifica porque el tipo subyacente es anónimo. En ese punto, escribe la clase.

5. **Un tipo con uno o dos campos y cero comportamiento que vive durante una sentencia obliga a usar un record.** Un par de doubles devueltos por una rutina de hit-test. Un `(width, height)` de un ayudante de layout. Un `(success, errorOrNull)` de una función estilo try. Escribir una clase Freezed para eso es burocracia.

Una heurística práctica: si los nombres de los campos aparecen en tu depuración con `print` o en tus registros de fallos, quieres una clase Freezed. Si el valor nunca escapa de una única función y nunca se registra, un record es la elección correcta.

## Recomendación reformulada

Para un código Flutter 3.44 / Dart 3.12 en 2026:

- **Forma local, efímera, anónima, sin comportamiento, sin JSON**: elige un **record**. Múltiples retornos, tuplas desestructuradas, formas de coincidencia de patrones dentro de una sola función.
- **Con nombre, escapa de un archivo, necesita `copyWith` / JSON / unión sellada / métodos**: elige una **clase Freezed 3.x**. Modelos de dominio, clases de estado, DTOs de API, cualquier cosa que acabe en una traza de pila.

En una aplicación real los dos conviven. Los records están dentro de funciones y archivos de widget; las clases Freezed están en `models/` y `state/`. El error es usar uno para el trabajo del otro: una clase Freezed para un valor de retorno de dos campos es sobreingeniería, y un typedef de record para un modelo `User` es subingeniería.

Si has heredado un código lleno de modelos basados en `equatable`, el camino de modernización en 2026 es moverlos a Freezed 3.x en lugar de a records, por la misma razón: esas clases tienen nombres, escapan de archivos y necesitan `copyWith`. Los records son una herramienta nueva, no un reemplazo.

## Relacionados

- [Flutter vs React Native vs .NET MAUI para un nuevo proyecto móvil en 2026](/es/2026/05/flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026/) para la elección a nivel de framework que está una capa por encima de esta decisión.
- [Dart 3.12 elimina la lista de inicialización para campos privados](/es/2026/05/dart-3-12-private-named-parameters-initializing-formals/) para el cambio del lenguaje que interactúa con cómo declaras los parámetros de la factory de Freezed en 2026.
- [Cómo migrar una aplicación Flutter de GetX a Riverpod](/es/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) para la modernización de la gestión de estado donde Freezed es la clase de estado canónica.
- [Cómo escribir un isolate de Dart para trabajo limitado por CPU](/es/2026/05/how-to-write-a-dart-isolate-for-cpu-bound-work/) para el caso en que los records cruzan un límite de isolate y necesitas pensar qué se serializa.
- [Cómo perfilar el jank en una aplicación Flutter con DevTools](/es/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) para el flujo de trabajo de rendimiento cuando la asignación de una clase de estado realmente aparece en la línea de tiempo.

## Fuentes

- [Tour del lenguaje de records de Dart](https://dart.dev/language/records), documentación de Dart, accedido 2026-05-27.
- [Anuncio de Dart 3.0](https://medium.com/dartlang/announcing-dart-3-0-79bff52e1bb6), equipo de Dart, mayo de 2023.
- [Paquete Freezed en pub.dev](https://pub.dev/packages/freezed), Remi Rousselet.
- [Paquete json_serializable](https://pub.dev/packages/json_serializable), equipo de Dart.
- [Notas de la versión de Flutter 3.44](https://docs.flutter.dev/release/release-notes), documentación de Flutter, accedido 2026-05-27.
