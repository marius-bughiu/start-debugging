---
title: "CV Shortlist: historische Notizen zu einer .NET-10-KI-SaaS"
description: "Was der Autor von CV Shortlist ankündigte, was die frühere README beschrieb und welche .NET-KI-Ideen nach dem Verschwinden des öffentlichen Repositorys bleiben."
pubDate: 2026-01-18
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-10"
lang: "de"
translationOf: "2026/01/cv-shortlist-an-ai-powered-net-10-saas-went-open-source-and-the-stack-is-worth-studying"
translatedBy: "claude"
translationDate: 2026-04-29
---

**Stand: 2. November 2026:** Das frühere öffentliche Repository `github.com/mihnea-radulescu/cvshortlist` liefert 404, auch über die GitHub-API. Daraus folgt nicht, ob es gelöscht, privat gemacht oder verschoben wurde. Ein öffentlicher Ersatz wurde nicht verifiziert. Dies ist eine historische Einordnung, keine aktuell ausführbare Code-Anleitung.

## Was der Autor tatsächlich ankündigte

In der [ursprünglichen Ankündigung](https://www.reddit.com/r/csharp/comments/1qgbjo4/saas_educational_free_and_opensource_example_cv/) beschrieb Mihnea Radulescu eine im November 2025 begonnene kommerzielle SaaS, die später eingestellt und als MIT-lizenziertes Lernprojekt veröffentlicht wurde. Genannt wurden .NET 10, ASP.NET Core, Blazor Server, Azure Cloud und Azure AI Foundry. Ziel war die Vorauswahl von Bewerbungen. Das sind Angaben des Autors, keine unabhängigen Nachweise für Genauigkeit oder Produktionsreife.

Eine zwischengespeicherte Kopie der früheren GitHub-README beschreibt PDF-Extraktion mit Document Intelligence und den Vergleich mit Stellenbeschreibungen durch ein Modell der GPT-5-Familie. Sie nennt EF Core 10, Azure-Speicher und Datenbanken sowie eine selbst gehostete Variante mit weiterhin benötigten Azure-KI-Ressourcen; die Bereitstellungshinweise nennen `gpt-5-mini`. Das belegt weder den aktuellen Code noch Modellverfügbarkeit, heutige Voraussetzungen oder Testergebnisse. Das nicht verfügbare Repository wurde hier nicht gebaut oder auditiert.

## Nützliche Entwurfsfragen trotz fehlendem Repository

Dokumentextraktion und Modellverarbeitung getrennt zu betrachten, ist ein sinnvoller Ansatz. Microsofts [Dokumentation zum Layoutmodell](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/layout?view=doc-intel-4.0.0) beschreibt die Extraktion von Text, Tabellen und Struktur. Prüfe die Ergebnisse an deinen eigenen Dokumenten, bevor du sie an ein Modell übergibst. Extraktion mit anschließendem LLM-Aufruf allein ist noch kein Nachweis einer RAG-Architektur.

Halte Konfiguration aus dem Quellcode heraus und validiere die tatsächlich benötigten Einstellungen. Die README-Empfehlung zu User Secrets und Umgebungsvariablen ist historische Projektberatung, kein vollständiges Produktionskonzept. Laut [Secret-Manager-Dokumentation](https://learn.microsoft.com/en-us/aspnet/core/security/app-secrets?view=aspnetcore-10.0) dienen User Secrets der Entwicklung und sind nicht verschlüsselt. Auch Umgebungsvariablen brauchen Zugriffsschutz. Das frühere illustrative `Program.cs`-Beispiel wurde entfernt: Es war kein geprüfter Repository-Code, und C#-`required`-Eigenschaften bewirkten keine Laufzeit-Pflichtfeldprüfung durch `ValidateDataAnnotations()`.

Als verfügbaren Lernpfad bietet [Generative AI for Beginners .NET v2](/de/2026/03/generative-ai-beginners-dotnet-v2-dotnet10-meai/) Materialien zu Dokumentverarbeitung und Modellintegration. Verwende ein nicht verfügbares Projekt nicht als Bereitstellungsvorlage.

**Korrektur vom 2. November 2026:** Ankündigung und historische README von aktuell geprüftem Quellcode getrennt; unbelegte Implementierungsempfehlungen und das ungeprüfte Konfigurationsbeispiel entfernt.
