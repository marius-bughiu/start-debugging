---
title: "As API keys do NuGet ganham limite de 30 dias em 17 de agosto, e toda key antiga expira em 1 de novembro"
description: "O NuGet.org remove a opção de API key de 365 dias em 2026-08-17, limita as novas a 30 dias e expira em 1 de novembro toda key criada antes dessa data. Veja o que quebra e como migrar seu fluxo de publicação para trusted publishing com OIDC."
pubDate: 2026-08-04
tags:
  - "dotnet"
  - "nuget"
  - "ci-cd"
  - "security"
  - "github-actions"
lang: "pt-br"
translationOf: "2026/08/nuget-api-keys-capped-at-30-days-from-august-17"
translatedBy: "claude"
translationDate: 2026-08-04
---

O time do .NET publicou [Strengthening NuGet Supply Chain Security: Reducing API Key Lifetime](https://devblogs.microsoft.com/dotnet/strengthening-nuget-supply-chain-security-reducing-api-key-lifetime/) em 2026-08-03, e o texto traz duas datas rígidas que vão quebrar pipelines de publicação se você ignorá-las.

## As duas datas

**2026-08-17**: novas API keys ficam limitadas a uma duração máxima de 30 dias. A opção de 365 dias some da interface de criação de keys no nuget.org.

**2026-11-01**: toda API key criada antes de 17 de agosto expira. Não só as de um ano. Se o seu secret `NUGET_API_KEY` foi gerado em junho, ele para de funcionar em 1 de novembro, independentemente da data de expiração exibida ao lado dele.

Essa segunda data é a que dói. Um fluxo de publicação disparado por tag que não roda desde outubro vai falhar no primeiro push depois de 1 de novembro com um 401, e a falha aparece em um job que ninguém acompanha até precisar realmente publicar.

## Por que uma key de 30 dias ainda tem o formato errado

Uma key de 30 dias é melhor que uma de 365, mas continua sendo um secret de vida longa guardado em um cofre de secrets do repositório, e agora você passa a rotacioná-lo doze vezes por ano em vez de uma. Automatizar a rotação é trabalho real: gerar a key no nuget.org com o escopo de pacote certo, enviá-la para o GitHub ou o Azure DevOps, conferir que a anterior foi revogada.

A alternativa para a qual a Microsoft está direcionando todo mundo é o [trusted publishing](https://learn.microsoft.com/en-us/nuget/nuget-org/trusted-publishing), que usa OIDC no lugar. Seu sistema de CI emite um token assinado de curta duração, o nuget.org valida contra uma política que você registrou e devolve uma API key temporária válida por **uma hora**. Um token compra exatamente uma key. Nada duradouro fica armazenado em lugar nenhum.

O formato no GitHub Actions é pequeno:

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

A configuração inicial é uma política no nuget.org em Account, Trusted Publishing: proprietário do repositório, repositório, nome do arquivo de workflow (`release.yml`, sem o prefixo `.github/workflows/`) e, opcionalmente, o nome do environment. O GitLab também funciona, trocando um claim de `id_tokens` contra `POST https://www.nuget.org/api/v2/token`.

Uma pegadinha que vale saber antes de novembro: uma política criada contra um repositório privado do GitHub começa **temporariamente ativa por 7 dias**. Se nenhuma publicação acontecer nessa janela, ela fica inativa, porque o nuget.org precisa dos IDs de repositório e proprietário vindos de uma troca de token real para fixar a política contra ataques de ressurreição. Registre a política e faça um push descartável; não registre e vá embora.

Se você já mantém uma publicação de múltiplos pacotes, a fiação está coberta em [Independently Releasing Multiple NuGet Packages with MinVer + Trusted Publishing](/2026/05/independently-release-multiple-nuget-packages-with-minver-and-trusted-publishing/). Caso contrário, o mínimo viável nesta semana é auditar quais dos seus pipelines ainda publicam com uma key estática e confirmar que a conta do nuget.org que recebe os avisos de expiração é uma que alguém realmente lê.
