---
title: "Solución: LateInitializationError: Field '...' has not been initialized en Flutter"
description: "Corrige lecturas de campos late sin inicializar en Flutter: inicialización síncrona o estados de carga, error y datos con código probado."
pubDate: 2026-06-24
updatedDate: 2026-11-02
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "es"
translationOf: "2026/06/fix-lateinitializationerror-field-has-not-been-initialized-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-24
---

Leer un campo `late` sin asignar produce `LateInitializationError`. Busca la lectura en el primer frame de tu propio código y comprueba qué ruta debía asignar el campo antes. `late` no espera a que termine una operación asíncrona. Los ejemplos se comprobaron con Flutter 3.44.8 y Dart 3.12.2.

## Reproducir el error

Este programa compila, pero falla al leer `name`:

```dart
class Profile {
  late String name;
}

void main() {
  print(Profile().name);
}
```

La VM de Dart muestra `LateInitializationError: Field 'name' has not been initialized.` Es un diagnóstico, no el nombre de una clase pública de `dart:core` que debas importar o capturar. Corrige la inicialización que falta.

## Representar carga, error y datos

Una petición iniciada en `initState()` puede seguir pendiente durante el primer `build()`. Este widget completo usa estado nullable y maneja éxito y error. Pasa tu función asíncrona como `loadName`:

```dart
import 'package:flutter/material.dart';

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key, required this.loadName});
  final Future<String> Function() loadName;

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  String? _name;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final name = await widget.loadName();
      if (!mounted) return;
      setState(() => _name = name);
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = error);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null) return Text('Failed: $_error');
    final name = _name;
    if (name == null) return const CircularProgressIndicator();
    return Text(name);
  }
}
```

El ejemplo carga una vez por instancia de `State`. Si la petición depende de entradas cambiantes del widget, trata sus cambios en `didUpdateWidget` o usa un widget/proveedor con la clave adecuada. Las comprobaciones de `mounted` evitan actualizar un estado eliminado; no cancelan la petición. También sirven `FutureBuilder` con un Future almacenado o `AsyncValue`. El propio campo que contiene un Future puede ser `late final` si se asigna antes de leerlo; su resultado puede llegar después.

## Elegir la inicialización según la dependencia

- **Valor síncrono:** asígnalo antes de leerlo, normalmente en `initState()` si necesita `widget`. Libera también un `TextEditingController` en `dispose()`.
- **Valor diferido:** `late final value = compute();` ejecuta el inicializador en el primer acceso. Un inicializador late de instancia puede acceder a miembros de la instancia, incluido `widget` en un `State`; el primer acceso debe ocurrir en el momento apropiado del ciclo de vida. El inicializador aún puede fallar o ser recursivo.
- **Dependencia heredada:** las llamadas que registran una dependencia, como `Theme.of(context)`, corresponden a `build()` o `didChangeDependencies()`, no a `initState()`. Este último hook se ejecuta antes del primer build y cuando cambian las dependencias. La restricción afecta al registro de dependencias, no a todo uso de `context`.

## Errores parecidos y soluciones engañosas

Asignar dos veces un campo `late final` produce la variante «already initialized». Elimina la asignación duplicada o usa un campo mutable si la reasignación es intencionada. `late` no desactiva todas las comprobaciones del analizador: Dart detecta variables locales late que definitivamente no están asignadas y algunas asignaciones repetidas a locales late final. Las comprobaciones en ejecución siguen siendo necesarias cuando el análisis estático no basta. No son assertions exclusivas de depuración; el mensaje exacto puede variar según el backend y el modo de compilación.

El valor debe estar listo antes de leerlo, o el estado pendiente debe representarse explícitamente. Un `await` no vuelve incorrecto a `late` si todos los consumidores esperan primero a que esté listo; el problema es la lectura prematura del widget.

**Corrección del 2 de noviembre de 2026:** se corrigieron las afirmaciones sobre el analizador, el acceso diferido a miembros de instancia, las dependencias heredadas y los diagnósticos en release; se eliminó la referencia a una clase pública inexistente. El widget revisado se analizó y probó con éxito, error y eliminación.

## Fuentes y lecturas relacionadas

- [Dart: late variables](https://dart.dev/language/variables#late-variables)
- [Dart: definitely_unassigned_late_local_variable](https://dart.dev/tools/diagnostics/definitely_unassigned_late_local_variable)
- [Flutter: initState](https://api.flutter.dev/flutter/widgets/State/initState.html)
- [Flutter: didChangeDependencies](https://api.flutter.dev/flutter/widgets/State/didChangeDependencies.html)
- [Dart: null safety](https://dart.dev/null-safety/understanding-null-safety#late-variables)

- [BuildContext / await](/es/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/)
- [AsyncValue](/es/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/)
- [TextEditingController / dispose](/es/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter/)
- [Controllers / dispose](/es/2026/06/how-to-dispose-controllers-in-flutter-to-avoid-memory-leaks/)
- [Flutter 2 → 3.x / null safety](/es/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/)
