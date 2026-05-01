---
title: "AdMob bringt Windows-Phone-Apps zum Absturz. Was ist die Alternative?"
description: "AdMob hat meine Windows-Phone-App über WebBrowser.InvokeScript zum Absturz gebracht. Hier sind Stack Trace, Ursache und alternative Werbenetzwerke wie InnerActive."
pubDate: 2012-09-16
updatedDate: 2023-11-05
tags:
  - "windows-phone"
lang: "de"
translationOf: "2012/09/admob-crashing-windows-phone-apps-what-is-the-alternative"
translatedBy: "claude"
translationDate: 2026-05-01
---
Vor nicht allzu langer Zeit habe ich meine erste App über das Devcenter-Entwicklerkonto und nicht über den Global Publisher veröffentlicht -- und nur wenige Tage (oder eher Wochen) später bemerkte ich Crash-Reports für meine App. Ich habe die Stack-Trace-Daten heruntergeladen, in der Hoffnung herauszufinden, wo das Problem liegt, aber ohne Glück -- sie gaben so gut wie keine Information über die Ursache. Ich weiß nur, dass es etwas mit dem Browser zu tun hat.

Hier mein Stack Trace:

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

Meine nächste Frage war also: Welcher Teil meiner App nutzt den Web Browser? Antwort: keiner. Außer dem Werbeteil. Und genau dort kommt AdMob ins Spiel. Nach einigen Suchen stellte ich fest, dass ich mit diesem Problem nicht allein bin -- viele Entwickler haben ähnliche Stack Traces, alle nutzen AdMob, um Anzeigen darzustellen.

Selbst die AdMob-Google-Gruppe ist voll mit solchen Issues und Crashes -- und doch wird nichts dagegen unternommen. Es gibt einige Workarounds -- etwa die Unhandled Exception als Handled zu markieren, damit die App nicht abstürzt -- aber das macht die Werbung auch unklickbar, was nicht wünschenswert ist.

Also habe ich nach Alternativen gesucht -- und nach einer Weile bin ich bei InnerActive gelandet. Die meisten Entwickler empfehlen ihn offenbar als Alternative zu Microsofts Pub Center und AdMob -- und soweit ich sehen konnte, haben sie nette Partnerschaften mit bekannten Publishern wie HalfBrick oder ZeptoLab. Ich werde sie ausprobieren.

Ich habe ihre Dokumentation und die unterstützten Anzeigentypen schon ein wenig angesehen -- und sie wirken in Ordnung (jedenfalls deutlich besser als AdMob). Ich werde ihre Anzeigen in einer meiner Apps integrieren und berichten, wie es läuft.
