---
title: "AdMob hace que las apps de Windows Phone se caigan. ¿Cuál es la alternativa?"
description: "AdMob estaba haciendo que mi app de Windows Phone se cayera vía WebBrowser.InvokeScript. Aquí tienes el stack trace, la causa raíz y alternativas como InnerActive."
pubDate: 2012-09-16
updatedDate: 2023-11-05
tags:
  - "windows-phone"
lang: "es"
translationOf: "2012/09/admob-crashing-windows-phone-apps-what-is-the-alternative"
translatedBy: "claude"
translationDate: 2026-05-01
---
Hace no mucho publiqué mi primera app usando la cuenta de developer del devcenter y no la del global publisher; y solo un par de días (o debería decir semanas) después empecé a notar reportes de crash para mi app. Descargué los datos del stack trace con la esperanza de averiguar dónde estaba el problema, pero sin suerte: prácticamente no me dieron información sobre la causa. Lo único que sé es que tiene algo que ver con el browser.

Aquí está mi stack trace:

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

Así que mi siguiente pregunta fue: ¿qué parte de mi app usa el web browser? Respuesta: ninguna. Excepto la parte de publicidad. Y ahí entra AdMob. Unas cuantas búsquedas después descubrí que no soy el único con este problema: hay muchos developers con stack traces similares, todos usando AdMob para mostrar anuncios.

Incluso el grupo de AdMob de Google está lleno de este tipo de issues y crashes, y aun así no hacen nada por resolverlos. Hay algunos workarounds para esto -- como marcar la unhandled exception como handled y evitar que la app se cuelgue -- pero eso también hará que los anuncios no sean clickables, lo cual no es deseable.

Así que empecé a mirar alternativas; y al cabo de un rato acabé con InnerActive. La mayoría de los developers parece recomendar esta como alternativa al Pub Center de Microsoft y a AdMob; y, por lo que vi, tienen algunas alianzas interesantes con publishers conocidos como HalfBrick o ZeptoLab. Y voy a probarlos.

Ya he echado un vistazo a su documentación y a los tipos de anuncios soportados, y parecen estar bien (en cualquier caso, mucho mejor que AdMob). Integraré sus anuncios en una de mis apps y te cuento qué tal va.
