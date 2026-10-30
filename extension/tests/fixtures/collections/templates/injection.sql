SELECT * FROM {{ table | ident }}
WHERE status = {{ status }}
  AND name LIKE '%{{ needle }}%'
  AND id IN {{ ids | sql_list }}
  AND kind = {{ kind | sql }}
{{ extra_where }}
