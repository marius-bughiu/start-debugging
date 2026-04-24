---
title: ".NET 10 no Ubuntu 26.04: tags de contêiner resolute e Native AOT no archive"
description: "Ubuntu 26.04 Resolute Raccoon traz .NET 10 no archive, introduz os tags de contêiner -resolute para substituir -noble, e empacota o ferramental de Native AOT via dotnet-sdk-aot-10.0."
pubDate: 2026-04-24
tags:
  - "dotnet"
  - "dotnet-10"
  - "ubuntu"
  - "containers"
  - "native-aot"
  - "linux"
lang: "pt-br"
translationOf: "2026/04/dotnet-10-ubuntu-2604-resolute-container-tags"
translatedBy: "claude"
translationDate: 2026-04-24
---

Ubuntu 26.04 "Resolute Raccoon" chegou à disponibilidade geral em 23 de abril de 2026, e o time do Microsoft .NET publicou o post de blog acompanhante no mesmo dia. O destaque é que .NET 10 está no archive da distro desde o dia um, a nomenclatura dos tags de contêiner rotacionou, e Native AOT finalmente ganhou um pacote apt próprio. Se você roda .NET no Linux, essa é a release que muda como suas linhas `FROM` vão parecer pelos próximos dois anos.

## Resolute substitui noble nos tags de contêiner

A partir do .NET 10, os tags de contêiner padrão referenciam imagens Ubuntu em vez de Debian. Com o 26.04 fora, a Microsoft adicionou uma nova variante baseada em Ubuntu 26.04 sob o tag `resolute`. A migração é mecânica:

```dockerfile
# Before
FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble

# After
FROM mcr.microsoft.com/dotnet/aspnet:10.0-resolute
```

As imagens `noble` ainda existem e continuam recebendo atualizações de base 24.04, então não há corte forçado. As variantes `chiseled` avançam em paralelo: `10.0-resolute-chiseled` é publicado junto com a imagem completa. Se você já estava em imagens chiseled noble para deployments estilo distroless, o upgrade é uma troca de tag e um rebuild.

## Instalando .NET 10 do archive

Nenhum feed de pacote da Microsoft é necessário no 26.04. O archive do Ubuntu traz o SDK direto:

```bash
sudo apt update
sudo apt install dotnet-sdk-10.0
```

.NET 10 é LTS, então a versão do archive recebe servicing de segurança pelo Ubuntu até o fim de vida da distro. Isso importa para ambientes endurecidos que bloqueiam fontes apt de terceiros.

## Native AOT como pacote apt de primeira classe

Essa é a mudança silenciosa mas importante. Até o 26.04, compilar Native AOT no Ubuntu significava instalar `clang`, `zlib1g-dev`, e as peças certas da toolchain por conta própria. O archive do 26.04 agora traz `dotnet-sdk-aot-10.0`, que puxa as peças do linker que o target `PublishAot` do SDK espera.

```bash
sudo apt install -y dotnet-sdk-aot-10.0 clang
dotnet publish -c Release -r linux-x64
```

A Microsoft cita um binário de 1.4 MB para um app hello-world com cold start de 3 ms, e um binário self-contained de 13 MB para um serviço web mínimo. Os números de tamanho e startup são familiares para quem usa AOT desde o .NET 8, mas que eles caiam de um único `apt install` num LTS stock é novo.

## .NET 8 e 9 via dotnet-backports

Se você ainda não está pronto para rebuildar no 10, o PPA `dotnet-backports` é o caminho suportado para versões mais antigas ainda em suporte no 26.04:

```bash
sudo apt install -y software-properties-common
sudo add-apt-repository ppa:dotnet/backports
sudo apt install dotnet-sdk-9.0
```

A Microsoft chama isso de suporte best-effort, então trate como uma ponte e não um plano de longo prazo. O fato de Ubuntu 26.04 ter .NET 10 pronto no dia de lançamento veio de rodar CI de `dotnet/runtime` contra Ubuntu 26.04 desde o fim de 2025. Se quiser acompanhar a mecânica, o [post oficial do blog do .NET](https://devblogs.microsoft.com/dotnet/whats-new-for-dotnet-in-ubuntu-2604/) tem a história completa.
