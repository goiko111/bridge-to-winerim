# Sa Pedrera - Mapping vs Winerim publicados

Fecha: 2026-06-04 11:50 CEST
Master data cacheada: 2026-06-04T09:50:08.262+00:00

## Resumen
- Configuración: `LEGACY_REGION_ROUTING` con 26 reglas de routing.
- Productos de vino vendibles detectados en Agora: 870.
- Productos publicados/subidos desde Winerim visibles: 385.
- Legacy visibles con mapping CONFIRMED: 92.
- Legacy visibles PENDING: 18.
- Legacy visibles REJECTED: 1.
- Legacy visibles sin mapping: 374.
- Duplicados probables legacy-confirmado + Winerim publicado mismo vino/formato: 92.

## Foto directa Lovable Cloud
- `winerim_push_tracking` total Sa Pedrera: 417 filas.
- Estado de publicación Winerim -> Agora: `VERIFIED=393`, `HIDDEN=17`, `FAILED=5`, `QUEUED=1`, `NOT_PUSHED=1`.
- Formatos Winerim verificados: `BOTTLE=352`, `MAGNUM=25`, `GLASS=16`.
- `product_mappings` total Sa Pedrera: 812 filas.
- Estado de mappings: `CONFIRMED=501`, `REJECTED=291`, `PENDING=20`.
- Métodos de mappings confirmados: `XML_IMPORT=408`, `FUZZY=55`, `LEGACY_SAFE_MATCH=38`.

Lectura importante:
- Los `XML_IMPORT` son productos Winerim publicados/importados, no legacy original del cliente.
- Los `LEGACY_SAFE_MATCH` son los mappings legacy más fiables creados para preservar la pantalla regional del cliente.
- Los `FUZZY` antiguos no deben usarse para ocultar botones Winerim sin revisión manual; hay ejemplos claramente sospechosos.
- Para una limpieza `legacy-first`, ocultar solo el producto Winerim duplicado cuando el legacy esté `CONFIRMED`, tenga variante correcta y el match sea manualmente razonable. No ocultar en masa los 92 duplicados probables sin filtrar.

## Publicado/subido desde Winerim por estado
```json
{
  "VERIFIED": 393,
  "HIDDEN": 17,
  "FAILED": 5,
  "QUEUED": 1,
  "NOT_PUSHED": 1
}
```

## Publicado/subido desde Winerim por formato visible
```json
{
  "BOTTLE": 352,
  "MAGNUM": 25,
  "GLASS": 16
}
```

## Legacy mapeado confirmado - primeros 80
| Agora ID | Legacy Agora | Familia | Winerim | Formato | Método |
| --- | --- | --- | --- | --- | --- |
| 104 | Martini Blanco | Aperitivos | B325-Izadi Blanco | BOTTLE | FUZZY |
| 108 | Lustau Blanco | Aperitivos | B322-Ossian Blanco | BOTTLE | FUZZY |
| 238 | 12 Volts | T Baleares | T4-12 Volts | BOTTLE | FUZZY |
| 239 | Sa Forana | T Baleares | T5-Sa Forana Tinto | BOTTLE | FUZZY |
| 240 | Trispol | T Baleares | T6-Trispol | BOTTLE | FUZZY |
| 247 | 4 Kilos | T Baleares | T12-4 Kilos | BOTTLE | FUZZY |
| 248 | Àn - Ànima Negra | T Baleares | T13-Àn - Ánima Negra | BOTTLE | FUZZY |
| 252 | Dido Negre | T Cataluña | T17-Dido Negre | BOTTLE | FUZZY |
| 254 | Finca L'Argatà | T Cataluña | T19- Finca l'Argatà | BOTTLE | FUZZY |
| 267 | Semele | T Ribera C.Leon | T31-Semele | BOTTLE | FUZZY |
| 274 | César Principe | T Ribera C.Leon | T37-César Principe | BOTTLE | FUZZY |
| 277 | Bosque de Matasnos | T Ribera C.Leon | T40-Bosque de Matasnos | BOTTLE | FUZZY |
| 279 | Tomás Postigo | T Ribera C.Leon | T42-Tomás Postigo | BOTTLE | FUZZY |
| 280 | Mauro | T Ribera C.Leon | T43-Mauro | BOTTLE | FUZZY |
| 287 | PSI Dominio De pingus | T Ribera C.Leon | T36-Dominio de Calogía | BOTTLE | FUZZY |
| 298 | Ultreia Saint Jacques | T Atlanticos | T60-Ultreia Saint Jacques | BOTTLE | FUZZY |
| 299 | Pétalos del Bierzo | T Atlanticos | T61-Pétalos del Bierzo | BOTTLE | FUZZY |
| 312 | La Montesa | T Rioja Navarra | T 74-Finca La Montesa | BOTTLE | FUZZY |
| 313 | La Montesa Magnum | T Rioja Navarra | MAGNUM 21 - Finca La Montesa | MAGNUM | LEGACY_SAFE_MATCH |
| 314 | Tobía | T Rioja Navarra | T 75-Tobía Selección de Autor | BOTTLE | LEGACY_SAFE_MATCH |
| 315 | Nat Cool | T Rioja Navarra | T 76-Nat Cool | BOTTLE | LEGACY_SAFE_MATCH |
| 316 | Ramón Bilbao | T Rioja Navarra | T 77-Ramón Bilbao Viñedos de Altura | BOTTLE | FUZZY |
| 319 | Villota Tinto | T Rioja Navarra | T80-Villota Tinto | BOTTLE | FUZZY |
| 320 | Señora de las Alturas | T Rioja Navarra | T81-Señora de las Alturas | BOTTLE | LEGACY_SAFE_MATCH |
| 321 | Gabaxo | T Rioja Navarra | T82-Gabaxo | BOTTLE | LEGACY_SAFE_MATCH |
| 324 | Orben | T Rioja Navarra | T85-Orben | BOTTLE | FUZZY |
| 326 | macan clasico | T Rioja Navarra | T87-Macán Clásico | BOTTLE | LEGACY_SAFE_MATCH |
| 327 | Conde De La Salceda | T Rioja Navarra | T88-Conde De La Salceda Reserva | BOTTLE | FUZZY |
| 330 | Muga Selección | T Rioja Navarra | T101-Torre Muga | BOTTLE | FUZZY |
| 331 | Remelluri | T Rioja Navarra | T92-Remelluri Reserva | BOTTLE | FUZZY |
| 332 | San Vicente | T Rioja Navarra | T93-San Vicente | BOTTLE | LEGACY_SAFE_MATCH |
| 333 | Viña Arana | T Rioja Navarra | T94-Viña Arana Gran Reserva | BOTTLE | LEGACY_SAFE_MATCH |
| 335 | Valdeginés | T Rioja Navarra | T96-Valdeginés | BOTTLE | FUZZY |
| 336 | Roda I Reserva | T Rioja Navarra | T97-Roda I Reserva | BOTTLE | FUZZY |
| 337 | Mingortiz | T Rioja Navarra | T98-Mingortiz | BOTTLE | LEGACY_SAFE_MATCH |
| 338 | MACAN | T Rioja Navarra | T99-Macán | BOTTLE | LEGACY_SAFE_MATCH |
| 339 | Gran Reserva 904 | T Rioja Navarra | T100-Gran Reserva 904 | BOTTLE | LEGACY_SAFE_MATCH |
| 340 | Torre Muga | T Rioja Navarra | T101-Torre Muga | BOTTLE | LEGACY_SAFE_MATCH |
| 341 | Prado Enea | T Rioja Navarra | T102-Prado Enea | BOTTLE | LEGACY_SAFE_MATCH |
| 342 | Trasnocho | T Rioja Navarra | T103-Trasnocho | BOTTLE | LEGACY_SAFE_MATCH |
| 343 | Viña Tondonia | T Rioja Navarra | T104-Viña Tondonia Reserva | BOTTLE | FUZZY |
| 344 | Barón de Chirel | T Rioja Navarra | T105-Barón de Chirel Reserva | BOTTLE | LEGACY_SAFE_MATCH |
| 345 | Macán Clásico | T Rioja Navarra | T87-Macán Clásico | BOTTLE | LEGACY_SAFE_MATCH |
| 346 | Finca el Bosque | T Rioja Navarra | T111-Finca el Bosque | BOTTLE | LEGACY_SAFE_MATCH |
| 347 | La Nieta | T Rioja Navarra | T112-La Nieta | BOTTLE | LEGACY_SAFE_MATCH |
| 348 | La Liende | T Rioja Navarra | T113-Colección no.1 La Liende | BOTTLE | LEGACY_SAFE_MATCH |
| 349 | Gran Reserva 890 | T Rioja Navarra | T114-Gran Reserva 890 | BOTTLE | LEGACY_SAFE_MATCH |
| 350 | Viña Tondonia gran reserva | T Rioja Navarra | T115- Viña Tondonia Gran Reserva 100 PUNTOS PARKER | BOTTLE | LEGACY_SAFE_MATCH |
| 351 | Castillo Ygay | T Rioja Navarra | T116-Castillo Ygay Gran Reserva Especial | BOTTLE | LEGACY_SAFE_MATCH |
| 370 | Bourgogne Pinot Noir | T Internacionales | T212-Bourgogne Pinot Noir | BOTTLE | FUZZY |
| 379 | Guy Amiot et Fils Bourgogne | T Internacionales | B427-Guy Amiot et Fils Chassagne-Montrachet "Vieilles Vignes" | BOTTLE | FUZZY |
| 393 | Bonnardot Tinto | T Internacionales | B424-Bonnardot Chassagne-Montrachet | BOTTLE | FUZZY |
| 398 | Domaine Parigot Volnay | T Internacionales | T231-Domaine Parigot Volnay 'Les Brouillards' | BOTTLE | FUZZY |
| 438 | Foraster | B Baleares | B-308- Foraster | BOTTLE | FUZZY |
| 442 | Gran Caus | B Cataluña | B312-Gran Caus Blanc | BOTTLE | FUZZY |
| 450 | Barco del Corneta | B Rueda | B320-Barco del Corneta | BOTTLE | FUZZY |
| 454 | Belondrade y Lurton | B Rueda | B323-Belondrade y Lurton | BOTTLE | FUZZY |
| 457 | Villota | B Rioja Navarra | T80-Villota Tinto | BOTTLE | FUZZY |
| 458 | Plácet | B Rioja Navarra | B327-Plácet Valtomelloso | BOTTLE | FUZZY |
| 459 | La Bastida | B Rioja Navarra | B328-La Bastida | BOTTLE | LEGACY_SAFE_MATCH |
| 460 | Qué Bonito Cacareaba | B Rioja Navarra | B329-Qué Bonito Cacareaba | BOTTLE | LEGACY_SAFE_MATCH |
| 461 | Viña Gravonia | B Rioja Navarra | B330-Viña Gravonia | BOTTLE | LEGACY_SAFE_MATCH |
| 463 | Capellanía Magnum | B Rioja Navarra | MAGNUM 7 - Marqués de Murrieta Capellanía | MAGNUM | LEGACY_SAFE_MATCH |
| 464 | Mirando al sur | B Rioja Navarra | B332-Mirando al Sur | BOTTLE | LEGACY_SAFE_MATCH |
| 466 | Mara Moura | B Galicia | B340-Mara Moura | BOTTLE | FUZZY |
| 468 | Terras Gauda | B Galicia | B342-Terras Gauda | BOTTLE | FUZZY |
| 469 | Arousa | B Galicia | B343-Arousa | BOTTLE | FUZZY |
| 474 | Atlántico | B Galicia | B348-Atlántico | BOTTLE | FUZZY |
| 480 | Godeval Cepas Vellas | B Galicia | B353-Godeval Cepas Vellas - Valdeorras | BOTTLE | FUZZY |
| 529 | Alba | Vinos Rosados | R601-Alba Rosé | BOTTLE | LEGACY_SAFE_MATCH |
| 530 | Izadi Larrosa | Vinos Rosados | B325-Izadi Blanco | BOTTLE | FUZZY |
| 533 | Whispering Angel | Vinos Rosados | R605-Whispering Angel Rosé | BOTTLE | FUZZY |
| 538 | Rimarts | E Españoles | E502-Rimarts Brut Nature Reserva 24 | BOTTLE | FUZZY |
| 539 | Agustí Torrelló | E Españoles | E503-Agustí Torelló Mata Rosat Trepat | BOTTLE | FUZZY |
| 540 | Llopart | E Españoles | E504-Llopart Brut Nature Reserva | BOTTLE | FUZZY |
| 541 | Clos Lentiscus | E Españoles | E505-Clos Lentiscus Blanc de Blancs Brut Nature | BOTTLE | FUZZY |
| 542 | Gramona Imperial | E Españoles | E507-Gramona Imperial Brut | BOTTLE | FUZZY |
| 570 | Laurent-Perrier-Rosé | Champagnes | E543-Laurent-Perrier Cuvée Rosé | BOTTLE | FUZZY |
| 580 | Copa Valverán Sidra de Hielo | Vino Dulce | D707- Valverán Sidra de Hielo | GLASS | LEGACY_SAFE_MATCH |
| 581 | Copa East India Solera | Vino Dulce | D702-East India Solera | GLASS | LEGACY_SAFE_MATCH |

## Publicado desde Winerim visible - primeros 120
| Agora ID | Nombre Agora | Familia | Winerim | Formato | Estado |
| --- | --- | --- | --- | --- | --- |
| 600015 | B T16-Pardas Collita Roja | T Cataluña | T16-Pardas Collita Roja | BOTTLE | VERIFIED |
| 510004 | B B409-Federspiel Mühlpoint Grüner Veltliner | B Internacionales | B409-Federspiel Mühlpoint Grüner Veltliner | BOTTLE | VERIFIED |
| 510005 | B B414-Domaine De La Borde Foudre à Canon Naturé | B Internacionales | B414-Domaine De La Borde Foudre à Canon Naturé | BOTTLE | VERIFIED |
| 600321 | B E555-Dom Pérignon Vintage 2008 | Champagnes | E555-Dom Pérignon Vintage 2008 | BOTTLE | VERIFIED |
| 601767 | B T32-Parada de Atauta | T Ribera C.Leon | T32-Parada de Atauta | BOTTLE | VERIFIED |
| 601768 | B T110-Pancrudo | T Rioja Navarra | T110-Pancrudo | BOTTLE | VERIFIED |
| 1001782 | M MAGNUM 18 - Almirez | MAGNUMS | MAGNUM 18 - Almirez | MAGNUM | VERIFIED |
| 601788 | B E521-Piper-Heidsieck Cuvée Brut | Champagnes | E521-Piper-Heidsieck Cuvée Brut | BOTTLE | VERIFIED |
| 601901 | B B361-Pepe Luis | B Galicia | B361-Pepe Luis | BOTTLE | VERIFIED |
| 601913 | B T252-Argiano Brunello di Montalcino | T Internacionales | T252-Argiano Brunello di Montalcino | BOTTLE | VERIFIED |
| 601961 | B T261-Bruno Rocca | T Internacionales | T261-Bruno Rocca | BOTTLE | VERIFIED |
| 601962 | B T224-La Closerie de Malescasse | T Internacionales | T224-La Closerie de Malescasse | BOTTLE | VERIFIED |
| 601963 | B T210-Morgon Côte du Py | T Internacionales | T210-Morgon Côte du Py | BOTTLE | VERIFIED |
| 601964 | B B316a-Milmanda | B Cataluña | B316a-Milmanda | BOTTLE | VERIFIED |
| 601965 | B B362- Agas do tempo Felicísimo | B Galicia | B362- Agas do tempo Felicísimo | BOTTLE | VERIFIED |
| 601967 | B T268-Philippe Pacalet Gevrey-Chambertin | T Internacionales | T268-Philippe Pacalet Gevrey-Chambertin | BOTTLE | VERIFIED |
| 601975 | B B323a-Territorio Luthier Blanco de Guarda | B Rueda | B323a-Territorio Luthier Blanco de Guarda | BOTTLE | VERIFIED |
| 602090 | B T243-Château Ormes de Pez | T Internacionales | T243-Château Ormes de Pez | BOTTLE | VERIFIED |
| 602177 | B T217 - Chateau la croix des templiers | T Internacionales | T217 - Chateau la croix des templiers | BOTTLE | VERIFIED |
| 602179 | B T222 -Eddie feraud et fils chateneauf du pape | T Internacionales | T222 -Eddie feraud et fils chateneauf du pape | BOTTLE | VERIFIED |
| 602181 | B T259 -Moulin à Vent | T Internacionales | T259 -Moulin à Vent | BOTTLE | VERIFIED |
| 605470 | B T263- Denis Père &amp; Fils Corton 'Les Paulands' | T Internacionales | T263- Denis Père & Fils Corton 'Les Paulands' | BOTTLE | VERIFIED |
| 605902 | B R607-Rock Angel Rosé | Vinos Rosados | R607-Rock Angel Rosé | BOTTLE | VERIFIED |
| 605904 | B E550- Moët &amp; Chandon Grand Vintage AÑADA 2000 | Champagnes | E550- Moët & Chandon Grand Vintage AÑADA 2000 | BOTTLE | VERIFIED |
| 605905 | B E551- Moët &amp; Chandon Grand Vintage AÑO 2003 | Champagnes | E551- Moët & Chandon Grand Vintage AÑO 2003 | BOTTLE | VERIFIED |
| 605906 | B E552- Moët &amp; Chandon Grand Vintage | Champagnes | E552- Moët & Chandon Grand Vintage | BOTTLE | VERIFIED |
| 605907 | B E544 -Les Vignes de Vrigny Brut | Champagnes | E544 -Les Vignes de Vrigny Brut | BOTTLE | VERIFIED |
| 606221 | B E525-Maurice Vesselle Rosé | Champagnes | E525-Maurice Vesselle Rosé | BOTTLE | VERIFIED |
| 619440 | B B 307 - Alba Blanca Garnacha | B Baleares | B 307 - Alba Blanca Garnacha | BOTTLE | VERIFIED |
| 619746 | B T221-Jean-Michel Cazes Pauillac | T Internacionales | T221-Jean-Michel Cazes Pauillac | BOTTLE | VERIFIED |
| 712174 | C D701-Valverán Sidra de Hielo | Copa Vino Postre | D701-Valverán Sidra de Hielo | GLASS | VERIFIED |
| 712176 | C D702-East India Solera | Copa Vino Postre | D702-East India Solera | GLASS | VERIFIED |
| 712177 | C D706-El Sequé Dulce | Copa Vino Postre | D706-El Sequé Dulce | GLASS | VERIFIED |
| 712178 | C D707-Niepoort LBV | Copa Vino Postre | D707-Niepoort LBV | GLASS | VERIFIED |
| 712179 | C G801-Península Palo Cortado | Copa Vino Postre | G801-Península Palo Cortado | GLASS | VERIFIED |
| 712180 | C G802-Papirusa | Copa Vino Postre | G802-Papirusa | GLASS | VERIFIED |
| 648271 | B T 33 -Arrocal Joven Roble | T Ribera C.Leon | T 33 -Arrocal Joven Roble | BOTTLE | VERIFIED |
| 666594 | B T115- Viña Tondonia Gran Reserva 100 PUNTOS PARKER | T Rioja Navarra | T115- Viña Tondonia Gran Reserva 100 PUNTOS PARKER | BOTTLE | VERIFIED |
| 671636 | B B-308- Foraster | B Baleares | B-308- Foraster | BOTTLE | VERIFIED |
| 675340 | B T236-Ca'Marcanda Promis | T Internacionales | T236-Ca'Marcanda Promis | BOTTLE | VERIFIED |
| 675342 | B T238-Labruyère-Prieur Bourgogne | T Internacionales | T238-Labruyère-Prieur Bourgogne | BOTTLE | VERIFIED |
| 675343 | B T235-Maison Les Alexandrins Hermitage | T Internacionales | T235-Maison Les Alexandrins Hermitage | BOTTLE | VERIFIED |
| 675355 | B T246-Gillardi Barolo Vignane | T Internacionales | T246-Gillardi Barolo Vignane | BOTTLE | VERIFIED |
| 675356 | B T213-Saint-Émilion Grand Cru | T Internacionales | T213-Saint-Émilion Grand Cru | BOTTLE | VERIFIED |
| 675357 | B T205-Prunotto Fiulot | T Internacionales | T205-Prunotto Fiulot | BOTTLE | VERIFIED |
| 675358 | B T250-Domaine de Lorient Saint Joseph | T Internacionales | T250-Domaine de Lorient Saint Joseph | BOTTLE | VERIFIED |
| 675359 | B T228-Château Paveil De Luze Margaux | T Internacionales | T228-Château Paveil De Luze Margaux | BOTTLE | VERIFIED |
| 675360 | B D207-Domaine Les Bruyères 'Georges' Crozes-Hermitage | T Internacionales | D207-Domaine Les Bruyères 'Georges' Crozes-Hermitage | BOTTLE | VERIFIED |
| 675361 | B T215-Il Frappato | T Internacionales | T215-Il Frappato | BOTTLE | VERIFIED |
| 675363 | B T204-Barbera d'Alba | T Internacionales | T204-Barbera d'Alba | BOTTLE | VERIFIED |
| 675508 | B T19- Finca l'Argatà | T Cataluña | T19- Finca l'Argatà | BOTTLE | VERIFIED |
| 676295 | B B317- Menade Verdejo | B Rueda | B317- Menade Verdejo | BOTTLE | VERIFIED |
| 876295 | C B317- Menade Verdejo | Copas Blanco | B317- Menade Verdejo | GLASS | VERIFIED |
| 676355 | B Doña Palaueta | T Cataluña | Doña Palaueta | BOTTLE | VERIFIED |
| 682857 | B E501- Colet A Priori Brut | E Españoles | E501- Colet A Priori Brut | BOTTLE | VERIFIED |
| 683006 | B B303-Binitord Blanc | B Baleares | B303-Binitord Blanc | BOTTLE | VERIFIED |
| 883006 | C B303-Binitord Blanc | Copas Blanco | B303-Binitord Blanc | GLASS | VERIFIED |
| 686443 | B E514-Gramona Roent Rose | E Españoles | E514-Gramona Roent Rose | BOTTLE | VERIFIED |
| 690751 | B T260- Azelia Barolo | T Internacionales | T260- Azelia Barolo | BOTTLE | VERIFIED |
| 690752 | B T244-Vietti Barbera d'Alba Vigna Vecchia Scarrone | T Internacionales | T244-Vietti Barbera d'Alba Vigna Vecchia Scarrone | BOTTLE | VERIFIED |
| 690753 | B E535- Sans Anée Extra Brut | Champagnes | E535- Sans Anée Extra Brut | BOTTLE | VERIFIED |
| 690802 | B E528-Pierre Gimonnet &amp; Fils Blanc de Blancs Cuvée Cuis Brut 1er Cru | Champagnes | E528-Pierre Gimonnet & Fils Blanc de Blancs Cuvée Cuis Brut 1er Cru | BOTTLE | VERIFIED |
| 694955 | B T277- Château La Mission Haut-Brion 1er Grand Cru Classé de Graves   100 PUNTOS PARKER | T Internacionales | T277- Château La Mission Haut-Brion 1er Grand Cru Classé de Graves   100 PUNTOS PARKER | BOTTLE | VERIFIED |
| 694956 | B T278- Château La Conseillante Pomerol 100 puntos Parker | T Internacionales | T278- Château La Conseillante Pomerol 100 puntos Parker | BOTTLE | VERIFIED |
| 694957 | B T279- Vieux Château Certan Pomerol 100 PUNTOS PARKER | T Internacionales | T279- Vieux Château Certan Pomerol 100 PUNTOS PARKER | BOTTLE | VERIFIED |
| 694958 | B T280- Lafite Rothschild 100 PUNTOS PARKER | T Internacionales | T280- Lafite Rothschild 100 PUNTOS PARKER | BOTTLE | VERIFIED |
| 694959 | B T281- Mouton Rothschild 100 PUNTOS PARKER | T Internacionales | T281- Mouton Rothschild 100 PUNTOS PARKER | BOTTLE | VERIFIED |
| 694960 | B T282- Château Margaux 1er Grand Cru Classé 100 PUNTOS PARKER | T Internacionales | T282- Château Margaux 1er Grand Cru Classé 100 PUNTOS PARKER | BOTTLE | VERIFIED |
| 694961 | B T273- Château de Beaucastel Hommage à Jacques Perrin | T Internacionales | T273- Château de Beaucastel Hommage à Jacques Perrin | BOTTLE | VERIFIED |
| 694962 | B T272- Clos Rougeard Saumur | T Internacionales | T272- Clos Rougeard Saumur | BOTTLE | VERIFIED |
| 694966 | B T270- Vérité La Joie 100 PUNTOS PARKER | T Internacionales | T270- Vérité La Joie 100 PUNTOS PARKER | BOTTLE | VERIFIED |
| 694968 | B T274- Sassicaia 2019 | T Internacionales | T274- Sassicaia 2019 | BOTTLE | VERIFIED |
| 694969 | B T276-Sassicaia 100 PUNTOS PARKER | T Internacionales | T276-Sassicaia 100 PUNTOS PARKER | BOTTLE | VERIFIED |
| 695269 | B T223- Villa Antinori Chianti Classico Riserva | T Internacionales | T223- Villa Antinori Chianti Classico Riserva | BOTTLE | VERIFIED |
| 700384 | B B410 - Arbois Savagnin En Guille-Bouton | B Internacionales | B410 - Arbois Savagnin En Guille-Bouton | BOTTLE | VERIFIED |
| 701260 | B T201- Morgon | T Internacionales | T201- Morgon | BOTTLE | VERIFIED |
| 703545 | B T49- PSI | T Ribera C.Leon | T49- PSI | BOTTLE | VERIFIED |
| 703603 | B B442- Nobiles Origines Blanc | B Internacionales | B442- Nobiles Origines Blanc | BOTTLE | VERIFIED |
| 705011 | B E515- Juvé &amp; Camps Milesimé | E Españoles | E515- Juvé & Camps Milesimé | BOTTLE | VERIFIED |
| 1105599 | M Magnum 31-  Dido | MAGNUMS | Magnum 31-  Dido | MAGNUM | VERIFIED |
| 711217 | B T227-  Piemonte Dolcetto d'Alba | T Internacionales | T227-  Piemonte Dolcetto d'Alba | BOTTLE | VERIFIED |
| 711219 | B B307-Sa Caterina Gran Clos Blanc | B Baleares | B307-Sa Caterina Gran Clos Blanc | BOTTLE | VERIFIED |
| 711220 | B T15-Sa Caterina Gran Clos Tinto | T Baleares | T15-Sa Caterina Gran Clos Tinto | BOTTLE | VERIFIED |
| 715439 | B T253- Jules Desjourneys Moulin à Vent Les Styx | T Internacionales | T253- Jules Desjourneys Moulin à Vent Les Styx | BOTTLE | VERIFIED |
| 1117272 | M MAGNUM 10- 12 Volts | MAGNUMS | MAGNUM 10- 12 Volts | MAGNUM | VERIFIED |
| 1117273 | M MAGNUM 33-  Finca l'Argatà | MAGNUMS | MAGNUM 33-  Finca l'Argatà | MAGNUM | VERIFIED |
| 1117274 | M MAGNUM 28 -4 Kilos | MAGNUMS | MAGNUM 28 -4 Kilos | MAGNUM | VERIFIED |
| 717295 | B B444- Domaine de Chevalier Pessac-Léognan Blanc (Grand Cru Classé de Graves) | B Internacionales | B444- Domaine de Chevalier Pessac-Léognan Blanc (Grand Cru Classé de Graves) | BOTTLE | VERIFIED |
| 717375 | B T 269-La Maison Romane Chambolle-Musigny | T Internacionales | T 269-La Maison Romane Chambolle-Musigny | BOTTLE | VERIFIED |
| 728319 | B T99-Macán | T Rioja Navarra | T99-Macán | BOTTLE | VERIFIED |
| 728320 | B T123- Ponce | T Otras Zonas | T123- Ponce | BOTTLE | VERIFIED |
| 733624 | B D708- Tokaji Aszú 3 Puttonyos | Vino Dulce | D708- Tokaji Aszú 3 Puttonyos | BOTTLE | VERIFIED |
| 733625 | B B407- Oremus Mandolás | B Internacionales | B407- Oremus Mandolás | BOTTLE | VERIFIED |
| 733627 | B D709- Petracs | Vino Dulce | D709- Petracs | BOTTLE | VERIFIED |
| 733644 | B T265- El Enemigo As Bravas Malbec 100 PUNTOS PARKER | T Internacionales | T265- El Enemigo As Bravas Malbec 100 PUNTOS PARKER | BOTTLE | VERIFIED |
| 733646 | B T202- Domaine Anita Reine de Nuit Moulin-à-Vent | T Internacionales | T202- Domaine Anita Reine de Nuit Moulin-à-Vent | BOTTLE | VERIFIED |
| 733647 | B B438- Bernkasteler Lay Riesling Auslese | B Internacionales | B438- Bernkasteler Lay Riesling Auslese | BOTTLE | VERIFIED |
| 733703 | B T211- Versante Nord | T Internacionales | T211- Versante Nord | BOTTLE | VERIFIED |
| 524301 | B T131-Pie Franco Casa Castillo | T Otras Zonas | T131-Pie Franco Casa Castillo | BOTTLE | VERIFIED |
| 524302 | B T128-Casa Castillo Las Gravas | T Otras Zonas | T128-Casa Castillo Las Gravas | BOTTLE | VERIFIED |
| 924303 | M MAGNUM 30 -Sori' Pradurent Superiore Dolcetto di Diano d'Alba | MAGNUMS | MAGNUM 30 -Sori' Pradurent Superiore Dolcetto di Diano d'Alba | MAGNUM | VERIFIED |
| 524308 | B E524-Collet Art Déco Brut Premier Cru | Champagnes | E524-Collet Art Déco Brut Premier Cru | BOTTLE | VERIFIED |
| 924315 | M MAGNUM  29- Le Maestrelle | MAGNUMS | MAGNUM  29- Le Maestrelle | MAGNUM | VERIFIED |
| 746967 | B T264- Troplong Mondot Saint-Émilion Grand Cru (Premier Grand Cru Classé) | T Internacionales | T264- Troplong Mondot Saint-Émilion Grand Cru (Premier Grand Cru Classé) | BOTTLE | VERIFIED |
| 749015 | B T262- Albert Bichot Vosne-Romanée 1er Cru 'Les Malconsorts' | T Internacionales | T262- Albert Bichot Vosne-Romanée 1er Cru 'Les Malconsorts' | BOTTLE | VERIFIED |
| 749016 | B T230- La Maison Romane Hautes-Côtes de Nuits | T Internacionales | T230- La Maison Romane Hautes-Côtes de Nuits | BOTTLE | VERIFIED |
| 749017 | B T242- Trapet Père &amp; Fils Marsannay | T Internacionales | T242- Trapet Père & Fils Marsannay | BOTTLE | VERIFIED |
| 749018 | B T220- Elio Grasso Barbera d’Alba Vigna Martina | T Internacionales | T220- Elio Grasso Barbera d’Alba Vigna Martina | BOTTLE | VERIFIED |
| 749019 | B T219- Roberto Voerzio Dolcetto D'Alba 'Priavino' | T Internacionales | T219- Roberto Voerzio Dolcetto D'Alba 'Priavino' | BOTTLE | VERIFIED |
| 749065 | B T225- Nicole Lamarche Bourgogne Passetoutgrain | T Internacionales | T225- Nicole Lamarche Bourgogne Passetoutgrain | BOTTLE | VERIFIED |
| 757192 | B B368 -Sorte O Soro | B Galicia | B368 -Sorte O Soro | BOTTLE | VERIFIED |
| 775099 | B Moscatel de la Marina | Vino Dulce | Moscatel de la Marina | BOTTLE | VERIFIED |
| 975099 | C Moscatel de la Marina | Copa Vino Postre | Moscatel de la Marina | GLASS | VERIFIED |
| 1177458 | M Magnum 34 - Bordón Crianza 1998 | MAGNUMS | Magnum 34 - Bordón Crianza 1998 | MAGNUM | VERIFIED |
| 536934 | B B346-Manar dos Seixaş | B Galicia | B346-Manar dos Seixaş | BOTTLE | VERIFIED |
| 536936 | B E504-Llopart Brut Nature Reserva | E Españoles | E504-Llopart Brut Nature Reserva | BOTTLE | VERIFIED |
| 536938 | B R605-Whispering Angel Rosé | Vinos Rosados | R605-Whispering Angel Rosé | BOTTLE | VERIFIED |
| 536939 | B T 77-Ramón Bilbao Viñedos de Altura | T Rioja Navarra | T 77-Ramón Bilbao Viñedos de Altura | BOTTLE | VERIFIED |
| 536941 | B T38-Thermes | T Ribera C.Leon | T38-Thermes | BOTTLE | VERIFIED |
| 536942 | B T50-Quinta Sardonia (QS) | T Ribera C.Leon | T50-Quinta Sardonia (QS) | BOTTLE | VERIFIED |

## Legacy sin mapping confirmado - primeros 120
| Agora ID | Legacy Agora | Familia | Estado | Candidato Winerim | Formato |
| --- | --- | --- | --- | --- | --- |
| 271 | Cair | T Ribera C.Leon | PENDING | T34-Cair Selección La Aguilera | BOTTLE |
| 272 | Montebaco Cara Norte | T Ribera C.Leon | PENDING | T31-Semele | BOTTLE |
| 325 | Artazu | T Rioja Navarra | PENDING | MAGNUM 2 - Artazu Santa Cruz Blanco | BOTTLE |
| 386 | Roberto Voerzio | T Internacionales | PENDING | T201- Morgon | BOTTLE |
| 401 | Mercurey | T Internacionales | PENDING | T234-Mercurey-Sazenay Premier Cru | BOTTLE |
| 556 | Paul Dethuné Rosè | Champagnes | PENDING | R601-Alba Rosé | BOTTLE |
| 566 | Eloquence | Champagnes | PENDING | D706-El Sequé Dulce | BOTTLE |
| 605 | Copa Tinto Menorca | Copas Tinto | PENDING | T1 - Iamontanum Garnacha - Isla de Menorca | BOTTLE |
| 607 | Copa Tinto Rioja | Copas Tinto | PENDING | T122-Santa Rosa | BOTTLE |
| 608 | Copa Tinto Ribera | Copas Tinto | PENDING | T104-Viña Tondonia Reserva | BOTTLE |
| 625 | Copa Blanco Menorca | Copas Blanco | PENDING | T1 - Iamontanum Garnacha - Isla de Menorca | BOTTLE |
| 626 | Copa Blanco Rueda | Copas Blanco | PENDING | MAGNUM 1 - Ossian Blanco | BOTTLE |
| 627 | Copa Blanco Godello | Copas Blanco | PENDING | MAGNUM 1 - Ossian Blanco | BOTTLE |
| 628 | Copa Blanco Especial | Copas Blanco | PENDING | T41-Abadía Retuerta Selección Especial | BOTTLE |
| 629 | Copa Rosado | Copas Rosado | PENDING | T42-Tomás Postigo | BOTTLE |
| 630 | Copa Rosado Especial | Copas Rosado | PENDING | T41-Abadía Retuerta Selección Especial | BOTTLE |
| 631 | Copa Cava | Vinos Por Copas | PENDING | Doña Palaueta | BOTTLE |
| 639 | ALBA garnacha | B Baleares | PENDING | R601-Alba Rosé | BOTTLE |
| 583 | Copa Don PX | Vino Dulce | REJECTED | D704-Don PX Pedro Ximenez | BOTTLE |
| 51 | Tinto Verano | Refrescos | LEGACY_NO_MAPPING |  |  |
| 96 | Copa Fernando Castilla | Coñac Brandy | LEGACY_NO_MAPPING |  |  |
| 107 | Izaguirre Blanco | Aperitivos | LEGACY_NO_MAPPING |  |  |
| 133 | Chupito Marc de Cava | Licores | LEGACY_NO_MAPPING |  |  |
| 235 | T1-Iamontanum Garnacha | T Baleares | LEGACY_NO_MAPPING |  |  |
| 236 | Obac | T Baleares | LEGACY_NO_MAPPING |  |  |
| 237 | Supernova Mantonegro | T Baleares | LEGACY_NO_MAPPING |  |  |
| 241 | AN/2 | T Baleares | LEGACY_NO_MAPPING |  |  |
| 242 | AN/2 Magnum | T Baleares | LEGACY_NO_MAPPING |  |  |
| 243 | Torralbenc pinot noir | T Baleares | LEGACY_NO_MAPPING |  |  |
| 244 | El Galgo | T Baleares | LEGACY_NO_MAPPING |  |  |
| 245 | Daniel | T Baleares | LEGACY_NO_MAPPING |  |  |
| 246 | Sòtil | T Baleares | LEGACY_NO_MAPPING |  |  |
| 249 | Grimalt Caballero | T Baleares | LEGACY_NO_MAPPING |  |  |
| 250 | 2 Tancas | T Baleares | LEGACY_NO_MAPPING |  |  |
| 251 | Pardas Collita | T Cataluña | LEGACY_NO_MAPPING |  |  |
| 253 | Trossos Vells | T Cataluña | LEGACY_NO_MAPPING |  |  |
| 255 | Martinet Bru | T Cataluña | LEGACY_NO_MAPPING |  |  |
| 256 | Camins del Priorat | T Cataluña | LEGACY_NO_MAPPING |  |  |
| 257 | Les Terrasses | T Cataluña | LEGACY_NO_MAPPING |  |  |
| 258 | Salanques | T Cataluña | LEGACY_NO_MAPPING |  |  |
| 259 | Acusp | T Cataluña | LEGACY_NO_MAPPING |  |  |
| 260 | Ferrer Bobet | T Cataluña | LEGACY_NO_MAPPING |  |  |
| 261 | Ferrer Bobet Magnum | T Cataluña | LEGACY_NO_MAPPING |  |  |
| 262 | Laurel | T Cataluña | LEGACY_NO_MAPPING |  |  |
| 263 | Gratallops | T Cataluña | LEGACY_NO_MAPPING |  |  |
| 264 | Clos Martinet | T Cataluña | LEGACY_NO_MAPPING |  |  |
| 265 | Finca Dofí | T Cataluña | LEGACY_NO_MAPPING |  |  |
| 266 | 1902 Centenary Carignan | T Cataluña | LEGACY_NO_MAPPING |  |  |
| 268 | Parada de Atauta | T Ribera C.Leon | LEGACY_NO_MAPPING |  |  |
| 269 | Arrocal Joven Roble | T Ribera C.Leon | LEGACY_NO_MAPPING |  |  |
| 270 | Pruno Magnum | T Ribera C.Leon | LEGACY_NO_MAPPING |  |  |
| 273 | Dominio de Calogía | T Ribera C.Leon | LEGACY_NO_MAPPING |  |  |
| 275 | Thermes | T Ribera C.Leon | LEGACY_NO_MAPPING |  |  |
| 276 | San Román | T Ribera C.Leon | LEGACY_NO_MAPPING |  |  |
| 278 | Abadía Retuerta | T Ribera C.Leon | LEGACY_NO_MAPPING |  |  |
| 281 | Cepa 21 Malabrigo | T Ribera C.Leon | LEGACY_NO_MAPPING |  |  |
| 282 | Pago de Carraovejas | T Ribera C.Leon | LEGACY_NO_MAPPING |  |  |
| 283 | Pago de Carraovejas Magnum | T Ribera C.Leon | LEGACY_NO_MAPPING |  |  |
| 284 | Vizcarra Torralvo | T Ribera C.Leon | LEGACY_NO_MAPPING |  |  |
| 285 | Malleolus | T Ribera C.Leon | LEGACY_NO_MAPPING |  |  |
| 286 | Hispania | T Ribera C.Leon | LEGACY_NO_MAPPING |  |  |
| 288 | Quinta Sardonia | T Ribera C.Leon | LEGACY_NO_MAPPING |  |  |
| 289 | Victorino | T Ribera C.Leon | LEGACY_NO_MAPPING |  |  |
| 290 | Pintia | T Ribera C.Leon | LEGACY_NO_MAPPING |  |  |
| 291 | El Nogal | T Ribera C.Leon | LEGACY_NO_MAPPING |  |  |
| 292 | Dominio del Aguila | T Ribera C.Leon | LEGACY_NO_MAPPING |  |  |
| 293 | Alión | T Ribera C.Leon | LEGACY_NO_MAPPING |  |  |
| 294 | garmon | T Ribera C.Leon | LEGACY_NO_MAPPING |  |  |
| 295 | Valbuena 5º | T Ribera C.Leon | LEGACY_NO_MAPPING |  |  |
| 296 | Alabaster | T Ribera C.Leon | LEGACY_NO_MAPPING |  |  |
| 297 | Vega Sicilia Único | T Ribera C.Leon | LEGACY_NO_MAPPING |  |  |
| 300 | Lalama | T Atlanticos | LEGACY_NO_MAPPING |  |  |
| 301 | Guímaro | T Atlanticos | LEGACY_NO_MAPPING |  |  |
| 302 | Lacima | T Atlanticos | LEGACY_NO_MAPPING |  |  |
| 303 | Sufreiral | T Atlanticos | LEGACY_NO_MAPPING |  |  |
| 304 | Ultreia Valtuille | T Atlanticos | LEGACY_NO_MAPPING |  |  |
| 305 | Algueira Serradelo | T Atlanticos | LEGACY_NO_MAPPING |  |  |
| 306 | El Rapolao | T Atlanticos | LEGACY_NO_MAPPING |  |  |
| 308 | Villa de Corullón | T Atlanticos | LEGACY_NO_MAPPING |  |  |
| 309 | Dominio do Bibei | T Atlanticos | LEGACY_NO_MAPPING |  |  |
| 310 | Las Lamas | T Atlanticos | LEGACY_NO_MAPPING |  |  |
| 311 | Taté | T Atlanticos | LEGACY_NO_MAPPING |  |  |
| 317 | Hacienda de Arínzano | T Rioja Navarra | LEGACY_NO_MAPPING |  |  |
| 318 | Artaxo | T Rioja Navarra | LEGACY_NO_MAPPING |  |  |
| 322 | El Terroir | T Rioja Navarra | LEGACY_NO_MAPPING |  |  |
| 323 | Luis Cañas | T Rioja Navarra | LEGACY_NO_MAPPING |  |  |
| 328 | Roda | T Rioja Navarra | LEGACY_NO_MAPPING |  |  |
| 329 | Colección 125 Chivite Tinto | T Rioja Navarra | LEGACY_NO_MAPPING |  |  |
| 334 | El Puntido | T Rioja Navarra | LEGACY_NO_MAPPING |  |  |
| 352 | Albahra | T Otras Zonas | LEGACY_NO_MAPPING |  |  |
| 353 | Valtosca | T Otras Zonas | LEGACY_NO_MAPPING |  |  |
| 354 | Venta La Ossa | T Otras Zonas | LEGACY_NO_MAPPING |  |  |
| 355 | Maduresa | T Otras Zonas | LEGACY_NO_MAPPING |  |  |
| 356 | Frontonio telescopico | T Otras Zonas | LEGACY_NO_MAPPING |  |  |
| 357 | Santa Rosa | T Otras Zonas | LEGACY_NO_MAPPING |  |  |
| 358 | Ponce | T Otras Zonas | LEGACY_NO_MAPPING |  |  |
| 359 | El Veneno | T Otras Zonas | LEGACY_NO_MAPPING |  |  |
| 360 | El Sequé Tinto | T Otras Zonas | LEGACY_NO_MAPPING |  |  |
| 361 | El Sequé Magnum | T Otras Zonas | LEGACY_NO_MAPPING |  |  |
| 362 | Alto de La Estrella | T Otras Zonas | LEGACY_NO_MAPPING |  |  |
| 363 | Finca Terrerazo | T Otras Zonas | LEGACY_NO_MAPPING |  |  |
| 364 | Las Gravas | T Otras Zonas | LEGACY_NO_MAPPING |  |  |
| 365 | La Mujer Cañón | T Otras Zonas | LEGACY_NO_MAPPING |  |  |
| 366 | Reina de los Deseos | T Otras Zonas | LEGACY_NO_MAPPING |  |  |
| 367 | Pie Franco | T Otras Zonas | LEGACY_NO_MAPPING |  |  |
| 368 | Morgon Domaine Marcel Lapierre | T Internacionales | LEGACY_NO_MAPPING |  |  |
| 369 | Domaine Anita Reine de Nuit | T Internacionales | LEGACY_NO_MAPPING |  |  |
| 371 | Prunotto fiulot | T Internacionales | LEGACY_NO_MAPPING |  |  |
| 372 | Prunotto Fiulot | T Internacionales | LEGACY_NO_MAPPING |  |  |
| 373 | J. Chamonard Morgon | T Internacionales | LEGACY_NO_MAPPING |  |  |
| 374 | Domaine Les Bruyères | T Internacionales | LEGACY_NO_MAPPING |  |  |
| 375 | Tagaro Piè del Monaco | T Internacionales | LEGACY_NO_MAPPING |  |  |
| 376 | Titan Shiraz | T Internacionales | LEGACY_NO_MAPPING |  |  |
| 377 | Morgon Côte du Py | T Internacionales | LEGACY_NO_MAPPING |  |  |
| 378 | Versante Nord | T Internacionales | LEGACY_NO_MAPPING |  |  |
| 380 | Château Pindefleurs | T Internacionales | LEGACY_NO_MAPPING |  |  |
| 381 | Les Jardins d'Edina | T Internacionales | LEGACY_NO_MAPPING |  |  |
| 382 | IL Frappato | T Internacionales | LEGACY_NO_MAPPING |  |  |
| 383 | Paolo Scavino Barolo | T Internacionales | LEGACY_NO_MAPPING |  |  |
| 384 | Chateau la Coix des templiers | T Internacionales | LEGACY_NO_MAPPING |  |  |

## Duplicados probables legacy-first - primeros 120
| Legacy ID | Legacy | Familia legacy | Winerim | Formato | Winerim ID Agora | Producto Winerim | Familia Winerim |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 104 | Martini Blanco | Aperitivos | B325-Izadi Blanco | BOTTLE | 509702 | B B325-Izadi Blanco | Vinos Blancos > B Rioja Navarra |
| 108 | Lustau Blanco | Aperitivos | B322-Ossian Blanco | BOTTLE | 509698 | B B322-Ossian Blanco | Vinos Blancos > B Rueda |
| 238 | 12 Volts | Vinos Tintos > T Baleares | T4-12 Volts | BOTTLE | 509754 | B T4-12 Volts | Vinos Tintos > T Baleares |
| 239 | Sa Forana | Vinos Tintos > T Baleares | T5-Sa Forana Tinto | BOTTLE | 509750 | B T5-Sa Forana Tinto | Vinos Tintos > T Baleares |
| 240 | Trispol | Vinos Tintos > T Baleares | T6-Trispol | BOTTLE | 509769 | B T6-Trispol | Vinos Tintos > T Baleares |
| 247 | 4 Kilos | Vinos Tintos > T Baleares | T12-4 Kilos | BOTTLE | 509773 | B T12-4 Kilos | Vinos Tintos > T Baleares |
| 248 | Àn - Ànima Negra | Vinos Tintos > T Baleares | T13-Àn - Ánima Negra | BOTTLE | 509774 | B T13-Àn - Ánima Negra | Vinos Tintos > T Baleares |
| 252 | Dido Negre | Vinos Tintos > T Cataluña | T17-Dido Negre | BOTTLE | 509778 | B T17-Dido Negre | Vinos Tintos > T Cataluña |
| 254 | Finca L'Argatà | Vinos Tintos > T Cataluña | T19- Finca l'Argatà | BOTTLE | 675508 | B T19- Finca l'Argatà | Vinos Tintos > T Cataluña |
| 267 | Semele | Vinos Tintos > T Ribera C.Leon | T31-Semele | BOTTLE | 509792 | B T31-Semele | Vinos Tintos > T Ribera C.Leon |
| 274 | César Principe | Vinos Tintos > T Ribera C.Leon | T37-César Principe | BOTTLE | 536943 | B T37-César Principe | Vinos Tintos > T Ribera C.Leon |
| 277 | Bosque de Matasnos | Vinos Tintos > T Ribera C.Leon | T40-Bosque de Matasnos | BOTTLE | 536944 | B T40-Bosque de Matasnos | Vinos Tintos > T Ribera C.Leon |
| 279 | Tomás Postigo | Vinos Tintos > T Ribera C.Leon | T42-Tomás Postigo | BOTTLE | 509800 | B T42-Tomás Postigo | Vinos Tintos > T Ribera C.Leon |
| 280 | Mauro | Vinos Tintos > T Ribera C.Leon | T43-Mauro | BOTTLE | 509802 | B T43-Mauro | Vinos Tintos > T Ribera C.Leon |
| 287 | PSI Dominio De pingus | Vinos Tintos > T Ribera C.Leon | T36-Dominio de Calogía | BOTTLE | 597624 | B T36-Dominio de Calogía | Vinos Tintos > T Ribera C.Leon |
| 298 | Ultreia Saint Jacques | Vinos Tintos > T Atlanticos | T60-Ultreia Saint Jacques | BOTTLE | 509847 | B T60-Ultreia Saint Jacques | Vinos Tintos > T Atlanticos |
| 299 | Pétalos del Bierzo | Vinos Tintos > T Atlanticos | T61-Pétalos del Bierzo | BOTTLE | 509848 | B T61-Pétalos del Bierzo | Vinos Tintos > T Atlanticos |
| 312 | La Montesa | Vinos Tintos > T Rioja Navarra | T 74-Finca La Montesa | BOTTLE | 509932 | B T 74-Finca La Montesa | Vinos Tintos > T Rioja Navarra |
| 313 | La Montesa Magnum | Vinos Tintos > T Rioja Navarra | MAGNUM 21 - Finca La Montesa | MAGNUM | 996202 | M MAGNUM 21 - Finca La Montesa | MAGNUMS |
| 314 | Tobía | Vinos Tintos > T Rioja Navarra | T 75-Tobía Selección de Autor | BOTTLE | 540391 | B T 75-Tobía Selección de Autor | Vinos Tintos > T Rioja Navarra |
| 315 | Nat Cool | Vinos Tintos > T Rioja Navarra | T 76-Nat Cool | BOTTLE | 509933 | B T 76-Nat Cool | Vinos Tintos > T Rioja Navarra |
| 316 | Ramón Bilbao | Vinos Tintos > T Rioja Navarra | T 77-Ramón Bilbao Viñedos de Altura | BOTTLE | 536939 | B T 77-Ramón Bilbao Viñedos de Altura | Vinos Tintos > T Rioja Navarra |
| 319 | Villota Tinto | Vinos Tintos > T Rioja Navarra | T80-Villota Tinto | BOTTLE | 509937 | B T80-Villota Tinto | Vinos Tintos > T Rioja Navarra |
| 320 | Señora de las Alturas | Vinos Tintos > T Rioja Navarra | T81-Señora de las Alturas | BOTTLE | 543307 | B T81-Señora de las Alturas | Vinos Tintos > T Rioja Navarra |
| 321 | Gabaxo | Vinos Tintos > T Rioja Navarra | T82-Gabaxo | BOTTLE | 538054 | B T82-Gabaxo | Vinos Tintos > T Rioja Navarra |
| 324 | Orben | Vinos Tintos > T Rioja Navarra | T85-Orben | BOTTLE | 509938 | B T85-Orben | Vinos Tintos > T Rioja Navarra |
| 326 | macan clasico | Vinos Tintos > T Rioja Navarra | T87-Macán Clásico | BOTTLE | 595336 | B T87-Macán Clásico | Vinos Tintos > T Rioja Navarra |
| 327 | Conde De La Salceda | Vinos Tintos > T Rioja Navarra | T88-Conde De La Salceda Reserva | BOTTLE | 536952 | B T88-Conde De La Salceda Reserva | Vinos Tintos > T Rioja Navarra |
| 330 | Muga Selección | Vinos Tintos > T Rioja Navarra | T101-Torre Muga | BOTTLE | 543848 | B T101-Torre Muga | Vinos Tintos > T Rioja Navarra |
| 331 | Remelluri | Vinos Tintos > T Rioja Navarra | T92-Remelluri Reserva | BOTTLE | 509939 | B T92-Remelluri Reserva | Vinos Tintos > T Rioja Navarra |
| 332 | San Vicente | Vinos Tintos > T Rioja Navarra | T93-San Vicente | BOTTLE | 543306 | B T93-San Vicente | Vinos Tintos > T Rioja Navarra |
| 333 | Viña Arana | Vinos Tintos > T Rioja Navarra | T94-Viña Arana Gran Reserva | BOTTLE | 509942 | B T94-Viña Arana Gran Reserva | Vinos Tintos > T Rioja Navarra |
| 335 | Valdeginés | Vinos Tintos > T Rioja Navarra | T96-Valdeginés | BOTTLE | 509953 | B T96-Valdeginés | Vinos Tintos > T Rioja Navarra |
| 336 | Roda I Reserva | Vinos Tintos > T Rioja Navarra | T97-Roda I Reserva | BOTTLE | 509952 | B T97-Roda I Reserva | Vinos Tintos > T Rioja Navarra |
| 337 | Mingortiz | Vinos Tintos > T Rioja Navarra | T98-Mingortiz | BOTTLE | 536951 | B T98-Mingortiz | Vinos Tintos > T Rioja Navarra |
| 338 | MACAN | Vinos Tintos > T Rioja Navarra | T99-Macán | BOTTLE | 728319 | B T99-Macán | Vinos Tintos > T Rioja Navarra |
| 339 | Gran Reserva 904 | Vinos Tintos > T Rioja Navarra | T100-Gran Reserva 904 | BOTTLE | 509951 | B T100-Gran Reserva 904 | Vinos Tintos > T Rioja Navarra |
| 340 | Torre Muga | Vinos Tintos > T Rioja Navarra | T101-Torre Muga | BOTTLE | 543848 | B T101-Torre Muga | Vinos Tintos > T Rioja Navarra |
| 341 | Prado Enea | Vinos Tintos > T Rioja Navarra | T102-Prado Enea | BOTTLE | 536956 | B T102-Prado Enea | Vinos Tintos > T Rioja Navarra |
| 342 | Trasnocho | Vinos Tintos > T Rioja Navarra | T103-Trasnocho | BOTTLE | 509955 | B T103-Trasnocho | Vinos Tintos > T Rioja Navarra |
| 343 | Viña Tondonia | Vinos Tintos > T Rioja Navarra | T104-Viña Tondonia Reserva | BOTTLE | 594418 | B T104-Viña Tondonia Reserva | Vinos Tintos > T Rioja Navarra |
| 344 | Barón de Chirel | Vinos Tintos > T Rioja Navarra | T105-Barón de Chirel Reserva | BOTTLE | 594417 | B T105-Barón de Chirel Reserva | Vinos Tintos > T Rioja Navarra |
| 345 | Macán Clásico | Vinos Tintos > T Rioja Navarra | T87-Macán Clásico | BOTTLE | 595336 | B T87-Macán Clásico | Vinos Tintos > T Rioja Navarra |
| 346 | Finca el Bosque | Vinos Tintos > T Rioja Navarra | T111-Finca el Bosque | BOTTLE | 509956 | B T111-Finca el Bosque | Vinos Tintos > T Rioja Navarra |
| 347 | La Nieta | Vinos Tintos > T Rioja Navarra | T112-La Nieta | BOTTLE | 509957 | B T112-La Nieta | Vinos Tintos > T Rioja Navarra |
| 348 | La Liende | Vinos Tintos > T Rioja Navarra | T113-Colección no.1 La Liende | BOTTLE | 536953 | B T113-Colección no.1 La Liende | Vinos Tintos > T Rioja Navarra |
| 349 | Gran Reserva 890 | Vinos Tintos > T Rioja Navarra | T114-Gran Reserva 890 | BOTTLE | 547760 | B T114-Gran Reserva 890 | Vinos Tintos > T Rioja Navarra |
| 350 | Viña Tondonia gran reserva | Vinos Tintos > T Rioja Navarra | T115- Viña Tondonia Gran Reserva 100 PUNTOS PARKER | BOTTLE | 666594 | B T115- Viña Tondonia Gran Reserva 100 PUNTOS PARKER | Vinos Tintos > T Rioja Navarra |
| 351 | Castillo Ygay | Vinos Tintos > T Rioja Navarra | T116-Castillo Ygay Gran Reserva Especial | BOTTLE | 590945 | B T116-Castillo Ygay Gran Reserva Especial | Vinos Tintos > T Rioja Navarra |
| 370 | Bourgogne Pinot Noir | Vinos Tintos > T Internacionales | T212-Bourgogne Pinot Noir | BOTTLE | 509983 | B T212-Bourgogne Pinot Noir | Vinos Tintos > T Internacionales |
| 379 | Guy Amiot et Fils Bourgogne | Vinos Tintos > T Internacionales | B427-Guy Amiot et Fils Chassagne-Montrachet "Vieilles Vignes" | BOTTLE | 509890 | B B427-Guy Amiot et Fils Chassagne-Montrachet &quot;Vieilles Vignes&quot; | Vinos Blancos > B Internacionales |
| 393 | Bonnardot Tinto | Vinos Tintos > T Internacionales | B424-Bonnardot Chassagne-Montrachet | BOTTLE | 547603 | B B424-Bonnardot Chassagne-Montrachet | Vinos Blancos > B Internacionales |
| 398 | Domaine Parigot Volnay | Vinos Tintos > T Internacionales | T231-Domaine Parigot Volnay 'Les Brouillards' | BOTTLE | 596701 | B T231-Domaine Parigot Volnay 'Les Brouillards' | Vinos Tintos > T Internacionales |
| 438 | Foraster | Vinos Blancos > B Baleares | B-308- Foraster | BOTTLE | 671636 | B B-308- Foraster | Vinos Blancos > B Baleares |
| 442 | Gran Caus | Vinos Blancos > B Cataluña | B312-Gran Caus Blanc | BOTTLE | 509657 | B B312-Gran Caus Blanc | Vinos Blancos > B Cataluña |
| 450 | Barco del Corneta | Vinos Blancos > B Rueda | B320-Barco del Corneta | BOTTLE | 509697 | B B320-Barco del Corneta | Vinos Blancos > B Rueda |
| 454 | Belondrade y Lurton | Vinos Blancos > B Rueda | B323-Belondrade y Lurton | BOTTLE | 509700 | B B323-Belondrade y Lurton | Vinos Blancos > B Rueda |
| 457 | Villota | Vinos Blancos > B Rioja Navarra | T80-Villota Tinto | BOTTLE | 509937 | B T80-Villota Tinto | Vinos Tintos > T Rioja Navarra |
| 458 | Plácet | Vinos Blancos > B Rioja Navarra | B327-Plácet Valtomelloso | BOTTLE | 509703 | B B327-Plácet Valtomelloso | Vinos Blancos > B Rioja Navarra |
| 459 | La Bastida | Vinos Blancos > B Rioja Navarra | B328-La Bastida | BOTTLE | 509704 | B B328-La Bastida | Vinos Blancos > B Rioja Navarra |
| 460 | Qué Bonito Cacareaba | Vinos Blancos > B Rioja Navarra | B329-Qué Bonito Cacareaba | BOTTLE | 545717 | B B329-Qué Bonito Cacareaba | Vinos Blancos > B Rioja Navarra |
| 461 | Viña Gravonia | Vinos Blancos > B Rioja Navarra | B330-Viña Gravonia | BOTTLE | 543308 | B B330-Viña Gravonia | Vinos Blancos > B Rioja Navarra |
| 463 | Capellanía Magnum | Vinos Blancos > B Rioja Navarra | MAGNUM 7 - Marqués de Murrieta Capellanía | MAGNUM | 996207 | M MAGNUM 7 - Marqués de Murrieta Capellanía | MAGNUMS |
| 464 | Mirando al sur | Vinos Blancos > B Rioja Navarra | B332-Mirando al Sur | BOTTLE | 509706 | B B332-Mirando al Sur | Vinos Blancos > B Rioja Navarra |
| 466 | Mara Moura | Vinos Blancos > B Galicia | B340-Mara Moura | BOTTLE | 538052 | B B340-Mara Moura | Vinos Blancos > B Galicia |
| 468 | Terras Gauda | Vinos Blancos > B Galicia | B342-Terras Gauda | BOTTLE | 538066 | B B342-Terras Gauda | Vinos Blancos > B Galicia |
| 469 | Arousa | Vinos Blancos > B Galicia | B343-Arousa | BOTTLE | 538065 | B B343-Arousa | Vinos Blancos > B Galicia |
| 474 | Atlántico | Vinos Blancos > B Galicia | B348-Atlántico | BOTTLE | 509713 | B B348-Atlántico | Vinos Blancos > B Galicia |
| 480 | Godeval Cepas Vellas | Vinos Blancos > B Galicia | B353-Godeval Cepas Vellas - Valdeorras | BOTTLE | 595249 | B B353-Godeval Cepas Vellas - Valdeorras | Vinos Blancos > B Galicia |
| 529 | Alba | Vinos Rosados | R601-Alba Rosé | BOTTLE | 557334 | B R601-Alba Rosé | Vinos Rosados |
| 530 | Izadi Larrosa | Vinos Rosados | B325-Izadi Blanco | BOTTLE | 509702 | B B325-Izadi Blanco | Vinos Blancos > B Rioja Navarra |
| 533 | Whispering Angel | Vinos Rosados | R605-Whispering Angel Rosé | BOTTLE | 536938 | B R605-Whispering Angel Rosé | Vinos Rosados |
| 538 | Rimarts | Espumosos > E Españoles | E502-Rimarts Brut Nature Reserva 24 | BOTTLE | 509893 | B E502-Rimarts Brut Nature Reserva 24 | Espumosos > E Españoles |
| 539 | Agustí Torrelló | Espumosos > E Españoles | E503-Agustí Torelló Mata Rosat Trepat | BOTTLE | 509896 | B E503-Agustí Torelló Mata Rosat Trepat | Espumosos > E Españoles |
| 540 | Llopart | Espumosos > E Españoles | E504-Llopart Brut Nature Reserva | BOTTLE | 536936 | B E504-Llopart Brut Nature Reserva | Espumosos > E Españoles |
| 541 | Clos Lentiscus | Espumosos > E Españoles | E505-Clos Lentiscus Blanc de Blancs Brut Nature | BOTTLE | 509895 | B E505-Clos Lentiscus Blanc de Blancs Brut Nature | Espumosos > E Españoles |
| 542 | Gramona Imperial | Espumosos > E Españoles | E507-Gramona Imperial Brut | BOTTLE | 509898 | B E507-Gramona Imperial Brut | Espumosos > E Españoles |
| 570 | Laurent-Perrier-Rosé | Espumosos > Champagnes | E543-Laurent-Perrier Cuvée Rosé | BOTTLE | 509920 | B E543-Laurent-Perrier Cuvée Rosé | Espumosos > Champagnes |
| 580 | Copa Valverán Sidra de Hielo | Vino Dulce | D707- Valverán Sidra de Hielo | GLASS | 712174 | C D701-Valverán Sidra de Hielo | Copa Vino Postre |
| 581 | Copa East India Solera | Vino Dulce | D702-East India Solera | GLASS | 712176 | C D702-East India Solera | Copa Vino Postre |
| 586 | Copa Niepoort LBV | Vino Dulce | D706-Niepoort LBV | GLASS | 712178 | C D707-Niepoort LBV | Copa Vino Postre |
| 588 | Aszú 5 Puttonyos | Vino Dulce | D708- Tokaji Aszú 3 Puttonyos | BOTTLE | 733624 | B D708- Tokaji Aszú 3 Puttonyos | Vino Dulce |
| 682 | Chablis | Vinos Blancos > B Internacionales | B421-Chablis | BOTTLE | 596698 | B B421-Chablis | Vinos Blancos > B Internacionales |
| 683 | Chateau Fuissé saint-Véran | Vinos Blancos > B Internacionales | T240-Château Lagrange Saint-Julien (Grand Cru Classé) | BOTTLE | 545732 | B T240-Château Lagrange Saint-Julien (Grand Cru Classé) | Vinos Tintos > T Internacionales |
| 686 | Magnum Artazu | Vinos Blancos > B Rioja Navarra | MAGNUM 2 - Artazu Santa Cruz Blanco | MAGNUM | 997990 | M MAGNUM 2 - Artazu Santa Cruz Blanco | MAGNUMS |
| 687 | Magnum EL Puntido | Vinos Tintos > T Rioja Navarra | MAGNUM 25 - El Puntido | MAGNUM | 997992 | M MAGNUM 25 - El Puntido | MAGNUMS |
| 689 | Rock Angel | Vinos Rosados | R607-Rock Angel Rosé | BOTTLE | 605902 | B R607-Rock Angel Rosé | Vinos Rosados |
| 693 | La Condenada | Vinos Tintos > T Rioja Navarra | T107-La Condenada | BOTTLE | 597952 | B T107-La Condenada | Vinos Tintos > T Rioja Navarra |
| 694 | El Escolladero | Vinos Tintos > T Rioja Navarra | T108-El Escolladero | BOTTLE | 599979 | B T108-El Escolladero | Vinos Tintos > T Rioja Navarra |
| 695 | Pancrudo | Vinos Tintos > T Rioja Navarra | T110-Pancrudo | BOTTLE | 601768 | B T110-Pancrudo | Vinos Tintos > T Rioja Navarra |
| 727 | Juvé &amp; Camps Milesimé | Espumosos > E Españoles | E515- Juvé & Camps Milesimé | BOTTLE | 705011 | B E515- Juvé &amp; Camps Milesimé | Espumosos > E Españoles |
| 1117281 | Territorio Luthier | Vinos Blancos > B Rioja Navarra | B323a-Territorio Luthier Blanco de Guarda | BOTTLE | 601975 | B B323a-Territorio Luthier Blanco de Guarda | Vinos Blancos > B Rueda |
