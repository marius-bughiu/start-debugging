---
title: "C# 12 - Primärkonstruktoren"
description: "Ab C# 12 lassen sich Primärkonstruktoren in Klassen und Structs definieren. Die Parameter werden in Klammern direkt nach dem Typnamen angegeben. Sie haben einen weiten Geltungsbereich: Sie können Eigenschaften oder Felder initialisieren, als Variablen in Methoden oder lokalen Funktionen dienen und an einen Basiskonstruktor übergeben werden."
pubDate: 2023-07-30
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "de"
translationOf: "2023/07/c-12-primary-constructors"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ab C# 12 ist es möglich, einen Primärkonstruktor innerhalb von Klassen und Structs zu definieren. Die Parameter werden in Klammern direkt nach dem Typnamen platziert.

```cs
public class Car(string make)
{
    public string Make => make;
}
```

Die Parameter eines Primärkonstruktors haben einen weiten Geltungsbereich. Sie können verwendet werden, um Eigenschaften oder Felder zu initialisieren, als Variablen in Methoden oder lokalen Funktionen zu dienen und an einen Basiskonstruktor übergeben zu werden.

Die Verwendung eines Primärkonstruktors signalisiert, dass diese Parameter für jede Instanz des Typs notwendig sind. Falls ein explizit geschriebener Konstruktor vorhanden ist, muss dieser die `this(...)`-Initialisierersyntax verwenden, um den Primärkonstruktor aufzurufen. Damit wird sichergestellt, dass alle Konstruktoren den Parametern des Primärkonstruktors tatsächlich Werte zuweisen.

In Klassen, einschließlich Record-Class-Typen, wird der implizite parameterlose Konstruktor nicht erzeugt, wenn ein Primärkonstruktor vorhanden ist. Bei Structs, einschließlich Record-Struct-Typen, wird der implizite parameterlose Konstruktor hingegen immer erstellt und initialisiert alle Felder, einschließlich der Primärkonstruktor-Parameter, mit dem 0-Bit-Muster. Wenn Sie sich dafür entscheiden, einen expliziten parameterlosen Konstruktor einzubinden, muss dieser den Primärkonstruktor aufrufen, sodass Sie abweichende Werte für die Primärkonstruktor-Parameter angeben können.

Der folgende Code zeigt Beispiele für Primärkonstruktoren:

```cs
public class ElectricCar(string make, int batteryCapacity) : Car(make)
{
    public ElectricCar() : this("unknown", 0) 
    {
    }

    public int BatteryCapacity => batteryCapacity;
}
```

In `class`- und `struct`-Typen bleiben die Parameter des Primärkonstruktors im gesamten Körper des Typs zugänglich. Sie können als Member-Felder verwendet werden. Bei Verwendung erfasst der Compiler den Konstruktor-Parameter automatisch in einem privaten Feld mit einem vom Compiler generierten Namen. Wenn ein Primärkonstruktor-Parameter jedoch an keiner Stelle im Körper des Typs verwendet wird, wird kein privates Feld erzeugt. Diese vorbeugende Regel verhindert die unbeabsichtigte Allokation von zwei Kopien eines Primärkonstruktor-Parameters, wenn dieser an einen Basiskonstruktor übergeben wird.

Ist der Typ mit dem `record`-Modifier markiert, geht der Compiler einen anderen Weg: Er synthetisiert eine öffentliche Eigenschaft mit demselben Namen wie der Primärkonstruktor-Parameter. Bei Record-Class-Typen wird, falls der Primärkonstruktor-Parameter den Namen eines Primärkonstruktors der Basis teilt, diese Eigenschaft zu einer öffentlichen Eigenschaft des Record-Class-Basistyps und nicht im abgeleiteten Record-Class-Typ dupliziert. Wichtig ist, dass diese Eigenschaften für Nicht-Record-Typen nicht erzeugt werden.
