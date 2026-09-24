---
title: "A Microsoft está trocando o certificado de assinatura de autor do NuGet: corrija trustedSigners antes que o NU3034 apareça"
description: "A partir de 23 de setembro de 2026, os pacotes da Microsoft no NuGet passam a ser assinados como autor com um novo certificado (SHA-256 9A1B131B...). Se o seu nuget.config fixa a Microsoft em trustedSigners, os restores vão falhar com NU3034. Aqui está a correção, incluindo o comando dotnet nuget trust correto."
pubDate: 2026-09-24
tags:
  - "nuget"
  - "dotnet"
  - "security"
  - "supply-chain"
lang: "pt-br"
translationOf: "2026/09/microsoft-nuget-author-signing-certificate-rotation-nu3034"
translatedBy: "claude"
translationDate: 2026-09-24
---

Em 23 de setembro de 2026, o time do .NET [anunciou](https://devblogs.microsoft.com/dotnet/microsoft-author-signing-certificate-update-2026/) que a Microsoft está trocando o certificado que usa para assinar como autor os pacotes no nuget.org. A maioria dos projetos nunca vai perceber. Se você roda o NuGet com `signatureValidationMode="require"` e uma lista `<trustedSigners>` que inclui a Microsoft, ou se roda `dotnet nuget verify --certificate-fingerprint` no CI, o primeiro pacote assinado com o novo certificado vai falhar com `NU3034` e quebrar o build.

## As impressões digitais

O novo certificado tem a impressão digital SHA-256 `9A1B131BEE0605433056A4EA3815478A8E177961A968C6C0027C1093D1FEB630`. O que está sendo substituído é `566A31882BE208BE4422F7CFD66ED09F5D4524A5994F50CCC8B05EC0528C1353`. Duas impressões digitais mais antigas, `3F9001EA...` e `AA12DA22...`, também continuam válidas para pacotes assinados anos atrás.

Não remova nenhuma delas. Os pacotes que já estão no nuget.org mantêm suas assinaturas originais, então a sua lista de confiança precisa aceitar todos os certificados que a Microsoft já usou, e não só o mais recente.

## A transição é gradual

Baixei o `Microsoft.Playwright` 1.63.0 (publicado em 23 de setembro, 20:23 UTC) e o `Microsoft.Identity.Web` 4.15.0 e rodei `dotnet nuget verify --all -v normal` no SDK 10.0.302. Os dois ainda estão assinados com o certificado antigo:

```text
Signature type: Author
  Subject Name: CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US
  SHA256 hash: 566A31882BE208BE4422F7CFD66ED09F5D4524A5994F50CCC8B05EC0528C1353
  Valid from: 27/07/2023 03:00:00 to 18/10/2026 02:59:59
```

O certificado antigo expira em 18 de outubro de 2026. Os times da Microsoft publicam cada um no seu ritmo, então espere que os pacotes migrem para o novo certificado ao longo das próximas semanas. Nada novo pode ser assinado com o antigo depois de 18 de outubro. Um build que funciona hoje ainda pode falhar na próxima terça-feira.

## O comando trust do anúncio não funciona

O post do blog sugere `dotnet nuget trust author Microsoft <fingerprint> --algorithm SHA256`. No SDK 10.0.302 isso falha com `Unrecognized command or argument '--algorithm'`, porque `trust author` recebe o caminho de um pacote assinado, e não uma impressão digital. Para adicionar uma impressão digital diretamente, use [`trust certificate`](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-nuget-trust):

```bash
dotnet nuget trust certificate Microsoft 9A1B131BEE0605433056A4EA3815478A8E177961A968C6C0027C1093D1FEB630 --algorithm SHA256 --configfile nuget.config
```

Se a entrada de autor `Microsoft` já existir, isso adiciona a impressão digital a ela ("Successfully updated the trusted signer 'Microsoft'"). A configuração resultante deve listar as quatro:

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

## Etapas de verificação no CI

O `dotnet nuget verify` aceita `--certificate-fingerprint` mais de uma vez. Passe as quatro. Com uma única impressão digital, a verificação falha assim que encontra um pacote assinado com um certificado diferente. Por exemplo, verificar o Playwright 1.63.0 apenas contra a nova impressão digital imprime:

```text
error: NU3034: The package signature did not match any of the allowed certificate fingerprints.
```

Organizações que espelham o nuget.org em um feed interno e verificam assinaturas na ingestão precisam da mesma mudança lá. A [referência do NU3034](https://learn.microsoft.com/en-us/nuget/reference/errors-and-warnings/nu3034) e o [guia de pacotes assinados](https://learn.microsoft.com/en-us/nuget/consume-packages/installing-signed-packages) cobrem o restante do modelo de `trustedSigners`. Adicionar a nova impressão digital agora, antes que o seu restore encontre um pacote que a use, é muito mais fácil do que depurar um build vermelho no meio de outubro.
