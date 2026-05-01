---
title: "Como expor publicamente seu serviço SignalR local para clientes móveis usando ngrok"
description: "Use o ngrok para expor publicamente seu serviço SignalR local para que clientes móveis possam se conectar sem configuração de rede ou contornos de SSL."
pubDate: 2020-11-04
tags:
  - "csharp"
  - "signalr"
  - "xamarin-forms"
lang: "pt-br"
translationOf: "2020/11/how-to-publicly-expose-local-signalr-service-publicly-for-mobile-clients"
translatedBy: "claude"
translationDate: 2026-05-01
---
Quando trabalhamos com clientes móveis, nem sempre é fácil colocá-los na mesma rede da sua máquina de desenvolvimento e, mesmo quando conseguimos, o `localhost` terá um significado diferente, então é preciso usar IPs, alterar bindings e desativar SSL ou confiar em certificados autoassinados; em resumo, é uma dor.

Diga olá para o [ngrok](https://ngrok.com).

O ngrok permite criar um proxy público e seguro que roteia todas as requisições para uma porta específica na sua máquina de desenvolvimento. O plano gratuito permite túneis HTTP/TCP com URLs e portas aleatórias para apenas um processo, mais um máximo de 40 conexões/minuto. Isso deve ser mais do que suficiente para a maioria. Se você precisa de domínios reservados ou subdomínios personalizados, e de limites maiores, também existem planos pagos.

## Vamos começar

Primeiro, registre uma conta no ngrok, baixe o cliente deles e extraia em um local de sua preferência. Em seguida, seguindo o [Setup & Installation guide](https://ngrok.com/docs/getting-started/), execute o comando `ngrok authtoken` para se autenticar.

Depois, inicie sua aplicação web e veja sua URL. A minha é `https://localhost:44312/`, o que significa que estamos interessados em encaminhar a porta 44312 via https. Então, na mesma janela do `cmd` que você usou para autenticar, execute `` ngrok http `https://localhost:44312/` ``, claro, substituindo `https://localhost:44312/` pela URL da sua aplicação. Isso iniciará seu proxy e mostrará as URLs públicas que você pode usar para acessá-lo.

![ngrok rodando um proxy público no plano Free](/wp-content/uploads/2020/10/image-1.png)

Se você não estiver usando HTTPS, pode usar o mais curto `ngrok http 44312`.

Se você receber um 400 Bad Request -- Invalid Hostname, significa que alguém está tentando validar o cabeçalho `Host` e falha porque eles não batem, já que por padrão o ngrok repassa tudo para o seu servidor web sem manipular. Para reescrever o cabeçalho `Host`, use a opção `-host-header=rewrite`.

No meu caso, usando ASP.NET Core + IIS Express, meu comando completo fica assim:

`ngrok http -host-header=rewrite https://localhost:44312`

Agora copie a URL da janela acima e atualize-a nos seus clientes. Atenção: a cada vez que você iniciar/parar o ngrok, a URL será diferente no plano Free.

## Experimente!

Você pode testar facilmente clonando o exemplo original do Xamarin Forms SignalR Chat (o repositório no GitHub não está mais disponível), executando o projeto .Web e expondo-o pelo `ngrok` como explicado acima. Depois, substitua a `ChatHubUrl` no `appsettings.json` pela URL gerada pelo `ngrok` para você.
