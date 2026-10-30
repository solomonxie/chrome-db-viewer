SELECT localdate, ad_hash, SUM(attributed_rev) AS revenue
FROM `acme-prod.production__4c1e7a2b_8d3f_4e5a_9b6c_1a2b3c4d5e6f.attribution_daily`
WHERE localdate >= '2026-10-01'
  AND localdate <= '2026-10-07'
  AND attribution_model = 'last_touch'
  AND platform IN ('facebook', 'tiktok')
  AND spend > 100
GROUP BY 1, 2
ORDER BY revenue DESC
LIMIT 50
