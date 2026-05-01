---
title: "C# UnsafeAccessor: private Member ohne Reflection (.NET 8)"
description: "Verwenden Sie das `[UnsafeAccessor]`-Attribut in .NET 8, um private Felder ohne Overhead zu lesen und private Methoden aufzurufen, ohne Reflection und vollständig AOT-kompatibel."
pubDate: 2023-10-31
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/10/unsafe-accessor"
translatedBy: "claude"
translationDate: 2026-05-01
---
Reflection erlaubt es, Typinformationen zur Laufzeit zu ermitteln und mit diesen Informationen auf private Member einer Klasse zuzugreifen. Das ist besonders nützlich, wenn Sie mit Klassen arbeiten, die nicht in Ihrer Hand liegen, etwa aus einem Drittanbieter-Paket. So mächtig Reflection auch ist, sie ist gleichzeitig sehr langsam, was einer der Hauptgründe ist, sie zu vermeiden. Damit ist jetzt Schluss.

.NET 8 führt mit dem `UnsafeAccessor`-Attribut eine neue Möglichkeit ein, ohne Overhead auf private Member zuzugreifen. Das Attribut kann auf eine `extern static`-Methode angewendet werden. Die Implementierung der Methode wird zur Laufzeit anhand der Attributinformationen und der Methodensignatur bereitgestellt. Wird zu den angegebenen Informationen keine Übereinstimmung gefunden, löst der Methodenaufruf entweder eine `MissingFieldException` oder eine `MissingMethodException` aus.

Sehen wir uns ein paar Beispiele für die Verwendung von `UnsafeAccessor` an. Betrachten wir die folgende Klasse mit privaten Membern:

```cs
class Foo
{
    private Foo() { }
    private Foo(string value) 
    {
        InstanceProperty = value;
    }

    private string InstanceProperty { get; set; } = "instance-property";
    private static string StaticProperty { get; set; } = "static-property";

    private int instanceField = 1;
    private static int staticField = 2;

    private string InstanceMethod(int value) => $"instance-method:{value}";
    private static string StaticMethod(int value) => $"static-method:{value}";
}
```

## Objektinstanzen über private Konstruktoren erstellen

Wie oben beschrieben, beginnen wir mit der Deklaration der `static extern`-Methoden.

-   wir versehen die Methoden mit dem `UnsafeAccessor`-Attribut: `[UnsafeAccessor(UnsafeAccessorKind.Constructor)]`
-   und sorgen dafür, dass die Signaturen der Konstruktoren übereinstimmen. Bei Konstruktoren muss der Rückgabetyp der Typ der Klasse sein, auf die wir umlenken (`Foo`). Auch die Parameterliste muss passen.
-   der Name der extern-Methode muss mit nichts übereinstimmen und keiner bestimmten Konvention folgen. Eine wichtige Beobachtung: Sie können keine zwei `extern static`-Methoden mit gleichem Namen, aber unterschiedlichen Parametern haben, ähnlich wie bei Überladungen, daher müssen Sie für jede Überladung eindeutige Namen vergeben.

Am Ende sollten Sie Folgendes haben:

```cs
[UnsafeAccessor(UnsafeAccessorKind.Constructor)]
extern static Foo PrivateConstructor();

[UnsafeAccessor(UnsafeAccessorKind.Constructor)]
extern static Foo PrivateConstructorWithParameters(string value);
```

Ab diesem Punkt ist das Erstellen von Objektinstanzen über die privaten Konstruktoren trivial.

```cs
var instance1 = PrivateConstructor();
var instance2 = PrivateConstructorWithParameters("bar");
```

## Private Instanzmethoden aufrufen

Das erste Argument der `extern static`-Methode ist eine Objektinstanz des Typs, der die private Methode enthält. Die übrigen Argumente müssen der Signatur der Zielmethode entsprechen. Auch der Rückgabetyp muss übereinstimmen.

```cs
[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "InstanceMethod")]
extern static string InstanceMethod(Foo @this, int value);

Console.WriteLine(InstanceMethod(instance1, 42)); 
// Output: "instance-method:42"
```

## Private Instanz-Properties lesen / schreiben

Ihnen wird auffallen, dass es kein `UnsafeAccessorKind.Property` gibt. Das liegt daran, dass Instanz-Properties, ähnlich wie Instanzmethoden, über ihre Getter- und Setter-Methoden angesprochen werden können:

-   `get_{PropertyName}`
-   `set_{PropertyName}`

```cs
[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "get_InstanceProperty")]
extern static string InstanceGetter(Foo @this);

[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "set_InstanceProperty")]
extern static void InstanceSetter(Foo @this, string value);

Console.WriteLine(InstanceGetter(instance1));
// Output: "instance-property"

InstanceSetter(instance1, "bar");

Console.WriteLine(InstanceGetter(instance1));
// Output: "bar"
```

## Statische Methoden und Properties

Sie verhalten sich identisch zu Instanz-Membern, mit dem einzigen Unterschied, dass Sie im `UnsafeAccessor`-Attribut `UnsafeAccessorKind.StaticMethod` angeben müssen. Sie müssen sogar beim Aufruf eine Objektinstanz dieses Typs übergeben.

Was ist mit `static`-Klassen? Statische Klassen werden derzeit nicht von `UnsafeAccessor`s unterstützt. Es gibt einen API-Vorschlag, der diese Lücke mit Blick auf .NET 9 schließen soll: [\[API Proposal\]: UnsafeAccessorTypeAttribute for static or private type access](https://github.com/dotnet/runtime/issues/90081)

```cs
[UnsafeAccessor(UnsafeAccessorKind.StaticMethod, Name = "StaticMethod")]
extern static string StaticMethod(Foo @this, int value);

[UnsafeAccessor(UnsafeAccessorKind.StaticMethod, Name = "get_StaticProperty")]
extern static string StaticGetter(Foo @this);

[UnsafeAccessor(UnsafeAccessorKind.StaticMethod, Name = "set_StaticProperty")]
extern static void StaticSetter(Foo @this, string value);
```

## Private Felder

Felder sind in Bezug auf die Syntax der `extern static`-Methode etwas spezieller. Hier stehen uns keine Getter- und Setter-Methoden mehr zur Verfügung, daher verwenden wir das Schlüsselwort `ref`, um eine Referenz auf das Feld zu erhalten, die wir sowohl zum Lesen als auch zum Schreiben des Werts nutzen können.

```cs
[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "instanceField")]
extern static ref int InstanceField(Foo @this);

[UnsafeAccessor(UnsafeAccessorKind.StaticField, Name = "staticField")]
extern static ref int StaticField(Foo @this);

// Read the field value
var x = InstanceField(instance1);
var y = StaticField(instance1);

// Update the field value
InstanceField(instance1) = 3;
StaticField(instance1) = 4;
```

Möchten Sie das Feature ausprobieren? Sie finden [alle obigen Beispiele auf GitHub](https://github.com/Start-Debugging/dotnet-samples/blob/main/unsafe-accessor/UnsafeAccessor/Program.cs).
