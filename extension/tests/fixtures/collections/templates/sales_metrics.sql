SELECT localdate, ad_id, SUM(revenue) AS revenue
FROM `acme-prod`.{{ dataset }}.sales
WHERE localdate BETWEEN {{ start_date | sql }} AND {{ end_date | sql }}
GROUP BY 1, 2
