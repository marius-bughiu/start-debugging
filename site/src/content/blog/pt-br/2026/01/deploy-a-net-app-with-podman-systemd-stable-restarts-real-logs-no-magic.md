---
title: "Implante uma app .NET com Podman + systemd: reinícios estáveis, logs reais, sem mágica"
description: "Implante serviços .NET 9 e .NET 10 em uma VM Linux usando Podman e systemd. Tenha reinícios estáveis, logs reais via journald e uma app em contêiner gerenciada como um serviço de verdade -- sem Kubernetes."
pubDate: 2026-01-10
tags:
  - "docker"
  - "dotnet"
lang: "pt-br"
translationOf: "2026/01/deploy-a-net-app-with-podman-systemd-stable-restarts-real-logs-no-magic"
translatedBy: "claude"
translationDate: 2026-04-30
---
Apareceu hoje no r/dotnet: as pessoas continuam procurando uma história de "implantação sem graça" para serviços .NET que não seja Kubernetes nem um script `nohup` frágil. Se você está em uma VM Linux, Podman mais systemd é um meio-termo sólido: uma app em contêiner gerenciada como um serviço de verdade.

Discussão original: [https://www.reddit.com/r/dotnet/comments/1q8gq1u/how_to_deploy_net_applications_with_systemd_and/](https://www.reddit.com/r/dotnet/comments/1q8gq1u/how_to_deploy_net_applications_with_systemd_and/)

## Por que isso funciona bem para serviços .NET 9 e .NET 10

-   **O systemd cuida dos reinícios**: se o processo morrer, ele reinicia, e você recebe um motivo claro.
-   **O journald cuida dos logs**: chega de caçar arquivos rotacionados em disco.
-   **O Podman é sem daemon**: o systemd inicia exatamente o que precisa.

## Compile e execute o contêiner

Aqui está um `Containerfile` mínimo para uma app .NET 9 (funciona igual para .NET 10, basta trocar a tag base):

```dockerfile
FROM mcr.microsoft.com/dotnet/aspnet:9.0 AS base
WORKDIR /app
EXPOSE 8080

FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish -c Release -o /out

FROM base
WORKDIR /app
COPY --from=build /out .
ENV ASPNETCORE_URLS=http://+:8080
ENTRYPOINT ["dotnet", "MyApp.dll"]
```

Depois:

```bash
podman build -t myapp:1 .
podman run -d --name myapp -p 8080:8080 myapp:1
```

## Deixe o systemd assumir o controle (a parte útil)

O Podman pode gerar um arquivo de unidade que o systemd entende. Observação: `podman generate systemd` está obsoleto no Podman 4.4+ em favor do [Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html), mas a saída gerada ainda funciona e mostra o conceito com clareza:

```bash
podman generate systemd --new --name myapp --files
```

Isso produz algo como `container-myapp.service`. Mova-o para o lugar:

```bash
sudo mv container-myapp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now container-myapp.service
```

Agora você tem comandos operacionais limpos:

```bash
sudo systemctl status container-myapp.service
sudo journalctl -u container-myapp.service -f
sudo systemctl restart container-myapp.service
```

## Dois detalhes que salvam você depois

### Deixe a configuração explícita

Use variáveis de ambiente e um diretório de configuração montado em vez de embutir segredos na imagem. Com o systemd, você pode definir overrides em um arquivo drop-in e reiniciar com segurança.

### Escolha uma política de restart que combine com a realidade

Se a sua app falha rápido por causa de configuração faltando, reinícios infinitos são só ruído. Prefira uma política de restart que não martele a máquina. O systemd permite controlar atrasos e limites de rajada.

Se você quer um único teste do tipo "estou fazendo certo?": reinicie a VM e veja se o seu serviço .NET volta sem você precisar entrar via SSH. Essa é a régua.

Leitura adicional: [https://docs.podman.io/](https://docs.podman.io/)
