---
title: "Correção: o WebSocket do hot reload do Blazor no dotnet watch falha em um domínio local personalizado (403)"
description: "Desde os SDKs .NET de setembro de 2026 (10.0.112, 10.0.401, 11 RC1), o dotnet watch rejeita WebSockets de browser-refresh vindos de origens desconhecidas. Defina DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS com o nome do seu host."
pubDate: 2026-09-29
template: error-page
tags:
  - "errors"
  - "blazor"
  - "dotnet-watch"
  - "hot-reload"
  - "dotnet-10"
  - "dotnet-11"
lang: "pt-br"
translationOf: "2026/09/fix-dotnet-watch-blazor-hot-reload-websocket-fails-on-custom-local-domain"
translatedBy: "claude"
translationDate: 2026-09-29
---

Defina `DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS` com o nome do seu host personalizado (apenas o host, como `myapp.localhost`, sem esquema e sem porta) no shell que inicia o `dotnet watch` e reinicie-o. Os SDKs de 8 de setembro de 2026 (10.0.112, 10.0.401, 9.0.121, 9.0.318, 8.0.131, 8.0.425 e 11.0.100-rc.1) corrigiram o CVE-2026-58649. Desde então, o WebSocket de browser-refresh só aceita um `Origin` igual a `localhost`, `127.0.0.1`, `[::1]` ou a um host que você liste nessa variável. Qualquer outro recebe um 403. Medi tudo abaixo no macOS com o SDK 10.0.302 (antes da correção) e o 10.0.401 (depois), usando o template padrão `dotnet new blazor`.

## O erro em contexto

Você abre o app em um nome como `http://myapp.localhost:5080`, `https://shop.test` ou um alias no arquivo hosts, em vez de `localhost` puro. A página renderiza e o circuito do próprio Blazor conecta, mas o console do navegador mostra isto:

```
Failed to load resource: the server responded with a status of 403 (Forbidden)
WebSocket connection to 'ws://localhost:5599/' failed:
WebSocket failed to connect.
WebSocket connection to 'wss://localhost:63038/' failed:
WebSocket failed to connect.
Unable to establish a connection to the browser refresh server.
```

As três últimas linhas são saída de `console.debug` do `aspnetcore-browser-refresh.js`, então você só as vê com o nível "Verbose" ativado nas DevTools do Chrome ou do Edge. Os números de porta são aleatórios, a menos que você os fixe. Enquanto isso, o terminal do `dotnet watch` parece completamente saudável:

```
dotnet watch ⌚ Files updated: ./Components/Pages/Home.razor
dotnet watch 🔥 C# and Razor changes applied in 109ms.
```

O terminal diz que a alteração foi aplicada e o navegador discorda. Essa incoerência é o que torna o problema tão confuso. Muitas pessoas que esbarram nele também não mudaram nada no projeto: o SDK foi atualizado por baixo dos panos pelo Visual Studio, pelo Homebrew ou por um `global.json` com `rollForward: latestPatch`. O relato em [dotnet/sdk#56291](https://github.com/dotnet/sdk/issues/56291) diz exatamente isso: o hot reload quebrou em `bug.dev.localhost` com o SDK 10.0.401, e fixar o 10.0.400 fez voltar a funcionar.

## Por que o socket de browser-refresh agora retorna 403

Sob o `dotnet watch`, os apps web recebem um pequeno script injetado, `_framework/aspnetcore-browser-refresh.js`. Esse script abre um WebSocket de volta para um servidor hospedado dentro do processo do `dotnet watch`. O servidor escuta em `127.0.0.1` em uma porta aleatória, mais uma porta WSS quando o certificado de desenvolvimento está disponível. O socket transporta recarregamentos de página, atualizações de CSS, deltas do Blazor WebAssembly e diagnósticos. A URL injetada sempre aponta para `localhost`, seja qual for o nome de host a partir do qual a própria página foi carregada:

```js
// injected by dotnet watch, SDK 10.0.401
const webSocketUrls = 'ws://localhost:5599,wss://localhost:63038'.split(',');
```

Assim, uma página em `http://myapp.localhost:5080` faz uma requisição WebSocket cross-origin para `ws://localhost:5599`, e o navegador envia `Origin: http://myapp.localhost:5080` junto. Antes de setembro de 2026, o servidor de refresh ignorava o cabeçalho `Origin` por completo. Qualquer página aberta no seu navegador, em qualquer site, podia se conectar a ele, e o socket transporta payloads de atualização de IL e PDB. Esse é o [CVE-2026-58649](https://github.com/dotnet/sdk/issues/56166), classificado como CWE-346 (Origin Validation Error), CVSS 6.5.

A correção ([dotnet/sdk#56198](https://github.com/dotnet/sdk/pull/56198) em `release/11.0.1xx`, portada para `main` como [#56246](https://github.com/dotnet/sdk/pull/56246)) adiciona esta verificação antes de o WebSocket ser aceito:

```csharp
// src/Dotnet.Watch/HotReloadClient/Web/BrowserRefreshServer.cs (SDK fix for CVE-2026-58649)
if (!Uri.TryCreate(context.Request.Headers.Origin.FirstOrDefault(), UriKind.Absolute, out var originUri) ||
    !webSocketConfig.GetAllowedOriginDomains().Contains(originUri.Host, StringComparer.OrdinalIgnoreCase))
{
    context.Response.StatusCode = StatusCodes.Status403Forbidden;
    return;
}
```

`GetAllowedOriginDomains()` retorna `localhost`, `127.0.0.1`, `[::1]`, cada entrada de `DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS` e o valor de `DOTNET_WATCH_AUTO_RELOAD_WS_HOSTNAME`, se estiver definido. A comparação é uma correspondência exata, sem diferenciar maiúsculas de minúsculas, contra `Uri.Host`. Não há curingas, nem correspondência por sufixo, nem tratamento especial para `*.localhost`. Uma requisição sem nenhum cabeçalho `Origin` também é rejeitada.

## Repro mínimo

```bash
# .NET SDK 10.0.401, macOS 26 (any OS behaves the same)
dotnet new blazor -o BlazorRepro
cd BlazorRepro
DOTNET_WATCH_AUTO_RELOAD_WS_PORT=5599 dotnet watch run --urls http://localhost:5080
```

Fixar a porta com `DOTNET_WATCH_AUTO_RELOAD_WS_PORT` só facilita sondar o socket. Navegadores Chromium resolvem qualquer nome `*.localhost` para o loopback sem uma entrada no arquivo hosts, então acesse `http://myapp.localhost:5080/` e você obtém a saída de console acima. Você nem precisa de um navegador. Um handshake WebSocket cru com `curl` mostra a decisão diretamente:

```bash
# .NET SDK 10.0.401, while dotnet watch is running
curl -s -o /dev/null -w '%{http_code}\n' --http1.1 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  -H 'Origin: http://myapp.test:5000' \
  http://127.0.0.1:5599/
```

Executei esse handshake nos dois SDKs, com valores diferentes da nova variável:

| Cabeçalho `Origin` | 10.0.302 | 10.0.401 | 10.0.401 + `ORIGINS=myapp.test;bug.dev.localhost` |
|---|---|---|---|
| `http://localhost:5000` | 101 | 101 | 101 |
| `http://myapp.test:5000` | 101 | 403 | 101 |
| `https://myapp.test` | 101 | 403 | 101 |
| `http://bug.dev.localhost:5000` | 101 | 403 | 101 |
| `https://evil.example` | 101 | 403 | 403 |
| (sem `Origin`) | 101 | 403 | 403 |

No 10.0.302, o 101 (Switching Protocols) para `https://evil.example` é a própria vulnerabilidade. No 10.0.401, todo nome personalizado é recusado até você listá-lo.

## A correção: permita o nome do seu host

O `dotnet watch` lê a variável do **seu próprio** ambiente de processo quando inicia. Defina-a no shell, no task runner ou no contêiner que inicia o `dotnet watch` e reinicie o watcher. Um watcher em execução não a captura.

```bash
# bash / zsh, .NET SDK 10.0.401+
export DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS="myapp.localhost"
dotnet watch run --urls http://localhost:5080
```

```powershell
# PowerShell, .NET SDK 10.0.401+
$env:DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS = "myapp.localhost"
dotnet watch run
```

Para mais de um nome, separe-os com `;` ou `,`. Espaços em branco ao redor de cada entrada são removidos:

```bash
# .NET SDK 10.0.401+
export DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS="shop.test;admin.shop.test,api.shop.test"
```

Se você inicia o watcher pelo VS Code, coloque a variável na task, não no `launch.json`. O `env` de uma configuração de launch `coreclr` vai para o app, e o app não é o processo que faz a verificação:

```json
// .vscode/tasks.json, .NET SDK 10.0.401+
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "watch",
      "type": "process",
      "command": "dotnet",
      "args": ["watch", "run", "--project", "BlazorRepro/BlazorRepro.csproj"],
      "options": { "env": { "DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS": "myapp.localhost" } },
      "isBackground": true
    }
  ]
}
```

Com `DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS=myapp.localhost` definido, a mesma página em `http://myapp.localhost:5080` conectou, e as edições chegaram ao navegador sem um refresh manual. Uma alteração de texto no `Home.razor` de SSR estático e uma mudança de cor em `wwwroot/app.css` apareceram na aba aberta.

## O que realmente quebra, e por que algumas edições ainda parecem funcionar

O sintoma depende de onde o componente renderiza, o que faz o bug parecer intermitente. No 10.0.401 sem a variável, com a página aberta em `myapp.localhost`:

- **Componentes Interactive Server** (o `Counter.razor` do template com `@rendermode InteractiveServer`): as edições de Razor e C# **ainda apareciam**. O delta é aplicado dentro do processo do servidor, e o Blazor re-renderiza pelo seu próprio circuito SignalR (`ws://myapp.localhost:5080/_blazor`), que é de mesma origem e nunca toca o servidor de refresh.
- **Páginas de SSR estático** (o `Home.razor` do template): as edições de Razor **não apareciam**. O `dotnet watch` imprimiu "C# and Razor changes applied", mas só um refresh do navegador enviado pelo socket de refresh mostraria o novo HTML.
- **CSS em `wwwroot`**: as alterações **não apareciam** em nenhuma página, mesmo com o terminal imprimindo "Static asset changes applied". As atualizações de CSS são entregues pelo socket de refresh.
- **Blazor WebAssembly** (standalone ou o projeto `.Client`): os próprios deltas trafegam pelo socket de refresh, então o hot reload de C# e Razor para componentes WebAssembly também para (não medi esse caso, mas o caminho de entrega é o mesmo socket).

Portanto, "o hot reload funciona na página do contador mas não na página inicial" é esse mesmo bug, não dois diferentes. Se você não tem certeza em qual categoria um componente se encaixa, veja [como o Blazor decide qual modo de renderização executa um componente](/pt-br/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/).

## Pegadinhas e casos parecidos

**O valor é um nome de host, não uma origem.** A verificação compara `Uri.Host`, então `http://myapp.test` e `myapp.test:5000` nunca correspondem a nada. Nas minhas execuções, `DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS="myapp.test:5000,*.localhost"` e `"http://myapp.test"` continuaram retornando 403 para toda origem personalizada. Liste cada subdomínio explicitamente.

**O `launchSettings.json` não funciona.** O `environmentVariables` de um perfil é passado ao processo do app. O `dotnet watch` já construiu sua lista de permissões até lá. Adicionei a variável nos dois perfis do `launchSettings.json` do template e ainda recebi 403 para `myapp.test`. A mesma correção também mudou a forma como as variáveis do perfil de launch chegam ao app: agora elas vão por RPC para o agente de hot reload, em vez de argumentos `-e` ([CVE-2026-69806](https://github.com/dotnet/sdk/issues/56167), mesmo PR). Nada disso afeta as configurações do próprio watcher, porém. Se você quer isso atrelado ao repositório, um script no estilo `.env` ou a definição de task acima é o lugar certo.

**`DOTNET_WATCH_AUTO_RELOAD_WS_HOSTNAME` é outro botão.** O host dela também é adicionado à lista de permissões (com `HOSTNAME=myapp.test`, as origens `myapp.test` retornaram 101 no meu teste), mas ela faz mais do que isso. Ela muda o host ao qual o servidor de refresh se vincula e a URL à qual o script injetado se conecta. O Kestrel trata um nome de host que não é IP como "escutar em todas as interfaces", então o socket passa a ser acessível a partir da sua rede. Use `HOSTNAME` apenas quando o navegador realmente não consegue alcançar `localhost`, por exemplo quando o `dotnet watch` roda dentro de um contêiner ou em uma máquina de desenvolvimento remota. Quando apenas o nome da página difere, use `ORIGINS`.

**Fixar o SDK antigo "corrige" trazendo a vulnerabilidade de volta.** Um `global.json` fixado em 10.0.400 ou 10.0.302 faz o 403 sumir, porque esses SDKs aceitam qualquer origem, inclusive `https://evil.example`. Trate isso como um passo de diagnóstico, não como uma correção.

**A tabela do advisory e as notas de versão discordam nos números de versão.** O advisory lista 10.0.111 e 10.0.400 como "corrigidos". Os [metadados de release](https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json) colocam o CVE-2026-58649 na release de 8 de setembro (runtime 10.0.12, SDKs 10.0.112 e 10.0.401). A medição e o autor do relato concordam com os metadados de release: o 10.0.400 aceita qualquer origem, e o 10.0.401 aplica a verificação. As tags públicas `v10.0.400` e `v10.0.401` apontam para o mesmo commit porque as correções de segurança são compiladas a partir do repositório interno, então não perca tempo comparando as tags.

**Um 403 na própria página é outra coisa.** Se o documento inteiro retorna 403, verifique o que de fato está escutando naquela porta. No macOS, a porta 5000 pertence ao AirPlay Receiver na Central de Controle, que responde 403 para qualquer caminho. Navegadores podem resolver `*.localhost` para `::1` antes de `127.0.0.1`, então um Kestrel vinculado apenas a `127.0.0.1:5000` perde essa conexão para o AirPlay. Esbarrei exatamente nisso ao montar o repro, e é por isso que os comandos acima usam `--urls http://localhost:5080`.

**Nenhum domínio personalizado envolvido e mesmo assim sem refresh?** Se você acessa `localhost` e o socket ainda falha, a causa está em outro lugar: uma página HTTPS tentando `wss://` sem um certificado de desenvolvimento confiável, `DOTNET_WATCH_SUPPRESS_BROWSER_REFRESH=1` esquecido no ambiente, ou um middleware que reescreve a resposta de modo que o script nunca seja injetado. [O que o dotnet watch adiciona ao dotnet run](/pt-br/2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run/) explica a injeção e as variáveis de ambiente que ele define.

**Isso deixa de existir no futuro.** No branch `main` do SDK, o [dotnet/sdk#56118](https://github.com/dotnet/sdk/pull/56118) (merge em 2026-09-21) roteia o WebSocket das browser-tools pela própria origem da aplicação e o encaminha para um provedor somente de loopback. Nesse desenho, a página e o socket compartilham uma origem, e um comentário no código diz que `DOTNET_WATCH_AUTO_RELOAD_WS_HOSTNAME` "no longer applies to this hop". Essa mudança não foi incluída em nenhum SDK até o momento em que escrevo, então no 10.0.401 e no 11 RC1 você ainda precisa da variável.

## Leituras relacionadas

Esta é a segunda vez que uma atualização do SDK quebra silenciosamente um app Blazor sem uma única mudança no projeto. A primeira foi [o 404 do blazor.server.js após instalar o SDK do .NET 10](/pt-br/2026/08/fix-404-not-found-for-blazor-server-js-after-installing-a-new-dotnet-sdk/). Para saber o que o `dotnet watch` ganhou recentemente além do socket do navegador, veja [dotnet watch no .NET 11 Preview 3 com hosts Aspire e recuperação de falhas](/pt-br/2026/04/dotnet-watch-11-preview-3-aspire-crash-recovery/). Se você usa o Visual Studio em vez da CLI, [o auto-restart do Hot Reload no Visual Studio 2026](/pt-br/2026/04/visual-studio-2026-hot-reload-auto-restart-rude-edits/) cobre como a IDE lida com edições que não consegue aplicar. Não testei a conexão de navegador do próprio Visual Studio para este post.

## Fontes

- [Advisory do CVE-2026-58649, dotnet/sdk#56166](https://github.com/dotnet/sdk/issues/56166), e o [anúncio, dotnet/announcements#441](https://github.com/dotnet/announcements/issues/441).
- [dotnet/sdk#56198](https://github.com/dotnet/sdk/pull/56198), a correção, que documenta `DOTNET_WATCH_AUTO_RELOAD_WS_ORIGINS` como a válvula de escape para domínios personalizados, e sua portagem para `main` em [#56246](https://github.com/dotnet/sdk/pull/56246).
- [dotnet/sdk#56291](https://github.com/dotnet/sdk/issues/56291), o relato de regressão em `*.dev.localhost` com o SDK 10.0.401 e o workaround do mantenedor.
- [`EnvironmentVariables.cs` no dotnet/sdk](https://github.com/dotnet/sdk/blob/main/src/Dotnet.Watch/Watch/Context/EnvironmentVariables.cs), para os nomes das variáveis, separadores e valores padrão.
- [dotnet/sdk#56118](https://github.com/dotnet/sdk/pull/56118), o redesenho de browser-tools de mesma origem no `main`.
- [Metadados de release do .NET 10](https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json), para saber quais builds do SDK trazem a correção.
