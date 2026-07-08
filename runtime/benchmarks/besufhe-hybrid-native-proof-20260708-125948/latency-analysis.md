# Analisi latenza BesuFHE ibrido

Modalita: add e mul_scalar native; mean e max proof-backed.

| Operazione | n | Gas medio | Media ms | Mediana ms | P90 ms | Media <5s ms | Outlier >=5s |
|---|---:|---:|---:|---:|---:|---:|---:|
| notarize | 10 | 989.271 | 6538 | 1055 | 28.722 | 990 | 2 |
| decrypt | 10 | 0 | 2796 | 2760 | 3000 | 2796 | 0 |
| add_view | 10 | 0 | 230 | 229 | 254 | 230 | 0 |
| add | 10 | 7.023.897 | 4390 | 1572 | 2072 | 1622 | 1 |
| mul_scalar | 10 | 8.928.178 | 1712 | 1568 | 2072 | 1712 | 0 |
| mean_view | 10 | 0 | 629 | 625 | 672 | 629 | 0 |
| mean | 10 | 3.086.338 | 8853 | 1064 | 28.649 | 919 | 3 |
| max_view | 10 | 0 | 621 | 621 | 652 | 621 | 0 |
| max | 10 | 3.086.511 | 3213 | 801 | 1075 | 779 | 1 |

Nota: gli outlier >=5s sono ritardi di receipt/inclusione. La mediana e la media <5s rappresentano meglio il comportamento ordinario della chain locale.
