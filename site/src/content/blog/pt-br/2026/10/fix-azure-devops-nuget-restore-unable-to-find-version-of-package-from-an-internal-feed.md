---
title: "Correção: o restore do NuGet no Azure DevOps falha com \"Unable to find version 'x.y.z' of package\" em um feed interno"
description: "A versão existe, mas o pipeline não consegue enxergá-la. Verifique a função da identidade de build no feed, a view do feed na URL, qual nuget.config a tarefa usa, o package source mapping e o cache HTTP de 30 minutos."
pubDate: 2026-10-29
template: error-page
tags:
  - "errors"
  - "nuget"
  - "azure-devops"
  - "dotnet"
  - "dotnet-10"
  - "ci-cd"
lang: "pt-br"
translationOf: "2026/10/fix-azure-devops-nuget-restore-unable-to-find-version-of-package-from-an-internal-feed"
translatedBy: "claude"
translationDate: 2026-10-29
---

A correção: quando um feed do Azure Artifacts tem o pacote mas o restore do pipeline diz que não encontra a versão, quase nunca o build está consultando o feed que você imagina, ou está consultando com uma identidade que não enxerga essa versão. Verifique nesta ordem: a identidade de build do pipeline tem a função **Feed and Upstream Reader (Collaborator)** no feed? (O simples **Feed Reader** não consegue puxar uma versão de uma fonte upstream como o NuGet.org que ainda não foi salva no feed.) A URL do feed aponta para uma view como `@Release` para a qual a versão nunca foi promovida? A tarefa de restore está usando o `nuget.config` do seu repositório ou um gerado automaticamente? O `packageSourceMapping` direciona o ID do pacote para outra fonte? Por fim, um agente self-hosted está servindo uma lista de versões desatualizada do cache HTTP de 30 minutos do NuGet?

Tudo abaixo foi verificado com o SDK do .NET 10 (10.0.302, NuGet 7.6.0) e as tarefas atuais do Azure DevOps Services (`NuGetAuthenticate@1`, `DotNetCoreCLI@2`, `NuGetCommand@2`) em outubro de 2026. As mesmas causas se aplicam ao .NET 8, ao 9 e às versões prévias do .NET 11, porque o erro vem do resolvedor do NuGet e do modelo de permissões do feed, não da versão do SDK.

O erro aparece em dois formatos, dependendo de qual cliente executa o restore. O `nuget.exe restore` em um projeto `packages.config` imprime a mensagem mais antiga:

```text
// nuget.exe 6.x/7.x, packages.config restore
Unable to find version '1.5.0' of package 'Contoso.Core'.
  https://pkgs.dev.azure.com/contoso/_packaging/contoso-internal/nuget/v3/index.json: Package 'Contoso.Core.1.5.0' is not found on source 'https://pkgs.dev.azure.com/contoso/_packaging/contoso-internal/nuget/v3/index.json'.
```

`dotnet restore`, `msbuild -t:restore` e o `nuget.exe` em projetos PackageReference imprimem `NU1102`, e essa versão é muito mais útil, porque diz o que cada fonte realmente retornou:

```text
// dotnet restore, .NET SDK 10.0.302
error NU1102: Unable to find package Contoso.Core with version (>= 1.5.0)
error NU1102:   - Found 1 version(s) in contoso-internal [ Nearest version: 1.4.0 ]
```

Leia essa segunda linha com atenção. "Found 1 version(s)" significa que a autenticação funcionou e o ID do pacote foi encontrado. O feed simplesmente não retornou a `1.5.0` para este chamador. Isso reduz o problema a "quais versões esta identidade, por esta URL, consegue ver", que é exatamente o que as causas abaixo controlam.

## Por que a versão existe no navegador mas não no pipeline

Quando você abre o feed na interface web do Azure DevOps, está olhando como você mesmo (muitas vezes um Feed Owner), pela view padrão `@Local`, com todas as fontes upstream habilitadas. O pipeline enxerga o feed como outro principal, possivelmente por outra URL, usando um `nuget.config` que você talvez não tenha escrito. Cada um destes pontos pode esconder uma versão:

1. **Versões de upstream exigem uma função que possa salvá-las.** O Azure Artifacts serve um pacote de um upstream (NuGet.org, outro feed) salvando uma cópia no seu feed na primeira requisição. Segundo a [tabela de permissões de feed](https://learn.microsoft.com/en-us/azure/devops/artifacts/feeds/feed-permissions), "Save packages from upstream sources" exige **Feed and Upstream Reader (Collaborator)** ou superior. Uma identidade de build que tem apenas **Feed Reader** consegue restaurar versões que já estão salvas, mas não as novas. Seu notebook restaurou a `1.5.0` sem problemas na semana passada porque você é Collaborator e o seu restore a salvou; a próxima versão que ninguém restaurou ainda falha no CI.
2. **A identidade de build errada.** Um pipeline roda como `Project Collection Build Service (<org>)` ou como `<Project> Build Service (<org>)`. Qual deles depende da configuração "Limit job authorization scope to current project". Conceder a função ao outro não adianta nada.
3. **Uma URL de view.** `.../_packaging/contoso-internal@Release/nuget/v3/index.json` expõe apenas as versões promovidas para `@Release`. Uma `1.5.0` recém-publicada fica em `@Local` até que alguém a promova.
4. **A tarefa ignorou o seu `nuget.config`.** `DotNetCoreCLI@2` e `NuGetCommand@2` com `feedsToUse: 'select'` geram uma configuração temporária contendo apenas o feed escolhido em `vstsFeed` (mais o NuGet.org se `includeNuGetOrg` for true).
5. **O package source mapping** envia `Contoso.*` para uma fonte, e a versão de que você precisa está em outra. O NuGet então informa que as versões da outra fonte "were not considered".
6. **Cache HTTP desatualizado.** Em um agente self-hosted, o NuGet reutiliza a lista de versões em cache de um pacote por até 30 minutos, então uma versão publicada há cinco minutos fica invisível para a próxima execução.
7. **Atraso do upstream ou versão externa bloqueada.** Pacotes do NuGet.org podem levar de 3 a 6 horas para aparecer por um upstream, e um ID de pacote que você também publica internamente pode ter versões externas bloqueadas.

## Repro mínimo: o mesmo NU1102 a partir de um feed de pasta local

Você não precisa do Azure DevOps para ver o que o NuGet faz quando uma fonte retorna menos versões do que você pediu. Este repro simula as causas 1 e 3 localmente, com uma fonte que só "mostra" a `1.4.0` para o chamador.

```bash
# .NET SDK 10.0.302, macOS/Linux shell
mkdir -p feed lib app
cd lib && dotnet new classlib -n Contoso.Core -o . -f net10.0
dotnet pack -c Release -p:Version=1.4.0 -o ../feed
cd ../app && dotnet new console -f net10.0
dotnet add package Contoso.Core --version 1.5.0 --no-restore
```

```xml
<!-- app/nuget.config, NuGet 7.6 -->
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="contoso-internal" value="../feed" />
  </packageSources>
</configuration>
```

```text
// dotnet restore output, .NET SDK 10.0.302
error NU1102: Unable to find package Contoso.Core with version (>= 1.5.0)
error NU1102:   - Found 1 version(s) in contoso-internal [ Nearest version: 1.4.0 ]
```

Esse é exatamente o formato que você recebe do Azure Artifacts quando a identidade de build não consegue salvar a `1.5.0` de um upstream, ou quando a URL aponta para uma view que só tem a `1.4.0`. O restore não está quebrado. Ele está relatando fielmente o que a fonte lhe entregou.

## Correção 1: dê a função Collaborator à identidade de build certa

Esta é a causa por trás da maioria dos relatos de "funciona na minha máquina", porque os desenvolvedores costumam ser Collaborators ou superior, e a identidade de build em feeds mais antigos muitas vezes é apenas Reader.

1. Descubra com qual identidade o pipeline roda. Em **Project settings > Pipelines > Settings**, verifique **Limit job authorization scope to current project for non-release pipelines**. Se estiver ativada, a identidade é `<Project> Build Service (<org>)`. Se estiver desativada, é `Project Collection Build Service (<org>)`. Os pipelines de release têm seu próprio seletor na mesma página.
2. Abra **Artifacts**, escolha o feed, selecione o ícone de engrenagem de **Feed settings** e depois **Permissions**.
3. Adicione essa identidade (procure por "Build Service") com a função **Feed and Upstream Reader (Collaborator)**. Se o pipeline também publica pacotes, dê **Feed Publisher (Contributor)** às duas identidades de build, como a documentação recomenda.
4. Se o feed está em um projeto diferente do pipeline e você usa a identidade com escopo de projeto, esse outro projeto também precisa conceder à identidade pelo menos **Edit project-level information**, conforme a nota no fim de [Manage permissions](https://learn.microsoft.com/en-us/azure/devops/artifacts/feeds/feed-permissions#pipelines-permissions).

No Azure DevOps Services, os novos feeds já concedem a função Collaborator às duas identidades de build. Os feeds que quebram são os criados antes desse padrão, os criados no Azure DevOps Server 2022 (onde apenas a identidade da collection a recebe) e aqueles cujas permissões alguém "restringiu".

Depois, certifique-se de que o pipeline se autentica de fato. Com a CLI do .NET, `NuGetAuthenticate@1` é a forma suportada, e nas imagens hospedadas Ubuntu 24.04 e posteriores ele é obrigatório, porque o `nuget.exe` não é mais suportado lá:

```yaml
# Azure Pipelines YAML, .NET SDK 10.0.302, NuGetAuthenticate@1
steps:
- task: UseDotNet@2
  inputs:
    packageType: sdk
    version: '10.0.x'

- task: NuGetAuthenticate@1

- script: dotnet restore MySolution.sln --configfile nuget.config
  displayName: Restore
```

`NuGetAuthenticate@1` instala o credential provider do Azure Artifacts e entrega a ele o token de acesso do job para todo feed do Azure Artifacts na mesma organização. Para um feed em outra organização, crie um PAT com **Packaging > Read**, envolva-o em uma service connection do NuGet e passe-o via `nuGetServiceConnections`, como mostrado em [Restore NuGet packages with Azure Pipelines](https://learn.microsoft.com/en-us/azure/devops/pipelines/packages/nuget-restore).

## Correção 2: aponte para a view que realmente contém a versão

Olhe a URL do feed no seu `nuget.config`. Tudo depois de um `@` no segmento do feed é uma view:

```xml
<!-- nuget.config, NuGet 7.6: the @Release view only sees promoted versions -->
<add key="contoso-internal"
     value="https://pkgs.dev.azure.com/contoso/_packaging/contoso-internal@Release/nuget/v3/index.json" />
```

Todo feed começa com `@Local`, `@Prerelease` e `@Release`. `@Local` contém tudo o que foi publicado no feed mais tudo o que foi salvo dos upstreams. `@Prerelease` e `@Release` contêm apenas o que um Feed Publisher promoveu explicitamente. Promova a versão (abra o pacote, escolha **Promote**, selecione a view) ou faça o pipeline produtor promovê-la como último passo. Se o build consumidor deve enxergar versões não promovidas, remova o sufixo `@Release` para que ele use a view padrão do feed.

O mesmo vale quando a versão de que você precisa vem por um upstream feed-para-feed. A definição do upstream nomeia uma view do outro feed, então uma versão que não foi promovida lá também fica invisível pelo seu feed.

## Correção 3: impeça a tarefa de substituir o seu nuget.config

Este YAML parece inofensivo, mas descarta o `nuget.config` do seu repositório:

```yaml
# Azure Pipelines YAML, DotNetCoreCLI@2: generates a temporary nuget.config
- task: DotNetCoreCLI@2
  inputs:
    command: restore
    projects: '**/*.csproj'
    feedsToUse: select
    vstsFeed: 'contoso-internal'
    includeNuGetOrg: false
```

Com `feedsToUse: select`, a tarefa escreve uma configuração temporária apenas com `vstsFeed` (e o NuGet.org se `includeNuGetOrg: true`). Se o seu `nuget.config` lista dois feeds, usa uma URL de feed com escopo de projeto com o segmento do projeto, ou contém `packageSourceMapping`, nada disso se aplica a este restore. Diga à tarefa para usar o seu arquivo:

```yaml
# Azure Pipelines YAML, DotNetCoreCLI@2 with the repo's nuget.config
- task: DotNetCoreCLI@2
  inputs:
    command: restore
    projects: '**/*.csproj'
    feedsToUse: config
    nugetConfigPath: 'nuget.config'
```

Ou dispense a tarefa de restore por completo e execute `dotnet restore --configfile nuget.config` depois de `NuGetAuthenticate@1`, como na Correção 1. Isso tem a vantagem de que o que o CI executa é exatamente o que um desenvolvedor executa localmente.

Já que você está nesse arquivo, siga o conselho da própria Microsoft para feeds com upstream: comece `<packageSources>` com `<clear />` e liste exatamente um feed do Azure Artifacts com upstreams habilitados. O NuGet consulta todas as fontes em paralelo e fica com a primeira resposta, então duas fontes tornam os restores não determinísticos. Um único feed com upstreams pesquisa em ordem fixa: pacotes publicados no feed, depois pacotes salvos dos upstreams, depois cada upstream na ordem configurada.

## Correção 4: verifique o package source mapping

Se o repositório usa [package source mapping](https://learn.microsoft.com/en-us/nuget/consume-packages/package-source-mapping), o erro diz isso diretamente:

```text
// dotnet restore output, .NET SDK 10.0.302, with packageSourceMapping
error NU1102: Unable to find package Contoso.Core with version (>= 1.5.0)
error NU1102:   - Found 1 version(s) in contoso-internal [ Nearest version: 1.4.0 ]
error NU1102:   - Versions from contoso-release were not considered
```

"Were not considered" significa que a versão pode muito bem estar em `contoso-release`, mas nenhum padrão de mapeamento direciona `Contoso.Core` para lá. Cada ID de pacote é resolvido apenas contra as fontes cujos padrões o correspondem, e o padrão mais específico vence. Corrija o mapeamento:

```xml
<!-- nuget.config, NuGet 7.6 -->
<packageSourceMapping>
  <packageSource key="contoso-internal">
    <package pattern="Contoso.*" />
    <package pattern="*" />
  </packageSource>
</packageSourceMapping>
```

Com um único feed com upstreams habilitados, o mapeamento correto mais simples é `*` para esse feed. O mapeamento só faz sentido quando você realmente mantém duas fontes, e então todo prefixo interno precisa ser listado.

## Correção 5: contorne o cache HTTP em agentes self-hosted

Agentes hospedados começam com o cache vazio, então este problema só atinge agentes self-hosted e máquinas de desenvolvedores. O [cache HTTP](https://learn.microsoft.com/en-us/nuget/consume-packages/managing-the-global-packages-and-cache-folders#http-cache) do NuGet armazena a lista de versões que cada fonte retornou, e entradas com menos de 30 minutos são reutilizadas. Publique a `1.5.0`, dispare o build consumidor três minutos depois no mesmo agente, e o restore ainda vê a lista em cache que termina na `1.4.0`.

```bash
# .NET SDK 10.0.302
dotnet restore --no-http-cache
# or, for packages.config projects with nuget.exe
nuget restore MySolution.sln -NoHttpCache
# or clear it once
dotnet nuget locals http-cache --clear
```

`--no-http-cache` é barato o bastante para deixar ligado no CI no passo que restaura pacotes internos recém-publicados. Não recorra a `dotnet nuget locals all --clear` em um agente compartilhado; apagar `global-packages` força todos os outros pipelines daquela máquina a baixar tudo de novo.

## Correção 6: espere a latência do upstream passar, ou permita versões externas

Dois comportamentos do lado do feed produzem o mesmo sintoma de "nearest version" para pacotes originados no NuGet.org:

- **Atraso de propagação.** A [documentação de fontes upstream](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/upstream-sources) afirma que normalmente há um atraso de 3 a 6 horas entre um push no NuGet.org e a versão ficar disponível por um upstream. Entre feeds do Azure Artifacts costumam ser alguns minutos. Se uma dependência lançada hoje de manhã falha e a versão da semana passada é restaurada, espere, ou fixe a versão anterior por algumas horas.
- **Versões externas bloqueadas.** Se você publica internamente um ID de pacote que também existe publicamente, o Azure Artifacts pode bloquear o salvamento de novas versões públicas desse ID para proteger contra dependency confusion. Um Feed Owner pode permiti-las por pacote com **Allow externally-sourced versions** na página do pacote, ou com a chamada REST `versionsFromExternalUpstreams: AllowExternalVersions` descrita em [Safeguard against malicious public packages](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/upstream-behavior). Reserve até 3 horas para a propagação dessa mudança.

Verifique também **Feed settings > Upstream sources** em busca de um status de sincronização com falha. Um upstream quebrado interrompe a atualização de metadados de todos os pacotes daquele protocolo, então as novas versões deixam de aparecer mesmo a partir de upstreams saudáveis.

## Armadilhas que parecem este erro mas não são

**`NU1101: Unable to find package Contoso.Core. No packages exist with this id in source(s)`.** Essa é uma situação diferente: o ID não foi encontrado de forma alguma. Em geral a fonte está errada, o feed tem escopo de projeto e falta o segmento do projeto na URL (`https://pkgs.dev.azure.com/<org>/<project>/_packaging/<feed>/nuget/v3/index.json`), ou o package source mapping exclui todas as fontes para esse ID.

**`NU1301: Unable to load the service index for source` ou um `401 Unauthorized`.** A autenticação falhou antes de a resolução de versões começar. Adicione `NuGetAuthenticate@1` e verifique se nada no `nuget.config` do repositório fixa `<packageSourceCredentials>` com um PAT expirado, pois elas sobrepõem o credential provider.

**`403 Forbidden ... lacks permission to complete this action`.** A identidade chegou ao feed, mas não tem nenhuma função nele. A correção é a mesma da Correção 1, além de verificar o escopo de autorização do job.

**Uma versão que restaura em um pipeline e não em outro.** Pipelines diferentes podem rodar como identidades diferentes: os pipelines de release clássicos têm seu próprio seletor de escopo, e pipelines YAML disparados a partir de outro projeto rodam como o build service daquele projeto.

**Versões com central package management.** Com `Directory.Packages.props`, a versão no erro vem do arquivo central, não do `.csproj`, então "corrigir" o arquivo do projeto não adianta nada. Se você está no meio de uma migração, o passo a passo sobre [mover uma solution para central package management](/pt-br/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/) cobre de onde cada versão é resolvida.

**Um pacote que desaparece após atualizar o SDK.** Se um pacote transitivo sumiu em vez de falhar na resolução, ele pode ter sido removido pelo [NuGet package pruning no .NET 10](/pt-br/2026/05/nuget-package-pruning-default-net-10/), que é um comportamento esperado e não um problema do feed.

**Problemas do lado da publicação.** Se a versão realmente não está no feed, o push do produtor falhou ou foi rejeitado. Versionar com MinVer e a configuração de trusted publishing em [lançar vários pacotes NuGet de forma independente](/2026/05/independently-release-multiple-nuget-packages-with-minver-and-trusted-publishing/) facilita ver qual versão cada tag produziu. Para os controles de segurança do lado do NuGet.org que também bloqueiam pushes, veja [o que proteger na sua conta do NuGet](/pt-br/2026/01/nuget-become-owner-request-spam-what-to-do-and-what-to-lock-down-in-net-9-net-10/).

## Um checklist que encontra a causa em cinco minutos

1. Leia a saída completa do `NU1102`. "Found N version(s)" significa que a autenticação funciona e o problema é de visibilidade. "Were not considered" significa package source mapping.
2. Copie a URL do feed do log de restore, não do seu `nuget.config` local. Se a tarefa gerou uma configuração temporária, o log mostra o caminho dela; mude para `feedsToUse: config`.
3. Procure um `@` nessa URL. Se houver uma view, verifique se a versão foi promovida para ela.
4. Procure a versão na página de pacotes do feed. Se ela não está lá mas existe no NuGet.org ou em um feed upstream, ela nunca foi salva: dê a função Collaborator à identidade de build, ou restaure-a uma vez como Collaborator para salvá-la.
5. Confirme qual identidade de build executa o job pela configuração de escopo de autorização do job e verifique exatamente essa identidade na página Permissions do feed.
6. Em um agente self-hosted, execute de novo com `--no-http-cache`.
7. Para um pacote lançado hoje no NuGet.org, verifique o status do upstream e a configuração de versões externas do pacote, e então espere.

Nove entre dez vezes a resposta está no passo 4 ou 5. O feed não está mentindo e o NuGet não está quebrado; o pipeline é apenas um leitor diferente de você.

## Fontes

- [Manage permissions - Azure Artifacts](https://learn.microsoft.com/en-us/azure/devops/artifacts/feeds/feed-permissions) (funções do feed, nomes das identidades de build, nota sobre projetos cruzados)
- [What are upstream sources?](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/upstream-sources) (ordem de busca, recomendação de feed único, atraso de 3 a 6 horas)
- [Safeguard against malicious public packages](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/upstream-behavior) (Allow external versions)
- [Restore NuGet packages with Azure Pipelines](https://learn.microsoft.com/en-us/azure/devops/pipelines/packages/nuget-restore) (`NuGetAuthenticate@1`, nota sobre Ubuntu 24.04, feeds entre organizações)
- [Feed views](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/views)
- [NuGet Error NU1102](https://learn.microsoft.com/en-us/nuget/reference/errors-and-warnings/nu1102)
- [Package Source Mapping](https://learn.microsoft.com/en-us/nuget/consume-packages/package-source-mapping)
- [Managing the global packages, cache, and temp folders](https://learn.microsoft.com/en-us/nuget/consume-packages/managing-the-global-packages-and-cache-folders) (cache HTTP de 30 minutos)
- [NuGet.Client Strings.resx](https://github.com/NuGet/NuGet.Client/blob/dev/src/NuGet.Core/NuGet.PackageManagement/Strings.resx) (mensagens `UnknownPackageSpecificVersion` e `PackageNotFoundOnSource`)
