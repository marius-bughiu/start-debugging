---
title: "Was ist neu in .NET 8"
description: ".NET 8 wurde am 14. November 2023 als LTS-Version (Long Term Support) veröffentlicht und erhält damit für mindestens drei Jahre nach Release weiterhin Support, Updates und Fehlerbehebungen. Wie üblich bringt .NET 8 Unterstützung für eine neue Version der C#-Sprache mit, nämlich C# 12."
pubDate: 2023-06-10
updatedDate: 2023-11-15
tags:
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/06/whats-new-in-net-8"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 wurde am **14. November 2023** als LTS-Version (Long Term Support) veröffentlicht und erhält damit für mindestens drei Jahre nach Release weiterhin Support, Updates und Fehlerbehebungen.

Wie üblich bringt .NET 8 Unterstützung für eine neue Version der C#-Sprache mit, nämlich C# 12. Sehen Sie sich unsere eigene Seite zu [Neuigkeiten in C# 12](/2023/06/whats-new-in-c-12/) an.

Tauchen wir in die Liste der Änderungen und neuen Features in .NET 8 ein:

-   [.NET Aspire (Vorschau)](/de/2023/11/what-is-net-aspire/)
    -   [Voraussetzungen](/de/2023/11/how-to-install-net-aspire/)
    -   [Erste Schritte](/de/2023/11/getting-started-with-net-aspire/)
-   .NET-SDK-Änderungen
    -   [Befehl 'dotnet workload clean'](/de/2023/09/dotnet-workload-clean/)
    -   Assets von 'dotnet publish' und 'dotnet pack'
-   Serialisierung
    -   [JSON-Benennungsrichtlinien snake\_case und kebab-case](/de/2023/08/net-8-json-serialize-property-names-using-snake-case-and-kebab-case/)
    -   [Fehlende Member während der Serialisierung behandeln](/de/2023/09/net-8-handle-missing-members-during-json-deserialization/)
    -   [In schreibgeschützte Eigenschaften deserialisieren](/de/2023/09/net-8-deserialize-into-read-only-properties/)
    -   [Nicht öffentliche Eigenschaften in die Serialisierung einbeziehen](/de/2023/09/net-8-include-non-public-members-in-json-serialization/)
    -   [Modifier zu bestehenden IJsonTypeInfoResolver-Instanzen hinzufügen](/de/2023/10/system-text-json-how-to-modify-existing-type-info-resolver/)
    -   Streaming-Deserialisierung: [Von JSON zu AsyncEnumerable](/de/2023/10/httpclient-get-json-as-asyncenumerable/)
    -   JsonNode: [Deep Clone, Deep Copy](/de/2023/10/deep-cloning-and-deep-equality-of-a-jsonnode/) und [weitere API-Updates](/de/2023/10/jsonnode-net-8-api-updates/)
    -   [Standardmäßige reflectionbasierte Serialisierung deaktivieren](/de/2023/10/system-text-json-disable-reflection-based-serialization/)
    -   [TypeInfoResolver in einer bestehenden JsonSerializerOptions-Instanz hinzufügen/entfernen](/de/2023/10/add-remove-typeinforesolver-to-existing-jsonserializeroptions/)
-   Kern-Bibliotheken von .NET
    -   [FrozenDictionary -- Performance-Vergleich](/de/2023/08/net-8-performance-dictionary-vs-frozendictionary/)
    -   Methoden zum Arbeiten mit Zufall -- [GetItems<T>()](/de/2023/11/c-randomly-choose-items-from-a-list/) und [Shuffle<T>()](/de/2023/10/c-how-to-shuffle-an-array/)
-   Erweiterungs-Bibliotheken
-   Garbage Collection
-   Source Generator für Konfigurationsbindung
-   Verbesserungen bei Reflection
    -   Schluss mit Reflection: lernen Sie [UnsafeAccessorAttribute](/de/2023/10/unsafe-accessor/) kennen (siehe [Performance-Benchmarks](/de/2023/11/net-8-performance-unsafeaccessor-vs-reflection/))
    -   [Aktualisieren von `readonly`-Feldern](/2023/06/whats-new-in-net-8/)
-   Native AOT-Unterstützung
-   Performance-Verbesserungen
-   .NET-Container-Images
-   .NET unter Linux
-   Windows Presentation Foundation (WPF)
    -   [Hardwarebeschleunigung in RDP](/de/2023/10/wpf-hardware-acceleration-in-rdp/)
    -   [Open Folder Dialog](/de/2023/10/wpf-open-folder-dialog/)
        -   Zusätzliche Dialogoptionen ([ClientGuid](/de/2023/10/wpf-individual-dialog-states-using-clientguid/), [RootDirectory](/de/2023/10/wpf-limit-openfiledialog-folder-tree-to-a-certain-folder/), [AddToRecent](/de/2023/10/wpf-prevent-file-dialog-selection-from-being-added-to-recents/) und CreateTestFile)
-   NuGet
