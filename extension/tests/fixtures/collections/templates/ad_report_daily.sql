WITH sales AS (
{% include "Base/sales_metrics" %}
), ads AS (
{% include "Base/fb_ads" %}
)
SELECT s.localdate, a.ad_name, s.revenue, a.spend
FROM sales s JOIN ads a USING (ad_id)
{% if model %}WHERE s.model = {{ model | sql }}{% endif %}
