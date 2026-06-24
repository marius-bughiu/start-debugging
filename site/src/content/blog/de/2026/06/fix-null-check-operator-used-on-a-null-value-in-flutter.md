---
title: "Lösung: Null check operator used on a null value in Flutter"
description: "Der !-Operator traf zur Laufzeit auf einen null-Wert. Ersetzen Sie ihn durch ?. und ?? für einen Standardwert, oder sichern Sie ihn mit einer expliziten null-Prüfung, statt einen Wert zu behaupten, der nicht da war."
pubDate: 2026-06-24
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
lang: "de"
translationOf: "2026/06/fix-null-check-operator-used-on-a-null-value-in-flutter"
translatedBy: "claude"
translationDate: 2026-06-24
---

Sie haben `something!` geschrieben, und `something` war `null`, als die Zeile lief. Der null-Prüfoperator (bang) verspricht dem Compiler "das ist niemals null", und Dart setzt dieses Versprechen zur Laufzeit durch, indem es in dem Moment wirft, in dem das Versprechen gebrochen wird. Die Lösung besteht fast immer darin, mit dem Behaupten aufzuhören und mit dem Behandeln anzufangen: Verwenden Sie `?.`, um kurzzuschließen, `??`, um einen Standardwert zu liefern, oder eine `if (x != null)`-Absicherung, die den Compiler den Typ für Sie eingrenzen lässt. Diese Seite verwendet Flutter 3.44 (stabil, Mai 2026) und Dart 3.x.

## Der Fehler im Kontext

Wenn der bang-Operator auf ein `null` trifft, erhalten Sie einen `TypeError` mit dieser exakten Meldung:

```
Unhandled Exception: Null check operator used on a null value
```

In der Widget-Schicht erscheint er meist vom Framework umhüllt, und genau dort sehen ihn die meisten tatsächlich:

```
======== Exception caught by widgets library =======================================================
The following _TypeError was thrown building ProfilePage(dirty):
Null check operator used on a null value

The relevant error-causing widget was:
  ProfilePage ProfilePage:file:///lib/profile_page.dart:18:12
```

Die Klasse ist `_TypeError` (ein Subtyp von `TypeError`), dieselbe Familie, die Dart für fehlgeschlagene Casts verwendet. Das ist der Hinweis: Der bang-Operator ist ein Cast. Er castet `T?` zu `T`, und wie jeder Cast kann er zur Laufzeit fehlschlagen.

## Warum das passiert: Der bang-Operator ist ein geprüfter Cast

Bei solider null safety sind `String?` und `String` verschiedene Typen. Das nachgestellte `!` ist eine Kurzform, die laut Dart-Dokumentation "den Ausdruck zu seiner Linken nimmt und ihn zu seinem zugrunde liegenden nicht-nullbaren Typ castet". Ein Cast von einem nullbaren Typ zu einem nicht-nullbaren lässt sich zur Compile-Zeit nicht als sicher beweisen, also fügt der Compiler eine Laufzeitprüfung ein. Ist der Wert `null`, wenn die Prüfung läuft, erhalten Sie `Null check operator used on a null value`.

Das ist also nie ein Compiler-Bug und nie ein Framework-Bug. Es ist ein Wert, der `null` ist, in einem Moment, in dem Ihr Code geschworen hat, dass er es nicht sein würde. Die Aufgabe ist, den Wert zu finden und zu entscheiden, was passieren soll, wenn er wirklich fehlt, statt ihn mit einem weiteren `!` zu überdecken.

## Minimale Reproduktion

Die kleinste Variante ist eine einzelne nullbare Variable, der noch nichts zugewiesen wurde:

```dart
// Flutter 3.44, Dart 3.x
String? name;          // nullable, defaults to null
void main() {
  print(name!.length); // throws: Null check operator used on a null value
}
```

In echtem Flutter-Code ist die häufigste Form Daten, die noch nicht geladen sind. Das Feld ist `null`, bis ein Netzwerkaufruf es füllt, aber `build` läuft sofort und dereferenziert es:

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

`build` wird aufgerufen, bevor `_loadUser` auflöst, also ist `_user` im ersten Frame noch `null` und `_user!` wirft.

## Die Lösung, in der Reihenfolge der Präferenz

Die richtige Lösung hängt davon ab, ob `null` ein legitimer Zustand ist (Daten laden noch, optionales Feld, fehlender Schlüssel) oder ein Bug (Sie haben einen Wert erwartet, und sein Fehlen bedeutet, dass weiter oben etwas kaputt ist). Meistens ist es Ersteres, und das Framework gibt Ihnen idiomatische Werkzeuge dafür.

### 1. Liefern Sie einen Standardwert mit `??`

Wenn ein sinnvoller Ersatzwert existiert, ist der null-coalescing-Operator die kürzeste korrekte Lösung. Er gibt die rechte Seite zurück, wenn die linke `null` ist:

```dart
// Flutter 3.44, Dart 3.x
Text(_user?.name ?? 'Loading...');
```

`_user?.name` ist `null`, wenn `_user` `null` ist (das `?.` schließt die gesamte Kette kurz), und `??` setzt den Platzhalter ein. Kein Wurf, und die Oberfläche zeigt etwas Nützliches, während die Daten laden.

### 2. Verzweigen Sie explizit über den Ladezustand

Wenn es keinen guten Standardwert gibt, rendern Sie unterschiedliche Widgets für den geladenen und den noch-nicht-geladenen Zustand. Eine `if (x != null)`-Prüfung promoviert die lokale Variable innerhalb des Zweigs zu nicht-nullbar, sodass Sie gar kein `!` brauchen:

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

Kopieren Sie das Feld zuerst in eine lokale Variable. Dart promoviert nur lokale Variablen, nicht Instanzfelder, weil eine andere Methode (oder ein anderes Isolate) ein Feld zwischen der Prüfung und der Verwendung mutieren könnte. Die lokale Variable ist der tragende Teil dieses Musters.

### 3. Lassen Sie `FutureBuilder` den null-Zustand übernehmen

Wenn der Wert aus einem einzigen asynchronen Aufruf kommt, basteln Sie das Flag nicht von Hand. `FutureBuilder` modelliert Laden, Fehler und Daten als ein einziges Objekt, und Sie lesen `data` erst, nachdem Sie bestätigt haben, dass es vorhanden ist:

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

Das `snapshot.data!` hier ist legitim, weil Sie bereits bewiesen haben, dass der Future ohne Fehler abgeschlossen wurde. Eine Einschränkung, die viele trifft: Erstellen Sie den Future einmal und speichern Sie ihn, nie inline in `build`, sonst startet jeder Rebuild einen neuen Fetch. Das ist ein eigener Fallstrick, behandelt in [warum FutureBuilder seinen Future ständig neu erstellt](/de/2026/06/how-to-initialize-a-future-so-futurebuilder-doesnt-recreate-it-on-every-rebuild-in-flutter/).

### 4. Verwenden Sie `late` nur, wenn die Initialisierung der ersten Lesung wirklich vorangeht

Wenn ein Wert genau einmal zugewiesen wird, bevor ihn etwas liest, entfernt `late` die Nullbarkeit ohne den bang. Aber das ist ein Tauschgeschäft, kein Gratisgewinn: Ein vor der Zuweisung gelesenes `late`-Feld wirft `LateInitializationError`, ein anderer und wohl schlimmerer Crash, weil man leicht annimmt, `late` habe den Wert sicher gemacht. Greifen Sie nur dazu, wenn die Reihenfolge garantiert ist, zum Beispiel ein Wert, der in `initState` gesetzt und in `build` gelesen wird:

```dart
// Flutter 3.44, Dart 3.x
late final AnimationController _controller;

@override
void initState() {
  super.initState();
  _controller = AnimationController(vsync: this); // assigned before any build
}
```

Ist die Reihenfolge nicht garantiert, halten Sie das Feld nullbar und sichern Sie es ab. Die vollständige Aufschlüsselung, wann `late` hilft und wann es schadet, finden Sie in [LateInitializationError in Flutter beheben](/de/2026/06/fix-lateinitializationerror-field-has-not-been-initialized-in-flutter/).

## Die üblichen Verdächtigen jenseits eines Lade-Flags

Der Fehler tritt in mehreren Verkleidungen auf. Dies sind die häufigsten, jede mit derselben zugrunde liegenden Ursache und derselben Form der Lösung.

**`GlobalKey.currentState!`, bevor das Widget eingehängt ist.** Der Aufruf von `_formKey.currentState!.validate()`, wenn das `Form` nicht im Baum ist (oder noch nicht gebaut wurde), wirft, weil `currentState` `null` ist, bis das Widget sich anhängt. Verwenden Sie `?.`:

```dart
// Flutter 3.44, Dart 3.x
if (_formKey.currentState?.validate() ?? false) {
  // form is valid and present
}
```

**Routenargumente, die nicht übergeben wurden.** `ModalRoute.of(context)!.settings.arguments as Args` nimmt sowohl an, dass eine Route existiert, als auch, dass Argumente bereitgestellt wurden. Pushen Sie die Route ohne Argumente, ist `arguments` `null`, und das spätere `as` oder ein folgendes `!` fliegt auf. Lesen Sie es defensiv:

```dart
// Flutter 3.44, Dart 3.x
final args = ModalRoute.of(context)?.settings.arguments as Args?;
if (args == null) return const ErrorScreen('Missing arguments');
```

**Map- und JSON-Zugriff mit `[key]!`.** Ein Map-Lookup gibt `null` für einen fehlenden Schlüssel zurück, und `json['email']!` wirft in dem Moment, in dem das Feld fehlt oder die API es umbenannt hat. Dekodieren Sie über ein Modell mit expliziter Nullbarkeit oder geben Sie jedem Feld einen Standardwert:

```dart
// Flutter 3.44, Dart 3.x
final email = (json['email'] as String?) ?? '';
```

**`firstWhere` mit einem bang auf dem Ergebnis.** Manche schreiben `list.firstWhere((e) => e.id == id, orElse: () => null)!`, um "zu finden oder abzustürzen". Das ist genau eine ungeprüfte Annahme. Bevorzugen Sie `firstWhereOrNull` aus `package:collection` und behandeln Sie den leeren Fall:

```dart
// Flutter 3.44, Dart 3.x
final match = list.firstWhereOrNull((e) => e.id == id);
if (match == null) { /* handle not found */ }
```

## Varianten, die das nicht ist, und wohin stattdessen

Suchverkehr für diesen Fehler gehört oft auf eine Nachbarseite. Drei Doppelgänger:

`LateInitializationError: Field '_x' has not been initialized` ist ein Geschwister, nicht derselbe Fehler. Er kommt vom Lesen einer `late`-Variable vor der Zuweisung, nicht von einem `!` auf einem nullbaren Wert. Wenn Ihr Stack Trace `LateInitializationError` sagt, liegt die Lösung auf [der LateInitializationError-Seite](/de/2026/06/fix-lateinitializationerror-field-has-not-been-initialized-in-flutter/), nicht hier.

Eine null-Prüfung, die nur nach der Navigation und nur im Release fehlschlägt, ist oft ein Symptom für einen toten Kontext. Der Lookup auf einem deaktivierten Kontext gibt im Release-Build `null` zurück (der Assert, der das fängt, gilt nur für Debug), und dieses `null` löst dann irgendwo weiter unten ein `!` aus. Wenn der Crash mit einem `await` gefolgt von einer Kontextverwendung korreliert, lesen Sie [BuildContext nach einem await sicher verwenden](/de/2026/06/how-to-use-buildcontext-safely-after-an-await-in-flutter/), denn der eigentliche Bug liegt oberhalb des bang.

Ein `TextEditingController` oder ein anderer Controller, der nach `dispose` verwendet wird, kann ebenfalls ein `null` in eine spätere Behauptung einspeisen. Ist der Controller die Quelle, behandelt [den Fehler des entsorgten Controllers beheben](/de/2026/06/fix-texteditingcontroller-was-used-after-being-disposed-in-flutter) den Lebenszyklus direkt.

## Der Lint, der das vor der Laufzeit fängt

Dart kann nicht vor jedem `!` warnen, das fehlschlagen könnte, denn das ist gerade der Sinn des Operators: Sie überstimmen den Analyzer. Aber es kann die kennzeichnen, von denen es beweisen kann, dass sie sinnlos sind. Die Regel `unnecessary_non_null_assertion`, im `flutter_lints` standardmäßig aktiv, schlägt an, wenn Sie einen bang auf einen Wert setzen, von dem der Analyzer bereits weiß, dass er nicht null ist, was meist bedeutet, dass Ihr mentales Modell und das Typsystem nicht übereinstimmen:

```yaml
# analysis_options.yaml -- on by default via flutter_lints
include: package:flutter_lints/flutter.yaml
```

Die umfassendere Disziplin ist, jedes `!`, das Sie tippen, als eine Behauptung zu behandeln, die Sie verteidigen müssen. Wenn Sie nicht auf die Zeile zeigen können, die garantiert, dass der Wert auf diesem Pfad nicht null ist, haben Sie kein `!`, Sie haben ein latentes `Null check operator used on a null value`. Asynchrone Daten als explizite Lade- und Fehlerzustände zu modellieren, wie in [Lade- und Fehlerzustände mit AsyncValue](/de/2026/06/how-to-show-loading-and-error-states-with-asyncvalue-in-flutter-riverpod/), entfernt die meisten dieser Behauptungen vollständig, weil das Framework Ihnen den Wert nur auf dem Zweig übergibt, auf dem er existiert.

## Die Gewohnheit, die den Fehler in Rente schickt

Der bang-Operator ist ein Versprechen an den Compiler, zur Laufzeit eingelöst, und `Null check operator used on a null value` ist die Quittung für ein gebrochenes Versprechen. Wann immer Sie versucht sind, `!` zu schreiben, fragen Sie sich, was passieren soll, wenn der Wert wirklich `null` ist: ein Platzhalter (`??`), ein anderes Widget (`if (x != null)`) oder ein echter Fehler, den Sie absichtlich auslösen. Wählen Sie eine davon, und der Crash erreicht nie einen Nutzer. Reservieren Sie `!` für den seltenen Fall, in dem `null` eine echte Verletzung einer Invariante wäre, und bevorzugen Sie selbst dann, einen `StateError` mit einer Meldung zu werfen, die erklärt, was schiefging, gegenüber einem nackten bang, der nur sagt "das war null".

## Quellen

- [Understanding null safety](https://dart.dev/null-safety/understanding-null-safety), Dart-Dokumentation, die den `!`-Operator als geprüften Cast zum nicht-nullbaren Typ definiert und erklärt, warum die Prüfung zur Laufzeit laufen muss.
- [Null safety unsound migration and the `!` operator](https://dart.dev/null-safety), Dokumentation der Dart-Sprache.
- [unnecessary_non_null_assertion lint rule](https://dart.dev/tools/linter-rules/unnecessary_non_null_assertion), Dart-Linter-Regeln.
- [firstWhereOrNull](https://pub.dev/documentation/collection/latest/collection/IterableExtension/firstWhereOrNull.html), API-Dokumentation von `package:collection`.
