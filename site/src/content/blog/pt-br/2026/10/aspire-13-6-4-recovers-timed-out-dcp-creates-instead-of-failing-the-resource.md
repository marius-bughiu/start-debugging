---
title: "Aspire 13.6.4 recupera criações do DCP que expiraram em vez de falhar o recurso"
description: "O Aspire 13.6.4 impede que uma única chamada de criação do DCP que expirou ou retornou HTTP 504 envie um recurso para FailedToStart, e expõe três timeouts de DcpPublisher que você pode aumentar em runners de CI lentos."
pubDate: 2026-10-25
tags:
  - "aspire"
  - "dotnet"
  - "ci"
lang: "pt-br"
translationOf: "2026/10/aspire-13-6-4-recovers-timed-out-dcp-creates-instead-of-failing-the-resource"
translatedBy: "claude"
translationDate: 2026-10-25
---

Se o AppHost do seu Aspire 13.6 vem falhando aleatoriamente no CI com um recurso preso em `FailedToStart`, o [Aspire 13.6.4](https://github.com/microsoft/aspire/releases/tag/v13.6.4), lançado em 2026-10-24, é o patch que você procura. Ele muda a forma como o AppHost conversa com o Developer Control Plane (DCP) quando uma chamada de criação não responde a tempo, e finalmente permite ajustar esses timeouts.

## Uma única chamada de criação lenta bastava para matar um recurso

Desde a 13.6.0, uma única requisição `Create` ao servidor de API do DCP que expirava ou retornava HTTP 504 não era repetida. O recurso ia direto para `FailedToStart`, e tudo que fazia `WaitFor` nele falhava com "Stopped waiting for resource ... because it failed to start." O relato em [microsoft/aspire#20691](https://github.com/microsoft/aspire/issues/20691) veio de runners `macos-15-intel` hospedados no GitHub com 2 vCPUs, onde o último projeto do grafo iniciava enquanto suas dependências ainda estavam subindo. Os logs mostravam uma `TimeoutRejectedException` do Polly após o orçamento de 20 segundos do cliente ou um `GatewayTimeout` do DCP após cerca de 34 segundos.

O problema é que um timeout não significa que a criação falhou. O DCP pode ter confirmado o objeto logo depois que o cliente desistiu, então uma nova tentativa às cegas também não é segura.

## Confirmar primeiro, depois repetir com o mesmo objeto

A correção em [#20752](https://github.com/microsoft/aspire/pull/20752) (com backport em [#20868](https://github.com/microsoft/aspire/pull/20868)) trata uma criação com timeout, 502, 503, 504 ou 429 como ambígua. Antes de repetir, o AppHost emite um `GET` para o mesmo objeto nomeado. Se o DCP já o criou, esse objeto é usado e o recurso continua iniciando. Se o `GET` retorna 404, a criação é repetida com backoff com jitter limitado a 5 segundos. Uma resposta "already exists" em uma nova tentativa também é aceita, já que a tentativa anterior pode ter sido concluída depois da verificação de confirmação. O `GET` importa porque ignora o lock de publicação do servidor de API, atrás do qual um segundo `POST` poderia ficar bloqueado.

O `HttpClientTimeout` de 100 segundos do próprio pacote KubernetesClient agora está desabilitado, então ele não pode mais cortar um orçamento configurado e aparecer como um cancelamento sem relação.

## Três ajustes em DcpPublisher

Os orçamentos agora são opções normais na configuração do AppHost:

| Chave | Padrão | Finalidade |
| --- | --- | --- |
| `DcpPublisher:KubernetesApiTimeout` | 40 s | Por operação da API |
| `DcpPublisher:KubernetesInitializationAdditionalTimeout` | 20 s | Somado até a primeira operação bem-sucedida |
| `DcpPublisher:KubernetesCreateRecoveryTimeout` | 2 min | Orçamento total para recuperar uma criação |

Cada valor deve ficar entre um segundo e dez minutos, e os timeouts de API e de inicialização somados não podem passar de dez minutos, caso contrário a validação das opções falha na inicialização. Streams de watch e de log já estabelecidos não estão sujeitos a esses limites.

Em um runner com poucos recursos, aumente-os no `appsettings.json` do AppHost:

```json
{
  "DcpPublisher": {
    "KubernetesApiTimeout": "00:01:30",
    "KubernetesInitializationAdditionalTimeout": "00:00:45",
    "KubernetesCreateRecoveryTimeout": "00:05:00"
  }
}
```

Ou mantenha os padrões do repositório e defina-os apenas no workflow de CI, já que variáveis de ambiente também são vinculadas via `IConfiguration`:

```yaml
env:
  DcpPublisher__KubernetesApiTimeout: "00:01:30"
  DcpPublisher__KubernetesCreateRecoveryTimeout: "00:05:00"
```

Para atualizar, suba a versão do `Aspire.AppHost.Sdk` e dos pacotes `Aspire.Hosting.*` para `13.6.4`. A mesma versão também restringe os logs de diagnóstico da CLI no Unix a arquivos `0600` em um diretório `0700`, porque esses logs podem conter URLs de login do dashboard. Se você está se atualizando na linha 13.6, o [post sobre o histórico de execuções do dashboard](/pt-br/2026/09/aspire-13-6-dashboard-keeps-your-last-ten-runs/) cobre o principal recurso dessa versão.
