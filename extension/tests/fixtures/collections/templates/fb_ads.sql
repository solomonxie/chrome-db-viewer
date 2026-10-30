SELECT ad_id, ad_name, spend
FROM `acme-prod`.{{ dataset }}.fb_ads
WHERE account_id = {{ account_id | sql }}
