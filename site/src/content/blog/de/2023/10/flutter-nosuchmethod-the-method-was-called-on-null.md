---
title: "Flutter NoSuchMethod: the method was called on null"
description: "Dieser Flutter-Fehler tritt auf, wenn eine Methode auf einer null-Objektreferenz aufgerufen wird. Erfahren Sie, wie Sie den NoSuchMethod-Fehler mit Aufrufstapel und Haltepunkten diagnostizieren und beheben."
pubDate: 2023-10-09
updatedDate: 2023-11-05
tags:
  - "flutter"
lang: "de"
translationOf: "2023/10/flutter-nosuchmethod-the-method-was-called-on-null"
translatedBy: "claude"
translationDate: 2026-05-01
---
Dieser Fehler tritt auf, wenn auf einer `null`-Objektreferenz eine Methode aufgerufen wird. Eine solche Methode gibt es nicht, weil das Aufrufziel `null` oder nicht zugewiesen ist. Beispiel:

```dart
foo.bar()
```

schlägt mit einem `NoSuchMethod`-Fehler fehl, sobald `foo` `null` ist. Der Fehlertext lautet: `NoSuchMethod: the method 'bar' was called on null`.

Das ist das Pendant zu einer `NullReferenceException` in C#.

## Wie behebe ich das?

Nutzen Sie den Aufrufstapel, um die Zeile zu bestimmen, in der der Fehler aufgetreten ist. Da der Methodenname Teil der Fehlermeldung ist, reicht das in der Regel aus. Falls nicht, setzen Sie einen Haltepunkt auf diese Zeile und prüfen die Variablenwerte auf einen `null`-Wert, sobald Sie ihn erreichen. Wenn Sie die Ursache gefunden haben, gehen Sie der Frage nach, wie es zu diesem Zustand kommen konnte, und beheben es.
