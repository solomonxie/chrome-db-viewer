-- @not_a_param in a comment
SELECT '@also_not' AS s, @start_date AS d, `col@x`
FROM t /* @nope */
WHERE d >= @start_date AND d < @end_date AND @@session.time_zone IS NOT NULL
