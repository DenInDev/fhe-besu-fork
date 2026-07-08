# Analisi latenza BesuFHE proof-backed

Report sorgente: `besufhe-proof-backed-20260708-122940/report.json`

| Operazione | n | Gas medio | Media ms | Mediana ms | P90 ms | Media <5s ms | Outlier >=5s |
|---|---:|---:|---:|---:|---:|---:|---:|
| notarize | 10 | 989.260 | 903 | 1053 | 1068 | 903 | 0 |
| decrypt | 10 | 0 | 2708 | 2742 | 2891 | 2708 | 0 |
| add_view | 10 | 0 | 230 | 234 | 248 | 230 | 0 |
| add | 10 | 3.084.521 | 5682 | 562 | 25.660 | 682 | 2 |
| mul_scalar | 10 | 3.082.636 | 6143 | 812 | 26.193 | 746 | 2 |
| mean_view | 10 | 0 | 670 | 671 | 700 | 670 | 0 |
| mean | 10 | 3.086.339 | 3105 | 558 | 1069 | 718 | 1 |
| max_view | 10 | 0 | 593 | 590 | 620 | 593 | 0 |
| max | 10 | 3.086.475 | 3217 | 812 | 1070 | 780 | 1 |

Nota: gli outlier da 25-29 s sono ritardi di receipt/inclusione, non costo ordinario della computazione FHE. Le latenze view misurano eth_call sulla precompile; le tx proof-backed misurano verifica attestazione + storage ciphertext completo.
