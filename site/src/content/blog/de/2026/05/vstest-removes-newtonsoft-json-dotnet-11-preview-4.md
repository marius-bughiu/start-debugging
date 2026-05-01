---
title: "VSTest verzichtet auf Newtonsoft.Json in .NET 11 Preview 4 und was bricht, wenn Sie sich transitiv darauf verlassen haben"
description: ".NET 11 Preview 4 und Visual Studio 18.8 liefern ein VSTest aus, das Newtonsoft.Json nicht mehr in Ihre Testprojekte fließen lässt. Builds, die stillschweigend die transitive Kopie nutzten, brechen und werden mit einer einzigen PackageReference repariert."
pubDate: 2026-05-01
tags:
  - "dotnet-11"
  - "vstest"
  - "newtonsoft-json"
  - "system-text-json"
  - "testing"
lang: "de"
translationOf: "2026/05/vstest-removes-newtonsoft-json-dotnet-11-preview-4"
translatedBy: "claude"
translationDate: 2026-05-01
---

Das .NET-Team hat [am 29. April angekündigt](https://devblogs.microsoft.com/dotnet/vs-test-is-removing-its-newtonsoft-json-dependency/), dass VSTest, die Engine hinter `dotnet test` und dem Test Explorer von Visual Studio, endlich seine Abhängigkeit von `Newtonsoft.Json` kappt. Die Änderung kommt mit .NET 11 Preview 4 (geplant für den 12. Mai 2026) und Visual Studio 18.8 Insiders 1 (geplant für den 9. Juni 2026). Unter .NET wechselt VSTest seinen internen Serializer auf `System.Text.Json`. Unter .NET Framework, wo `System.Text.Json` eine zu schwere Nutzlast ist, kommt eine kleine Bibliothek namens JSONite zum Einsatz. Die Arbeit wird in [microsoft/vstest#15540](https://github.com/microsoft/vstest/pull/15540) verfolgt, das SDK-Breaking-Change in [dotnet/docs#53174](https://github.com/dotnet/docs/issues/53174).

## Die meisten Projekte müssen nichts tun

Wenn Ihr Testprojekt `Newtonsoft.Json` bereits mit einer normalen `PackageReference` deklariert, ändert sich nichts. Das Paket funktioniert weiter, und jeder Code, der `JObject`, `JToken` oder das statische `JsonConvert` verwendet, kompiliert weiter. Der einzige öffentliche Typ, den VSTest exponierte, `Newtonsoft.Json.Linq.JToken`, lebte an einer einzigen Stelle des VSTest-Kommunikationsprotokolls, und die Einschätzung des Teams ist, dass im Wesentlichen kein realer Konsument von dieser Oberfläche abhängt.

## Wo es tatsächlich bricht

Der interessante Fehlerfall ist das Projekt, das nie nach `Newtonsoft.Json` gefragt hat und es trotzdem bekam, weil VSTest die Assembly mitschleppte. Sobald Preview 4 den transitiven Fluss kappt, verschwindet diese Kopie zur Laufzeit, und Sie sehen eine `FileNotFoundException` für `Newtonsoft.Json` während der Testausführung. Die Reparatur ist eine Zeile in der `.csproj`:

```xml
<ItemGroup>
  <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
</ItemGroup>
```

Die zweite Spielart sind Projekte, die das Runtime Asset eines transitiven `Newtonsoft.Json` explizit ausgeschlossen haben, üblicherweise um Bereitstellungs-Nutzlasten klein zu halten:

```xml
<PackageReference Include="Newtonsoft.Json" Version="13.0.3">
  <ExcludeAssets>runtime</ExcludeAssets>
</PackageReference>
```

Das funktionierte, weil VSTest die Runtime-DLL selbst mitlieferte. Nach Preview 4 funktioniert es aus demselben Grund nicht mehr: Niemand bringt das Binary mehr mit. Entfernen Sie das `ExcludeAssets`-Element, oder verschieben Sie das Paket in ein Projekt, das seine Runtime tatsächlich mitliefert.

## Warum der Aufwand

`Newtonsoft.Json` innerhalb der Testplattform mitzuführen, war eine alte Kompatibilitätswarze. Sie verankerte einen 13.x-Major in jeder Testsitzung, sorgte gelegentlich für Binding-Redirect-Drama unter .NET Framework, und zwang Teams, die `Newtonsoft.Json` aus ihrer App bewusst verbannten, es unter Tests trotzdem zu dulden. Der Wechsel auf `System.Text.Json` unter .NET verkleinert den Footprint des Test Host und bringt die Testausführung mit dem Rest des modernen SDK in Einklang ([verwandt: System.Text.Json in .NET 11 Preview 3](/de/2026/04/system-text-json-11-pascalcase-per-member-naming/)). Für .NET Framework hält JSONite dasselbe Protokoll auf einem winzigen, dedizierten Parser am Leben, statt einer geteilten Bibliothek, die Teams in der Vergangenheit gebissen hat.

Wenn Sie früh wissen wollen, ob Sie zur kaputten Gruppe gehören, richten Sie Ihre CI auf das Preview-Paket [Microsoft.TestPlatform 1.0.0-alpha-stj-26213-07](https://www.nuget.org/packages/Microsoft.TestPlatform/1.0.0-alpha-stj-26213-07) und lassen Sie Ihre vorhandene Test-Suite laufen. Ein grüner Build heute bedeutet ein grüner Build am 12. Mai.
