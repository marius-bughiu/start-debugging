---
title: "AdMob travando apps Windows Phone. Qual a alternativa?"
description: "O AdMob estava derrubando meu app Windows Phone via WebBrowser.InvokeScript. Aqui estão o stack trace, a causa raiz e alternativas como o InnerActive."
pubDate: 2012-09-16
updatedDate: 2023-11-05
tags:
  - "windows-phone"
lang: "pt-br"
translationOf: "2012/09/admob-crashing-windows-phone-apps-what-is-the-alternative"
translatedBy: "claude"
translationDate: 2026-05-01
---
Há pouco tempo publiquei meu primeiro app usando a conta de developer do devcenter, e não a do global publisher -- e poucos dias depois (ou seria semanas) comecei a notar relatos de crash do app. Baixei os dados do stack trace na esperança de descobrir onde estava o problema, mas sem sorte -- ele não me deu praticamente nenhuma informação sobre a causa. Tudo o que sei é que tem algo a ver com o browser.

Aqui está o meu stack trace:

```plaintext
Frame    Image             Function                                                   Offset
0        coredll.dll       xxx_RaiseException                                         19
1        mscoree3_7.dll                                                               436172
2        mscoree3_7.dll                                                               383681
3        mscoree3_7.dll                                                               540620
4                          TransitionStub                                             0
5                          Microsoft.Phone.Controls.NativeMethods.ValidateHResult     236
6                          Microsoft.Phone.Controls.WebBrowserInterop.InvokeScript    128
7                          Microsoft.Phone.Controls.WebBrowser.InvokeScript           84
8                          .__c__DisplayClass36._RunScripts_b__34                     228
9        mscoree3_7.dll                                                               428848
10       mscoree3_7.dll                                                               222523
11       mscoree3_7.dll                                                               221143
12                         System.Reflection.RuntimeMethodInfo.InternalInvoke         112
13                         System.Reflection.RuntimeMethodInfo.InternalInvoke         1556
14                         System.Reflection.MethodBase.Invoke                        104
15                         System.Delegate.DynamicInvokeOne                           564
16                         System.MulticastDelegate.DynamicInvokeImpl                 84
17                         System.Windows.Threading.DispatcherOperation.Invoke        80
18                         System.Windows.Threading.Dispatcher.Dispatch               404
19                         System.Windows.Threading.Dispatcher.OnInvoke               56
```

Então minha próxima pergunta foi: qual parte do meu app usa o web browser? Resposta: nenhuma. Exceto a parte de publicidade. E é aí que entra o AdMob. Algumas pesquisas depois, descobri que não sou o único com esse problema -- há vários developers por aí com stack traces similares, todos usando AdMob para exibir anúncios.

Até o grupo do AdMob no Google está cheio desse tipo de issue e crash -- e mesmo assim eles não fazem nada para resolver. Existem alguns workarounds -- como marcar a unhandled exception como handled e impedir o app de travar -- mas isso também deixa os anúncios não clicáveis, o que não é desejável.

Então comecei a olhar alternativas -- e depois de um tempo cheguei no InnerActive. A maioria dos developers parece recomendá-lo como alternativa ao Pub Center da Microsoft e ao AdMob -- e, pelo que vi, eles têm parcerias legais com publishers conhecidos, como HalfBrick e ZeptoLab. Vou dar uma chance.

Já dei uma olhada na documentação e nos tipos de anúncios suportados -- e parecem ok (e, em todo caso, bem melhores do que o AdMob). Vou integrar os anúncios deles em um dos meus apps e conto como foi.
