---
title: "Solución: Null check operator used on a null value en Flutter"
description: "El operador ! encontró un null en runtime. Reemplazalo por ?. y ?? para un valor por defecto, o protegelo con una comprobación de null explícita, en lugar de afirmar un valor que no estaba."
pubDate: 2026-06-24
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "es"
translationOf: "2026/06/fix-null-check-operator-used-on-a-null-value-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-24
---

Escribiste `something!` y `something` era `null` cuando se ejecutó la línea. El operador de comprobación de null (bang) le promete al compilador "esto nunca es null", y Dart hace cumplir esa promesa en runtime lanzando el error en el instante en que se rompe. La solución casi siempre consiste en dejar de afirmar y empezar a manejar: usá `?.` para cortocircuitar, `??` para proporcionar un valor por defecto, o una protección `if (x != null)` que deje que el compilador acote el tipo por vos. Esta página usa Flutter 3.44 (estable, mayo de 2026) y Dart 3.x.

## El error en contexto

Cuando el operador bang encuentra un `null`, obtenés un `TypeError` con este mensaje exacto:

```
Unhandled Exception: Null check operator used on a null value
```

En la capa de widgets normalmente aparece envuelto por el framework, que es donde la mayoría de la gente lo ve en realidad:

```
======== Exception caught by widgets library =======================================================
The following _TypeError was thrown building ProfilePage(dirty):
Null check operator used on a null value

The relevant error-causing widget was:
  ProfilePage ProfilePage:file:///lib/profile_page.dart:18:12
```

La clase es `_TypeError` (un subtipo de `TypeError`), la misma familia que Dart usa para los casts fallidos. Esa es la pista: el operador bang es un cast. Convierte `T?` a `T`, y como cualquier cast puede fallar en runtime.

## Por qué ocurre: el operador bang es un cast verificado

En null safety sólida, `String?` y `String` son tipos distintos. El `!` postfijo es una forma abreviada que, en palabras de la documentación de Dart, "toma la expresión a su izquierda y la convierte a su tipo no anulable subyacente". Un cast de un tipo anulable a uno no anulable no se puede demostrar como seguro en tiempo de compilación, así que el compilador inserta una comprobación en runtime. Si el valor es `null` cuando se ejecuta la comprobación, obtenés `Null check operator used on a null value`.

Así que esto nunca es un error del compilador ni del framework. Es un valor que es `null` en un momento en el que tu código juró que no lo sería. La tarea es encontrar el valor y decidir qué debería pasar cuando esté genuinamente ausente, en lugar de taparlo con otro `!`.

## Reproducción mínima

La versión más pequeña es una sola variable anulable a la que todavía no se le asignó nada:

```dart
// Flutter 3.44, Dart 3.x
String? name;          // nullable, defaults to null
void main() {
  print(name!.length); // throws: Null check operator used on a null value
}
```

En código Flutter real, la forma más común son datos que aún no se cargaron. El campo es `null` hasta que una llamada de red lo llena, pero `build` se ejecuta de inmediato y lo desreferencia:

```dart
// Flutter 3.44, Dart 3.x -- crashes on first build
class ProfilePage extends StatefulWidget {
  const ProfilePage({super.key});
  @override
  State<ProfilePage> createState() => _ProfilePageState();
}

class _ProfilePageState extends State<ProfilePage> {
  User? _user; // null until the fetch returns

  @override
  void initState() {
    super.initState();
    _loadUser(); // async, completes some frames later
  }

  Future<void> _loadUser() async {
    final u = await api.fetchUser();
    setState(() => _user = u);
  }

  @override
  Widget build(BuildContext context) {
    return Text(_user!.name); // <-- _user is null on the first build
  }
}
```

`build` se llama antes de que `_loadUser` se resuelva, así que `_user` todavía es `null` en el primer frame y `_user!` lanza el error.

## La solución, en orden de preferencia

La solución correcta depende de si `null` es un estado legítimo (datos aún cargándose, campo opcional, clave ausente) o un error (esperabas un valor y su ausencia significa que algo más arriba está roto). La mayoría de las veces es lo primero, y el framework te da herramientas idiomáticas para ello.

### 1. Proporcioná un valor por defecto con `??`

Si existe un valor de reserva sensato, el operador de fusión de null es la solución correcta más corta. Devuelve el lado derecho cuando el izquierdo es `null`:

```dart
// Flutter 3.44, Dart 3.x
Text(_user?.name ?? 'Loading...');
```

`_user?.name` es `null` cuando `_user` es `null` (el `?.` cortocircuita toda la cadena), y `??` sustituye el marcador de posición. Sin lanzamiento de error, y la interfaz muestra algo útil mientras se cargan los datos.

### 2. Ramificá según el estado de carga de forma explícita

Cuando no hay un buen valor por defecto, renderizá widgets distintos para el estado cargado y el aún-no-cargado. Una comprobación `if (x != null)` promueve la variable local a no anulable dentro de la rama, así que no necesitás `!` en absoluto:

```dart
// Flutter 3.44, Dart 3.x
@override
Widget build(BuildContext context) {
  final user = _user;            // copy to a local for promotion
  if (user == null) {
    return const Center(child: CircularProgressIndicator());
  }
  return Text(user.name);        // user is User here, not User?
}
```

Copiá el campo a una variable local primero. Dart solo promueve variables locales, no campos de instancia, porque otro método (u otro isolate) podría mutar un campo entre la comprobación y el uso. La variable local es la parte que sostiene este patrón.

### 3. Dejá que `FutureBuilder` se encargue del estado null

Si el valor viene de una sola llamada asíncrona, no improvises el flag a mano. `FutureBuilder` modela carga, error y datos como un solo objeto, y solo leés `data` una vez que confirmaste que está presente:

```dart
// Flutter 3.44, Dart 3.x
FutureBuilder<User>(
  future: _userFuture, // created once, not in build -- see below
  builder: (context, snapshot) {
    if (snapshot.connectionState != ConnectionState.done) {
      return const CircularProgressIndicator();
    }
    if (snapshot.hasError) {
      return Text('Failed: ${snapshot.error}');
    }
    return Text(snapshot.data!.name); // safe: hasData is implied here
  },
);
```

El `snapshot.data!` acá es legítimo porque ya demostraste que el future se completó sin error. Una salvedad que afecta a mucha gente: creá el future una sola vez y guardalo, nunca en línea dentro de `build`, o cada reconstrucción inicia un nuevo fetch. Ese es su propio problema, cubierto en [por qué FutureBuilder sigue recreando su Future](/es/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/).

### 4. Usá `late` solo cuando la inicialización realmente precede a la primera lectura

Si un valor se asigna exactamente una vez, antes de que nada lo lea, `late` elimina la nulabilidad sin el bang. Pero esto es un intercambio, no una victoria gratis: un campo `late` leído antes de la asignación lanza `LateInitializationError`, un crash distinto y posiblemente peor, porque es fácil suponer que `late` hizo seguro el valor. Recurrí a él solo cuando el orden está garantizado, por ejemplo un valor asignado en `initState` y leído en `build`:

```dart
// Flutter 3.44, Dart 3.x
late final AnimationController _controller;

@override
void initState() {
  super.initState();
  _controller = AnimationController(vsync: this); // assigned before any build
}
```

Si el orden no está garantizado, mantené el campo anulable y protegelo. El desglose completo de cuándo `late` ayuda y cuándo perjudica está en [cómo solucionar LateInitializationError en Flutter](/es/2026/06/fix-lateinitializationerror-field-has-not-been-initialized-in-flutter/).

## Los sospechosos habituales más allá de un flag de carga

El error se disfraza de varias formas. Estas son las de mayor frecuencia, cada una con la misma causa subyacente y la misma forma de solución.

**`GlobalKey.currentState!` antes de que el widget esté montado.** Llamar a `_formKey.currentState!.validate()` cuando el `Form` no está en el árbol (o todavía no se construyó) lanza el error, porque `currentState` es `null` hasta que el widget se adjunta. Usá `?.`:

```dart
// Flutter 3.44, Dart 3.x
if (_formKey.currentState?.validate() ?? false) {
  // form is valid and present
}
```

**Argumentos de ruta que no se pasaron.** `ModalRoute.of(context)!.settings.arguments as Args` asume tanto que existe una ruta como que se proporcionaron argumentos. Si empujás la ruta sin argumentos, `arguments` es `null` y el `as` posterior o un `!` siguiente explota. Leelo de forma defensiva:

```dart
// Flutter 3.44, Dart 3.x
final args = ModalRoute.of(context)?.settings.arguments as Args?;
if (args == null) return const ErrorScreen('Missing arguments');
```

**Acceso a Map y JSON con `[key]!`.** Una búsqueda en un map devuelve `null` para una clave ausente, y `json['email']!` lanza el error en cuanto el campo no está o la API lo renombró. Decodificá a través de un modelo con nulabilidad explícita o asigná un valor por defecto a cada campo:

```dart
// Flutter 3.44, Dart 3.x
final email = (json['email'] as String?) ?? '';
```

**`firstWhere` con un bang sobre el resultado.** A veces la gente escribe `list.firstWhere((e) => e.id == id, orElse: () => null)!` para "encontrar o reventar". Eso es exactamente una suposición no verificada. Preferí `firstWhereOrNull` de `package:collection` y manejá el caso vacío:

```dart
// Flutter 3.44, Dart 3.x
final match = list.firstWhereOrNull((e) => e.id == id);
if (match == null) { /* handle not found */ }
```

## Variantes que esto no es, y a dónde ir en su lugar

El tráfico de búsqueda para este error a menudo pertenece a una página vecina. Tres parecidos:

`LateInitializationError: Field '_x' has not been initialized` es un hermano, no el mismo error. Viene de leer una variable `late` antes de la asignación, no de un `!` sobre un anulable. Si tu stack trace dice `LateInitializationError`, la solución está en [la página de LateInitializationError](/es/2026/06/fix-lateinitializationerror-field-has-not-been-initialized-in-flutter/), no acá.

Una comprobación de null que solo falla después de navegar, y solo en release, suele ser un síntoma de contexto muerto. La búsqueda sobre un contexto desactivado devuelve `null` en builds de release (el assert que lo detecta es solo de debug), y ese `null` luego dispara un `!` en algún punto más abajo. Si el crash se correlaciona con un `await` seguido de un uso del contexto, leé [usar BuildContext de forma segura después de un await](/es/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/), porque el error real está más arriba que el bang.

Un `TextEditingController` u otro controlador usado después de `dispose` también puede alimentar un `null` a una afirmación posterior. Si el controlador es la fuente, [cómo solucionar el error de controlador descartado](/es/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter) aborda el ciclo de vida directamente.

## El lint que detecta esto antes del runtime

Dart no puede advertir sobre cada `!` que podría fallar, porque ese es justamente el sentido del operador: estás anulando al analizador. Pero sí puede marcar los que puede demostrar que son inútiles. La regla `unnecessary_non_null_assertion`, activada por defecto en `flutter_lints`, se dispara cuando aplicás un bang a un valor que el analizador ya sabe que es no nulo, lo que normalmente significa que tu modelo mental y el sistema de tipos no coinciden:

```yaml
# analysis_options.yaml -- on by default via flutter_lints
include: package:flutter_lints/flutter.yaml
```

La disciplina más amplia es tratar cada `!` que escribís como una afirmación que tenés que defender. Si no podés señalar la línea que garantiza que el valor es no nulo en ese camino, no tenés un `!`, tenés un `Null check operator used on a null value` latente. Modelar los datos asíncronos como estados explícitos de carga y error, como en [estados de carga y error con AsyncValue](/es/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/), elimina la mayoría de estas afirmaciones por completo, porque el framework te entrega el valor solo en la rama donde existe.

## El hábito que retira el error

El operador bang es una promesa al compilador, saldada en runtime, y `Null check operator used on a null value` es el recibo de una promesa rota. Cada vez que tengas la tentación de escribir `!`, preguntate qué debería pasar cuando el valor sea realmente `null`: un marcador de posición (`??`), un widget distinto (`if (x != null)`), o un error real que surgís a propósito. Elegí una de esas opciones y el crash nunca llega a un usuario. Reservá `!` para el caso raro donde `null` sería una violación genuina de una invariante, e incluso entonces, preferí lanzar un `StateError` con un mensaje que explique qué salió mal antes que un bang pelado que solo dice "esto era null".

## Fuentes

- [Understanding null safety](https://dart.dev/null-safety/understanding-null-safety), documentación de Dart, que define el operador `!` como un cast verificado al tipo no anulable y explica por qué la comprobación debe ejecutarse en runtime.
- [Null safety unsound migration and the `!` operator](https://dart.dev/null-safety), documentación del lenguaje Dart.
- [unnecessary_non_null_assertion lint rule](https://dart.dev/tools/linter-rules/unnecessary_non_null_assertion), reglas del linter de Dart.
- [firstWhereOrNull](https://pub.dev/documentation/collection/latest/collection/IterableExtension/firstWhereOrNull.html), documentación de la API de `package:collection`.
