---
title: "Statische SSR-Formulare in Blazor erhalten clientseitige Validierung in .NET 11 Preview 5"
description: "Statisch serverseitig gerenderte Blazor-Formulare konnten erst nach einem vollständigen POST-Roundtrip validieren. .NET 11 Preview 5 rendert die Validierungsmetadaten, sodass das Blazor-JS die DataAnnotations-Regeln im Browser durchsetzt, ohne Circuit."
pubDate: 2026-06-11
tags:
  - "blazor"
  - "dotnet-11"
  - "aspnetcore"
  - "ssr"
  - "csharp"
lang: "de"
translationOf: "2026/06/blazor-static-ssr-client-side-validation-dotnet-11-preview-5"
translatedBy: "claude"
translationDate: 2026-06-11
---

[.NET 11 Preview 5](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/) erschien am 2026-06-09, und eine Änderung in ASP.NET Core schließt eine Lücke, die jeden geärgert hat, der Formulare auf statischem serverseitigem Rendering (static SSR) aufbaut: Formulare validieren jetzt im Browser ohne einen interaktiven Rendermodus. Bis zu dieser Vorschauversion hatte ein static-SSR-Formular genau eine Möglichkeit, dem Benutzer mitzuteilen, dass seine E-Mail fehlerhaft war: das Ganze absenden, den Server `DataAnnotations` ausführen lassen und die Seite mit den Fehlermeldungen neu rendern. Das ist ein vollständiger POST-Roundtrip für einen Tippfehler.

## Warum static-SSR-Formulare an den Server gebunden waren

Das Blazor-Web-App-Template rendert den Großteil des Inhalts als statisches HTML. Es gibt keinen SignalR-Circuit und keine WebAssembly-Last, und genau deshalb ist static SSR günstig und schnell. Aber clientseitige Validierung benötigt Code, der im Browser läuft, und eine statische Seite liefert keinerlei Komponentenlogik an den Client. Also lebte die Validierung vollständig auf dem Server: Sie sendeten das Formular, der `DataAnnotationsValidator` durchlief das Modell, und alle Fehler kamen als neu gerenderte Seite zurück. Korrekt, aber langsam, und eine schlechte Erfahrung neben einem interaktiven Formular, das ein fehlerhaftes Feld beim Verlassen des Fokus markiert.

Der übliche Workaround bestand darin, die Formularkomponente nur für Live-Feedback auf `InteractiveServer` oder `InteractiveWebAssembly` umzustellen und so für einen Circuit oder einen WASM-Download zu bezahlen, den Sie sonst nicht benötigt hätten.

## Wie Preview 5 die Lücke schließt

In Preview 5 rendert der Server die Validierungsregeln als Metadaten in das HTML, und das Blazor-JS setzt sie im Browser durch. Ihre `DataAnnotations`-Attribute bleiben die maßgebliche Quelle der Wahrheit und werden beim Absenden erneut auf dem Server ausgewertet. Der Browser erhält lediglich eine frühe, kostenlose Kopie derselben Regeln. Die Funktion ist standardmäßig für jedes static-SSR-Formular aktiviert, das einen `DataAnnotationsValidator` enthält, und sie funktioniert mit erweiterten und nicht erweiterten Formularen.

Es gibt keine neue API zu lernen. Das Formular, das Sie bereits geschrieben haben, beginnt clientseitig zu validieren, sobald Sie auf das Preview-5-SDK abzielen:

```razor
<EditForm Model="Model" Enhance FormName="registration" OnValidSubmit="HandleValidSubmit">
    <DataAnnotationsValidator />
    <div>
        <label for="Email">Email</label>
        <InputText @bind-Value="Model!.Email" id="Email" />
        <ValidationMessage For="@(() => Model!.Email)" />
    </div>
    <button type="submit" id="submit-btn">Register</button>
</EditForm>
```

```csharp
public class RegistrationModel
{
    [Required]
    [EmailAddress]
    public string Email { get; set; }

    [Required]
    [StringLength(100, MinimumLength = 8)]
    public string Password { get; set; }

    [Required]
    [Compare("Password")]
    [Display(Name = "Confirm Password")]
    public string ConfirmPassword { get; set; }
}
```

Eine fehlerhafte E-Mail oder ein zu kurzes Passwort erscheint jetzt im Browser, bevor das Formular überhaupt das Netzwerk erreicht. Der Server führt beim POST weiterhin dieselben Prüfungen aus, sodass Sie die Defense-in-Depth nicht verlieren: die Client-Validierung ist eine Komfortebene, keine Sicherheitsgrenze, genau wie es sein sollte.

## Was noch fehlt

Asynchrone Regeln (eine Eindeutigkeitsprüfung in der Datenbank, eine Abfrage an eine entfernte API) sind hier noch nicht enthalten. Die Release Notes sagen, dass die vollständige asynchrone Geschichte kommt, wenn die neuen asynchronen `DataAnnotations`-APIs in einer späteren Vorschauversion erscheinen. Vorerst deckt dies den synchronen Attributsatz ab, der den Großteil der realen Formularvalidierung ausmacht.

Das passt zu den anderen Ergänzungen von Preview 5 wie der [System.Text.Json JSON-Lines-Serialisierung](/de/2026/06/system-text-json-json-lines-serialization-dotnet-11-preview-5/). Zum Ausprobieren installieren Sie das .NET 11 Preview 5 SDK und zielen auf `net11.0` ab. Alle Details finden Sie in den [ASP.NET Core Preview 5 Release Notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/aspnetcore.md).
