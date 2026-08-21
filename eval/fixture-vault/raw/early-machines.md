---
ingested: '2026-03-01'
source-format: dataset
derived-from: raw/early-machines.csv
---
# early-machines.csv

A dataset descriptor written by Luka. The original file is retained.

- Rows: 6
- Columns: 5
- Delimiter: comma
- Header row: yes

## Schema

| Column | Type |
| --- | --- |
| name | string |
| year | integer |
| country | string |
| binary | boolean |
| programmable | string |

## First 6 rows

| name | year | country | binary | programmable |
| --- | --- | --- | --- | --- |
| Z3 | 1941 | Germany | yes | limited |
| Colossus | 1943 | UK | yes | limited |
| ENIAC | 1945 | USA | no | rewiring |
| Manchester Baby | 1948 | UK | yes | stored-program |
| EDSAC | 1949 | UK | yes | stored-program |
| UNIVAC I | 1951 | USA | yes | stored-program |

## Provenance

Extracted from `raw/early-machines.csv`.
