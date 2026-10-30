CREATE TEMP TABLE picked AS SELECT * FROM {{ table | ident }} WHERE status = {{ status | sql }};
-- a comment; with a semicolon
INSERT INTO audit (note) VALUES ('ran; for {{ status }}');
SELECT count(*) AS n FROM picked
