---
title: "Was ist .NET Aspire?"
description: "Eine Übersicht über .NET Aspire, das cloudorientierte Framework zum Erstellen skalierbarer verteilter Anwendungen, einschließlich Orchestrierung, Komponenten und Tooling."
pubDate: 2023-11-14
updatedDate: 2023-11-16
tags:
  - "aspire"
  - "dotnet"
lang: "de"
translationOf: "2023/11/what-is-net-aspire"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET Aspire ist ein umfassendes, cloudorientiertes Framework zum Erstellen skalierbarer, beobachtbarer und produktionsreifer verteilter Anwendungen. Es wurde als Preview im Rahmen des .NET 8-Releases eingeführt.

Das Framework wird über eine Reihe von NuGet-Paketen bereitgestellt, die jeweils unterschiedliche Aspekte der Cloud-Native-Anwendungsentwicklung adressieren. Solche Anwendungen sind typischerweise als Netzwerk von Microservices statt als eine einzige große Codebasis strukturiert und stützen sich stark auf eine Vielzahl von Services wie Datenbanken, Messaging-Systeme und Caching-Lösungen.

## Orchestration

Die Orchestrierung im Kontext cloud-nativer Anwendungen umfasst die Synchronisation und Verwaltung verschiedener Komponenten. .NET Aspire verbessert diesen Prozess, indem es die Einrichtung und Integration verschiedener Segmente einer cloud-nativen Anwendung vereinfacht. Es bietet High-Level-Abstraktionen für die effektive Handhabung von Aspekten wie Service Discovery, Umgebungsvariablen und Konfigurationen für Container und macht somit aufwendigen Low-Level-Code überflüssig. Diese Abstraktionen sorgen für einheitliche Konfigurationsverfahren über Anwendungen mit mehreren Komponenten und Services hinweg.

Mit .NET Aspire deckt die Orchestrierung Schlüsselbereiche ab, wie etwa:

-   **Anwendungszusammenstellung:** Dies umfasst die Definition der .NET-Projekte, Container, ausführbaren Dateien und cloudbasierten Ressourcen, aus denen die Anwendung besteht.
-   **Service Discovery und Verwaltung von Verbindungszeichenfolgen:** Der Anwendungshost ist dafür verantwortlich, präzise Verbindungszeichenfolgen und Service-Discovery-Details nahtlos einzubinden und so den Entwicklungsprozess zu verbessern.

So ermöglicht .NET Aspire beispielsweise die Erstellung einer lokalen Redis-Container-Ressource und die Einrichtung der entsprechenden Verbindungszeichenfolge in einem "frontend"-Projekt mit minimalem Code, indem nur ein paar Hilfsmethoden verwendet werden.

```cs
// Create a distributed application builder given the command line arguments.
var builder = DistributedApplication.CreateBuilder(args);

// Add a Redis container to the application.
var cache = builder.AddRedisContainer("cache");

// Add the frontend project to the application and configure it to use the 
// Redis container, defined as a referenced dependency.
builder.AddProject<Projects.MyFrontend>("frontend")
       .WithReference(cache);
```

## Components

.NET Aspire-Komponenten, verfügbar als NuGet-Pakete, sind darauf ausgelegt, die Integration mit weit verbreiteten Services und Plattformen wie Redis und PostgreSQL zu vereinfachen. Diese Komponenten adressieren verschiedene Aspekte der cloud-nativen Anwendungsentwicklung, indem sie einheitliche Konfigurationen, einschließlich der Implementierung von Health Checks und Telemetrie-Funktionen, anbieten.

Jede dieser Komponenten ist so konzipiert, dass sie sich nahtlos in das .NET Aspire-Orchestrierungsframework einfügt. Sie können ihre Konfigurationen automatisch über Abhängigkeiten propagieren, basierend auf den Beziehungen, die in .NET-Projekt- und Paketreferenzen definiert sind. Das bedeutet: Wenn eine Komponente, sagen wir Example.ServiceFoo, von einer anderen, Example.ServiceBar, abhängt, übernimmt Example.ServiceFoo automatisch die nötigen Konfigurationen aus Example.ServiceBar, um deren Kommunikation untereinander zu ermöglichen.

Zur Veranschaulichung betrachten wir die Verwendung der .NET Aspire Service Bus-Komponente in einem Code-Szenario.

```cs
builder.AddAzureServiceBus("servicebus");
```

Die Methode `AddAzureServiceBus` in .NET Aspire erfüllt mehrere Schlüsselfunktionen:

1.  Sie etabliert einen `ServiceBusClient` als Singleton im Dependency Injection (DI)-Container und ermöglicht so die Verbindung zu Azure Service Bus.
2.  Diese Methode erlaubt die Konfiguration des `ServiceBusClient`, was direkt im Code oder über externe Konfigurationseinstellungen erfolgen kann.
3.  Zusätzlich aktiviert sie relevante Health Checks, Logging und Telemetrie-Funktionen, die speziell auf Azure Service Bus zugeschnitten sind, und sorgt damit für effiziente Überwachung und Wartung.

## Tooling

Mit .NET Aspire entwickelte Anwendungen folgen einer einheitlichen Struktur, die durch die standardmäßigen .NET Aspire-Projektvorlagen festgelegt ist. Typischerweise besteht eine .NET Aspire-Anwendung aus mindestens drei verschiedenen Projekten:

1.  **Foo**: Dies ist die Ausgangsanwendung, bei der es sich um ein standardmäßiges .NET-Projekt wie Blazor UI oder Minimal API handeln kann. Mit dem Wachstum der Anwendung können weitere Projekte hinzugefügt werden, und ihre Orchestrierung erfolgt über die Projekte Foo.AppHost und Foo.ServiceDefaults.
2.  **Foo.AppHost**: Das AppHost-Projekt überwacht die übergeordnete Orchestrierung der Anwendung. Dazu gehört das Zusammenstellen verschiedener Komponenten wie APIs, Service-Container und ausführbare Dateien sowie die Konfiguration ihrer Vernetzung und Kommunikation.
3.  **Foo.ServiceDefaults**: Dieses Projekt enthält die Standardkonfigurationseinstellungen für eine .NET Aspire-Anwendung. Diese Einstellungen, die Aspekte wie Health Checks und OpenTelemetry-Konfigurationen umfassen, können nach Bedarf angepasst und erweitert werden.

Um den Einstieg in diese Struktur zu erleichtern, werden zwei primäre .NET Aspire-Starter-Vorlagen angeboten:

-   **.NET Aspire Application**: Eine grundlegende Starter-Vorlage, die nur die Projekte Foo.AppHost und Foo.ServiceDefaults enthält und das Grundgerüst für den Aufbau bereitstellt.
-   **.NET Aspire Starter Application**: Eine umfassendere Vorlage, die nicht nur die Projekte Foo.AppHost und Foo.ServiceDefaults enthält, sondern auch mit vorkonfigurierten UI- und API-Projekten geliefert wird. Diese zusätzlichen Projekte sind mit Service Discovery und anderen Standardfunktionen von .NET Aspire vorkonfiguriert.

### Read next:

-   [How to install .NET Aspire](/de/2023/11/how-to-install-net-aspire/)
-   [Build your first .NET Aspire application](/de/2023/11/getting-started-with-net-aspire/)
