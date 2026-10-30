SELECT ad_name, SUM(revenue) / NULLIF(SUM(spend), 0) AS roas
FROM {{ ref("ad_report_daily") }} AS cd
GROUP BY ad_name
ORDER BY roas DESC
LIMIT {{ var("limit", 20) }}
