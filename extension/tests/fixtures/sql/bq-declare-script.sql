-- Window for the report.
DECLARE end_date DATE DEFAULT CURRENT_DATE();
SET end_date = DATE_SUB(end_date, INTERVAL 1 DAY);

SELECT ad_key_hash, COUNT(*) AS clicks
FROM clicks
WHERE day <= end_date
GROUP BY 1;

SELECT COUNT(*) FROM clicks WHERE day = end_date;
