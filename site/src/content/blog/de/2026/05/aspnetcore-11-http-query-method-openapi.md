---
title: "ASP.NET Core in .NET 11 Preview 4 bringt OpenAPI die HTTP-Methode QUERY bei"
description: ".NET 11 Preview 4 sorgt dafur, dass die OpenAPI-Generierung in ASP.NET Core HTTP QUERY als erstklassige Operation in OpenAPI 3.2 erkennt, mit einem eleganten Fallback fur 3.0- und 3.1-Dokumente."
pubDate: 2026-05-24
tags:
  - "dotnet-11"
  - "aspnetcore"
  - "openapi"
  - "http"
  - "minimal-apis"
lang: "de"
translationOf: "2026/05/aspnetcore-11-http-query-method-openapi"
translatedBy: "claude"
translationDate: 2026-05-24
---

[.NET 11 Preview 4](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-4/), veroffentlicht am 2026-05-12, hat eine kleine, aber zukunftsweisende Anderung in ASP.NET Core eingefuhrt: Die OpenAPI-Dokumentgenerierung erkennt jetzt `QUERY` als bekannten HTTP-Operationstyp. Falls Sie noch nie von der Methode QUERY gehort haben, ist genau das der Punkt dieses Beitrags. Es handelt sich um eine vorgeschlagene Standardmethode, die eine reale Spannung lost, die Such-Endpunkte seit Jahren plagt.

## Warum ein neues Verb fur die Suche

Eine Suchanfrage will zwei Dinge, die die bestehenden Verben nicht gemeinsam bieten konnen. Sie will sicher und idempotent sein, wie `GET`, damit Caches und Proxies sie sinnvoll behandeln und ein erneuter Versuch nie etwas verandert. Und sie will einen strukturierten Anfragerumpf tragen, wie `POST`, weil ein ernsthafter Filter (verschachtelte boolesche Klauseln, geografische Grenzen, ein Vektor plus Pradikate auf Metadaten) nicht sauber in eine Query-String passt und an die Langenbegrenzungen der URL stosst.

Teams haben das ein Jahrzehnt lang uberdeckt, indem sie `POST /search` mit einem JSON-Rumpf gesendet und stillschweigend so getan haben, als sei es idempotent. Das funktioniert, aber es belugt jeden Cache und jede Zwischenstation auf dem Weg. Die `QUERY`-Methode der IETF ist die ehrliche Variante: `GET`-Semantik (sicher, idempotent, cachefahig) plus ein Anfragerumpf. Preview 4 erfindet die Methode nicht, es bringt der OpenAPI-Pipeline bei, sie korrekt zu beschreiben.

## Einen QUERY-Endpunkt zuordnen

Das Routing unterstutzte bereits beliebige Verben, daher gibt es kein neues Attribut zu lernen. Sie ordnen einen QUERY-Endpunkt mit der bestehenden Uberladung von `MapMethods` zu:

```csharp
app.MapMethods("/search", ["QUERY"], (SearchRequest request) =>
    SearchService.Run(request));
```

Das Neue ist, was aus dem OpenAPI-Dokumentgenerator herauskommt. QUERY wurde erst in OpenAPI 3.2 zu einem erstklassigen Konzept, daher mussen Sie sich fur diese Spezifikationsversion entscheiden:

```csharp
builder.Services.AddOpenApi(options =>
{
    options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_2;
});
```

Mit ausgewahltem 3.2 wird der obige Endpunkt als korrekte `query`-Operation im Path-Item ausgegeben. Wenn Sie noch an OpenAPI 3.0 oder 3.1 gebunden sind, die vor der Methode liegen, verwirft der Generator den Endpunkt nicht stillschweigend. Er greift auf eine `x-oai-additionalOperations`-Erweiterung zuruck, damit Werkzeuge, die die Erweiterung verstehen, die Operation weiterhin sehen konnen, und solche, die das nicht tun, zumindest nicht daran ersticken.

## Wissenswertes, bevor Sie es ausliefern

QUERY ist nach wie vor eine vorgeschlagene Methode, daher ist die Unterstutzung uber Browser, HTTP-Clients, CDNs und Unternehmens-Proxies hinweg uneinheitlich. Bei dieser Anderung geht es darum, einen Endpunkt prazise zu dokumentieren, nicht um das Versprechen, dass jede Zwischenstation ihn weiterleitet. Fur interne Service-zu-Service-Such-APIs, bei denen Sie beide Enden kontrollieren, passt sie heute schon sauber. Fur offentliche APIs behandeln Sie sie als Zukunftssicherung und behalten einen `POST`-Pfad bei, bis das Okosystem nachzieht.

Die Arbeit ist in [dotnet/aspnetcore #65714](https://github.com/dotnet/aspnetcore/pull/65714) gelandet. Es ist eine unscheinbare Zeile in einer unscheinbaren Preview, aber es ist die Art von Infrastruktur, die entscheidet, ob QUERY wirklich ankommt oder fur immer ein Entwurf bleibt.
