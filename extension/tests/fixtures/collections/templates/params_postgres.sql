SELECT '$9 literal' AS s -- $8 comment
FROM orders WHERE status = $2 AND created_at >= $1 /* $7 */
