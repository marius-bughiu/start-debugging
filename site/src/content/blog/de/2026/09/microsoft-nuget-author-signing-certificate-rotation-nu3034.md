---
title: "Microsoft wechselt sein NuGet-Author-Signing-Zertifikat: trustedSigners anpassen, bevor NU3034 zuschlägt"
description: "Ab dem 23. September 2026 werden Microsoft-Pakete auf NuGet mit einem neuen Zertifikat (SHA-256 9A1B131B...) autorsigniert. Wenn Ihre nuget.config Microsoft in trustedSigners festlegt, schlagen Restores mit NU3034 fehl. Hier ist die Lösung, einschließlich des korrekten dotnet nuget trust-Befehls."
pubDate: 2026-09-24
tags:
  - "nuget"
  - "dotnet"
  - "security"
  - "supply-chain"
lang: "de"
translationOf: "2026/09/microsoft-nuget-author-signing-certificate-rotation-nu3034"
translatedBy: "claude"
translationDate: 2026-09-24
---

Am 23. September 2026 hat das .NET-Team [angekündigt](https://devblogs.microsoft.com/dotnet/microsoft-author-signing-certificate-update-2026/), dass Microsoft das Zertifikat wechselt, mit dem es Pakete auf nuget.org autorsigniert. Die meisten Projekte werden davon nichts merken. Wenn Sie NuGet mit `signatureValidationMode="require"` und einer `<trustedSigners>`-Liste betreiben, die Microsoft enthält, oder in der CI `dotnet nuget verify --certificate-fingerprint` ausführen, scheitert das erste mit dem neuen Zertifikat signierte Paket mit `NU3034` und bricht den Build.

## Die Fingerabdrücke

Das neue Zertifikat hat den SHA-256-Fingerabdruck `9A1B131BEE0605433056A4EA3815478A8E177961A968C6C0027C1093D1FEB630`. Das abgelöste Zertifikat hat `566A31882BE208BE4422F7CFD66ED09F5D4524A5994F50CCC8B05EC0528C1353`. Zwei ältere Fingerabdrücke, `3F9001EA...` und `AA12DA22...`, bleiben ebenfalls gültig für Pakete, die vor Jahren signiert wurden.

Entfernen Sie keinen davon. Pakete, die bereits auf nuget.org liegen, behalten ihre ursprünglichen Signaturen. Ihre Vertrauensliste muss daher jedes Zertifikat akzeptieren, das Microsoft je verwendet hat, nicht nur das neueste.

## Die Umstellung erfolgt schrittweise

Ich habe `Microsoft.Playwright` 1.63.0 (veröffentlicht am 23. September, 20:23 UTC) und `Microsoft.Identity.Web` 4.15.0 heruntergeladen und `dotnet nuget verify --all -v normal` mit SDK 10.0.302 ausgeführt. Beide sind noch mit dem alten Zertifikat signiert:

```text
Signature type: Author
  Subject Name: CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US
  SHA256 hash: 566A31882BE208BE4422F7CFD66ED09F5D4524A5994F50CCC8B05EC0528C1353
  Valid from: 27/07/2023 03:00:00 to 18/10/2026 02:59:59
```

Das alte Zertifikat läuft am 18. Oktober 2026 ab. Die Microsoft-Teams veröffentlichen nach ihrem eigenen Zeitplan, daher ist damit zu rechnen, dass Pakete in den nächsten Wochen nach und nach auf das neue Zertifikat wechseln. Nach dem 18. Oktober kann nichts Neues mehr mit dem alten signiert werden. Ein Build, der heute funktioniert, kann nächsten Dienstag trotzdem fehlschlagen.

## Der trust-Befehl aus der Ankündigung funktioniert nicht

Der Blogbeitrag schlägt `dotnet nuget trust author Microsoft <fingerprint> --algorithm SHA256` vor. Mit SDK 10.0.302 schlägt das mit `Unrecognized command or argument '--algorithm'` fehl, weil `trust author` einen Pfad zu einem signierten Paket erwartet, keinen Fingerabdruck. Um einen reinen Fingerabdruck hinzuzufügen, verwenden Sie [`trust certificate`](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-nuget-trust):

```bash
dotnet nuget trust certificate Microsoft 9A1B131BEE0605433056A4EA3815478A8E177961A968C6C0027C1093D1FEB630 --algorithm SHA256 --configfile nuget.config
```

Wenn der Autoreneintrag `Microsoft` bereits existiert, fügt dieser Befehl den Fingerabdruck hinzu ("Successfully updated the trusted signer 'Microsoft'"). Die resultierende Konfiguration sollte alle vier auflisten:

```xml
<trustedSigners>
  <author name="Microsoft">
    <certificate fingerprint="3F9001EA83C560D712C24CF213C3D312CB3BFF51EE89435D3430BD06B5D0EECE" hashAlgorithm="SHA256" allowUntrustedRoot="false" />
    <certificate fingerprint="AA12DA22A49BCE7D5C1AE64CC1F3D892F150DA76140F210ABD2CBFFCA2C18A27" hashAlgorithm="SHA256" allowUntrustedRoot="false" />
    <certificate fingerprint="566A31882BE208BE4422F7CFD66ED09F5D4524A5994F50CCC8B05EC0528C1353" hashAlgorithm="SHA256" allowUntrustedRoot="false" />
    <certificate fingerprint="9A1B131BEE0605433056A4EA3815478A8E177961A968C6C0027C1093D1FEB630" hashAlgorithm="SHA256" allowUntrustedRoot="false" />
  </author>
</trustedSigners>
```

## Verify-Schritte in der CI

`dotnet nuget verify` akzeptiert `--certificate-fingerprint` mehrfach. Übergeben Sie alle vier. Mit nur einem Fingerabdruck schlägt die Prüfung fehl, sobald sie auf ein Paket trifft, das mit einem anderen Zertifikat signiert ist. Die Prüfung von Playwright 1.63.0 nur gegen den neuen Fingerabdruck gibt zum Beispiel aus:

```text
error: NU3034: The package signature did not match any of the allowed certificate fingerprints.
```

Organisationen, die nuget.org in einen internen Feed spiegeln und Signaturen beim Import prüfen, brauchen dort dieselbe Änderung. Die [NU3034-Referenz](https://learn.microsoft.com/en-us/nuget/reference/errors-and-warnings/nu3034) und der [Leitfaden zu signierten Paketen](https://learn.microsoft.com/en-us/nuget/consume-packages/installing-signed-packages) behandeln den Rest des `trustedSigners`-Modells. Den neuen Fingerabdruck jetzt hinzuzufügen, bevor Ihr Restore auf ein Paket trifft, das ihn verwendet, ist deutlich einfacher, als Mitte Oktober einen roten Build zu debuggen.
