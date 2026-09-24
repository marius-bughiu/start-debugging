---
title: "Microsoft rota su certificado de firma de autor de NuGet: corrige trustedSigners antes de que aparezca NU3034"
description: "A partir del 23 de septiembre de 2026, los paquetes de Microsoft en NuGet se firman como autor con un nuevo certificado (SHA-256 9A1B131B...). Si tu nuget.config fija a Microsoft en trustedSigners, las restauraciones fallarán con NU3034. Aquí está la solución, incluido el comando dotnet nuget trust correcto."
pubDate: 2026-09-24
tags:
  - "nuget"
  - "dotnet"
  - "security"
  - "supply-chain"
lang: "es"
translationOf: "2026/09/microsoft-nuget-author-signing-certificate-rotation-nu3034"
translatedBy: "claude"
translationDate: 2026-09-24
---

El 23 de septiembre de 2026 el equipo de .NET [anunció](https://devblogs.microsoft.com/dotnet/microsoft-author-signing-certificate-update-2026/) que Microsoft cambia el certificado que usa para firmar como autor los paquetes en nuget.org. La mayoría de los proyectos nunca lo notarán. Si ejecutas NuGet con `signatureValidationMode="require"` y una lista `<trustedSigners>` que nombra a Microsoft, o si ejecutas `dotnet nuget verify --certificate-fingerprint` en CI, el primer paquete firmado con el nuevo certificado fallará con `NU3034` y romperá la compilación.

## Las huellas digitales

El nuevo certificado tiene la huella digital SHA-256 `9A1B131BEE0605433056A4EA3815478A8E177961A968C6C0027C1093D1FEB630`. El que se reemplaza es `566A31882BE208BE4422F7CFD66ED09F5D4524A5994F50CCC8B05EC0528C1353`. Dos huellas más antiguas, `3F9001EA...` y `AA12DA22...`, también siguen siendo válidas para paquetes firmados hace años.

No elimines ninguna. Los paquetes que ya están en nuget.org conservan sus firmas originales, así que tu lista de confianza tiene que aceptar todos los certificados que Microsoft ha usado, no solo el más reciente.

## El despliegue es gradual

Descargué `Microsoft.Playwright` 1.63.0 (publicado el 23 de septiembre, 20:23 UTC) y `Microsoft.Identity.Web` 4.15.0 y ejecuté `dotnet nuget verify --all -v normal` con el SDK 10.0.302. Ambos siguen firmados con el certificado anterior:

```text
Signature type: Author
  Subject Name: CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US
  SHA256 hash: 566A31882BE208BE4422F7CFD66ED09F5D4524A5994F50CCC8B05EC0528C1353
  Valid from: 27/07/2023 03:00:00 to 18/10/2026 02:59:59
```

El certificado anterior vence el 18 de octubre de 2026. Los equipos de Microsoft publican según sus propios calendarios, así que espera que los paquetes pasen al nuevo certificado durante las próximas semanas. Después del 18 de octubre no se puede firmar nada nuevo con el anterior. Una compilación que funciona hoy puede fallar el próximo martes.

## El comando trust del anuncio no funciona

La publicación del blog sugiere `dotnet nuget trust author Microsoft <fingerprint> --algorithm SHA256`. Con el SDK 10.0.302 eso falla con `Unrecognized command or argument '--algorithm'`, porque `trust author` recibe la ruta a un paquete firmado, no una huella digital. Para agregar una huella digital directamente, usa [`trust certificate`](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-nuget-trust):

```bash
dotnet nuget trust certificate Microsoft 9A1B131BEE0605433056A4EA3815478A8E177961A968C6C0027C1093D1FEB630 --algorithm SHA256 --configfile nuget.config
```

Si la entrada de autor `Microsoft` ya existe, esto le agrega la huella digital ("Successfully updated the trusted signer 'Microsoft'"). La configuración resultante debería incluir las cuatro:

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

## Pasos de verificación en CI

`dotnet nuget verify` acepta `--certificate-fingerprint` más de una vez. Pasa las cuatro. Con una sola huella digital, la comprobación falla en cuanto encuentra un paquete firmado con otro certificado. Por ejemplo, verificar Playwright 1.63.0 solo contra la nueva huella digital imprime:

```text
error: NU3034: The package signature did not match any of the allowed certificate fingerprints.
```

Las organizaciones que replican nuget.org en un feed interno y comprueban las firmas al ingerir los paquetes necesitan el mismo cambio allí. La [referencia de NU3034](https://learn.microsoft.com/en-us/nuget/reference/errors-and-warnings/nu3034) y la [guía de paquetes firmados](https://learn.microsoft.com/en-us/nuget/consume-packages/installing-signed-packages) cubren el resto del modelo de `trustedSigners`. Agregar la nueva huella digital ahora, antes de que tu restauración se encuentre con un paquete que la use, es mucho más fácil que depurar una compilación en rojo a mediados de octubre.
