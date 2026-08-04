---
title: "NuGet-API-Keys bekommen am 17. August eine 30-Tage-Grenze, und jeder alte Key läuft am 1. November ab"
description: "NuGet.org streicht am 2026-08-17 die 365-Tage-Option für API-Keys, begrenzt neue Keys auf 30 Tage und lässt am 1. November jeden zuvor erstellten Key ablaufen. Was dabei bricht und wie Sie einen Publish-Workflow auf OIDC Trusted Publishing umstellen."
pubDate: 2026-08-04
tags:
  - "dotnet"
  - "nuget"
  - "ci-cd"
  - "security"
  - "github-actions"
lang: "de"
translationOf: "2026/08/nuget-api-keys-capped-at-30-days-from-august-17"
translatedBy: "claude"
translationDate: 2026-08-04
---

Das .NET-Team hat am 2026-08-03 [Strengthening NuGet Supply Chain Security: Reducing API Key Lifetime](https://devblogs.microsoft.com/dotnet/strengthening-nuget-supply-chain-security-reducing-api-key-lifetime/) veröffentlicht, und darin stehen zwei harte Termine, die Release-Pipelines zerlegen, wenn man sie ignoriert.

## Die zwei Termine

**2026-08-17**: Neue API-Keys sind auf eine maximale Laufzeit von 30 Tagen begrenzt. Die 365-Tage-Option verschwindet aus der Key-Erstellung auf nuget.org.

**2026-11-01**: Jeder vor dem 17. August erstellte API-Key läuft ab. Nicht nur die einjährigen. Wenn Ihr Secret `NUGET_API_KEY` im Juni erzeugt wurde, funktioniert es ab dem 1. November nicht mehr, unabhängig vom Ablaufdatum, das daneben steht.

Der zweite Termin ist der kritische. Ein tag-gesteuerter Release-Workflow, der seit Oktober nicht mehr gelaufen ist, scheitert nach dem 1. November beim ersten Push mit einem 401, und der Fehler taucht in einem Job auf, den niemand beobachtet, bis tatsächlich ausgeliefert werden soll.

## Warum ein 30-Tage-Key immer noch die falsche Form hat

Ein 30-Tage-Key ist besser als ein 365-Tage-Key, aber es bleibt ein langlebiges Secret in einem Secret-Store des Repositorys, und jetzt rotieren Sie es zwölfmal im Jahr statt einmal. Rotationsautomatisierung ist echte Arbeit: Key auf nuget.org mit dem richtigen Paket-Scope erzeugen, ihn nach GitHub oder Azure DevOps schieben, prüfen, dass der alte widerrufen ist.

Die Alternative, zu der Microsoft alle drängt, ist [Trusted Publishing](https://learn.microsoft.com/en-us/nuget/nuget-org/trusted-publishing), das stattdessen OIDC nutzt. Ihr CI-System stellt ein kurzlebiges signiertes Token aus, nuget.org validiert es gegen eine von Ihnen registrierte Policy und gibt einen temporären API-Key zurück, der **eine Stunde** gültig ist. Ein Token kauft genau einen Key. Es wird nirgends etwas Dauerhaftes gespeichert.

Die GitHub-Actions-Form ist klein:

```yaml
publish:
  environment: release
  permissions:
    id-token: write   # required for GitHub to mint the OIDC token
    contents: read
  steps:
    - name: NuGet login (OIDC to temp API key)
      uses: NuGet/login@v1
      id: login
      with:
        user: ${{ secrets.NUGET_USER }}   # nuget.org profile name, not your email
    - name: Push
      run: >
        dotnet nuget push artifacts/*.nupkg
        --api-key ${{ steps.login.outputs.NUGET_API_KEY }}
        --source https://api.nuget.org/v3/index.json
        --skip-duplicate
```

Die einmalige Einrichtung ist eine Policy auf nuget.org unter Account, Trusted Publishing: Repository-Owner, Repository, Dateiname des Workflows (`release.yml`, ohne den Präfix `.github/workflows/`) und optional der Environment-Name. GitLab funktioniert ebenfalls und tauscht einen `id_tokens`-Claim gegen `POST https://www.nuget.org/api/v2/token`.

Eine Fallstricke-Sache, die man vor November kennen sollte: Eine Policy für ein privates GitHub-Repository startet **temporär aktiv für 7 Tage**. Findet in diesem Fenster keine Veröffentlichung statt, wird sie inaktiv, denn nuget.org braucht die Repository- und Owner-IDs aus einem echten Token-Austausch, um die Policy gegen Resurrection-Angriffe zu binden. Registrieren Sie die Policy und machen Sie einen Wegwerf-Push, statt sie zu registrieren und liegen zu lassen.

Wenn Sie bereits ein Release mit mehreren Paketen fahren, ist die Verkabelung in [Independently Releasing Multiple NuGet Packages with MinVer + Trusted Publishing](/2026/05/independently-release-multiple-nuget-packages-with-minver-and-trusted-publishing/) beschrieben. Andernfalls ist das Minimum für diese Woche: prüfen, welche Ihrer Pipelines noch mit einem statischen Key pushen, und sicherstellen, dass das nuget.org-Konto mit den Ablaufbenachrichtigungen eines ist, das jemand tatsächlich liest.
